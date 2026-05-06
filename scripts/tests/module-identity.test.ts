import { describe, it, expect } from 'vitest';
import { checkModuleIdentity } from '../lib/module-identity.js';

// Fixture mirrors a real Laravel-Modules module.json. Only `registry_id`
// is registry-relevant; the rest is included to confirm we ignore it.
const valid = {
	name: 'AcmeReports',
	alias: 'acme-reports',
	registry_id: 'acme/reports',
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
	it('accepts matching registry_id', () => {
		const r = checkModuleIdentity(valid, 'acme/reports');
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
	});

	it('ignores module.json.name and module.json.alias entirely', () => {
		const r = checkModuleIdentity(
			{ ...valid, name: 'whatever-the-author-wants', alias: 'unrelated-alias' },
			'acme/reports',
		);
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
	});

	it('rejects mismatched registry_id', () => {
		const r = checkModuleIdentity({ ...valid, registry_id: 'acme/other' }, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors.find((e) => e.includes('module.json.registry_id'))).toBeTruthy();
	});

	it('rejects missing registry_id', () => {
		const { registry_id: _id, ...withoutId } = valid;
		void _id;
		const r = checkModuleIdentity(withoutId, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors.find((e) => e.includes('module.json.registry_id'))).toBeTruthy();
	});

	it('rejects non-string registry_id', () => {
		const r = checkModuleIdentity({ ...valid, registry_id: 42 }, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors.find((e) => e.includes('module.json.registry_id'))).toBeTruthy();
	});

	it('does not enforce other module.json fields (no schema check)', () => {
		// Strip every field except registry_id. Registry should still
		// pass, because schema validation is no longer the registry's
		// responsibility.
		const minimal = { registry_id: 'acme/reports' };
		const r = checkModuleIdentity(minimal, 'acme/reports');
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
	});

	it('rejects non-object input', () => {
		const r = checkModuleIdentity(null, 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors).toContain('module.json must be an object');
	});

	it('rejects array input', () => {
		const r = checkModuleIdentity(['not', 'an', 'object'], 'acme/reports');
		expect(r.valid).toBe(false);
		expect(r.errors.find((e) => e.includes('module.json.registry_id'))).toBeTruthy();
	});
});
