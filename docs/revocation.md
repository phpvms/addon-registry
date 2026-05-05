# Revocation and archival

This document is for registry maintainers, not addon authors. Both
revocation and archival are maintainer actions taken via PR. For
addon-author guidance see [`plugin-authors.md`](./plugin-authors.md).

## When to use which

| Flag       | Meaning                                                     | Host behaviour (out of scope here)                  |
| ---------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `revoked`  | The addon is **critically unsafe** to install.              | Hosts refuse to install; warn for existing installs.|
| `archived` | The addon is **no longer maintained**, but not unsafe.      | Hosts still allow install but display a notice.     |

`revoked` is for security issues and similar hard breaks — you would not
want any operator to install this addon as-is. `archived` is for
maintainer abandonment, succession ("see acme/reports2"), or planned
end-of-life.

A package may be both revoked and archived. `archived: true` alone
without `revoked: true` is the maintained-as-archived case.

## How to revoke

Open a PR that adds `revoked: true` and a `revoked_reason` to the YAML:

```yaml
# packages/acme/reports.yml (excerpt)
revoked: true
revoked_reason: "Arbitrary file write in v1.x. See https://example.com/security-advisory."
```

Both fields are required when revoking. The validator skips upstream
checks for revoked entries (so the PR passes even if the source repo no
longer exists or the release zip is broken).

## How to archive

```yaml
# packages/acme/reports.yml (excerpt)
archived: true
archived_reason: "Author has stopped maintaining this addon. See acme/reports2 for a successor."
```

`archived_reason` is required. Upstream checks are also skipped for
archived entries.

## What the registry does after revocation/archival

1. Discovery does **not** poll the upstream repo for new releases.
2. The publish workflow re-runs and includes the flag and reason in
   `raw/packages.json` verbatim.
3. The worker serves the updated index; the host installer interprets
   the flag.

Existing pinned `release:` blocks are preserved unless the maintainer
also removes them.

## Reverting a revocation

If a revocation was made in error or the underlying issue is fixed,
remove `revoked: true` (and `revoked_reason`) in a follow-up PR. The
validator runs all upstream checks for that file as if it were a fresh
submission.

## Reverting an archival

Same pattern: remove `archived: true` (and `archived_reason`). Discovery
resumes polling on the next run.

## Hard removal

Sometimes you want the package gone, not just flagged. Open a PR that
deletes the YAML file. The publish workflow rebuilds without that
package; the worker drops it from the public list on the next refresh.

Hosts cache aggressively — operators with the package already installed
will still have a working install until they upgrade or until your host
installer enforces removal at install time.

## Decision flowchart

```
Is the addon dangerous to install right now?
|
+- Yes -> mark `revoked: true` + reason. Coordinate with author if reachable.
|
+- No, but not maintained?
   |
   +- Yes -> mark `archived: true` + reason.
   |
   +- No, just want to take it down -> delete the YAML file.
```

## Coordinating with authors

Notify the author by GitHub issue or email when reasonable, especially
for revocation. The registry is a curation layer; trust signals work
both ways.
