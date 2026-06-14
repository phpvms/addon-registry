#!/usr/bin/env bun
/**
 * scripts/validate.ts — PR-time addon validator (single Bun entry point).
 *
 * For each changed `packages/{publisher}.yml` it runs, in order:
 *   1. structural checks  — path shape (packages/{publisher}.yml)
 *   2. JSON schema        — schema/package.schema.json (publisher file: meta + addons)
 *   3. per-addon checks (skipped for revoked/archived addons):
 *      a. source release  — repo is public + has a release with a zip asset
 *      b. zip inspection  — module.json at root, forbidden paths, identity
 *      c. migration lint  — PHP AST allow-list
 *
 * `revoked`/`archived` addons skip the upstream network checks.
 *
 * Usage:
 *   bun scripts/validate.ts [file ...]               validate the given YAMLs
 *   BASE_SHA=.. HEAD_SHA=.. bun scripts/validate.ts  validate the PR diff
 *   bun scripts/validate.ts                          validate every publisher file
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

import { readYaml, type PublisherYaml } from './lib/yaml.js';
import { buildPublisherValidator } from './lib/schema.js';
import { getSource, SUPPORTED_SOURCE_TYPES } from './lib/sources/index.js';
import { findForbiddenEntries, findRootEntry, readEntryByName } from './lib/zip.js';
import { checkModuleManifest } from './lib/module-manifest.js';
import { lintMigration } from './lib/migration-lint.js';

export interface CheckIssue {
	rule: string;
	message: string;
}

export interface AddonCheckOutcome {
	name: string | null;
	registryName: string | null;
	skipped: boolean;
	skipReason?: string;
	issues: CheckIssue[];
}

export interface PublisherCheckOutcome {
	yamlPath: string;
	publisher: string | null;
	fileIssues: CheckIssue[];
	addons: AddonCheckOutcome[];
}

// --- Structural checks -----------------------------------------------------

/** Verify the YAML lives at `packages/{publisher}.yml` (exactly 2 path segments). */
export function checkPath(yamlRelPath: string): CheckIssue[] {
	const issues: CheckIssue[] = [];
	const parts = yamlRelPath.split('/');
	if (parts[0] !== 'packages') {
		issues.push({ rule: 'path-prefix', message: `Expected file under packages/, got ${yamlRelPath}` });
		return issues;
	}
	if (parts.length !== 2) {
		issues.push({ rule: 'path-shape', message: `Expected packages/{publisher}.yml, got ${yamlRelPath}` });
		return issues;
	}
	if (!parts[1]!.endsWith('.yml')) {
		issues.push({
			rule: 'path-extension',
			message: `Publisher files must use .yml (not .yaml or other): ${yamlRelPath}`,
		});
	}
	return issues;
}

/** Run AJV schema validation (+ category enum) and surface issues. */
export function schemaValidate(data: unknown): CheckIssue[] {
	const validator = buildPublisherValidator();
	const result = validator.validate(data);
	return result.errors.map((e) => ({ rule: 'schema', message: `${e.path}: ${e.message}` }));
}

/** Detect duplicate addon names within a single publisher file. */
export function checkDuplicateAddonNames(addons: Array<{ name?: string | null }>): CheckIssue[] {
	const seen = new Set<string>();
	const issues: CheckIssue[] = [];
	for (const addon of addons) {
		const name = addon.name;
		if (!name) continue;
		if (seen.has(name)) {
			issues.push({ rule: 'duplicate-addon-name', message: `Duplicate addon name "${name}" in publisher file` });
		} else {
			seen.add(name);
		}
	}
	return issues;
}

// --- Per-publisher runner --------------------------------------------------

/**
 * Run all PR-time checks for a single publisher YAML. Network checks
 * (source repo, release, zip, migrations) are skipped for revoked or
 * archived addons.
 */
