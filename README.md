# phpVMS addon registry

The curated catalogue of phpVMS Laravel-module addons. Authors submit a
minimal YAML referencing their GitHub release; CI validates, hashes the
zip, lints migrations, and publishes a JSON index to Cloudflare R2 that
the host installer and public read API consume.

This repo runs on GitHub Actions plus an R2 bucket — no application
servers. The public read API lives in `addon-registry-api`; the host
installer lives in `phpvms/phpvms`.

## Layout

- `packages/{author}/{name}.yml` — addon entries
- `packages/{author}/meta.yml` — namespace metadata (display, maintainers)
- `schema/` — JSON schemas + the closed `category` enum
- `scripts/` — TypeScript validator, release automation, index builder
- `.github/workflows/` — CI definitions
- `docs/` — contributor and operator guides

## Contributing

See `docs/plugin-authors.md` for how to submit an addon (covers
both registry submission and migration rules).

## Spec

This repository was bootstrapped from the OpenSpec change
`openspec/changes/bootstrap-addon-registry/`. The capability specs in
that change describe the `registry-format`, `submission-pipeline`,
`release-automation`, and `index-publishing` rules in detail.
