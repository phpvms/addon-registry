# Operations

This document is for registry maintainers. Addon authors should read
[`plugin-authors.md`](./plugin-authors.md).

## Repository overview

- `packages/{author}/{name}.yml` — addon entries.
- `packages/{author}/meta.yml` — optional namespace metadata (not validated).
- `schema/` — the JSON schema + the closed `category` enum.
- `scripts/validate.ts` — the validator; helpers live in `scripts/lib/`.
- `.github/workflows/` — CI definitions.

There is no application server, no external storage, and no bot. Every
check runs inside GitHub Actions via a single Bun script.

## Workflows

| Workflow      | Job        | Trigger                              | Does                                              |
| ------------- | ---------- | ------------------------------------ | ------------------------------------------------- |
| `Validate PR` | `validate` | PR touching `packages/**`/`schema/**`| Runs `bun scripts/validate.ts` on changed YAMLs.  |
| `CI`          | `test`     | every PR and push to `main`          | `bun run typecheck` + `bun test`.                 |

Both workflows use the default `GITHUB_TOKEN` only. No repository secrets
or variables are required.

## Credentials

None. The validator reads author repositories through the public GitHub
API using the runner's default `GITHUB_TOKEN` (1000 req/h against the
runner's own repo; sufficient for PR-time validation). It posts nothing
back and needs no App, R2, or external tokens.

## Branch protection (manual configuration)

Configure on `main` via Settings -> Branches -> Branch protection rules:

- Require a pull request before merging.
- Require status checks to pass before merging.
  - Add: `validate` (the Validate PR workflow's job).
  - Add: `test` (the CI workflow's job).
- Require linear history.
- Allow squash merging only (disable merge commits and rebase merging).
- Require branches to be up to date before merging.

## Validating locally

```bash
bun install

# Validate one file (read-only; hits the GitHub API for the source repo)
bun scripts/validate.ts packages/acme/reports.yml

# Validate every package under packages/
bun scripts/validate.ts

# Validate exactly what a PR changed
BASE_SHA=<base> HEAD_SHA=<head> bun scripts/validate.ts
```

Set `GITHUB_TOKEN` in the environment to raise API rate limits when
validating many packages at once.

## Triaging a failing PR

A PR's `validate` check goes red when a changed YAML fails a rule:

1. Open the workflow logs; each failure is printed as `[rule] message`.
2. For schema/structural failures, the fix is in the YAML itself.
3. For `source-repo-*`, `release-*`, `zip-*`, `module-identity`, or
   `migration:*` failures, the problem is in the author's repository or
   release zip. Ask the author to fix the upstream release, then push a
   new commit to the PR (or an empty commit) to re-run validation.
4. To accept an entry whose upstream is gone or broken but should remain
   listed, mark it `revoked`/`archived` (see [`revocation.md`](./revocation.md));
   those flags skip the upstream checks.
