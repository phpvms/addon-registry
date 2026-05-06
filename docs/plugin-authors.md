# Plugin authors guide

This guide is for addon (plugin) authors. Operators install addons
through their phpVMS host's admin UI; they do not interact with this
repository directly.

If you maintain the registry itself, see [`operations.md`](./operations.md)
and [`revocation.md`](./revocation.md).

---

## Part 1: Submitting an addon

### What you submit

A **single YAML file** at `packages/{author}/{name}.yml` describing your
addon. You do **not** submit a `release:` block — the registry's bot
queries your GitHub releases and adds it after merge.

If your namespace doesn't exist yet, also submit `packages/{author}/meta.yml`
in the same PR.

### Prerequisites

- A public GitHub repository for your addon.
- At least one published GitHub release with a zip asset attached.
- The zip contains `module.json` at its root (not inside a subdirectory).
- The zip's `module.json` declares `registry_id` equal to your registry
  name (e.g. `acme/reports`). The `name` and `alias` fields are owned
  by phpVMS core (Laravel-Modules) and are not inspected by the
  registry.
- All migrations under `Database/Migrations/` follow the rules in
  [Part 2](#part-2-migration-rules).

### Naming rules and conventions

Registry names use the form `{author}/{package}`:

- Lowercase letters, digits, and hyphens only.
- Each segment is at least two characters.
- No underscores, no uppercase, no periods.
- The slug `meta` is reserved (it denotes namespace metadata).

**Conventions (recommended, not enforced):**

- The `{author}` segment should match your **GitHub username or
  organisation**. This keeps ownership unambiguous and makes the
  source repo easy to find.
- The `{package}` segment should match the **GitHub repository name**
  of the addon source. So an addon hosted at
  `https://github.com/acme/reports-addon` is best registered as
  `acme/reports-addon`.

Following these conventions is not enforced by CI, but maintainers
prefer PRs that follow them. Deviating without a clear reason slows
down review.

Examples that follow the convention: `acme/reports`,
`phpvms/core-tools`, `crew-tools/dispatch`.

### Minimal package YAML

```yaml
# packages/acme/reports.yml
name: acme/reports
description: Reports addon for phpVMS — KPIs, route performance, scheduled exports.
category: reporting
license: MIT
keywords:
  - reports
  - analytics
  - dashboard
source:
  type: github-release
  repository: acme/reports-addon
requirements:
  php: '>=8.3'
  phpvms: '>=7.0.0'
```

That's the entire submission. The bot resolves the `release:` block after
merge.

### Allowed `category` values

Pick exactly one. The current list lives in `schema/categories.yml`:

`accounting`, `communications`, `crew`, `dev-tools`, `integration`,
`operations`, `pireps`, `reporting`, `scheduling`, `templates`, `ui`,
`widget`, `other`.

To request a new category, open a separate PR adding it to that file
before submitting your package YAML.

### meta.yml (first-time author)

If your namespace is new (no other addons under `packages/{author}/`),
include `packages/{author}/meta.yml` in the same PR:

```yaml
# packages/acme/meta.yml
name: Acme Corp
url: https://acme.example.com
maintainers:
  - acme-dev
  - jdoe
```

`maintainers` is a list of GitHub usernames. The first listed is treated
as the primary contact.

### What CI checks at PR time

1. **Schema** — required fields, valid `name` regex, allowed category,
   requirements present.
2. **Filename matches name** — `acme/reports` lives at
   `packages/acme/reports.yml`, no exceptions.
3. **Source repo exists and is public.**
4. **Latest release** — at least one published release with a zip asset.
5. **Zip integrity** — downloadable, contains `module.json` at the root,
   no forbidden paths (`.git/`, `.github/`, `tests/`, `node_modules/`,
   `.idea/`, `.vscode/`, `.DS_Store`, `Tests/`).
6. **module.json** — `registry_id` equals the registry name. No other field is checked.
7. **Migration lint** — see [Part 2](#part-2-migration-rules).

The validator posts a single comment summarising results. If everything
passes, the comment includes the proposed `release:` block.

### What happens after merge

1. The `release-block` workflow opens an auto-merging bot PR appending
   the resolved `release:` block to your YAML.
2. The `publish` workflow builds `raw/packages.json` and `raw/keywords.json`,
   uploads them to R2, and refreshes the worker's edge cache.
3. Hosts polling the read API see your addon within a few minutes.
4. Subsequent releases on your repo are picked up by the discovery
   sweep (cron every 6h, plus push triggers from the worker).

### Updating your addon

Tag a new release on your GitHub repo. The discovery sweep opens an
auto-merging `bot/bump-{author}-{name}-{version}` PR within hours.

You do not interact with this repository for routine updates.

### Marking an addon revoked or archived

See [`revocation.md`](./revocation.md). Revocation and archival are
maintainer actions, not author actions.

---

## Part 2: Migration rules

Addon migrations under `Database/Migrations/` are static-analysed at PR
time using an allow-list. The author namespace `{author}` is the first
segment of your registry name (e.g. for `acme/reports` the namespace is
`acme`).

### The rules at a glance

| Rule                                                                  | Allowed                                            | Forbidden                                                |
| --------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Class declaration                                                     | `class ... extends Migration`                      | classes that don't extend `Migration`                    |
| `Schema::create / table / drop / dropIfExists / rename` table targets | tables matching `^{author}_*`                      | core tables, other authors' tables, dynamic table names  |
| `DB::table()` targets                                                 | tables matching `^{author}_*`                      | core tables, other authors' tables, dynamic table names  |
| `DB::raw()`                                                           | always                                             | -                                                        |
| `DB::statement`, `DB::unprepared`                                     | -                                                  | always forbidden                                         |
| Foreign key referent (`->on('users')`)                                | any table                                          | -                                                        |
| `foreignId(...)->constrained()` (implicit referent)                   | any table                                          | -                                                        |
| `eval`, `include`, `include_once`, `require`, `require_once`          | -                                                  | always forbidden                                         |

### Why allow-list, not deny-list

A deny-list of "core tables" would need updating every time phpVMS adds
a table. The allow-list catches **all** core tables (none start with
`{author}_`) and **all** other authors' tables automatically. It also
allows you to share tables across your own addons (e.g. `acme/reports`
may legitimately read `acme_inventory_*` tables).

### Examples that pass

```php
// Allowed: schema operation on author-prefixed table
Schema::create('acme_reports_runs', function (Blueprint $t) {
    $t->id();
    $t->timestamps();
});

// Allowed: cross-addon, same author
Schema::table('acme_inventory_items', function (Blueprint $t) {
    $t->boolean('reported')->default(false);
});

// Allowed: foreign key referent on a core table
Schema::create('acme_reports_runs', function (Blueprint $t) {
    $t->id();
    $t->foreignId('user_id')->constrained();             // implicit ->on('users')
    $t->foreign('aircraft_id')->references('id')->on('aircraft'); // explicit
});

// Allowed: DB::raw expression for a default value
Schema::create('acme_reports_runs', function (Blueprint $t) {
    $t->timestamp('created_at')->default(DB::raw('CURRENT_TIMESTAMP'));
});

// Allowed: rename within author prefix
Schema::rename('acme_reports_old', 'acme_reports_new');
```

### Examples that fail

```php
// FAIL: target is a core table
Schema::create('users', function (Blueprint $t) {});

// FAIL: another author's prefix
Schema::create('beta_forms_responses', function (Blueprint $t) {});

// FAIL: dynamic table name
$name = 'foo';
Schema::create($name, function (Blueprint $t) {});

// FAIL: rename has core table on one side
Schema::rename('users', 'acme_reports_users');

// FAIL: arbitrary SQL execution
DB::statement('TRUNCATE other_users');
DB::unprepared('UPDATE accounts SET ...');

// FAIL: eval / include / require
eval('echo 1;');
include 'helpers.php';
require_once 'config.php';

// FAIL: DB::table on a core table
DB::table('users')->update(['banned' => true]);
```

### Common gotchas

- **`Schema::create(...)` table name must be a string literal.** Even
  innocuous patterns like `$name = 'acme_x'; Schema::create($name, ...)`
  are rejected. The lint cannot prove what `$name` resolves to.
- **`DB::table($var)` is rejected.** Same reason.
- **Forbidden imports/requires.** Helpers belong in your service
  provider or a regular class file, not in migrations.
- **Drop migrations must also use the prefix.** `Schema::drop('users')`
  fails just as `Schema::create('users')` does. Drop only what you own.
- **Reverse migrations**. The `down()` method is linted with the same
  rules as `up()`.

### What the lint does not catch

- Runtime SQL injection via Eloquent or query builder. The lint targets
  the migration boundary; addon runtime code is reviewed manually.
- Migrations that don't import the `Schema` facade. The class-extends
  check still flags them as not-a-migration if the parent class is
  missing.
- Vendor/library code shipped under `Database/Migrations/`. The lint
  applies to every PHP file in that directory regardless of origin.

If you find a real-world legitimate pattern the lint rejects, please
open an issue — the rules are tunable and we'd rather adjust them than
maintain workarounds.
