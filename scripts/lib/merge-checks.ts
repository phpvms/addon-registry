/**
 * Helpers for the bot-PR auto-merge workflow.
 *
 * Two gates must pass before a bot PR can self-merge:
 *
 *   1. Tamper check: every commit on the branch must originate from the
 *      registry's GitHub App (author.type === 'Bot' && author.login ===
 *      `${appSlug}[bot]`) and carry a verified GitHub signature. This
 *      rejects branches a human pushed to while the PR was open.
 *
 *   2. Required-checks check: the named required workflows must all
 *      have a SUCCESS check run on the PR's current head SHA.
 *
 * Both gates are advisory in the sense that failure leaves the PR open
 * for human intervention rather than failing the workflow run. The merge
 * workflow re-fires on every required-workflow completion, so a green
 * second run after a tampered commit is reverted will still merge.
 */
import type { Octokit } from '@octokit/rest';
import type { RepoIdentity } from './github.js';

export interface CommitTamperResult {
	clean: boolean;
	/** Human-readable reason when `clean === false`. */
	reason?: string;
	/** Commit sha that failed the check (when clean === false). */
	offendingSha?: string;
}

interface PrCommit {
	sha: string;
	commit: {
		verification?: {
			verified?: boolean;
			reason?: string;
		};
	};
	author: {
		login?: string;
		type?: string;
	} | null;
}

/**
 * Walk every commit on the PR branch and confirm the bot authored it
 * and GitHub signed it. A single bad commit fails the check.
 *
 * NOTE: we trust `author`, not `committer`. When commits arrive via the
 * GitHub Contents API, `committer.login` is `web-flow` (GitHub's own
 * signing identity) regardless of who initiated the commit. The author
 * field is the actual originator and is what we can authenticate
 * against the bot's identity.
 */
export async function checkCommitsAreBotAuthored(
	client: Octokit,
	repo: RepoIdentity,
	prNumber: number,
	expectedBotLogin: string,
): Promise<CommitTamperResult> {
	const commits: PrCommit[] = [];
	const iterator = client.paginate.iterator(client.pulls.listCommits, {
		owner: repo.owner,
		repo: repo.repo,
		pull_number: prNumber,
		per_page: 100,
	});
	for await (const { data } of iterator) {
		commits.push(...(data as unknown as PrCommit[]));
	}

	if (commits.length === 0) {
		return { clean: false, reason: 'PR has no commits' };
	}

	for (const c of commits) {
		const author = c.author;
		if (!author || author.type !== 'Bot' || author.login !== expectedBotLogin) {
			return {
				clean: false,
				offendingSha: c.sha,
				reason: `commit ${c.sha.slice(0, 7)} authored by ${author?.login ?? 'unknown'} (${author?.type ?? 'unknown'}), expected ${expectedBotLogin}`,
			};
		}
		const verification = c.commit.verification;
		if (!verification?.verified || verification.reason !== 'valid') {
			return {
				clean: false,
				offendingSha: c.sha,
				reason: `commit ${c.sha.slice(0, 7)} verification failed (verified=${verification?.verified}, reason=${verification?.reason})`,
			};
		}
	}

	return { clean: true };
}

export interface RequiredChecksResult {
	allGreen: boolean;
	/** Names of required workflows that have not yet succeeded. */
	missing: string[];
	/** Names that completed with conclusion !== 'success'. */
	failed: string[];
}

interface CheckRunSummary {
	name: string;
	status: string;
	conclusion: string | null;
}

/**
 * Verify that every workflow in `requiredWorkflowNames` has a check run
 * on `headSha` whose conclusion is 'success'.
 *
 * Matching is by check-run `name`, which equals the workflow's job
 * name. Workflows in this repo use a single job each, so the job name
 * happens to match the workflow name (CI -> 'test', Validate PR ->
 * 'validate'). Caller passes job names, not workflow names, to keep
 * lookup direct.
 */
export async function checkRequiredJobsGreen(
	client: Octokit,
	repo: RepoIdentity,
	headSha: string,
	requiredJobNames: string[],
): Promise<RequiredChecksResult> {
	const runs: CheckRunSummary[] = [];
	const iterator = client.paginate.iterator(client.checks.listForRef, {
		owner: repo.owner,
		repo: repo.repo,
		ref: headSha,
		// `latest` (the default) returns only the most recent run for
		// each check name, which is what we want: a re-run replaces a
		// prior failure for merge purposes.
		filter: 'latest',
		per_page: 100,
	});
	for await (const { data } of iterator) {
		// `client.paginate.iterator` for `checks.listForRef` yields each
		// page as `{ data: CheckRun[] }`, where the array elements are
		// already the unwrapped `check_runs` items.
		runs.push(...(data as unknown as CheckRunSummary[]));
	}

	const missing: string[] = [];
	const failed: string[] = [];

	for (const requiredName of requiredJobNames) {
		const matches = runs.filter((r) => r.name === requiredName);
		if (matches.length === 0) {
			missing.push(requiredName);
			continue;
		}
		const allCompleted = matches.every((r) => r.status === 'completed');
		if (!allCompleted) {
			missing.push(requiredName);
			continue;
		}
		const allSucceeded = matches.every((r) => r.conclusion === 'success');
		if (!allSucceeded) {
			failed.push(requiredName);
		}
	}

	return {
		allGreen: missing.length === 0 && failed.length === 0,
		missing,
		failed,
	};
}
