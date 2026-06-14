/**
 * Source registry — maps a package YAML's `source.type` to the
 * implementation that knows how to retrieve its release zip.
 */

import { githubReleaseSource } from './github.js';
import type { AddonSource } from './types.js';

const REGISTRY = new Map<string, AddonSource>([[githubReleaseSource.type, githubReleaseSource]]);

/** Look up a source implementation by `source.type`. Undefined if unknown. */
export function getSource(type: string): AddonSource | undefined {
	return REGISTRY.get(type);
}

/** The `source.type` values the validator can currently resolve. */
export const SUPPORTED_SOURCE_TYPES: string[] = [...REGISTRY.keys()];

export type { AddonSource, ResolvedSource, SourceIssue } from './types.js';
