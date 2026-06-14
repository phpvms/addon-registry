#!/usr/bin/env bun
/**
 * scripts/validate.ts — PR-time addon validator (single Bun entry point).
 *
 * For each changed `packages/{author}/{name}.yml` it runs, in order:
 *   1. structural checks  — path shape, filename matches `name`, reserved name
 *   2. JSON schema        — schema/package.schema.json + categories.yml enum
 *   3. source release     — repo is public + has a release with a zip asset
 *   4. zip inspection     — module.json at root, forbidden paths, identity
 *   5. migration lint     — PHP AST allow-list
 *
 * `revoked`/`archived` entries skip the upstream network checks (3-5).
 *
 * Usage:
 *   bun scripts/validate.ts [file ...]               validate the given YAMLs
 *   BASE_SHA=.. HEAD_SHA=.. bun scripts/validate.ts  validate the PR diff
 *   bun scripts/validate.ts                          validate every package
 *
 * Env:
 *   GITHUB_TOKEN        optional; raises GitHub API rate limits.
 *   BASE_SHA / HEAD_SHA optional; when both set, validate the git diff.
 *   REPO_ROOT           optional; defaults to the current working directory.
 *
 * Exits non-zero if any check fails.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { readYaml, type PackageYaml } from './lib/yaml.js';
import { buildPackageValidator } from './lib/schema.js';
import { isRepoPublic, listReleases, parseRepository, pickZipAsset, type RepoIdentity } from './lib/github.js';
import { fetchAndInspectZip, findForbiddenEntries, findRootEntry, readEntryByName } from './lib/zip.js';
import { checkModuleManifest } from './lib/module-manifest.js';
import { lintMigration } from './lib/migration-lint.js';

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
}

const RESERVED_PACKAGE_NAMES = new Set(['meta']);

// --- Structural checks -----------------------------------------------------

/** Verify the YAML lives at `packages/{author}/{name}.yml`. */
export function checkPath(yamlRelPath: string): CheckIssue[] {
	const issues: CheckIssue[] = [];
	const parts = yamlRelPath.split('/');
	if (parts[0] !== 'packages') {
		issues.push({ rule: 'path-prefix', message: `Expected file under packages/, got ${yamlRelPath}` });
		return issues;
	}
	if (parts.length !== 3) {
		issues.push({ rule: 'path-shape', message: `Expected packages/{author}/{name}.yml, got ${yamlRelPath}` });
		return issues;
	}
	if (!parts[2]!.endsWith('.yml')) {
		issues.push({
			rule: 'path-extension',
			message: `Package files must use .yml (not .yaml or other): ${yamlRelPath}`,
		});
	}
	return issues;
}

