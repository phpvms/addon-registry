import { describe, expect, test } from 'bun:test';
import { checkPath, schemaValidate, filterPublisherYamlPaths, checkDuplicateAddonNames, checkPublisherMatchesStem } from '../validate.ts';
import { checkModuleManifest } from '../lib/module-manifest.ts';
import { getSource, SUPPORTED_SOURCE_TYPES } from '../lib/sources/index.ts';
import { parseRepository } from '../lib/sources/github.ts';

const validAddon = {
	name: 'reports',
	description: 'Reports addon',
	category: 'reporting',
	license: 'MIT',
	keywords: ['reports'],
	source: { type: 'github-release', repository: 'acme/reports-addon' },
	requirements: { php: '>=8.3', phpvms: '>=7.0.0' },
};

const validPublisher = {
	meta: { publisher: 'acme', name: 'Acme', url: 'https://acme.example.com', maintainers: ['acme-dev'] },
	addons: [{ ...validAddon }],
};

describe('structural checks', () => {
	test('checkPath accepts packages/{publisher}.yml', () => {
		expect(checkPath('packages/phpvms.yml')).toEqual([]);
	});

	test('checkPath rejects multi-segment, deep, and .yaml paths', () => {
		expect(checkPath('packages/acme/reports.yml').some((i) => i.rule === 'path-shape')).toBe(true);
		expect(checkPath('packages/acme/sub/reports.yml').some((i) => i.rule === 'path-shape')).toBe(true);
		expect(checkPath('packages/phpvms.yaml').some((i) => i.rule === 'path-extension')).toBe(true);
		expect(checkPath('schema/categories.yml').some((i) => i.rule === 'path-prefix')).toBe(true);
	});
});

