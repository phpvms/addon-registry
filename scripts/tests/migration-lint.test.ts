import { describe, it, expect } from 'vitest';
import { lintMigration } from '../lib/migration-lint.js';

const baseClass = (body: string): string => `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;
use Illuminate\\Support\\Facades\\DB;

class CreateThings extends Migration
{
	public function up(): void
	{
		${body}
	}

	public function down(): void
	{
		// noop
	}
}
`;

const author = 'acme';

const lint = (body: string) => lintMigration({ source: baseClass(body), path: '.../m.php', author });

const lintRaw = (source: string) => lintMigration({ source, path: '.../m.php', author });

describe('migration lint — class extends Migration', () => {
	it('accepts a class extending Migration', () => {
		const result = lint('// empty');
		expect(result.errors.filter((e) => e.rule === 'class-extends')).toEqual([]);
	});

	it('rejects a file with no Migration subclass', () => {
		const src = `<?php\nclass Plain {}\n`;
		const r = lintRaw(src);
		expect(r.errors.find((e) => e.rule === 'class-extends')).toBeTruthy();
	});
});

describe('migration lint — Schema:: allow-list', () => {
	it('accepts Schema::create on author-prefixed table', () => {
		const r = lint(`Schema::create('acme_reports_runs', function (Blueprint $t) {});`);
		expect(r.errors).toEqual([]);
	});

	it('accepts Schema::create on cross-author-prefixed table (same author namespace)', () => {
		const r = lint(`Schema::create('acme_inventory_items', function (Blueprint $t) {});`);
		expect(r.errors).toEqual([]);
	});

	it('rejects Schema::create on a core table name', () => {
		const r = lint(`Schema::create('users', function (Blueprint $t) {});`);
		expect(r.errors.find((e) => e.rule === 'schema-allow-list')).toBeTruthy();
	});

	it('rejects Schema::create on another author prefix', () => {
		const r = lint(`Schema::create('beta_forms_responses', function (Blueprint $t) {});`);
		expect(r.errors.find((e) => e.rule === 'schema-allow-list')).toBeTruthy();
	});

	it('accepts Schema::table on allow-listed prefix', () => {
		const r = lint(`Schema::table('acme_reports_runs', function (Blueprint $t) {});`);
		expect(r.errors).toEqual([]);
	});

	it('accepts Schema::drop on allow-listed prefix', () => {
		const r = lint(`Schema::drop('acme_reports_runs');`);
		expect(r.errors).toEqual([]);
	});

	it('accepts Schema::dropIfExists on allow-listed prefix', () => {
		const r = lint(`Schema::dropIfExists('acme_reports_runs');`);
		expect(r.errors).toEqual([]);
	});

	it('accepts Schema::rename when both names match prefix', () => {
		const r = lint(`Schema::rename('acme_reports_old', 'acme_reports_new');`);
		expect(r.errors).toEqual([]);
	});

	it('rejects Schema::rename when one side is core', () => {
		const r = lint(`Schema::rename('users', 'acme_reports_users');`);
		expect(r.errors.find((e) => e.rule === 'schema-allow-list')).toBeTruthy();
	});

	it('rejects Schema::create with dynamic table name', () => {
		const r = lint(`$name = 'foo';\nSchema::create($name, function (Blueprint $t) {});`);
		expect(r.errors.find((e) => e.rule === 'schema-dynamic-table')).toBeTruthy();
	});
});

describe('migration lint — DB:: rules', () => {
	it('accepts DB::table on author-prefixed table', () => {
		const r = lint(`DB::table('acme_reports_runs')->insert([]);`);
		expect(r.errors).toEqual([]);
	});

	it('rejects DB::table on a core table', () => {
		const r = lint(`DB::table('users')->update([]);`);
		expect(r.errors.find((e) => e.rule === 'db-allow-list')).toBeTruthy();
	});

	it('accepts DB::raw expressions', () => {
		const r = lint(`Schema::create('acme_reports_runs', function (Blueprint $t) {\n\t$t->timestamp('created_at')->default(DB::raw('CURRENT_TIMESTAMP'));\n});`);
		expect(r.errors).toEqual([]);
	});

	it('rejects DB::statement', () => {
		const r = lint(`DB::statement('CREATE TABLE foo (id int)');`);
		expect(r.errors.find((e) => e.rule === 'db-forbidden')).toBeTruthy();
	});

	it('rejects DB::unprepared', () => {
		const r = lint(`DB::unprepared('TRUNCATE users');`);
		expect(r.errors.find((e) => e.rule === 'db-forbidden')).toBeTruthy();
	});
});

describe('migration lint — eval / include / require', () => {
	it('rejects eval', () => {
		const r = lint(`eval('echo 1;');`);
		expect(r.errors.find((e) => e.rule === 'eval')).toBeTruthy();
	});

	it('rejects include', () => {
		const r = lint(`include 'helpers.php';`);
		expect(r.errors.find((e) => e.rule === 'include')).toBeTruthy();
	});

	it('rejects include_once', () => {
		const r = lint(`include_once 'helpers.php';`);
		expect(r.errors.find((e) => e.rule === 'include')).toBeTruthy();
	});

	it('rejects require', () => {
		const r = lint(`require 'helpers.php';`);
		expect(r.errors.find((e) => e.rule === 'include')).toBeTruthy();
	});

	it('rejects require_once', () => {
		const r = lint(`require_once 'helpers.php';`);
		expect(r.errors.find((e) => e.rule === 'include')).toBeTruthy();
	});
});

describe('migration lint — foreign key referents', () => {
	it('accepts ->on() referring to a core table', () => {
		const r = lint(`Schema::create('acme_reports_runs', function (Blueprint $t) {
			$t->unsignedBigInteger('user_id');
			$t->foreign('user_id')->references('id')->on('users');
		});`);
		expect(r.errors).toEqual([]);
	});

	it('accepts foreignId(...)->constrained() with implicit users reference', () => {
		const r = lint(`Schema::create('acme_reports_runs', function (Blueprint $t) {
			$t->foreignId('user_id')->constrained();
		});`);
		expect(r.errors).toEqual([]);
	});
});
