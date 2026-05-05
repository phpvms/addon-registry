import { describe, it, expect } from 'vitest';
import { checkModuleIdentity } from '../lib/module-identity.js';

const valid = {
	name: 'acme/reports',
	alias: 'acme/reports',
	description: 'Reports addon',
	keywords: [],
	active: true,
	order: 0,
	providers: ['Modules\\AcmeReports\\Providers\\AcmeReportsServiceProvider'],
	aliases: {},
	files: [],
	requires: [],
};

describe('module identity', () => {
	it('accepts matching alias', () => {
		const r = checkModuleIdentity(valid, 'acme/reports');
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
	});

	it('accepts a differing module.json.name (display-style value)', () => {
		const r = checkModuleIdentity({ ...valid, name: 'AcmeReports' }, 'acme/reports');
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
	});

	it('rejects mismatched alias', () => {
		const r = checkModuleIdentity({ ...valid, alias: 'acme-reports' }, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors.find((e) => e.includes('module.json.alias'))).toBeTruthy();
	});

	it('rejects missing alias', () => {
		const { alias: _alias, ...withoutAlias } = valid;
		void _alias;
		const r = checkModuleIdentity(withoutAlias, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors.find((e) => e.includes('module.json.alias'))).toBeTruthy();
	});

	it('rejects missing required fields', () => {
		const partial = { name: 'acme/reports', alias: 'acme/reports' };
		const r = checkModuleIdentity(partial, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors).toContain('module.json failed schema validation');
		expect(r.moduleSchemaErrors.length).toBeGreaterThan(0);
	});

	it('rejects empty providers array', () => {
		const r = checkModuleIdentity({ ...valid, providers: [] }, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.moduleSchemaErrors.find((e) => e.path === '/providers')).toBeTruthy();
	});

	it('rejects non-object input', () => {
		const r = checkModuleIdentity(null, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors).toContain('module.json must be an object');
	});
});
