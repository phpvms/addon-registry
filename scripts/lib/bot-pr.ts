/**
 * Bot PR creation helpers.
 *
 * The release-block flow and version-bump flow both produce a
 * single-file diff. We commit via the GitHub Contents API rather than a
 * git push, which sidesteps SSH key management and lets the App's
 * installation token sign the commit.
 *
 * Branch naming:
 *   - bot/release-{author}-{name}-{version}  — appends release block to a fresh YAML
 *   - bot/bump-{author}-{name}-{version}     — bumps an existing release block
 *
 * Concurrency: at most one open bump PR per package. The caller checks
 * `findOpenBumpPrForPackage` before opening; if one exists it updates
 * the branch on the existing PR instead of opening a duplicate.
 */

import type { Octokit } from '@octokit/rest';
import { Buffer } from 'node:buffer';
import { findOpenPrByBranch, openPullRequest, type RepoIdentity } from './github.js';

export interface CommitFileParams {
	owner: string;
	repo: string;
	branch: string;
	path: string;
	content: string; // utf-8 string
	message: string;
	parentSha: string;
	/** sha of the existing blob, required when updating an existing file. */
	currentSha?: string;
}

/**
 * Produce a `bot/release-{author}-{name}-{version}` branch name from the
 * registry name and version.
 */
export function releaseBranchName(name: string, version: string): string {
	return `bot/release-${slugify(name)}-${version}`;
}

/** Produce a `bot/bump-{author}-{name}-{version}` branch name. */
export function bumpBranchName(name: string, version: string): string {
	return `bot/bump-${slugify(name)}-${version}`;
}

/** Slugify `acme/reports` to `acme-reports` for branch names. */
export function slugify(registryName: string): string {
	return registryName.replace(/\//g, '-');
}

/** Title format for a bump PR. */
export function bumpPrTitle(name: string, oldVersion: string, newVersion: string): string {
	return `bump: ${name} ${oldVersion} → ${newVersion}`;
}

/** Title format for a release-block PR. */
export function releaseBlockPrTitle(name: string, version: string): string {
	return `release-block: ${name} ${version}`;
}

/**
 * Detect any open bump or release-block PR for a given package,
 * regardless of version. Used to prevent duplicate concurrent bumps.
 *
 * Pagination: at ~50 addons we won't hit a page boundary, but a noisy
 * maintenance period (e.g. many open bot PRs after an outage) could
 * push past 100. Silent miss there would let discovery open duplicate
 * PRs. Iterate via `client.paginate` so the cap is irrelevant.
 */
export async function findOpenBotPrForPackage(
	client: Octokit,
	repo: RepoIdentity,
	registryName: string,
): Promise<{ number: number; head: string } | null> {
	const slug = slugify(registryName);
	const branchPrefixes = [`bot/bump-${slug}-`, `bot/release-${slug}-`];
	const iterator = client.paginate.iterator(client.pulls.list, {
		owner: repo.owner,
		repo: repo.repo,
		state: 'open',
		per_page: 100,
	});
	for await (const { data } of iterator) {
		const found = data.find((pr) => branchPrefixes.some((p) => pr.head.ref.startsWith(p)));
		if (found) return { number: found.number, head: found.head.ref };
	}
	return null;
}

/**
 * Get a reference to the base branch's tip commit. Used as the parent
 * sha for fresh bot branches.
 */
export async function getBaseSha(client: Octokit, repo: RepoIdentity, baseBranch: string): Promise<string> {
	const { data } = await client.repos.getBranch({ owner: repo.owner, repo: repo.repo, branch: baseBranch });
	return data.commit.sha;
}

/** Create a branch at `parentSha` if it doesn't exist; reset it if it does. */
export async function upsertBranch(
	client: Octokit,
	repo: RepoIdentity,
	branch: string,
	parentSha: string,
): Promise<void> {
	const ref = `heads/${branch}`;
	try {
		await client.git.getRef({ owner: repo.owner, repo: repo.repo, ref });
		await client.git.updateRef({
			owner: repo.owner,
			repo: repo.repo,
			ref,
			sha: parentSha,
			force: true,
		});
	} catch (err: unknown) {
		const status = (err as { status?: number }).status;
		if (status !== 404) throw err;
		await client.git.createRef({
			owner: repo.owner,
			repo: repo.repo,
			ref: `refs/heads/${branch}`,
			sha: parentSha,
		});
	}
}

/**
 * Read the current sha + content of a file at `branch`. Returns null
 * when the file does not yet exist (release-block flow path).
 */
export async function readFileAtBranch(
	client: Octokit,
	repo: RepoIdentity,
	branch: string,
	pathInRepo: string,
): Promise<{ content: string; sha: string } | null> {
	try {
		const { data } = await client.repos.getContent({
			owner: repo.owner,
			repo: repo.repo,
			path: pathInRepo,
			ref: branch,
		});
		if (Array.isArray(data) || data.type !== 'file') return null;
		const buf = Buffer.from(data.content, data.encoding as BufferEncoding);
		return { content: buf.toString('utf8'), sha: data.sha };
	} catch (err: unknown) {
		const status = (err as { status?: number }).status;
		if (status === 404) return null;
		throw err;
	}
}

/**
 * Commit a single file change to a branch. Creates the file if absent,
 * updates if present. Returns the new commit sha, or `null` when the
 * existing blob already matches `newContent` (no-op short-circuit).
 *
 * The no-op check is essential: re-running discovery on the same
 * upstream tag would otherwise spam the bot branch with empty commits
 * and trigger 422 responses from the Contents API when the blob hash
 * is identical.
 */
export async function commitFileToBranch(
	client: Octokit,
	repo: RepoIdentity,
	params: {
		branch: string;
		pathInRepo: string;
		newContent: string;
		message: string;
	},
): Promise<string | null> {
	const existing = await readFileAtBranch(client, repo, params.branch, params.pathInRepo);
	if (existing && existing.content === params.newContent) {
		return null;
	}
	const { data } = await client.repos.createOrUpdateFileContents({
		owner: repo.owner,
		repo: repo.repo,
		path: params.pathInRepo,
		message: params.message,
		content: Buffer.from(params.newContent, 'utf8').toString('base64'),
		branch: params.branch,
		sha: existing?.sha,
	});
	return data.commit.sha ?? '';
}

/**
 * High-level: open or update a bot PR. If an open PR exists for the same
 * branch, no new PR is created (the commit alone updates the branch).
 * Returns the PR number.
 *
 * The PR is opened without auto-merge. The bot-pr-auto-merge workflow
 * (.github/workflows/bot-pr-auto-merge.yml) self-merges this PR once
 * required checks pass and a tamper check confirms every commit is
 * bot-authored.
 */
export async function openOrUpdateBotPr(
	client: Octokit,
	repo: RepoIdentity,
	params: {
		branch: string;
		title: string;
		baseBranch: string;
		body: string;
	},
): Promise<{ number: number; created: boolean }> {
	const existing = await findOpenPrByBranch(client, repo, params.branch);
	if (existing) {
		return { number: existing, created: false };
	}
	const { number } = await openPullRequest(client, repo, {
		title: params.title,
		head: params.branch,
		base: params.baseBranch,
		body: params.body,
	});
	return { number, created: true };
}
