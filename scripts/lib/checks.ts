import path from 'node:path';
import { Buffer } from 'node:buffer';
import type { Octokit } from '@octokit/rest';
import { readYaml, type PackageYaml } from './yaml.js';
import { buildPackageValidator, type ValidationResult } from './schema.js';
import { isRepoPublic, listReleases, parseRepository, pickZipAsset, type RepoIdentity } from './github.js';
import {
	fetchAndInspectZip,
	findRootEntry,
	findForbiddenEntries,
	readEntry,
	type ZipEntry,
} from './zip.js';
import { checkModuleIdentity } from './module-identity.js';
import { lintMigration, type LintResult } from './migration-lint.js';
import { isStable, parseTag } from './semver.js';
import type { ResolvedRelease } from './resolve-release.js';

export interface CheckIssue {
	rule: string;
	message: string;
}

export interface PackageCheckOutcome {
	yamlPath: string;
	registryName: string | null;
	skipped: boolean;
	skipReason?: string;
	issues: CheckIssue[];
	migrationLints: LintResult[];
	resolvedRelease?: ResolvedRelease;
}

const RESERVED_PACKAGE_NAMES = new Set(['meta']);

/**
 * Verify a package YAML's filename matches its `name`. Returns a path-issue
 * if the YAML is in the wrong location (orphan, .yaml extension, etc.).
 */
export function checkPath(yamlRelPath: string): CheckIssue[] {
	const issues: CheckIssue[] = [];
	const parts = yamlRelPath.split(path.sep);
	if (parts[0] !== 'packages') {
		issues.push({ rule: 'path-prefix', message: `Expected file under packages/, got ${yamlRelPath}` });
		return issues;
	}
	if (parts.length !== 3) {
		issues.push({
			rule: 'path-shape',
			message: `Expected packages/{author}/{name}.yml, got ${yamlRelPath}`,
		});
		return issues;
	}
	const file = parts[2]!;
	if (!file.endsWith('.yml')) {
		issues.push({
			rule: 'path-extension',
			message: `Package files must use .yml (not .yaml or other): ${yamlRelPath}`,
		});
	}
	return issues;
}

/** Verify filename matches `name`. Both must already pass `checkPath`. */
export function checkFilenameMatchesName(yamlRelPath: string, name: string): CheckIssue[] {
	const parts = yamlRelPath.split(path.sep);
	if (parts.length !== 3) return [];
	const author = parts[1]!;
	const file = parts[2]!;
	const stem = file.replace(/\.ya?ml$/i, '');
	const expected = `${author}/${stem}`;
	if (expected !== name) {
		return [
			{
				rule: 'name-path-mismatch',
				message: `\`name\` "${name}" must match path "${expected}" derived from ${yamlRelPath}`,
			},
		];
	}
	return [];
}

/** Reject `meta` as a package name (the file `meta.yml` is namespace metadata). */
export function checkReservedName(name: string): CheckIssue[] {
	const second = name.split('/')[1];
	if (second && RESERVED_PACKAGE_NAMES.has(second)) {
		return [
			{
				rule: 'reserved-name',
				message: `Package name "${name}" uses the reserved word "${second}"; meta.yml is namespace metadata, not a package`,
			},
		];
	}
	return [];
}

/** Run AJV schema validation; returns issues for surface display. */
export function schemaValidate(data: unknown): { result: ValidationResult; issues: CheckIssue[] } {
	const validator = buildPackageValidator();
	const result = validator.validate(data);
	const issues = result.errors.map((e) => ({
		rule: 'schema',
		message: `${e.path}: ${e.message}`,
	}));
	return { result, issues };
}

/**
 * Run all PR-time checks for a single package YAML. Network checks
 * (source repo, releases, zip) are gated behind the `revoked`/`archived`
 * flags per the spec.
 */
