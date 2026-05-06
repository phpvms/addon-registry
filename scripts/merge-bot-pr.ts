/**
 * scripts/merge-bot-pr.ts — self-merge a bot PR once gating workflows
 * pass and tamper check is clean.
 *
 * Triggered by `.github/workflows/bot-pr-auto-merge.yml` on
 * `workflow_run: completed` for the CI and Validate PR workflows.
 * Runs idempotently: if the PR is already merged, already closed, or
 * if the second gating workflow has not yet finished, the script
 * returns 0 without action. The next gating workflow's completion
 * will retrigger this one.
 *
 * Environment:
 *   APP_TOKEN          installation token with pull-requests: write
 *   GITHUB_REPOSITORY  owner/repo
 *   HEAD_BRANCH        e.g. bot/release-acme-reports-1.2.3
 *   HEAD_SHA           workflow_run.head_sha (the commit that triggered us)
 *
 * Required job names (the names of the check runs we wait on) are
 * hardcoded to mirror the two workflows that gate every bot PR:
 *   - 'test'      from .github/workflows/ci.yml
 *   - 'validate'  from .github/workflows/validate-pr.yml
 */
import type { Octokit } from '@octokit/rest';
import { buildOctokit, parseRepository, type RepoIdentity } from './lib/github.js';
import {
	checkCommitsAreBotAuthored,
	checkRequiredJobsGreen,
} from './lib/merge-checks.js';

const REQUIRED_JOB_NAMES = ['test', 'validate'];

async function findOpenBotPr(
	client: Octokit,
	repo: RepoIdentity,
	headBranch: string,
	headSha: string,
): Promise<{ number: number; head: { sha: string }; state: string; merged: boolean } | null> {
	// `pulls.list` accepts `head: owner:branch`. Filter to the exact
	// commit we were triggered by; if the PR has since been advanced,
	// the next workflow_run will pick up the new SHA.
	const { data } = await client.pulls.list({
		owner: repo.owner,
		repo: repo.repo,
		head: `${repo.owner}:${headBranch}`,
		state: 'all',
		per_page: 10,
	});
	const matching = data.find((pr) => pr.head.sha === headSha);
	if (!matching) return null;
	return {
		number: matching.number,
		head: { sha: matching.head.sha },
		state: matching.state,
		merged: Boolean(matching.merged_at),
	};
}

async function resolveBotLogin(client: Octokit): Promise<string> {
	// `apps.getAuthenticated` returns the App's metadata when called
	// with an installation token. The bot user login is `<slug>[bot]`.
	const { data } = await client.apps.getAuthenticated();
	const slug = (data as { slug?: string } | null)?.slug;
	if (!slug) throw new Error('apps.getAuthenticated returned no slug; cannot derive bot login');
	return `${slug}[bot]`;
}

async function commentTamperBlocked(
	client: Octokit,
	repo: RepoIdentity,
	prNumber: number,
	reason: string,
): Promise<void> {
	const body = [
		'**Auto-merge blocked.**',
		'',
		'A commit on this branch did not originate from the registry bot, or its signature could not be verified. Auto-merge has been skipped to protect the release pipeline.',
		'',
		`Detail: \`${reason}\``,
		'',
		'A maintainer should review the branch history and either reset the branch or merge manually after inspection.',
	].join('\n');
	await client.issues.createComment({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: prNumber,
		body,
	});
}

async function main(): Promise<void> {
	const repoSpec = process.env.GITHUB_REPOSITORY;
	const headBranch = process.env.HEAD_BRANCH;
	const headSha = process.env.HEAD_SHA;
	const token = process.env.APP_TOKEN ?? process.env.GITHUB_TOKEN;
	if (!repoSpec || !headBranch || !headSha || !token) {
		throw new Error('Missing required env: GITHUB_REPOSITORY, HEAD_BRANCH, HEAD_SHA, APP_TOKEN');
	}
	if (!headBranch.startsWith('bot/')) {
		console.log(`head branch ${headBranch} is not a bot branch; nothing to do`);
		return;
	}

	const repo = parseRepository(repoSpec);
	const client = buildOctokit(token);

	const pr = await findOpenBotPr(client, repo, headBranch, headSha);
	if (!pr) {
		console.log(`no open PR found for ${headBranch}@${headSha.slice(0, 7)}; nothing to do`);
		return;
	}
	if (pr.merged) {
		console.log(`PR #${pr.number} already merged`);
		return;
	}
	if (pr.state !== 'open') {
		console.log(`PR #${pr.number} is ${pr.state}, not open; skipping`);
		return;
	}

	const checks = await checkRequiredJobsGreen(client, repo, headSha, REQUIRED_JOB_NAMES);
	if (!checks.allGreen) {
		if (checks.failed.length > 0) {
			console.log(`PR #${pr.number}: required job(s) failed: ${checks.failed.join(', ')}; not merging`);
			return;
		}
		console.log(`PR #${pr.number}: waiting on required job(s): ${checks.missing.join(', ')}`);
		return;
	}

	const botLogin = await resolveBotLogin(client);
	const tamper = await checkCommitsAreBotAuthored(client, repo, pr.number, botLogin);
	if (!tamper.clean) {
		const reason = tamper.reason ?? 'unknown';
		console.log(`PR #${pr.number}: tamper check failed: ${reason}`);
		await commentTamperBlocked(client, repo, pr.number, reason);
		return;
	}

	try {
		await client.pulls.merge({
			owner: repo.owner,
			repo: repo.repo,
			pull_number: pr.number,
			merge_method: 'squash',
			sha: headSha,
		});
		console.log(`PR #${pr.number} merged (squash) at ${headSha.slice(0, 7)}`);
	} catch (err: unknown) {
		const status = (err as { status?: number }).status;
		const message = (err as Error).message;
		// 405: PR not mergeable (race on a competing merge or branch
		// change). 409: head SHA mismatch (someone advanced the branch
		// between our check and the merge call). Treat both as
		// retryable: the next workflow_run completion picks them up.
		if (status === 405 || status === 409) {
			console.log(`PR #${pr.number} merge skipped (${status}): ${message}`);
			return;
		}
		throw err;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
