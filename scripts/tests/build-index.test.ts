import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildIndex } from '../lib/build-index.js';

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), 'addon-index-'));
	mkdirSync(path.join(root, 'packages'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writePackage(author: string, name: string, body: object): void {
	const dir = path.join(root, 'packages', author);
	mkdirSync(dir, { recursive: true });
	const yaml = Object.entries(body)
		.map(([k, v]) => yamlField(k, v))
		.join('\n');
	writeFileSync(path.join(dir, `${name}.yml`), yaml + '\n', 'utf8');
}

function writeMeta(author: string, body: object): void {
	const dir = path.join(root, 'packages', author);
	mkdirSync(dir, { recursive: true });
	const yaml = Object.entries(body)
		.map(([k, v]) => yamlField(k, v))
		.join('\n');
	writeFileSync(path.join(dir, 'meta.yml'), yaml + '\n', 'utf8');
}

function yamlField(key: string, value: unknown): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return `${key}: []`;
		return `${key}:\n${value.map((v) => `  - ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`).join('\n')}`;
	}
	if (value && typeof value === 'object') {
		const inner = Object.entries(value as Record<string, unknown>)
			.map(([k, v]) => `  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
			.join('\n');
		return `${key}:\n${inner}`;
	}
	return `${key}: ${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`;
}

const minimalPackage = {
	name: 'acme/reports',
	description: 'Reports',
	category: 'reporting',
	license: 'MIT',
	keywords: ['reports'],
	source: { type: 'github-release', repository: 'acme/reports-addon' },
	requirements: { php: '>=8.3', phpvms: '>=7.0.0' },
};

describe('buildIndex — packages.json shape', () => {
	it('creates one entry per YAML keyed by name', () => {
		writePackage('acme', 'reports', minimalPackage);
		const r = buildIndex(root);
		expect(Object.keys(r.packages)).toEqual(['acme/reports']);
		const e = r.packages['acme/reports']!;
		expect(e.name).toBe('acme/reports');
		expect(e.description).toBe('Reports');
		expect(e.category).toBe('reporting');
	});

	it('includes namespace metadata when meta.yml present', () => {
		writeMeta('acme', { name: 'Acme Corp', url: 'https://acme.example.com', maintainers: ['acme-dev'] });
		writePackage('acme', 'reports', minimalPackage);
		const r = buildIndex(root);
		const e = r.packages['acme/reports']!;
		expect(e.author).toEqual({
			namespace: 'acme',
			name: 'Acme Corp',
			url: 'https://acme.example.com',
			maintainers: ['acme-dev'],
		});
	});

	it('produces minimal author block when meta.yml missing', () => {
		writePackage('acme', 'reports', minimalPackage);
		const r = buildIndex(root);
		expect(r.packages['acme/reports']!.author).toEqual({ namespace: 'acme' });
	});

	it('derives repository_url from source.repository', () => {
		writePackage('acme', 'reports', minimalPackage);
		const r = buildIndex(root);
		expect(r.packages['acme/reports']!.repository_url).toBe('https://github.com/acme/reports-addon');
	});

	it('marks phpvms namespace official:true', () => {
		writePackage('phpvms', 'core-tools', { ...minimalPackage, name: 'phpvms/core-tools' });
		writePackage('acme', 'reports', minimalPackage);
		const r = buildIndex(root);
		expect(r.packages['phpvms/core-tools']!.official).toBe(true);
		expect(r.packages['acme/reports']!.official).toBe(false);
	});

	it('propagates revoked and revoked_reason verbatim', () => {
		writePackage('acme', 'reports', { ...minimalPackage, revoked: true, revoked_reason: 'Arbitrary file write in v1.x' });
		const r = buildIndex(root);
		const e = r.packages['acme/reports']!;
		expect(e.revoked).toBe(true);
		expect(e.revoked_reason).toBe('Arbitrary file write in v1.x');
	});

	it('propagates archived and archived_reason verbatim', () => {
		writePackage('acme', 'reports', {
			...minimalPackage,
			archived: true,
			archived_reason: 'No longer maintained.',
		});
		const r = buildIndex(root);
		const e = r.packages['acme/reports']!;
		expect(e.archived).toBe(true);
		expect(e.archived_reason).toBe('No longer maintained.');
	});

	it('omits release field when YAML has no release block', () => {
		writePackage('acme', 'reports', minimalPackage);
		const r = buildIndex(root);
		expect(r.packages['acme/reports']!.release).toBeUndefined();
	});
});

describe('buildIndex — keywords.json', () => {
	it('counts shared keywords across multiple packages', () => {
		writePackage('acme', 'a', { ...minimalPackage, name: 'acme/a', keywords: ['reports'] });
		writePackage('acme', 'b', { ...minimalPackage, name: 'acme/b', keywords: ['reports', 'analytics'] });
		writePackage('beta', 'c', { ...minimalPackage, name: 'beta/c', keywords: ['reports'] });
		const r = buildIndex(root);
		expect(r.keywords['reports']).toBe(3);
		expect(r.keywords['analytics']).toBe(1);
	});

	it('excludes revoked package keywords', () => {
		writePackage('acme', 'a', { ...minimalPackage, name: 'acme/a', keywords: ['reports'] });
		writePackage('acme', 'b', { ...minimalPackage, name: 'acme/b', keywords: ['reports'], revoked: true });
		const r = buildIndex(root);
		expect(r.keywords['reports']).toBe(1);
	});

	it('excludes archived package keywords', () => {
		writePackage('acme', 'a', { ...minimalPackage, name: 'acme/a', keywords: ['reports'] });
		writePackage('acme', 'b', { ...minimalPackage, name: 'acme/b', keywords: ['reports'], archived: true });
		const r = buildIndex(root);
		expect(r.keywords['reports']).toBe(1);
	});

	it('produces empty object when no eligible packages', () => {
		writePackage('acme', 'a', { ...minimalPackage, name: 'acme/a', revoked: true });
		const r = buildIndex(root);
		expect(r.keywords).toEqual({});
		expect(r.keywordsJson).toBe('{}\n');
	});
});

describe('buildIndex — determinism', () => {
	it('produces byte-identical output across runs on identical state', () => {
		writePackage('acme', 'reports', minimalPackage);
		writePackage('beta', 'forms', { ...minimalPackage, name: 'beta/forms', keywords: ['forms'] });
		writeMeta('acme', { name: 'Acme Corp', url: 'https://acme.example.com', maintainers: ['acme-dev'] });
		const a = buildIndex(root);
		const b = buildIndex(root);
		expect(a.packagesJson).toBe(b.packagesJson);
		expect(a.keywordsJson).toBe(b.keywordsJson);
	});

	it('sorts top-level package names alphabetically', () => {
		writePackage('zeta', 'z', { ...minimalPackage, name: 'zeta/z' });
		writePackage('acme', 'a', { ...minimalPackage, name: 'acme/a' });
		writePackage('beta', 'b', { ...minimalPackage, name: 'beta/b' });
		const r = buildIndex(root);
		const json = r.packagesJson;
		const aIdx = json.indexOf('"acme/a"');
		const bIdx = json.indexOf('"beta/b"');
		const zIdx = json.indexOf('"zeta/z"');
		expect(aIdx).toBeGreaterThan(0);
		expect(aIdx).toBeLessThan(bIdx);
		expect(bIdx).toBeLessThan(zIdx);
	});

	it('sorts entry-level field keys alphabetically', () => {
		writePackage('acme', 'reports', minimalPackage);
		const r = buildIndex(root);
		const json = r.packagesJson;
		// "author" should appear before "category" alphabetically
		const authorIdx = json.indexOf('"author"');
		const categoryIdx = json.indexOf('"category"');
		const descIdx = json.indexOf('"description"');
		expect(authorIdx).toBeGreaterThan(0);
		expect(authorIdx).toBeLessThan(categoryIdx);
		expect(categoryIdx).toBeLessThan(descIdx);
	});

	it('preserves YAML keyword array order', () => {
		writePackage('acme', 'reports', { ...minimalPackage, keywords: ['banana', 'apple', 'cherry'] });
		const r = buildIndex(root);
		expect(r.packages['acme/reports']!.keywords).toEqual(['banana', 'apple', 'cherry']);
	});
});
