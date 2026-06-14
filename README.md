# phpVMS addon registry

The curated catalogue of phpVMS Laravel-module addons. Authors submit a
minimal YAML referencing their GitHub repository; CI validates the YAML
against a JSON schema and inspects the repo's latest release.

This repo runs on GitHub Actions only — no application servers, no
external infrastructure. A single Bun script performs every check.

## Layout

- `packages/{publisher}.yml` — one file per publisher; contains a required `meta` block and an `addons` list
- `schema/` — the JSON schema + the closed `category` enum
- `scripts/validate.ts` — the validator (plus small helpers in `scripts/lib/`)
- `.github/workflows/` — CI definitions

## What CI does

On every PR touching `packages/**`, `scripts/validate.ts` validates each
changed package YAML:

1. **Structural** — path shape (`packages/{publisher}.yml`), JSON schema, duplicate addon names rejected
2. **JSON schema** — `schema/package.schema.json` + the `category` enum
3. **Source release** — repo is public and has a release with a zip asset
4. **Zip inspection** — `module.json` at the root, no forbidden paths,
   `registry_id` matches the full `{publisher}/{addon-name}` identity
5. **Migration lint** — static allow-list checks on `Database/Migrations/`

`revoked`/`archived` entries skip checks 3–5. The job exits non-zero on
any failure (a plain pass/fail check, no PR comment).

## Local use

```bash
bun install
bun scripts/validate.ts packages/acme.yml           # validate one file
bun scripts/validate.ts                             # validate every package
bun test                                            # unit tests
bun run typecheck                                   # tsc --noEmit
```

`GITHUB_TOKEN` is optional locally; set it to raise GitHub API rate
limits when validating many packages.

## Contributing

See `docs/plugin-authors.md` for how to submit an addon (covers both
registry submission and migration rules).
