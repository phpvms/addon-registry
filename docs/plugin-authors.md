# Plugin authors guide

This guide is for addon (plugin) authors. Operators install addons
through their phpVMS host's admin UI; they do not interact with this
repository directly.

If you maintain the registry itself, see [`operations.md`](./operations.md)
and [`revocation.md`](./revocation.md).

---

## Part 1: Submitting an addon

### What you submit

A **single YAML file** at `packages/{publisher}.yml` — one file per
publisher (GitHub username or organisation). The file contains two
top-level keys:

- `meta` (**required**): display name, URL, and a list of GitHub
  maintainer usernames.
- `addons`: a non-empty list of addon entries.

The registry does not pin a version — each addon entry points at a
GitHub repository, and CI validates that repo's latest release.

### Prerequisites

- A public GitHub repository for your addon.
- At least one published GitHub release with a zip asset attached.
- The zip contains `module.json` at its root (not inside a subdirectory).
- The zip's `module.json` declares:
  - `registry_id` equal to the full registry identity (e.g. `acme/reports`),
  - `schema_version` (integer, `1` for current addons),
  - `type` — `module` or `theme`,
  - `description` — a non-empty string,
  - if present, `database.tables` entries all start with `{publisher}_`
    (e.g. `acme_reports_runs`).

  The `name` and `alias` fields are owned by phpVMS core (Laravel-Modules)
  and are not inspected by the registry.

- All migrations under `Database/Migrations/` follow the rules in
  [Part 2](#part-2-migration-rules).

### Naming rules and conventions

The full registry identity of an addon is `{publisher}/{addon-name}`,
derived from the filename and the addon's `name` field:

- **Publisher** (`{publisher}`): the stem of your YAML file
  (`packages/acme.yml` → publisher `acme`). Should match your GitHub
  username or organisation.
- **Addon name** (`{addon-name}`): the unqualified `name` field inside
  the `addons` list — a single segment, no slash.
  - Lowercase letters, digits, and hyphens only.
  - At least two characters.
  - No underscores, no uppercase, no periods.

**Conventions (recommended, not enforced):**

- The addon `name` should match the **GitHub repository name** of the
  addon source. So an addon hosted at
  `https://github.com/acme/reports-addon` is best registered as
  `name: reports-addon` in `packages/acme.yml`.

Following these conventions is not enforced by CI, but maintainers
prefer PRs that follow them. Deviating without a clear reason slows
down review.

Examples: `acme/reports`, `phpvms/core-tools`, `crew-tools/dispatch`.

### Minimal package YAML

```yaml
# packages/acme.yml
meta:
  publisher: acme
  name: Acme Corp
  url: https://acme.example.com
  maintainers:
    - acme-dev
addons:
  - name: reports
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

That's the entire submission. `meta` is required. `source.type` is
currently `github-release` (the addon zip is pulled from your repo's
latest GitHub release); it is the only supported source type today.

### Allowed `category` values

Pick exactly one. The allowed values are defined as an enum in
`schema/package.schema.json`:

`accounting`, `communications`, `crew`, `dev-tools`, `integration`,
`operations`, `pireps`, `reporting`, `scheduling`, `templates`, `ui`,
`widget`, `other`.

To request a new category, open a separate PR adding it to the `enum`
in `schema/package.schema.json` before submitting your package YAML.

### `keywords` limits

`keywords` is a free-form list of tags. At most **5** keywords, each up
to **12 characters**. Order is preserved into the published index.

### meta block (required namespace metadata)

Every publisher file must include a `meta` block at the top level:

```yaml
# packages/acme.yml
meta:
  publisher: acme
  name: Acme Corp
  url: https://acme.example.com
  maintainers:
    - acme-dev
    - jdoe
addons:
  - ...
```

`publisher` is the namespace identifier and **must match the file name
stem** — i.e. `packages/acme.yml` requires `publisher: acme` (lowercase
letters, digits, and hyphens; at least two characters). `name` is a
display name, `url` must be a valid URI, and `maintainers` is a non-empty
list of GitHub usernames. The `meta` block is required and validated by CI.

### What CI checks at PR time

1. **Schema** — required fields, valid addon `name` regex, allowed
   category, requirements present, `meta` block present and valid.
2. **Structural** — file path matches `packages/{publisher}.yml`;
   `meta.publisher` equals the file name stem; no duplicate addon `name`
   values within the publisher file.
3. **Source repo exists and is public.**
4. **Latest release** — at least one published release with a zip asset.
5. **Zip integrity** — downloadable, contains `module.json` at the root,
   no forbidden paths (`.git/`, `.github/`, `tests/`, `node_modules/`,
   `.idea/`, `.vscode/`, `.DS_Store`, `Tests/`).
6. **module.json** — `registry_id` equals the full `{publisher}/{addon-name}`
   identity (e.g. `acme/reports`); `schema_version` (int), `type`
   (`module`/`theme`), and `description` are present; any declared
   `database.tables` are namespaced under `{publisher}_`.
7. **Migration lint** — see [Part 2](#part-2-migration-rules).

CI is a plain pass/fail check. Read the workflow logs for the per-rule
failure detail.

### What happens after merge

Nothing automated. Once merged, your addon entry inside
`packages/{publisher}.yml` is part of the catalogue. The registry does
not track versions or republish anything — it is the curated list itself.

### Updating your addon

Tag new releases on your GitHub repo as usual. Because the registry
entry references the repository (not a pinned version), routine releases
need no change here. Open a PR only to change metadata (description,
keywords, category) in your `packages/{publisher}.yml`, or to mark the
addon `revoked`/`archived`.

### Marking an addon revoked or archived

See [`revocation.md`](./revocation.md). Revocation and archival are
maintainer actions, not author actions.

---

## Part 2: Migration rules

Addon migrations under `Database/Migrations/` are static-analysed at PR
time using an allow-list. The author namespace is the **publisher** — the
filename stem of your `packages/{publisher}.yml` (e.g. for an addon in
`packages/acme.yml` the namespace is `acme`).

### The rules at a glance

| Rule                                                                  | Allowed                       | Forbidden                                               |
| --------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| Class declaration                                                     | `class ... extends Migration` | classes that don't extend `Migration`                   |
| `Schema::create / table / drop / dropIfExists / rename` table targets | tables matching `^{author}_*` | core tables, other authors' tables, dynamic table names |
| `DB::table()` targets                                                 | tables matching `^{author}_*` | core tables, other authors' tables, dynamic table names |
| `DB::raw()`                                                           | always                        | -                                                       |
| `DB::statement`, `DB::unprepared`                                     | -                             | always forbidden                                        |
| Foreign key referent (`->on('users')`)                                | any table                     | -                                                       |
| `foreignId(...)->constrained()` (implicit referent)                   | any table                     | -                                                       |
| `eval`, `include`, `include_once`, `require`, `require_once`          | -                             | always forbidden                                        |

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
