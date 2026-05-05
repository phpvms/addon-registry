<!-- Thanks for contributing to the phpVMS addon registry. Pick the
section below that matches your PR and delete the others. -->

## What kind of PR is this?

- [ ] Adding a new addon (new `packages/{author}/{name}.yml`)
- [ ] Adding a new namespace (new `packages/{author}/meta.yml`)
- [ ] Updating an existing addon's metadata (description, keywords, etc.)
- [ ] Marking an addon `revoked` or `archived`
- [ ] Adding a category to `schema/categories.yml`
- [ ] Maintainer change (schemas, scripts, workflows, docs)

---

## New addon submission

If you are adding a new addon, please confirm:

- [ ] My YAML file is at `packages/{author}/{name}.yml` (lowercase, hyphens, no underscores)
- [ ] The `name` field equals the directory + filename (e.g. `acme/reports`)
- [ ] My GitHub repo for the addon is **public**
- [ ] My repo has at least one **published release** with a **zip asset**
- [ ] The zip contains `module.json` at the **root** (not inside a subdirectory)
- [ ] The zip's `module.json` declares `name` and `alias` equal to my registry name
- [ ] My migrations follow the [migration rules](../docs/plugin-authors.md#part-2-migration-rules)
- [ ] My zip's `module.json` declares `alias` equal to my registry name
- [ ] I have **not** added a `release:` block — the bot will add it after merge
- [ ] If this is my first addon, I have included a `packages/{author}/meta.yml`

## Why this addon

<!-- One paragraph: what does the addon do, and what category does it belong in? -->

## Anything reviewers should know

<!-- Cross-addon overlap, unusual migration patterns, third-party libraries
shipped, etc. Leave blank if none. -->
