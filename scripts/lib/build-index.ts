/**
 * Build the registry index — `dist/raw/packages.json` and
 * `dist/raw/keywords.json` — from on-disk YAMLs.
 *
 * Determinism rules:
 *   - Top-level keys (package names, keyword strings) sorted alphabetically.
 *   - Field keys within each entry sorted alphabetically (so an entry with
 *     keys [name, description, source, ...] always serialises in stable
 *     order regardless of YAML write order).
 *   - Array values (e.g. keywords[]) preserve YAML source order.
 *   - JSON encoded with 2-space indent and a trailing newline.
 *
 * Author block resolution:
 *   - Read `packages/{author}/meta.yml` once per directory.
 *   - Inject `author` object onto every entry in that namespace.
 *   - When meta.yml is absent, the entry's `author` is `{ namespace: "..." }`.
 *
 * Computed fields per entry:
 *   - author       — derived from meta.yml (always present, namespace at minimum)
 *   - repository_url — `https://github.com/{source.repository}`
 *   - official     — true iff name starts with `phpvms/`
 *
 * Revoked / archived entries: their fields propagate verbatim. Their
 * keywords are excluded from the keywords aggregate.
 */

import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { readYaml, type MetaYaml, type PackageYaml } from './yaml.js';

export interface AuthorBlock {
	namespace: string;
	name?: string;
	url?: string;
	maintainers?: string[];
}

export interface IndexEntry {
	[key: string]: unknown;
	name: string;
	description: string;
	category: string;
	license: string;
	keywords: string[];
	source: PackageYaml['source'];
	requirements: PackageYaml['requirements'];
	author: AuthorBlock;
	repository_url: string;
	official: boolean;
	release?: PackageYaml['release'];
	revoked?: boolean;
	revoked_reason?: string;
	archived?: boolean;
	archived_reason?: string;
}

export interface BuildIndexResult {
	packagesJson: string;
	keywordsJson: string;
	packages: Record<string, IndexEntry>;
	keywords: Record<string, number>;
}

/**
 * Read all packages and namespace metadata, build the two JSON
 * artifacts. Returns serialised strings (byte-identical for identical
 * inputs) plus the structured data for tests.
 */
export function buildIndex(repoRoot: string): BuildIndexResult {
	const packagesDir = path.join(repoRoot, 'packages');
	const packages: Record<string, IndexEntry> = {};
	const keywordCounts: Record<string, number> = {};

	for (const author of readdirSync(packagesDir).sort()) {
		const authorDir = path.join(packagesDir, author);
		if (!statSync(authorDir).isDirectory()) continue;

		let meta: MetaYaml | null = null;
		const metaPath = path.join(authorDir, 'meta.yml');
		if (fileExists(metaPath)) {
			try {
				meta = readYaml<MetaYaml>(metaPath);
			} catch {
				meta = null;
			}
		}

		for (const file of readdirSync(authorDir).sort()) {
			if (file === 'meta.yml') continue;
			if (!file.endsWith('.yml')) continue;
			const yamlPath = path.join(authorDir, file);
			let data: PackageYaml;
			try {
				data = readYaml<PackageYaml>(yamlPath);
			} catch (err) {
				throw new Error(`Failed to read ${yamlPath}: ${(err as Error).message}`);
			}
			const entry = buildEntry(data, author, meta);
			packages[data.name] = entry;
			if (data.revoked !== true && data.archived !== true) {
				for (const kw of data.keywords ?? []) {
					keywordCounts[kw] = (keywordCounts[kw] ?? 0) + 1;
				}
			}
		}
	}

	const sortedPackages = sortObjectKeys(packages, sortEntryKeys);
	const sortedKeywords = sortObjectKeys(keywordCounts);

	return {
		packagesJson: serialiseJson(sortedPackages),
		keywordsJson: serialiseJson(sortedKeywords),
		packages: sortedPackages as Record<string, IndexEntry>,
		keywords: sortedKeywords as Record<string, number>,
	};
}

function buildEntry(data: PackageYaml, namespace: string, meta: MetaYaml | null): IndexEntry {
	const author: AuthorBlock = { namespace };
	if (meta) {
		if (meta.name) author.name = meta.name;
		if (meta.url) author.url = meta.url;
		if (meta.maintainers && meta.maintainers.length > 0) author.maintainers = [...meta.maintainers];
	}

	const entry: IndexEntry = {
		name: data.name,
		description: data.description,
		category: data.category,
		license: data.license,
		keywords: [...(data.keywords ?? [])],
		source: data.source,
		requirements: data.requirements,
		author,
		repository_url: `https://github.com/${data.source.repository}`,
		official: namespace === 'phpvms',
	};
	if (data.release) entry.release = data.release;
	if (data.revoked === true) entry.revoked = true;
	if (data.revoked_reason !== undefined) entry.revoked_reason = data.revoked_reason;
	if (data.archived === true) entry.archived = true;
	if (data.archived_reason !== undefined) entry.archived_reason = data.archived_reason;
	return entry;
}

/**
 * Recursively sort object keys alphabetically. Optional second arg is a
 * per-value transform (used to also sort entry-level keys). Arrays are
 * left in source order.
 */
function sortObjectKeys<T>(obj: Record<string, T>, transform?: (v: T) => unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj).sort()) {
		const value = obj[key];
		out[key] = transform ? transform(value as T) : value;
	}
	return out;
}

/** Sort an entry's top-level keys; recursively sort nested objects too. */
function sortEntryKeys(entry: unknown): unknown {
	if (Array.isArray(entry)) return entry.map(sortEntryKeys);
	if (entry && typeof entry === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
			out[key] = sortEntryKeys((entry as Record<string, unknown>)[key]);
		}
		return out;
	}
	return entry;
}

function serialiseJson(value: unknown): string {
	return JSON.stringify(value, null, 2) + '\n';
}

function fileExists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}