export async function runPackageChecks(opts: {
	repoRoot: string;
	yamlRelPath: string;
	octokit: Octokit;
}): Promise<PackageCheckOutcome> {
	const { repoRoot, yamlRelPath, octokit } = opts;
	const yamlAbsPath = path.join(repoRoot, yamlRelPath);
	const outcome: PackageCheckOutcome = {
		yamlPath: yamlRelPath,
		registryName: null,
		skipped: false,
		issues: [],
		migrationLints: [],
	};

	// 1. Path shape
	outcome.issues.push(...checkPath(yamlRelPath));
	if (outcome.issues.length > 0) return outcome;

	// 2. Parse YAML
	let data: PackageYaml;
	try {
		data = readYaml<PackageYaml>(yamlAbsPath);
	} catch (err) {
		outcome.issues.push({
			rule: 'yaml-parse',
			message: `Failed to parse YAML: ${(err as Error).message}`,
		});
		return outcome;
	}

	// 3. Schema validation
	const { issues: schemaIssues } = schemaValidate(data);
	outcome.issues.push(...schemaIssues);
	if (schemaIssues.length > 0 || !data.name) return outcome;
	outcome.registryName = data.name;

	// 4. Filename matches name + reserved name check
	outcome.issues.push(...checkFilenameMatchesName(yamlRelPath, data.name));
	outcome.issues.push(...checkReservedName(data.name));

	// 5. Pre-release version in release block is forbidden
	if (data.release?.version && !isStable(data.release.version)) {
		outcome.issues.push({
			rule: 'release-prerelease',
			message: `release.version "${data.release.version}" must be a stable SemVer (no pre-release suffix)`,
		});
	}

	// 6. Skip upstream checks for revoked or archived
	if (data.revoked === true) {
		outcome.skipped = true;
		outcome.skipReason = 'revoked';
		return outcome;
	}
	if (data.archived === true) {
		outcome.skipped = true;
		outcome.skipReason = 'archived';
		return outcome;
	}

	if (outcome.issues.length > 0) return outcome;

	// 7. Source repository: must exist + public
	let repoIdent: RepoIdentity;
	try {
		repoIdent = parseRepository(data.source.repository);
	} catch (err) {
		outcome.issues.push({ rule: 'source-repo-format', message: (err as Error).message });
		return outcome;
	}
	const isPublic = await isRepoPublic(octokit, repoIdent).catch((err) => {
		outcome.issues.push({
			rule: 'source-repo-error',
			message: `Failed to check repo ${data.source.repository}: ${(err as Error).message}`,
		});
		return false;
	});
	if (!isPublic) {
		outcome.issues.push({
			rule: 'source-repo-public',
			message: `Repository ${data.source.repository} is not publicly visible (or does not exist)`,
		});
		return outcome;
	}

	// 8. Latest release with zip
	const releases = await listReleases(octokit, repoIdent);
	const releaseWithZip = releases.find((r) => pickZipAsset(r) !== null);
	if (!releaseWithZip) {
		outcome.issues.push({
			rule: 'release-required',
			message: `Repository ${data.source.repository} has no published release with a zip asset`,
		});
		return outcome;
	}
	const asset = pickZipAsset(releaseWithZip)!;

	// 9. Download + hash + inspect zip
	const inspection = await fetchAndInspectZip(asset.browser_download_url).catch((err) => {
		outcome.issues.push({
			rule: 'zip-download',
			message: `Failed to download ${asset.browser_download_url}: ${(err as Error).message}`,
		});
		return null;
	});
	if (!inspection) return outcome;

	// 10. module.json at root
	const moduleEntry = findRootEntry(inspection.entries, 'module.json');
	if (!moduleEntry) {
		outcome.issues.push({
			rule: 'module-json-missing',
			message: `Zip must contain module.json at the root`,
		});
		return outcome;
	}

	// 11. Forbidden paths
	const forbidden = findForbiddenEntries(inspection.entries);
	if (forbidden.length > 0) {
		outcome.issues.push({
			rule: 'forbidden-paths',
			message: `Zip contains forbidden paths: ${forbidden.slice(0, 10).join(', ')}${forbidden.length > 10 ? `, ...${forbidden.length - 10} more` : ''}`,
		});
	}

	// 12. module.json registry identity (registry_id must match)
	let moduleParsed: unknown;
	try {
		const bytes = await readEntry(inspection.bytes, moduleEntry);
		moduleParsed = JSON.parse(bytes.toString('utf8'));
	} catch (err) {
		outcome.issues.push({
			rule: 'module-json-parse',
			message: `Failed to parse module.json: ${(err as Error).message}`,
		});
		return outcome;
	}
	const identity = checkModuleIdentity(moduleParsed, data.name);
	for (const e of identity.errors) outcome.issues.push({ rule: 'module-identity', message: e });

	// 13. Migration lint
	const author = data.name.split('/')[0]!;
	const migrationEntries = inspection.entries.filter(
		(e) => e.name.startsWith('Database/Migrations/') && e.name.endsWith('.php'),
	);
	for (const entry of migrationEntries) {
		const phpBytes = await readEntry(inspection.bytes, entry).catch(() => null);
		if (!phpBytes) {
			outcome.issues.push({
				rule: 'migration-read',
				message: `Failed to read migration ${entry.name} from zip`,
			});
			continue;
		}
		const lint = lintMigration({
			source: phpBytes.toString('utf8'),
			path: entry.name,
			author,
		});
		outcome.migrationLints.push(lint);
		for (const err of lint.errors) {
			outcome.issues.push({
				rule: `migration:${err.rule}`,
				message: `${entry.name}${err.line ? `:${err.line}` : ''} — ${err.message}`,
			});
		}
	}

	// 14. If everything passed, build the resolved release block
	if (outcome.issues.length === 0) {
		const parsed = parseTag(releaseWithZip.tag_name);
		const version = parsed?.version ?? releaseWithZip.tag_name.replace(/^v/i, '');
		outcome.resolvedRelease = {
			version,
			tag: releaseWithZip.tag_name,
			zip_url: asset.browser_download_url,
			sha256: inspection.sha256,
			published_at: releaseWithZip.published_at ?? new Date().toISOString(),
		};
	}

	return outcome;
}

export type { ZipEntry };
export type { Buffer };
