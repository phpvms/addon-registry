<!-- Thanks for contributing to the phpVMS addon registry. Pick the
section below that matches your PR and delete the others. -->

## What kind of PR is this?

- [ ] Adding a new addon (new entry in `packages/{publisher}.yml`)
- [ ] Adding or updating a publisher file (`packages/{publisher}.yml`)
- [ ] Updating an existing addon's metadata (description, keywords, etc.)
- [ ] Marking an addon `revoked` or `archived`
- [ ] Adding a category to `schema/package.schema.json`
- [ ] Maintainer change (schema, scripts, workflows, docs)

---

## New addon submission

If you are adding a new addon, please confirm:

- [ ] My publisher file is at `packages/{publisher}.yml` (lowercase, hyphens, no underscores)
- [ ] The file includes a `meta` block with `name`, `url`, and at least one entry in `maintainers`
- [ ] My addon `name` is an unqualified single segment (lowercase, hyphens, no underscores, no slash)
- [ ] My GitHub repo for the addon is **public**
- [ ] My repo has at least one **published release** with a **zip asset**
- [ ] The zip contains `module.json` at the **root** (not inside a subdirectory)
- [ ] The zip's `module.json` declares `registry_id` equal to the full identity (e.g. `acme/reports`)
- [ ] The zip's `module.json` declares `schema_version`, `type` (`module`/`theme`), and a non-empty `description`
- [ ] Any `database.tables` in `module.json` are namespaced under `{publisher}_`
- [ ] My migrations follow the [migration rules](../docs/plugin-authors.md#part-2-migration-rules)

## Why this addon

<!-- One paragraph: what does the addon do, and what category does it belong in? -->

## Anything reviewers should know

<!-- Cross-addon overlap, unusual migration patterns, third-party libraries
shipped, etc. Leave blank if none. -->
