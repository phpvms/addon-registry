/**
 * Minimal GitHub REST access via native fetch. Used by the validator to
 * confirm a source repo is public and to find its latest release zip.
 * An optional token (GITHUB_TOKEN) raises rate limits and allows reads
 * of repos the Actions token can see; anonymous access works for public
 * repos.
 */

export interface GithubAsset {
	name: string;
	browser_download_url: string;
	content_type: string;
	size: number;
}

export interface GithubRelease {
	tag_name: string;
	name: string | null;
	published_at: string | null;
	prerelease: boolean;
	draft: boolean;
	assets: GithubAsset[];
}

export interface RepoIdentity {
	owner: string;
	repo: string;
}

const API = 'https://api.github.com';

/** Parse `owner/repo` into a structured identity. Throws on malformed input. */
export function parseRepository(spec: string): RepoIdentity {
	const parts = spec.split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Invalid repository "${spec}"; expected "owner/repo"`);
	}
	return { owner: parts[0], repo: parts[1] };
}

function headers(token?: string): Record<string, string> {
	const h: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'phpvms-addon-registry/validator',
		'X-GitHub-Api-Version': '2022-11-28',
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

/** Returns true if the repo exists and is publicly visible. */
export async function isRepoPublic(repo: RepoIdentity, token?: string): Promise<boolean> {
	const res = await fetch(`${API}/repos/${repo.owner}/${repo.repo}`, { headers: headers(token) });
	if (res.status === 404) return false;
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} for ${repo.owner}/${repo.repo}: ${await res.text()}`);
	}
	const data = (await res.json()) as { private?: boolean };
	return data.private === false;
}

/** List releases (most recent first). Drafts are filtered out. */
export async function listReleases(repo: RepoIdentity, token?: string): Promise<GithubRelease[]> {
	const res = await fetch(`${API}/repos/${repo.owner}/${repo.repo}/releases?per_page=30`, {
		headers: headers(token),
	});
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} listing releases for ${repo.owner}/${repo.repo}: ${await res.text()}`);
	}
	const data = (await res.json()) as Array<{
		tag_name: string;
		name: string | null;
		published_at: string | null;
		prerelease: boolean;
		draft: boolean;
		assets?: Array<{ name: string; browser_download_url: string; content_type?: string; size: number }>;
	}>;
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
export function pickZipAsset(release: GithubRelease): GithubAsset | null {
	const byExtension = release.assets.find((a) => a.name.toLowerCase().endsWith('.zip'));
	if (byExtension) return byExtension;
	const byContentType = release.assets.find((a) => a.content_type === 'application/zip');
	return byContentType ?? null;
}
