import { describe, it, expect } from 'vitest';
import { checkPath, checkFilenameMatchesName, checkReservedName, schemaValidate } from '../lib/checks.js';

describe('checkPath', () => {
	it('accepts packages/{a}/{b}.yml', () => {
		expect(checkPath('packages/acme/reports.yml')).toEqual([]);
	});

	it('rejects orphan top-level YAML', () => {
		const issues = checkPath('packages/orphan.yml');
		expect(issues.find((i) => i.rule === 'path-shape')).toBeTruthy();
	});

	it('rejects .yaml extension', () => {
		const issues = checkPath('packages/acme/reports.yaml');
		expect(issues.find((i) => i.rule === 'path-extension')).toBeTruthy();
	});

	it('rejects deeply nested', () => {
		const issues = checkPath('packages/acme/sub/reports.yml');
		expect(issues.find((i) => i.rule === 'path-shape')).toBeTruthy();
	});

	it('rejects files outside packages/', () => {
		const issues = checkPath('schema/categories.yml');
		expect(issues.find((i) => i.rule === 'path-prefix')).toBeTruthy();
	});
});

describe('checkFilenameMatchesName', () => {
	it('passes when name matches path', () => {
		expect(checkFilenameMatchesName('packages/acme/reports.yml', 'acme/reports')).toEqual([]);
	});

	it('rejects mismatched name', () => {
		const issues = checkFilenameMatchesName('packages/acme/reports.yml', 'other/something');
		expect(issues.find((i) => i.rule === 'name-path-mismatch')).toBeTruthy();
	});
});

describe('checkReservedName', () => {
	it('rejects "meta" as the package segment', () => {
		const issues = checkReservedName('acme/meta');
		expect(issues.find((i) => i.rule === 'reserved-name')).toBeTruthy();
	});

	it('accepts non-reserved names', () => {
		expect(checkReservedName('acme/reports')).toEqual([]);
	});
});

describe('schemaValidate (package YAML)', () => {
	const valid = {
		name: 'acme/reports',
		description: 'Reports addon',
		category: 'reporting',
		license: 'MIT',
		keywords: ['reports'],
		source: { type: 'github-release', repository: 'acme/reports-addon' },
		requirements: { php: '>=8.3', phpvms: '>=7.0.0' },
	};

	it('accepts a complete valid YAML', () => {
		const { issues } = schemaValidate(valid);
		expect(issues).toEqual([]);
	});

	it('rejects unlisted category', () => {
		const { issues } = schemaValidate({ ...valid, category: 'foobar' });
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects malformed name (uppercase)', () => {
		const { issues } = schemaValidate({ ...valid, name: 'Acme/Reports' });
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects single-segment name', () => {
		const { issues } = schemaValidate({ ...valid, name: 'reports' });
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects underscore in name', () => {
		const { issues } = schemaValidate({ ...valid, name: 'acme/cool_reports' });
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects unsupported source.type', () => {
		const { issues } = schemaValidate({ ...valid, source: { type: 'gitlab-release', repository: 'a/b' } });
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects missing requirements.phpvms', () => {
		const r = { ...valid, requirements: { php: '>=8.3' } };
		const { issues } = schemaValidate(r);
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects partial release block (missing sha256)', () => {
		const r = {
			...valid,
			release: {
				version: '1.2.3',
				tag: 'v1.2.3',
				zip_url: 'https://example.com/x.zip',
				published_at: '2025-01-01T00:00:00Z',
			},
		};
		const { issues } = schemaValidate(r);
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects pre-release version in release.version', () => {
		const r = {
			...valid,
			release: {
				version: '1.2.3-beta.1',
				tag: 'v1.2.3-beta.1',
				zip_url: 'https://example.com/x.zip',
				sha256: 'a'.repeat(64),
				published_at: '2025-01-01T00:00:00Z',
			},
		};
		const { issues } = schemaValidate(r);
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('rejects revoked_reason without revoked: true', () => {
		const r = { ...valid, revoked_reason: 'unsafe' };
		const { issues } = schemaValidate(r);
		expect(issues.find((i) => i.rule === 'schema')).toBeTruthy();
	});

	it('accepts revoked: true with revoked_reason', () => {
		const r = { ...valid, revoked: true, revoked_reason: 'unsafe' };
		const { issues } = schemaValidate(r);
		expect(issues).toEqual([]);
	});
});
