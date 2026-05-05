import { describe, it, expect } from 'vitest';
import { parseTag, isStable, compareVersions, selectLatestStable, stripLeadingV } from '../lib/semver.js';

describe('semver helpers', () => {
	it('strips a leading v', () => {
		expect(stripLeadingV('v1.2.3')).toBe('1.2.3');
		expect(stripLeadingV('1.2.3')).toBe('1.2.3');
		expect(stripLeadingV('V1.2.3')).toBe('1.2.3');
	});

	it('parseTag normalises version and preserves tag', () => {
		const r = parseTag('v1.2.3');
		expect(r).not.toBeNull();
		expect(r!.version).toBe('1.2.3');
		expect(r!.tag).toBe('v1.2.3');
		expect(r!.preRelease).toBe(false);
	});

	it('parseTag detects pre-release', () => {
		const r = parseTag('v1.2.3-beta.1');
		expect(r!.preRelease).toBe(true);
		expect(r!.version).toBe('1.2.3-beta.1');
	});

	it('parseTag returns null for non-semver', () => {
		expect(parseTag('release-2025-01-01')).toBeNull();
	});

	it('parseTag coerces 2-segment tags via loose mode', () => {
		const r = parseTag('v1.0');
		expect(r).not.toBeNull();
		expect(r!.version).toBe('1.0.0');
	});

	it('parseTag coerces single-segment numeric tags', () => {
		const r = parseTag('v2');
		expect(r).not.toBeNull();
		expect(r!.version).toBe('2.0.0');
	});

	it('isStable rejects pre-releases', () => {
		expect(isStable('1.2.3')).toBe(true);
		expect(isStable('1.2.3-beta.1')).toBe(false);
	});

	it('compareVersions works with or without v prefix', () => {
		expect(compareVersions('v1.2.3', '1.3.0')).toBe(-1);
		expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
		expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
	});

	it('selectLatestStable picks highest stable, skipping pre-releases', () => {
		const r = selectLatestStable(['v1.0.0', '1.3.0-rc.1', 'v1.2.3', 'v1.3.0', 'release-text']);
		expect(r).not.toBeNull();
		expect(r!.version).toBe('1.3.0');
		expect(r!.tag).toBe('v1.3.0');
	});

	it('selectLatestStable returns null when only pre-releases exist', () => {
		expect(selectLatestStable(['v1.3.0-rc.1', 'v1.3.0-beta.2'])).toBeNull();
	});
});
