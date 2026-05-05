import { readFileSync } from 'node:fs';
import { parse, parseDocument, stringify, type Document } from 'yaml';

export interface PackageRelease {
	version: string;
	tag: string;
	zip_url: string;
	sha256: string;
	published_at: string;
}

export interface PackageSource {
	type: 'github-release';
	repository: string;
}

export interface PackageRequirements {
	php: string;
	phpvms: string;
	extensions?: string[];
	[key: string]: unknown;
}

export interface PackageYaml {
	name: string;
	description: string;
	category: string;
	license: string;
	keywords: string[];
	source: PackageSource;
	requirements: PackageRequirements;
	release?: PackageRelease;
	revoked?: boolean;
	revoked_reason?: string;
	archived?: boolean;
	archived_reason?: string;
}

export interface MetaYaml {
	name: string;
	url: string;
	maintainers: string[];
}

/** Parse YAML string into a plain JS value. Throws on syntax errors. */
export function parseYaml<T = unknown>(content: string): T {
	return parse(content) as T;
}

/** Read and parse a YAML file from disk. */
export function readYaml<T = unknown>(path: string): T {
	const content = readFileSync(path, 'utf8');
	return parseYaml<T>(content);
}

/**
 * Read a YAML file as a structured Document so callers can mutate it
 * while preserving comments, key order, and most formatting.
 */
export function readYamlDocument(path: string): Document.Parsed {
	const content = readFileSync(path, 'utf8');
	return parseDocument(content);
}

export { parseDocument, stringify };
