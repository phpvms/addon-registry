import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { buildZip } from './helpers/zip-builder.js';
import { listEntries, findRootEntry, readEntry, findForbiddenEntries, sha256 } from '../lib/zip.js';

const MODULE_JSON = JSON.stringify({
	name: 'AcmeReports',
	alias: 'acme-reports',
	registry_id: 'acme/reports',
	description: 'Reports',
	keywords: [],
	active: true,
	order: 0,
	providers: ['Modules\\AcmeReports\\Providers\\AcmeReportsServiceProvider'],
	aliases: {},
	files: [],
	requires: [],
});

describe('zip inspection', () => {
	it('parses a minimal valid zip with module.json at root', async () => {
		const buf = buildZip([{ path: 'module.json', body: MODULE_JSON }]);
		const entries = await listEntries(buf);
		expect(entries.length).toBe(1);
		expect(entries[0]?.name).toBe('module.json');
		expect(findRootEntry(entries, 'module.json')).toBeTruthy();
	});

	it('extracts a stored entry', async () => {
		const buf = buildZip([{ path: 'module.json', body: MODULE_JSON }]);
		const entries = await listEntries(buf);
		const entry = findRootEntry(entries, 'module.json');
		if (!entry) throw new Error('expected entry');
		const bytes = await readEntry(buf, entry);
		expect(bytes.toString('utf8')).toBe(MODULE_JSON);
	});

	it('detects module.json missing at root when only nested copy exists', async () => {
		const buf = buildZip([{ path: 'acme-reports/module.json', body: MODULE_JSON }]);
		const entries = await listEntries(buf);
		expect(findRootEntry(entries, 'module.json')).toBeNull();
	});

	it('flags forbidden paths', async () => {
		const buf = buildZip([
			{ path: 'module.json', body: MODULE_JSON },
			{ path: '.git/HEAD', body: 'ref' },
			{ path: 'tests/Foo.php', body: '<?php' },
			{ path: '.DS_Store', body: '' },
			{ path: 'Database/Migrations/M.php', body: '<?php' },
		]);
		const entries = await listEntries(buf);
		const offenders = findForbiddenEntries(entries);
		expect(offenders).toContain('.git/HEAD');
		expect(offenders).toContain('tests/Foo.php');
		expect(offenders).toContain('.DS_Store');
		expect(offenders).not.toContain('Database/Migrations/M.php');
		expect(offenders).not.toContain('module.json');
	});

	it('rejects malformed zip (no EOCD)', async () => {
		const garbage = Buffer.from('not a zip file at all');
		await expect(listEntries(garbage)).rejects.toThrow();
	});

	it('produces stable sha256', () => {
		const buf = buildZip([{ path: 'module.json', body: MODULE_JSON }]);
		const a = sha256(buf);
		const b = sha256(buf);
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]{64}$/);
	});
});