/** Verify the filename matches `name`. Assumes `checkPath` already passed. */
export function checkFilenameMatchesName(yamlRelPath: string, name: string): CheckIssue[] {
	const parts = yamlRelPath.split('/');
	if (parts.length !== 3) return [];
	const author = parts[1]!;
	const stem = parts[2]!.replace(/\.ya?ml$/i, '');
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

/** Reject `meta` as a package name (meta.yml is namespace metadata). */
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

/** Run AJV schema validation (+ category enum) and surface issues. */
export function schemaValidate(data: unknown): CheckIssue[] {
	const validator = buildPackageValidator();
	const result = validator.validate(data);
	return result.errors.map((e) => ({ rule: 'schema', message: `${e.path}: ${e.message}` }));
}

// --- Per-package runner ----------------------------------------------------

/**
 * Run all PR-time checks for a single package YAML. Network checks
 * (source repo, release, zip, migrations) are skipped for revoked or
 * archived entries.
 */
export async function runPackageChecks(opts: { repoRoot: string; yamlRelPath: string; token?: string }): Promise<PackageCheckOutcome> {
	const { repoRoot, yamlRelPath, token } = opts;
	const yamlAbsPath = path.join(repoRoot, yamlRelPath);
	const outcome: PackageCheckOutcome = {
		yamlPath: yamlRelPath,
		registryName: null,
		skipped: false,
		issues: [],
	};

	// 1. Path shape
	outcome.issues.push(...checkPath(yamlRelPath));
	if (outcome.issues.length > 0) return outcome;

	// 2. Parse YAML
	let data: PackageYaml;
	try {
		data = readYaml<PackageYaml>(yamlAbsPath);
	} catch (err) {
		outcome.issues.push({ rule: 'yaml-parse', message: `Failed to parse YAML: ${(err as Error).message}` });
		return outcome;
	}

	// 3. Schema validation
	const schemaIssues = schemaValidate(data);
	outcome.issues.push(...schemaIssues);
	if (schemaIssues.length > 0 || !data.name) return outcome;
	outcome.registryName = data.name;

	// 4. Filename matches name + reserved name
	outcome.issues.push(...checkFilenameMatchesName(yamlRelPath, data.name));
	outcome.issues.push(...checkReservedName(data.name));

	// 5. Skip upstream checks for revoked or archived entries
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

	// 6. Source repository: must exist + be public
	let repoIdent: RepoIdentity;
	try {
		repoIdent = parseRepository(data.source.repository);
	} catch (err) {
		outcome.issues.push({ rule: 'source-repo-format', message: (err as Error).message });
		return outcome;
	}
	const isPublic = await isRepoPublic(repoIdent, token).catch((err) => {
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

	// 7. Latest release with a zip asset
	const releases = await listReleases(repoIdent, token);
	const releaseWithZip = releases.find((r) => pickZipAsset(r) !== null);
	if (!releaseWithZip) {
		outcome.issues.push({
			rule: 'release-required',
			message: `Repository ${data.source.repository} has no published release with a zip asset`,
		});
		return outcome;
	}
	const asset = pickZipAsset(releaseWithZip)!;

	// 8. Download + inspect zip
	const inspection = await fetchAndInspectZip(asset.browser_download_url).catch((err) => {
		outcome.issues.push({
			rule: 'zip-download',
			message: `Failed to download ${asset.browser_download_url}: ${(err as Error).message}`,
		});
		return null;
	});
	if (!inspection) return outcome;

	// 9. module.json at root
	const moduleEntry = findRootEntry(inspection.entries, 'module.json');
	if (!moduleEntry) {
		outcome.issues.push({ rule: 'module-json-missing', message: `Zip must contain module.json at the root` });
		return outcome;
	}

	// 10. Forbidden paths
	const forbidden = findForbiddenEntries(inspection.entries);
	if (forbidden.length > 0) {
		outcome.issues.push({
			rule: 'forbidden-paths',
			message: `Zip contains forbidden paths: ${forbidden.slice(0, 10).join(', ')}${forbidden.length > 10 ? `, ...${forbidden.length - 10} more` : ''}`,
		});
	}

	// 11. module.json manifest (identity + required fields + table namespace)
	let moduleParsed: unknown;
	try {
		const bytes = await readEntryByName(inspection.bytes, moduleEntry.name);
		moduleParsed = JSON.parse(bytes.toString('utf8'));
	} catch (err) {
		outcome.issues.push({ rule: 'module-json-parse', message: `Failed to parse module.json: ${(err as Error).message}` });
		return outcome;
	}
	const manifest = checkModuleManifest(moduleParsed, data.name);
	outcome.issues.push(...manifest.errors);

	// 12. Migration lint
	const author = data.name.split('/')[0]!;
	const migrationEntries = inspection.entries.filter((e) => e.name.startsWith('Database/Migrations/') && e.name.endsWith('.php'));
	for (const entry of migrationEntries) {
		const phpBytes = await readEntryByName(inspection.bytes, entry.name).catch(() => null);
		if (!phpBytes) {
			outcome.issues.push({ rule: 'migration-read', message: `Failed to read migration ${entry.name} from zip` });
			continue;
		}
		const lint = lintMigration({ source: phpBytes.toString('utf8'), path: entry.name, author });
		for (const err of lint.errors) {
			outcome.issues.push({
				rule: `migration:${err.rule}`,
				message: `${entry.name}${err.line ? `:${err.line}` : ''} — ${err.message}`,
			});
		}
	}

	return outcome;
}

// --- File discovery --------------------------------------------------------

/** Keep only package YAMLs (under packages/, .yml, excluding meta.yml). */
export function filterPackageYamlPaths(paths: string[]): string[] {
	return paths
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.filter((l) => l.startsWith('packages/') && l.endsWith('.yml'))
		.filter((l) => path.basename(l) !== 'meta.yml');
}

/** Package YAMLs changed in the PR diff (excludes deleted paths). */
function changedYamlFiles(repoRoot: string, baseSha: string, headSha: string): string[] {
	// `git diff` pathspecs do not support `**`; filter in JS instead.
	// `--diff-filter=ACMRT` excludes deleted paths so we never read a YAML
	// the PR removed.
	const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', `${baseSha}...${headSha}`], {
		cwd: repoRoot,
		encoding: 'utf8',
	});
	return filterPackageYamlPaths(out.split('\n'));
}

/** Every package YAML under packages/ (used when no diff/args are given). */
function allPackageYamls(repoRoot: string): string[] {
	const root = path.join(repoRoot, 'packages');
	const found: string[] = [];
	let authors: string[];
	try {
		authors = readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
	for (const author of authors) {
		const dir = path.join(root, author);
		for (const entry of readdirSync(dir)) {
			if (entry.endsWith('.yml') && entry !== 'meta.yml') {
				found.push(`packages/${author}/${entry}`);
			}
		}
	}
	return found;
}

function resolveTargets(repoRoot: string): string[] {
	const args = process.argv.slice(2);
	if (args.length > 0) {
		return filterPackageYamlPaths(args.map((a) => path.relative(repoRoot, path.resolve(repoRoot, a))));
	}
	const baseSha = process.env.BASE_SHA;
	const headSha = process.env.HEAD_SHA;
	if (baseSha && headSha) return changedYamlFiles(repoRoot, baseSha, headSha);
	return allPackageYamls(repoRoot);
}

async function main(): Promise<void> {
	const repoRoot = process.env.REPO_ROOT ?? process.cwd();
	const token = process.env.GITHUB_TOKEN || undefined;

	const targets = resolveTargets(repoRoot);
	if (targets.length === 0) {
		console.log('No package YAML changes detected; nothing to validate.');
		return;
	}

	console.log(`Validating ${targets.length} package YAML file(s):`);
	for (const f of targets) console.log(`  - ${f}`);

	let failed = false;
	for (const yamlRelPath of targets) {
		console.log(`\n--- ${yamlRelPath}`);
		const outcome = await runPackageChecks({ repoRoot, yamlRelPath, token });
		if (outcome.issues.length > 0) {
			failed = true;
			console.log(`  ${outcome.issues.length} issue(s):`);
			for (const issue of outcome.issues) console.log(`    - [${issue.rule}] ${issue.message}`);
		} else if (outcome.skipped) {
			console.log(`  passed (${outcome.skipReason}; upstream checks skipped)`);
		} else {
			console.log(`  passed`);
		}
	}

	if (failed) {
		console.error('\nValidation failed.');
		process.exit(1);
	}
	console.log('\nValidation passed.');
}

// Only auto-run when invoked as a script, not when imported (e.g. tests).
const entryUrl = process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : '';
if (import.meta.url === entryUrl) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
