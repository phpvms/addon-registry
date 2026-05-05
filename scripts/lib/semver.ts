import semver from 'semver';

export interface ParsedTag {
	/** The raw tag as published on GitHub (e.g. "v1.2.3" or "1.2.3"). */
	tag: string;
	/** SemVer triple with no leading `v` (e.g. "1.2.3"). */
	version: string;
	/** True if the parsed semver has any pre-release component (alpha, beta, rc, etc.). */
	preRelease: boolean;
}

/**
 * Strip a single leading `v` (or `V`) from a tag and return the remainder.
 * The literal tag is preserved separately so we can record both forms.
 */
export function stripLeadingV(tag: string): string {
	return tag.replace(/^v/i, '');
}

/**
 * Parse a GitHub tag into a structured value. Returns `null` if the
 * tag is not a recognisable version string.
 *
 * Accepts:
 *  - Strict SemVer:  `1.2.3`, `v1.2.3`, `1.2.3-beta.1`
 *  - Short numeric:  `v1.0` -> `1.0.0`, `v2` -> `2.0.0` (loose-mode coerce)
 *
 * Rejects everything that does not start with a digit-only segment
 * (or `v`-prefixed digit). This keeps `release-2025-01-01` and similar
 * date-style tags out of discovery.
 */
export function parseTag(tag: string): ParsedTag | null {
	const versionRaw = stripLeadingV(tag);
	// Must look like digits-and-dots-and-dashes from the start. This is
	// stricter than semver.coerce, which would happily extract `2025.0.0`
	// from `release-2025-01-01`.
	if (!/^\d/.test(versionRaw)) return null;
	const parsed = semver.parse(versionRaw, { loose: true }) ?? semver.coerce(versionRaw);
	if (!parsed) return null;
	const prerelease = (parsed as { prerelease?: ReadonlyArray<string | number> }).prerelease ?? [];
	return {
		tag,
		version: parsed.version,
		preRelease: prerelease.length > 0,
	};
}

/**
 * True if `version` is a stable SemVer with no pre-release component.
 * Strict mode here: `release.version` in YAML is a registry artifact we
 * own, so we do not coerce — `1.0` is rejected as malformed; authors
 * must supply `1.0.0`. (Discovery stores the bot-resolved version, which
 * has already been coerced via parseTag's loose path.)
 */
export function isStable(version: string): boolean {
	const parsed = semver.parse(version, { loose: false });
	return parsed !== null && parsed.prerelease.length === 0;
}

/**
 * Compare two SemVer strings. Returns -1 / 0 / 1.
 * Inputs may include or omit leading `v`; both are normalized.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	return semver.compare(stripLeadingV(a), stripLeadingV(b)) as -1 | 0 | 1;
}

/**
 * Pick the highest stable SemVer from a list of GitHub tags. Returns
 * the parsed result or null if no stable tag is present.
 */
export function selectLatestStable(tags: string[]): ParsedTag | null {
	const candidates = tags.map(parseTag).filter((t): t is ParsedTag => t !== null && !t.preRelease);
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => compareVersions(a.version, b.version));
	return candidates[candidates.length - 1] ?? null;
}
