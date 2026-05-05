import { Octokit } from '@octokit/rest';

export interface GithubRelease {
	tag_name: string;
	name: string | null;
	published_at: string | null;
	prerelease: boolean;
	draft: boolean;
	assets: Array<{
		name: string;
		browser_download_url: string;
		content_type: string;
		size: number;
	}>;
}

export interface RepoIdentity {
	owner: string;
	repo: string;
}

/**
 * Parse `owner/repo` into a structured identity. Throws on malformed input.
 */
export function parseRepository(spec: string): RepoIdentity {
	const parts = spec.split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Invalid repository "${spec}"; expected "owner/repo"`);
	}
	return { owner: parts[0], repo: parts[1] };
}

/**
 * Build an Octokit client. Pass an installation token for authenticated
 * operations (PR creation, comments). Omit `token` for read-only public
 * API access.
 */
export function buildOctokit(token?: string): Octokit {
	return new Octokit({ auth: token, userAgent: 'phpvms-addon-registry/0.1' });
}

/** Returns true if the repo exists and is publicly visible. */
export async function isRepoPublic(client: Octokit, repo: RepoIdentity): Promise<boolean> {
	try {
		const { data } = await client.repos.get({ owner: repo.owner, repo: repo.repo });
		return data.private === false;
	} catch (err: unknown) {
		const status = (err as { status?: number }).status;
		if (status === 404) return false;
		throw err;
	}
}

/** List releases (most recent first). Drafts are filtered out. */
export async function listReleases(client: Octokit, repo: RepoIdentity): Promise<GithubRelease[]> {
	const { data } = await client.repos.listReleases({ ...repo, per_page: 30 });
	return data
		.filter((r) => !r.draft)
		.map((r) => ({
			tag_name: r.tag_name,
			name: r.name ?? null,
			published_at: r.published_at,
			prerelease: r.prerelease,
			draft: r.draft,
			assets: (r.assets ?? []).map((a) => ({
				name: a.name,
				browser_download_url: a.browser_download_url,
				content_type: a.content_type ?? '',
				size: a.size,
			})),
		}));
}

/**
 * Pick the first zip asset on a release. Prefers `.zip` files, falls back
 * to anything with `application/zip` content type. Returns null if none.
 */
export function pickZipAsset(release: GithubRelease): GithubRelease['assets'][number] | null {
	const byExtension = release.assets.find((a) => a.name.toLowerCase().endsWith('.zip'));
	if (byExtension) return byExtension;
	const byContentType = release.assets.find((a) => a.content_type === 'application/zip');
	return byContentType ?? null;
}

/** Find an existing PR comment authored by the App. Used to update single-comment threads. */
export async function findCommentByMarker(
	client: Octokit,
	repo: RepoIdentity,
	prNumber: number,
	marker: string,
): Promise<number | null> {
	const { data } = await client.issues.listComments({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: prNumber,
		per_page: 100,
	});
	const found = data.find((c) => typeof c.body === 'string' && c.body.includes(marker));
	return found ? found.id : null;
}

/**
 * Post or update a single PR comment identified by an HTML comment marker.
 * Idempotent re-runs of validators / bots produce one comment.
 */
export async function upsertComment(
	client: Octokit,
	repo: RepoIdentity,
	prNumber: number,
	marker: string,
	body: string,
): Promise<void> {
	const fullBody = `<!-- ${marker} -->\n${body}`;
	const existing = await findCommentByMarker(client, repo, prNumber, marker);
	if (existing) {
		await client.issues.updateComment({
			owner: repo.owner,
			repo: repo.repo,
			comment_id: existing,
			body: fullBody,
		});
	} else {
		await client.issues.createComment({
			owner: repo.owner,
			repo: repo.repo,
			issue_number: prNumber,
			body: fullBody,
		});
	}
}

/** Add a label to an issue/PR. Idempotent. */
export async function addLabel(client: Octokit, repo: RepoIdentity, issueNumber: number, label: string): Promise<void> {
	await client.issues.addLabels({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: issueNumber,
		labels: [label],
	});
}

/** Remove a label from an issue/PR. No-op if the label is absent. */
export async function removeLabel(client: Octokit, repo: RepoIdentity, issueNumber: number, label: string): Promise<void> {
	try {
		await client.issues.removeLabel({
			owner: repo.owner,
			repo: repo.repo,
			issue_number: issueNumber,
			name: label,
		});
	} catch (err: unknown) {
		const status = (err as { status?: number }).status;
		if (status !== 404) throw err;
	}
}

/**
 * Open a pull request and enable squash auto-merge. Returns the PR number
 * and node ID. Caller is responsible for ensuring the source branch exists.
 */
export async function openPullRequest(
	client: Octokit,
	repo: RepoIdentity,
	params: {
		title: string;
		head: string;
		base: string;
		body: string;
	},
): Promise<{ number: number; nodeId: string; htmlUrl: string }> {
	const { data } = await client.pulls.create({
		owner: repo.owner,
		repo: repo.repo,
		title: params.title,
		head: params.head,
		base: params.base,
		body: params.body,
	});
	return { number: data.number, nodeId: data.node_id, htmlUrl: data.html_url };
}

/**
 * Enable squash auto-merge on a pull request. Uses the GraphQL endpoint
 * because REST does not expose this control directly.
 */
export async function enableAutoMerge(client: Octokit, prNodeId: string): Promise<void> {
	const mutation = `
		mutation Enable($id: ID!) {
			enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
				pullRequest { id }
			}
		}
	`;
	await client.graphql(mutation, { id: prNodeId });
}

/** Find an open PR by head branch name. Returns the PR number or null. */
export async function findOpenPrByBranch(client: Octokit, repo: RepoIdentity, head: string): Promise<number | null> {
	const headFull = head.includes(':') ? head : `${repo.owner}:${head}`;
	const { data } = await client.pulls.list({
		owner: repo.owner,
		repo: repo.repo,
		state: 'open',
		head: headFull,
		per_page: 1,
	});
	return data[0]?.number ?? null;
}
