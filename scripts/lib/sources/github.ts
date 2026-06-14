/**
 * GitHub release source — resolves an addon's release zip from a public
 * GitHub repository's latest release. Talks to the GitHub REST API via
 * native fetch; an optional token raises rate limits and reads repos the
 * Actions token can see (anonymous access works for public repos).
 */

import { fetchAndInspectZip } from '../zip.js';
import type { AddonSource, ResolvedSource, SourceIssue } from './types.js';
import type { PackageSource } from '../yaml.js';

interface GithubAsset {
	name: string;
	browser_download_url: string;
	content_type: string;
	size: number;
}

interface GithubRelease {
	tag_name: string;
	draft: boolean;
	assets: GithubAsset[];
}

interface RepoIdentity {
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

/** True if the repo exists and is publicly visible. */
async function isRepoPublic(repo: RepoIdentity, token?: string): Promise<boolean> {
	const res = await fetch(`${API}/repos/${repo.owner}/${repo.repo}`, { headers: headers(token) });
	if (res.status === 404) return false;
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} for ${repo.owner}/${repo.repo}: ${await res.text()}`);
	}
	const data = (await res.json()) as { private?: boolean };
	return data.private === false;
}

/** List releases (most recent first). Drafts are filtered out. */
async function listReleases(repo: RepoIdentity, token?: string): Promise<GithubRelease[]> {
	const res = await fetch(`${API}/repos/${repo.owner}/${repo.repo}/releases?per_page=30`, {
		headers: headers(token),
	});
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} listing releases for ${repo.owner}/${repo.repo}: ${await res.text()}`);
	}
	const data = (await res.json()) as Array<{
		tag_name: string;
		draft: boolean;
		assets?: Array<{ name: string; browser_download_url: string; content_type?: string; size: number }>;
	}>;
	return data
		.filter((r) => !r.draft)
		.map((r) => ({
			tag_name: r.tag_name,
			draft: r.draft,
			assets: (r.assets ?? []).map((a) => ({
				name: a.name,
				browser_download_url: a.browser_download_url,
				content_type: a.content_type ?? '',
				size: a.size,
			})),
		}));
}

/** First zip asset on a release: prefer `.zip`, fall back to content type. */
function pickZipAsset(release: GithubRelease): GithubAsset | null {
	const byExtension = release.assets.find((a) => a.name.toLowerCase().endsWith('.zip'));
	if (byExtension) return byExtension;
	return release.assets.find((a) => a.content_type === 'application/zip') ?? null;
}

export const githubReleaseSource: AddonSource = {
	type: 'github-release',

	async resolve(source: PackageSource, { token }): Promise<ResolvedSource> {
		const issues: SourceIssue[] = [];
		const repository = typeof source.repository === 'string' ? source.repository : '';

		let repoIdent: RepoIdentity;
		try {
			repoIdent = parseRepository(repository);
		} catch (err) {
			issues.push({ rule: 'source-repo-format', message: (err as Error).message });
			return { inspection: null, issues };
		}

		const isPublic = await isRepoPublic(repoIdent, token).catch((err) => {
			issues.push({
				rule: 'source-repo-error',
				message: `Failed to check repo ${repository}: ${(err as Error).message}`,
			});
			return false;
		});
		if (!isPublic) {
			issues.push({
				rule: 'source-repo-public',
				message: `Repository ${repository} is not publicly visible (or does not exist)`,
			});
			return { inspection: null, issues };
		}

		const releases = await listReleases(repoIdent, token);
		const releaseWithZip = releases.find((r) => pickZipAsset(r) !== null);
		if (!releaseWithZip) {
			issues.push({
				rule: 'release-required',
				message: `Repository ${repository} has no published release with a zip asset`,
			});
			return { inspection: null, issues };
		}
		const asset = pickZipAsset(releaseWithZip)!;

		const inspection = await fetchAndInspectZip(asset.browser_download_url).catch((err) => {
			issues.push({
				rule: 'zip-download',
				message: `Failed to download ${asset.browser_download_url}: ${(err as Error).message}`,
			});
			return null;
		});

		return { inspection, issues };
	},
};