describe('schema validation', () => {
	test('accepts a complete valid publisher YAML', () => {
		expect(schemaValidate(validPublisher)).toEqual([]);
	});

	test('rejects unlisted category', () => {
		const data = { ...validPublisher, addons: [{ ...validAddon, category: 'foobar' }] };
		expect(schemaValidate(data).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects malformed addon name and missing requirements', () => {
		expect(schemaValidate({ ...validPublisher, addons: [{ ...validAddon, name: 'Reports' }] }).some((i) => i.rule === 'schema')).toBe(true);
		expect(schemaValidate({ ...validPublisher, addons: [{ ...validAddon, name: 'a' }] }).some((i) => i.rule === 'schema')).toBe(true);
		expect(
			schemaValidate({ ...validPublisher, addons: [{ ...validAddon, requirements: { php: '>=8.3' } }] }).some((i) => i.rule === 'schema'),
		).toBe(true);
	});

	test('rejects unknown extra fields on addon (release block removed)', () => {
		expect(
			schemaValidate({ ...validPublisher, addons: [{ ...validAddon, release: { version: '1.0.0' } }] }).some((i) => i.rule === 'schema'),
		).toBe(true);
	});

	test('accepts revoked: true with revoked_reason on addon', () => {
		expect(schemaValidate({ ...validPublisher, addons: [{ ...validAddon, revoked: true, revoked_reason: 'unsafe' }] })).toEqual([]);
	});

	test('rejects missing meta block', () => {
		const { meta: _meta, ...noMeta } = validPublisher;
		expect(schemaValidate(noMeta).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects missing meta.publisher', () => {
		const { publisher: _publisher, ...metaNoPublisher } = validPublisher.meta;
		expect(schemaValidate({ ...validPublisher, meta: metaNoPublisher }).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects a malformed meta.publisher', () => {
		const data = { ...validPublisher, meta: { ...validPublisher.meta, publisher: 'Acme Corp' } };
		expect(schemaValidate(data).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects empty addons array', () => {
		expect(schemaValidate({ ...validPublisher, addons: [] }).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects more than 5 keywords', () => {
		const data = { ...validPublisher, addons: [{ ...validAddon, keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }] };
		expect(schemaValidate(data).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects a keyword longer than 12 chars', () => {
		const data = { ...validPublisher, addons: [{ ...validAddon, keywords: ['thirteenchars'] }] };
		expect(schemaValidate(data).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('accepts 5 keywords of 12 chars', () => {
		const data = { ...validPublisher, addons: [{ ...validAddon, keywords: ['abcdefghijkl', 'b', 'c', 'd', 'e'] }] };
		expect(schemaValidate(data)).toEqual([]);
	});
});

describe('module.json manifest', () => {
	const valid = {
		registry_id: 'acme/reports',
		schema_version: 1,
		type: 'module',
		description: 'Reports addon',
	};

	test('accepts a complete valid manifest', () => {
		expect(checkModuleManifest(valid, 'acme/reports').valid).toBe(true);
	});

	test('requires registry_id to equal the registry name', () => {
		const { errors } = checkModuleManifest({ ...valid, registry_id: 'other/x' }, 'acme/reports');
		expect(errors.some((e) => e.rule === 'module-identity')).toBe(true);
	});

	test('requires schema_version, type, and description', () => {
		const r1 = checkModuleManifest({ ...valid, schema_version: '1' }, 'acme/reports');
		expect(r1.errors.some((e) => e.rule === 'module-schema-version')).toBe(true);
		const r2 = checkModuleManifest({ ...valid, type: 'plugin' }, 'acme/reports');
		expect(r2.errors.some((e) => e.rule === 'module-type')).toBe(true);
		const r3 = checkModuleManifest({ ...valid, description: '  ' }, 'acme/reports');
		expect(r3.errors.some((e) => e.rule === 'module-description')).toBe(true);
	});

	test('accepts type theme', () => {
		expect(checkModuleManifest({ ...valid, type: 'theme' }, 'acme/reports').valid).toBe(true);
	});

	test('enforces database.tables author prefix', () => {
		const ok = checkModuleManifest({ ...valid, database: { tables: ['acme_reports_runs'] } }, 'acme/reports');
		expect(ok.valid).toBe(true);
		const bad = checkModuleManifest({ ...valid, database: { tables: ['users', 'acme_reports_runs'] } }, 'acme/reports');
		expect(bad.errors.some((e) => e.rule === 'module-tables')).toBe(true);
	});

	test('rejects a non-object manifest', () => {
		expect(checkModuleManifest(null, 'acme/reports').valid).toBe(false);
	});
});

describe('source registry', () => {
	test('resolves the github-release source by type', () => {
		const source = getSource('github-release');
		expect(source?.type).toBe('github-release');
	});

	test('returns undefined for an unknown source type', () => {
		expect(getSource('gitlab-release')).toBeUndefined();
	});

	test('advertises supported source types', () => {
		expect(SUPPORTED_SOURCE_TYPES).toContain('github-release');
	});

	test('parseRepository splits owner/repo and rejects malformed input', () => {
		expect(parseRepository('acme/reports-addon')).toEqual({ owner: 'acme', repo: 'reports-addon' });
		expect(() => parseRepository('not-a-repo')).toThrow();
	});
});

describe('source.type schema', () => {
	const base = {
		meta: { publisher: 'acme', name: 'Acme', url: 'https://acme.example.com', maintainers: ['acme-dev'] },
		addons: [
			{
				name: 'reports',
				description: 'Reports addon',
				category: 'reporting',
				license: 'MIT',
				keywords: ['reports'],
				requirements: { php: '>=8.3', phpvms: '>=7.0.0' },
			},
		],
	};

	test('accepts a github-release source with a repository', () => {
		const data = { ...base, addons: [{ ...base.addons[0], source: { type: 'github-release', repository: 'acme/reports-addon' } }] };
		expect(schemaValidate(data)).toEqual([]);
	});

	test('rejects github-release without a repository', () => {
		const data = { ...base, addons: [{ ...base.addons[0], source: { type: 'github-release' } }] };
		expect(schemaValidate(data).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('rejects an unknown source type at the schema layer', () => {
		const data = { ...base, addons: [{ ...base.addons[0], source: { type: 'gitlab-release', repository: 'acme/x' } }] };
		expect(schemaValidate(data).some((i) => i.rule === 'schema')).toBe(true);
	});
});

describe('filterPublisherYamlPaths', () => {
	test('keeps a valid top-level publisher YAML', () => {
		expect(filterPublisherYamlPaths(['packages/phpvms.yml'])).toEqual(['packages/phpvms.yml']);
	});

	test('drops a nested path (3 segments)', () => {
		expect(filterPublisherYamlPaths(['packages/acme/reports.yml'])).toEqual([]);
	});

	test('drops a path outside packages/', () => {
		expect(filterPublisherYamlPaths(['schema/categories.yml'])).toEqual([]);
	});

	test('drops .yaml extension (wrong ext)', () => {
		expect(filterPublisherYamlPaths(['packages/phpvms.yaml'])).toEqual([]);
	});

	test('handles mixed input correctly', () => {
		const input = [
			'packages/phpvms.yml',
			'packages/acme/reports.yml',
			'schema/categories.yml',
			'packages/phpvms.yaml',
			'packages/acme.yml',
		];
		expect(filterPublisherYamlPaths(input)).toEqual(['packages/phpvms.yml', 'packages/acme.yml']);
	});
});

describe('checkDuplicateAddonNames', () => {
	test('returns no issues for unique names', () => {
		const addons = [{ name: 'reports' }, { name: 'finance' }];
		expect(checkDuplicateAddonNames(addons)).toEqual([]);
	});

	test('emits duplicate-addon-name issue for repeated names', () => {
		const addons = [{ name: 'reports' }, { name: 'finance' }, { name: 'reports' }];
		const issues = checkDuplicateAddonNames(addons);
		expect(issues.length).toBe(1);
		expect(issues[0]!.rule).toBe('duplicate-addon-name');
		expect(issues[0]!.message).toContain('reports');
	});

	test('emits one issue per duplicated name', () => {
		const addons = [{ name: 'reports' }, { name: 'reports' }, { name: 'finance' }, { name: 'finance' }];
		const issues = checkDuplicateAddonNames(addons);
		expect(issues.length).toBe(2);
		expect(issues.map((i) => i.rule)).toEqual(['duplicate-addon-name', 'duplicate-addon-name']);
	});

	test('skips addons with missing names', () => {
		const addons = [{ name: 'reports' }, { name: null }, { name: undefined }];
		expect(checkDuplicateAddonNames(addons)).toEqual([]);
	});
});

describe('checkPublisherMatchesStem', () => {
	test('passes when meta.publisher equals the file stem', () => {
		expect(checkPublisherMatchesStem('acme', 'acme')).toEqual([]);
	});

	test('emits publisher-mismatch when they differ', () => {
		const issues = checkPublisherMatchesStem('acme', 'other');
		expect(issues.length).toBe(1);
		expect(issues[0]!.rule).toBe('publisher-mismatch');
	});
});

describe('meta.url format validation', () => {
	test('rejects non-URI meta.url', () => {
		const data = { ...validPublisher, meta: { ...validPublisher.meta, url: 'not-a-url' } };
		expect(schemaValidate(data).some((i) => i.rule === 'schema')).toBe(true);
	});

	test('accepts a valid https URL', () => {
		const data = { ...validPublisher, meta: { ...validPublisher.meta, url: 'https://example.com' } };
		expect(schemaValidate(data)).toEqual([]);
	});
});
