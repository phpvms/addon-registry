import { readFileSync, writeFileSync } from 'node:fs';
import { Document, parseDocument, Scalar, YAMLMap } from 'yaml';
import type { ResolvedRelease } from './resolve-release.js';

/**
 * Apply a resolved `release:` block to a YAML file in place, preserving
 * comments and key order outside the release block. If a `release:` key
 * already exists it is replaced; otherwise it is appended at the end of
 * the document's top-level mapping.
 *
 * The function returns the new file contents as a string. Pass `write:
 * true` to write it back to disk in one call.
 */
export function applyReleaseBlock(opts: {
	yamlPath: string;
	release: ResolvedRelease;
	write?: boolean;
}): string {
	const original = readFileSync(opts.yamlPath, 'utf8');
	const doc = parseDocument(original);

	if (!doc.contents || !(doc.contents instanceof YAMLMap)) {
		throw new Error(`Expected the YAML root to be a mapping; got ${doc.contents?.toString() ?? 'empty document'}`);
	}

	doc.set('release', buildReleaseMap(opts.release));

	const next = doc.toString();
	if (opts.write) {
		writeFileSync(opts.yamlPath, next, 'utf8');
	}
	return next;
}

/**
 * Render just the `release:` block as YAML — used in PR comments
 * ("here's what the bot would append on merge") and for any caller
 * that wants the standalone fragment without touching disk.
 *
 * Single source of truth: builds the same YAMLMap as `applyReleaseBlock`
 * and serialises it with the canonical `yaml` emitter, so both paths
 * are byte-identical for identical input.
 */
export function renderReleaseBlock(release: ResolvedRelease): string {
	const doc = new Document();
	const root = new YAMLMap();
	root.set('release', buildReleaseMap(release));
	doc.contents = root;
	return doc.toString();
}

/** Build the YAMLMap node we inject under `release:`. */
function buildReleaseMap(release: ResolvedRelease): YAMLMap {
	const map = new YAMLMap();
	map.set('version', quotedScalar(release.version));
	map.set('tag', quotedScalar(release.tag));
	map.set('zip_url', quotedScalar(release.zip_url));
	map.set('sha256', quotedScalar(release.sha256));
	map.set('published_at', quotedScalar(release.published_at));
	return map;
}

/** Force double-quoted scalar style so re-runs are byte-stable. */
function quotedScalar(value: string): Scalar {
	const s = new Scalar(value);
	s.type = Scalar.QUOTE_DOUBLE;
	return s;
}