export async function runPublisherChecks(opts: { repoRoot: string; yamlRelPath: string; token?: string }): Promise<PublisherCheckOutcome> {
	const { repoRoot, yamlRelPath, token } = opts;
	const yamlAbsPath = path.join(repoRoot, yamlRelPath);
	const outcome: PublisherCheckOutcome = {
		yamlPath: yamlRelPath,
		publisher: null,
		fileIssues: [],
		addons: [],
	};

	// 1. Path shape
	outcome.fileIssues.push(...checkPath(yamlRelPath));
	if (outcome.fileIssues.length > 0) return outcome;

	// 2. Parse YAML
	let data: PublisherYaml;
	try {
		data = readYaml<PublisherYaml>(yamlAbsPath);
	} catch (err) {
		outcome.fileIssues.push({ rule: 'yaml-parse', message: `Failed to parse YAML: ${(err as Error).message}` });
		return outcome;
	}

	// 3. Schema validation (whole publisher object)
	const schemaIssues = schemaValidate(data);
	outcome.fileIssues.push(...schemaIssues);
	if (schemaIssues.length > 0 || !Array.isArray(data?.addons)) return outcome;

	// 4. Derive publisher from file stem
	const publisher = path.basename(yamlRelPath).replace(/\.ya?ml$/i, '');
	outcome.publisher = publisher;

	// 5. Duplicate addon-name detection
	outcome.fileIssues.push(...checkDuplicateAddonNames(data.addons));
	if (outcome.fileIssues.length > 0) return outcome;

	// 6. Per-addon checks
	for (const addon of data.addons) {
		const registryName = `${publisher}/${addon.name}`;
		const addonOutcome: AddonCheckOutcome = {
			name: addon.name ?? null,
			registryName,
			skipped: false,
			issues: [],
		};

		// Skip upstream checks for revoked or archived addons
		if (addon.revoked === true) {
			addonOutcome.skipped = true;
			addonOutcome.skipReason = 'revoked';
			outcome.addons.push(addonOutcome);
			continue;
		}
		if (addon.archived === true) {
			addonOutcome.skipped = true;
			addonOutcome.skipReason = 'archived';
			outcome.addons.push(addonOutcome);
			continue;
		}

		// Resolve release zip via the source implementation
		const source = getSource(addon.source.type);
		if (!source) {
			addonOutcome.issues.push({
				rule: 'source-type',
				message: `Unsupported source.type "${addon.source.type}". Supported: ${SUPPORTED_SOURCE_TYPES.join(', ')}`,
			});
			outcome.addons.push(addonOutcome);
			continue;
		}
		const resolved = await source.resolve(addon.source, { token });
		addonOutcome.issues.push(...resolved.issues);
		if (!resolved.inspection) {
			outcome.addons.push(addonOutcome);
			continue;
		}
		const inspection = resolved.inspection;

		// module.json at root
		const moduleEntry = findRootEntry(inspection.entries, 'module.json');
		if (!moduleEntry) {
			addonOutcome.issues.push({ rule: 'module-json-missing', message: `Zip must contain module.json at the root` });
			outcome.addons.push(addonOutcome);
			continue;
		}

		// Forbidden paths
		const forbidden = findForbiddenEntries(inspection.entries);
		if (forbidden.length > 0) {
			addonOutcome.issues.push({
				rule: 'forbidden-paths',
				message: `Zip contains forbidden paths: ${forbidden.slice(0, 10).join(', ')}${forbidden.length > 10 ? `, ...${forbidden.length - 10} more` : ''}`,
			});
		}

		// module.json manifest (identity + required fields + table namespace)
		let moduleParsed: unknown;
		try {
			const bytes = await readEntryByName(inspection.bytes, moduleEntry.name);
			moduleParsed = JSON.parse(bytes.toString('utf8'));
		} catch (err) {
			addonOutcome.issues.push({ rule: 'module-json-parse', message: `Failed to parse module.json: ${(err as Error).message}` });
			outcome.addons.push(addonOutcome);
			continue;
		}
		const manifest = checkModuleManifest(moduleParsed, registryName);
		addonOutcome.issues.push(...manifest.errors);

		// Migration lint
		const migrationEntries = inspection.entries.filter((e) => e.name.startsWith('Database/Migrations/') && e.name.endsWith('.php'));
		for (const entry of migrationEntries) {
			const phpBytes = await readEntryByName(inspection.bytes, entry.name).catch(() => null);
			if (!phpBytes) {
				addonOutcome.issues.push({ rule: 'migration-read', message: `Failed to read migration ${entry.name} from zip` });
				continue;
			}
			const lint = lintMigration({ source: phpBytes.toString('utf8'), path: entry.name, author: publisher });
			for (const err of lint.errors) {
				addonOutcome.issues.push({
					rule: `migration:${err.rule}`,
					message: `${entry.name}${err.line ? `:${err.line}` : ''} — ${err.message}`,
				});
			}
		}

		outcome.addons.push(addonOutcome);
	}

	return outcome;
}

