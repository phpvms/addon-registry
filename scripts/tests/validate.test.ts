import { describe, expect, test } from 'bun:test';
import { checkFilenameMatchesName, checkPath, checkReservedName, schemaValidate } from '../validate.ts';

describe('structural checks', () => {
	test('checkPath accepts packages/{a}/{b}.yml', () => {
		expect(checkPath('packages/acme/reports.yml')).toEqual([]);
	});

	test('checkPath rejects orphan, nested, and .yaml paths', () => {
		expect(checkPath('packages/orphan.yml').some((i) => i.rule === 'path-shape')).toBe(true);
		expect(checkPath('packages/acme/sub/reports.yml').some((i) => i.rule === 'path-shape')).toBe(true);
		expect(checkPath('packages/acme/reports.yaml').some((i) => i.rule === 'path-extension')).toBe(true);
		expect(checkPath('schema/categories.yml').some((i) => i.rule === 'path-prefix')).toBe(true);
	});

	test('checkFilenameMatchesName binds name to path', () => {
		expect(checkFilenameMatchesName('packages/acme/reports.yml', 'acme/reports')).toEqual([]);
		expect(checkFilenameMatchesName('packages/acme/reports.yml', 'other/thing').some((i) => i.rule === 'name-path-mismatch')).toBe(true);
	});

	test('checkReservedName rejects the meta segment', () => {
		expect(checkReservedName('acme/meta').some((i) => i.rule === 'reserved-name')).toBe(true);
		expect(checkReservedName('acme/reports')).toEqual([]);
	});
});

describe('schema validation', () => {
	const valid = {
		name: 'acme/reports',
		description: 'Reports addon',
		category: 'reporting',
		license: 'MIT',
		keywords: ['reports'],
		source: { type: 'github-release', repository: 'acme/reports-addon' },
		requirements: { php: '>=8.3', phpvms: '>=7.0.0' },
	};

	test('accepts a complete valid YAML', () => {
		expect(schemaValidate(valid)).toEqual([]);
	});

	test('rejects unlisted category', () => {
		expect(schemaValidate({ ...valid, category: 'foobar' }).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects malformed name and missing requirements', () => {
		expect(schemaValidate({ ...valid, name: 'Acme/Reports' }).some((i) => i.rule === 'schema')).toBe(true);
		expect(schemaValidate({ ...valid, name: 'reports' }).some((i) => i.rule === 'schema')).toBe(true);
		expect(schemaValidate({ ...valid, requirements: { php: '>=8.3' } }).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects unknown extra fields (release block removed)', () => {
		expect(schemaValidate({ ...valid, release: { version: '1.0.0' } }).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('accepts revoked: true with revoked_reason', () => {
		expect(schemaValidate({ ...valid, revoked: true, revoked_reason: 'unsafe' })).toEqual([]);
	});
});
