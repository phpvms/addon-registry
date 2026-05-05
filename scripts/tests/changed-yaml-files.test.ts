import { describe, it, expect } from 'vitest';
import { filterPackageYamlPaths } from '../validate.js';

describe('filterPackageYamlPaths', () => {
	it('returns only packages/**/*.yml entries (excluding meta.yml)', () => {
		const diff = [
			'packages/acme/foo.yml',
			'packages/acme/meta.yml',
			'packages/phpvms/bar.yml',
			'README.md',
			'docs/operations.md',
			'schema/package.schema.json',
			'scripts/validate.ts',
		].join('\n');

		expect(filterPackageYamlPaths(diff)).toEqual([
			'packages/acme/foo.yml',
			'packages/phpvms/bar.yml',
		]);
	});

	it('handles trailing newline + blank lines + whitespace', () => {
		const diff = '\n  packages/acme/foo.yml  \n\npackages/acme/bar.yml\n\n';
		expect(filterPackageYamlPaths(diff)).toEqual([
			'packages/acme/foo.yml',
			'packages/acme/bar.yml',
		]);
	});

	it('returns empty array for empty input', () => {
		expect(filterPackageYamlPaths('')).toEqual([]);
		expect(filterPackageYamlPaths('\n\n')).toEqual([]);
	});

	it('does NOT depend on diff-filter — it trusts the caller to supply the right diff', () => {
		// This test documents the contract: if a deleted path slips in, the
		// filter still passes it through (because the function cannot
		// distinguish A/M/D from --name-only output). The fix lives at the
		// `git diff` invocation site (--diff-filter=ACMRT). Documented here
		// so the responsibility is explicit.
		const diff = 'packages/acme/deleted.yml\npackages/acme/added.yml';
		expect(filterPackageYamlPaths(diff)).toEqual([
			'packages/acme/deleted.yml',
			'packages/acme/added.yml',
		]);
	});

	it('rejects non-yaml extensions and paths outside packages/', () => {
		const diff = [
			'packages/acme/foo.yaml',
			'packages/acme/foo.yml.bak',
			'tests/packages/acme/foo.yml',
			'.github/workflows/validate-pr.yml',
			'packages/acme/foo.yml',
		].join('\n');
		expect(filterPackageYamlPaths(diff)).toEqual(['packages/acme/foo.yml']);
	});
});