// --- File discovery --------------------------------------------------------

/** Keep only publisher YAMLs (under packages/, .yml, exactly 2 path segments). */
export function filterPublisherYamlPaths(paths: string[]): string[] {
	return paths
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.filter((l) => l.startsWith('packages/') && l.endsWith('.yml'))
		.filter((l) => l.split('/').length === 2);
}

/** Publisher YAMLs changed in the PR diff (excludes deleted paths). */
function changedYamlFiles(repoRoot: string, baseSha: string, headSha: string): string[] {
	const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', `${baseSha}...${headSha}`], {
		cwd: repoRoot,
		encoding: 'utf8',
	});
	return filterPublisherYamlPaths(out.split('\n'));
}

/** Every publisher YAML under packages/ (used when no diff/args are given). */
function allPublisherYamls(repoRoot: string): string[] {
	const root = path.join(repoRoot, 'packages');
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith('.yml'))
			.map((d) => `packages/${d.name}`);
	} catch {
		return [];
	}
}

function resolveTargets(repoRoot: string): string[] {
	const args = process.argv.slice(2);
	if (args.length > 0) {
		return filterPublisherYamlPaths(args.map((a) => path.relative(repoRoot, path.resolve(repoRoot, a))));
	}
	const baseSha = process.env.BASE_SHA;
	const headSha = process.env.HEAD_SHA;
	if (baseSha && headSha) return changedYamlFiles(repoRoot, baseSha, headSha);
	return allPublisherYamls(repoRoot);
}

async function main(): Promise<void> {
	const repoRoot = process.env.REPO_ROOT ?? process.cwd();
	const token = process.env.GITHUB_TOKEN || undefined;

	const targets = resolveTargets(repoRoot);
	if (targets.length === 0) {
		console.log('No publisher YAML changes detected; nothing to validate.');
		return;
	}

	console.log(`Validating ${targets.length} publisher YAML file(s):`);
	for (const f of targets) console.log(`  - ${f}`);

	let failed = false;
	for (const yamlRelPath of targets) {
		console.log(`\n--- ${yamlRelPath}`);
		const outcome = await runPublisherChecks({ repoRoot, yamlRelPath, token });

		if (outcome.fileIssues.length > 0) {
			failed = true;
			console.log(`  ${outcome.fileIssues.length} file-level issue(s):`);
			for (const issue of outcome.fileIssues) console.log(`    - [${issue.rule}] ${issue.message}`);
			continue;
		}

		for (const addon of outcome.addons) {
			const label = addon.registryName ?? addon.name ?? '(unknown)';
			if (addon.issues.length > 0) {
				failed = true;
				console.log(`  ${label}: ${addon.issues.length} issue(s):`);
				for (const issue of addon.issues) console.log(`    - [${issue.rule}] ${issue.message}`);
			} else if (addon.skipped) {
				console.log(`  ${label}: passed (${addon.skipReason}; upstream checks skipped)`);
			} else {
				console.log(`  ${label}: passed`);
			}
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
