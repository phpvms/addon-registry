/**
 * Resolve the upstream release for a package YAML and produce a
 * `release:` block. Used both by the post-merge release-block workflow
 * (after author PR merges) and by version discovery (after upstream
 * tags appear).
 */

import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import { readYaml, type PackageYaml } from './yaml.js';
import { listReleases, parseRepository, pickZipAsset, type GithubRelease } from './github.js';
import { fetchAndInspectZip } from './zip.js';
import { selectLatestStable, parseTag, isStable } from './semver.js';

export interface ResolvedRelease {
	version: string;
	tag: string;
	zip_url: string;
	sha256: string;
	published_at: string;
}

export type ResolveOutcome =
	| { kind: 'release'; release: ResolvedRelease }
	| { kind: 'skip'; reason: 'revoked' | 'archived' }
	| { kind: 'no-stable-release'; details: string }
	| { kind: 'no-zip-asset'; tag: string }
	| { kind: 'error'; details: string };

export interface ResolveOptions {
	yamlAbsPath: string;
	octokit: Octokit;
	/**
	 * If specified, force resolution of this tag (used by `repository_dispatch`
	 * with a known tag). Otherwise pick the latest stable.
	 */
	preferTag?: string;
}

/**
 * Compute a resolved release block for the YAML. Read-only — does not
 * write anything to disk. Caller invokes `appendReleaseBlock` for the
 * write step.
 */
export async function resolveRelease(opts: ResolveOptions): Promise<ResolveOutcome> {
	let data: PackageYaml;
	try {
		data = readYaml<PackageYaml>(opts.yamlAbsPath);
	} catch (err) {
		return { kind: 'error', details: `Failed to read YAML: ${(err as Error).message}` };
	}

	if (data.revoked === true) return { kind: 'skip', reason: 'revoked' };
	if (data.archived === true) return { kind: 'skip', reason: 'archived' };

	const repoIdent = parseRepository(data.source.repository);
	const releases = await listReleases(opts.octokit, repoIdent).catch((err) => {
		return { __error: err as Error };
	});
	if ('__error' in releases) {
		return { kind: 'error', details: `listReleases failed: ${releases.__error.message}` };
	}

	let candidate: GithubRelease | undefined;
	if (opts.preferTag) {
		candidate = releases.find((r) => r.tag_name === opts.preferTag);
		if (!candidate) {
			return { kind: 'error', details: `Preferred tag ${opts.preferTag} not found on ${data.source.repository}` };
		}
	} else {
		const tags = releases.map((r) => r.tag_name);
		const latest = selectLatestStable(tags);
		if (!latest) {
			return {
				kind: 'no-stable-release',
				details: `No stable releases on ${data.source.repository} (saw ${tags.length} tag(s) total)`,
			};
		}
		candidate = releases.find((r) => r.tag_name === latest.tag);
		if (!candidate) {
			return { kind: 'error', details: `Internal: latest tag ${latest.tag} not found in release list` };
		}
	}

	const parsed = parseTag(candidate.tag_name);
	if (!parsed) {
		return { kind: 'error', details: `Tag ${candidate.tag_name} is not a valid SemVer` };
	}
	if (!isStable(parsed.version)) {
		return { kind: 'no-stable-release', details: `Tag ${candidate.tag_name} is a pre-release` };
	}

	const asset = pickZipAsset(candidate);
	if (!asset) {
		return { kind: 'no-zip-asset', tag: candidate.tag_name };
	}

	const inspection = await fetchAndInspectZip(asset.browser_download_url).catch((err) => ({
		__error: err as Error,
	}));
	if ('__error' in inspection) {
		return { kind: 'error', details: `Failed to download zip: ${inspection.__error.message}` };
	}

	return {
		kind: 'release',
		release: {
			version: parsed.version,
			tag: candidate.tag_name,
			zip_url: asset.browser_download_url,
			sha256: inspection.sha256,
			published_at: candidate.published_at ?? new Date().toISOString(),
		},
	};
}

/**
 * Convenience: resolve and unpack into a known shape. For callers that
 * want the path on disk in addition to the release.
 */
export interface ResolveByPathResult {
	yamlPath: string;
	registryName: string;
	outcome: ResolveOutcome;
}

export async function resolveReleaseByRelPath(opts: {
	repoRoot: string;
	yamlRelPath: string;
	octokit: Octokit;
	preferTag?: string;
}): Promise<ResolveByPathResult> {
	const yamlAbsPath = path.join(opts.repoRoot, opts.yamlRelPath);
	const data = readYaml<PackageYaml>(yamlAbsPath);
	const outcome = await resolveRelease({
		yamlAbsPath,
		octokit: opts.octokit,
		preferTag: opts.preferTag,
	});
	return { yamlPath: opts.yamlRelPath, registryName: data.name, outcome };
}
