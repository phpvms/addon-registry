import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface PackageSource {
	/** Discriminator selecting the source implementation (e.g. `github-release`). */
	type: string;
	/** GitHub `owner/repo` (github-release sources). */
	repository?: string;
	[key: string]: unknown;
}

export interface PackageRequirements {
	php: string;
	phpvms: string;
	extensions?: string[];
	[key: string]: unknown;
}

export interface AddonYaml {
	name: string;
	description: string;
	category: string;
	license: string;
	keywords: string[];
	source: PackageSource;
	requirements: PackageRequirements;
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

export interface PublisherYaml {
	meta: MetaYaml;
	addons: AddonYaml[];
}

/** @deprecated Use AddonYaml instead. */
export type PackageYaml = AddonYaml;

/** Parse YAML string into a plain JS value. Throws on syntax errors. */
export function parseYaml<T = unknown>(content: string): T {
	return parse(content) as T;
}

/** Read and parse a YAML file from disk. */
export function readYaml<T = unknown>(path: string): T {
	const content = readFileSync(path, 'utf8');
	return parseYaml<T>(content);
}
