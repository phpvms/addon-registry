import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { buildZip } from './helpers/zip-builder.js';
import { listEntries, findRootEntry, findForbiddenEntries, readEntry } from '../lib/zip.js';
import { lintMigration } from '../lib/migration-lint.js';
import { checkModuleIdentity } from '../lib/module-identity.js';

const VALID_MODULE_JSON = JSON.stringify({
	name: 'acme/reports',
	alias: 'acme/reports',
	description: 'Reports',
	keywords: [],
	active: true,
	order: 0,
	providers: ['Modules\\AcmeReports\\Providers\\AcmeReportsServiceProvider'],
	aliases: {},
	files: [],
	requires: [],
});

const VALID_MIGRATION = `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

class CreateAcmeReportsRuns extends Migration {
	public function up(): void {
		Schema::create('acme_reports_runs', function (Blueprint $t) {
			$t->id();
			$t->foreignId('user_id')->constrained();
			$t->timestamps();
		});
	}
	public function down(): void {
		Schema::dropIfExists('acme_reports_runs');
	}
}
`;

const BAD_MIGRATION = `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Support\\Facades\\Schema;
use Illuminate\\Support\\Facades\\DB;

class BadMigration extends Migration {
	public function up(): void {
		Schema::create('users', function ($t) {});
		DB::statement('TRUNCATE other_users');
		eval('1');
	}
	public function down(): void {}
}
`;

describe('fixture: minimal valid zip', () => {
	it('passes module identity, has no forbidden paths, migrations clean', async () => {
		const buf = buildZip([
			{ path: 'module.json', body: VALID_MODULE_JSON },
			{ path: 'Database/Migrations/2025_01_01_000000_create_acme_reports_runs.php', body: VALID_MIGRATION },
		]);
		const entries = await listEntries(buf);
		expect(findForbiddenEntries(entries)).toEqual([]);
		const moduleEntry = findRootEntry(entries, 'module.json');
		expect(moduleEntry).toBeTruthy();
		const moduleParsed = JSON.parse((await readEntry(buf, moduleEntry!)).toString('utf8'));
		const identity = checkModuleIdentity(moduleParsed, 'acme/reports');
		expect(identity.valid).toBe(true);

		const migrationEntry = entries.find((e) => e.name.endsWith('.php'))!;
		const phpSrc = (await readEntry(buf, migrationEntry)).toString('utf8');
		const lint = lintMigration({ source: phpSrc, path: migrationEntry.name, author: 'acme' });
		expect(lint.errors).toEqual([]);
	});
});

describe('fixture: malformed zip', () => {
	it('parser rejects garbage input', async () => {
		const garbage = Buffer.from('definitely not a zip file');
		await expect(listEntries(garbage)).rejects.toThrow();
	});
});

describe('fixture: zip with forbidden paths', () => {
	it('forbidden detector lists every offender', async () => {
		const buf = buildZip([
			{ path: 'module.json', body: VALID_MODULE_JSON },
			{ path: '.git/HEAD', body: 'ref' },
			{ path: '.github/workflows/ci.yml', body: '' },
			{ path: 'tests/Foo.php', body: '<?php' },
			{ path: 'Tests/Bar.php', body: '<?php' },
			{ path: 'node_modules/x/index.js', body: '' },
			{ path: '.idea/workspace.xml', body: '' },
			{ path: '.vscode/settings.json', body: '' },
			{ path: '.DS_Store', body: '' },
		]);
		const offenders = findForbiddenEntries(await listEntries(buf));
		expect(offenders).toEqual(
			expect.arrayContaining([
				'.git/HEAD',
				'.github/workflows/ci.yml',
				'tests/Foo.php',
				'Tests/Bar.php',
				'node_modules/x/index.js',
				'.idea/workspace.xml',
				'.vscode/settings.json',
				'.DS_Store',
			]),
		);
		expect(offenders).not.toContain('module.json');
	});
});

describe('fixture: zip with disallowed migration patterns', () => {
	it('lint reports schema allow-list violation, db-forbidden, eval', async () => {
		const buf = buildZip([
			{ path: 'module.json', body: VALID_MODULE_JSON },
			{ path: 'Database/Migrations/2025_01_01_000000_bad.php', body: BAD_MIGRATION },
		]);
		const entries = await listEntries(buf);
		const phpEntry = entries.find((e) => e.name.endsWith('.php'))!;
		const phpSrc = (await readEntry(buf, phpEntry)).toString('utf8');
		const lint = lintMigration({ source: phpSrc, path: phpEntry.name, author: 'acme' });
		const rules = new Set(lint.errors.map((e) => e.rule));
		expect(rules.has('schema-allow-list')).toBe(true);
		expect(rules.has('db-forbidden')).toBe(true);
		expect(rules.has('eval')).toBe(true);
	});
});
