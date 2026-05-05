# Operations

This document is for registry maintainers. Addon authors should read
[`plugin-authors.md`](./plugin-authors.md).

## Repository overview

- `packages/{author}/{name}.yml` — addon entries.
- `packages/{author}/meta.yml` — namespace metadata.
- `schema/` — JSON Schemas + the closed `category` enum.
- `scripts/` — TypeScript: validator, release automation, index builder.
- `.github/workflows/` — CI definitions.
- `dist/` — gitignored build artifacts (`raw/packages.json`,
  `raw/keywords.json`).

## Canonical repo gating

All four production workflows skip on forks via the condition
`github.repository == (vars.CANONICAL_REPO || 'phpvms/addon-registry')`.

If the canonical home of the registry differs (renamed org, transferred
to a personal account, staging fork), set the `CANONICAL_REPO`
**repository variable** (Settings -> Secrets and variables -> Actions ->
Variables -> New repository variable) to `owner/repo`. The workflows
pick it up on the next run.

Forks of the canonical repo will never run the production workflows
(no APP_TOKEN secret available, no R2 credentials), which is the safe
default behaviour.

## Required repository secrets

| Secret                  | Used by             | Purpose                                                            |
| ----------------------- | ------------------- | ------------------------------------------------------------------ |
| `APP_ID`                | bot-acting flows    | Numeric ID of the `phpvms-addon-bot` GitHub App.                   |
| `APP_PRIVATE_KEY`       | bot-acting flows    | PEM-encoded private key for the App.                               |
| `R2_ACCOUNT_ID`         | publish workflow    | Cloudflare account that owns the R2 bucket.                        |
| `R2_ACCESS_KEY_ID`      | publish workflow    | R2 token (read+write on the registry bucket only).                 |
| `R2_SECRET_ACCESS_KEY`  | publish workflow    | R2 token secret.                                                   |
| `R2_BUCKET`             | publish workflow    | Bucket name (e.g. `phpvms-addon-registry`).                        |
| `WORKER_REFRESH_SECRET` | publish workflow    | Bearer token for `POST /v1/internal/refresh` on the read API.      |

The default `GITHUB_TOKEN` is sufficient for read-only public API calls
(checking source repos, listing releases). Bot-acting workflows mint an
App installation token via `actions/create-github-app-token`.

## R2 bucket layout

```
raw/
  packages.json   # one JSON object keyed by package name
  keywords.json   # keyword to count map
```

The publish workflow overwrites both objects on every successful run.
The worker (`addon-registry-api`) reads them and serves them with
edge-cached responses; it never writes to R2.

## Cross-repo credential map

Three groups of credentials, three different homes. Don't merge them.

| Group               | Stored in                          | Used by                          |
| ------------------- | ---------------------------------- | -------------------------------- |
| Registry CI         | `addon-registry` repo secrets       | This repo's workflows           |
| Worker runtime      | Cloudflare Worker secrets (wrangler) | `addon-registry-api` runtime    |
| Worker deploy       | `addon-registry-api` repo secrets   | `addon-registry-api` workflow   |

### Registry CI (this repo)

| Secret                  | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `APP_ID`                | GitHub App ID (used to mint installation tokens).           |
| `APP_PRIVATE_KEY`       | GitHub App private key PEM.                                 |
| `R2_ACCOUNT_ID`         | Cloudflare account ID owning the R2 bucket.                 |
| `R2_ACCESS_KEY_ID`      | R2 token (S3-API access; read+write on the registry bucket). |
| `R2_SECRET_ACCESS_KEY`  | R2 token secret.                                            |
| `R2_BUCKET`             | Bucket name.                                                |
| `WORKER_REFRESH_SECRET` | Bearer token CI sends to the worker's refresh endpoint.    |

`CANONICAL_REPO` is a repository **variable** (not secret) and is
optional; defaults to `phpvms/addon-registry`.

### Worker runtime (addon-registry-api, set via `wrangler secret put`)

| Secret                                | Purpose                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `WORKER_REFRESH_SECRET`               | Bearer-validates incoming `POST /v1/internal/refresh` from the registry.    |
| `DISPATCH_GITHUB_APP_ID`              | Reuses the same `phpvms-addon-bot` App. Numeric ID.                         |
| `DISPATCH_GITHUB_APP_PRIVATE_KEY`     | Same PEM as registry's `APP_PRIVATE_KEY`.                                   |
| `DISPATCH_GITHUB_APP_INSTALLATION_ID` | Numeric installation ID for `addon-registry`.                              |
| `TINYBIRD_TOKEN`                      | Read token for the analytics workspace (stats merge into list endpoint).   |

R2 access from the worker is a **runtime binding**, not a secret. In
`wrangler.jsonc`:

```jsonc
"r2_buckets": [
  { "binding": "REGISTRY_R2", "bucket_name": "phpvms-addon-registry" }
]
```

The worker reads via `env.REGISTRY_R2.get("raw/packages.json")` — no
key, no signing. The bucket name MUST match this repo's `R2_BUCKET`
secret value.

### Worker deploy (addon-registry-api repo, via Actions secrets)

| Secret                  | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Account hosting the worker.                              |
| `CLOUDFLARE_API_TOKEN`  | Token with `Workers Scripts: Edit`, `Workers R2: Edit` scopes. |

These let `wrangler deploy` push the worker. They are **not** in this
repo and **not** in the worker's runtime — they're in
`addon-registry-api`'s Actions secrets, used only at deploy time.

### Rotation cross-references

- Rotating `APP_PRIVATE_KEY` here means also rotating the worker's
  `DISPATCH_GITHUB_APP_PRIVATE_KEY` to the same PEM. Set both, then
  revoke the old key on the App.
- Rotating `WORKER_REFRESH_SECRET` requires changing both the registry
  secret AND the worker secret in coordinated order; see the
  rotation procedure below.

## GitHub App: phpvms-addon-bot

The bot identity is a **GitHub App** (NOT an OAuth App). GitHub Apps
authenticate as themselves with short-lived installation tokens, have
fine-grained permissions, and never need a user to be logged in. OAuth
Apps are for end-user sign-in flows and are not appropriate here.

### One-time provisioning

These steps are performed once, by an org owner. After this, secret
rotation (see below) is the only routine maintenance.

#### Step 1: Create the App

1. Sign in to GitHub as a member of the `phpvms` org with the
   **Owner** role.
2. Navigate to:
   `https://github.com/organizations/phpvms/settings/apps/new`.
   (For a personal-account App during early development, use
   `https://github.com/settings/apps/new` instead. Org ownership is
   the recommended long-term home.)
3. Fill in the form as follows:

   | Field                           | Value                                              |
   | ------------------------------- | -------------------------------------------------- |
   | GitHub App name                 | `phpvms-addon-bot`                                 |
   | Homepage URL                    | `https://github.com/phpvms/addon-registry`         |
   | Identifying and authorizing users | leave the **Callback URL** field blank          |
   | Post installation               | leave **Setup URL** blank; uncheck "Redirect on update" |
   | Webhook                         | **uncheck** "Active". Leave webhook URL and secret blank |

   The bot does not authenticate users (no callback URL needed) and does
   not receive events via webhook (workflows trigger via GitHub Actions
   on `pull_request`, `push`, `schedule`, and `repository_dispatch`).
   Disabling webhooks avoids needing a public webhook receiver.

4. **Repository permissions** — set exactly these three; leave all
   others as `No access`:

   | Permission     | Access |
   | -------------- | ------ |
   | Contents       | Read & write |
   | Pull requests  | Read & write |
   | Issues         | Read & write |

   Rationale:
   - **Contents: write** is needed to push commits to bot branches.
   - **Pull requests: write** is needed to open/update PRs and enable
     auto-merge.
   - **Issues: write** is needed because PR labels (the `error` label)
     live under the Issues permission scope.

5. **Organization permissions**: leave everything as `No access`.
6. **User permissions**: leave everything as `No access`.
7. **Where can this GitHub App be installed?** select
   **Only on this account**. The App must not leak to other
   organisations.
8. Click **Create GitHub App**. GitHub takes you to the App's settings
   page.

#### Step 2: Generate a private key

On the App's settings page, scroll to **Private keys** and click
**Generate a private key**. A `.pem` file downloads automatically;
keep it on your machine just long enough to copy into the repo secret
(next step), then delete it.

#### Step 3: Note the App ID

On the same settings page, near the top, copy the numeric **App ID**
(displayed as `App ID: 12345`).

#### Step 4: Install the App on this repo

The web flow is fastest the first time:

1. From the App's settings page, click **Install App** in the left
   sidebar.
2. Choose the `phpvms` org.
3. Select **Only select repositories** and pick `addon-registry`. Do
   not select "All repositories" — the App should be scoped to this
   repo only.
4. Click **Install**.

(For repeat installs or scripted setups on a fresh org, see
[App-installation via gh](#app-installation-via-gh) below.)

#### Step 5: Add the secrets to this repo

The remaining steps are scriptable. Run from a shell with `gh` logged
in as a repo admin (`gh auth login`), with the downloaded private-key
PEM file in your working directory:

```bash
# Sanity: gh sees the right repo
gh repo view phpvms/addon-registry --json nameWithOwner

# APP_ID — numeric, from the App settings page
gh secret set APP_ID --repo phpvms/addon-registry --body "<numeric-id>"

# APP_PRIVATE_KEY — read directly from the .pem file
gh secret set APP_PRIVATE_KEY --repo phpvms/addon-registry < phpvms-addon-bot.<date>.private-key.pem

# Canonical repo variable (only needed if the repo lives somewhere
# other than the hardcoded fallback `phpvms/addon-registry`)
gh variable set CANONICAL_REPO --repo phpvms/addon-registry --body "phpvms/addon-registry"

# Verify
gh secret list --repo phpvms/addon-registry
gh variable list --repo phpvms/addon-registry
```

After uploading, **shred the local PEM**:

```bash
shred -u phpvms-addon-bot.*.private-key.pem      # Linux
# or, on macOS:
rm -P phpvms-addon-bot.*.private-key.pem
```

> **Why repository secrets, not environment secrets?**
> Environments add a manual approval gate before a job can read their
> secrets. That fits "production deploy needs a human approver"
> workflows; ours are PR-time validation and merge-time bot actions
> that must run automatically on every event. Gating `validate-pr`
> behind environment approval would require clicking "approve" on
> every contributor PR before validation runs. Use plain repository
> secrets for `APP_ID`, `APP_PRIVATE_KEY`, the four `R2_*` values, and
> `WORKER_REFRESH_SECRET`. Environments are appropriate later if we
> add a destructive workflow (e.g. bulk R2 deletion) where a manual
> reviewer should sign off.

#### Step 6: Verify the install

Trigger any bot-acting workflow manually (e.g.
**Actions -> Discovery -> Run workflow**). The first step that mints a
token (`Set up bot env -> Generate App token`) should succeed and a
subsequent step should be able to call the API.

If the token-minting step fails:
- `bad credentials` -> the private key in `APP_PRIVATE_KEY` is wrong
  or malformed (missing newlines, wrong PEM block).
- `installation not found` -> the App is not installed on this repo,
  or it's installed on a different repo.
- `resource not accessible by integration` -> the App's permissions
  are missing one of contents/pull-requests/issues. Edit them in the
  App settings and re-install on the repo to apply.

### App-installation via gh

The web-form install in Step 4 is the easiest path. If you need to
script the install (e.g. provisioning a fresh registry for a fork or
staging environment), `gh` can drive it via the App's installation
endpoints:

```bash
# Replace <APP_SLUG> with your App's URL slug (the bit after
# /apps/ in the App's public URL, e.g. "phpvms-addon-bot").
APP_SLUG="phpvms-addon-bot"
ORG="phpvms"
REPO="addon-registry"

# 1. Get the App's installation ID for the org
INSTALL_ID=$(gh api "/orgs/$ORG/installation" --jq '.id')

# 2. Get the repository's numeric ID
REPO_ID=$(gh api "/repos/$ORG/$REPO" --jq '.id')

# 3. Add this repo to the App's installation (if the App was
#    installed at the org level with "Only select repositories")
gh api -X PUT "/user/installations/$INSTALL_ID/repositories/$REPO_ID"

# 4. Verify the App can see the repo
gh api "/repos/$ORG/$REPO/installation" --jq '.app_slug, .permissions'
```

The PUT call requires the App to already exist; `gh` cannot create the
App itself (no GitHub API endpoint exists for creating an App from
scratch). Step 1 (the web form) remains a one-time manual action.

### Permissions reference

The App needs **no permissions on author repositories**. Author repo
data (release lists, zip downloads) is read via the unauthenticated
public GitHub API using the runner's default `GITHUB_TOKEN` (which has
60-req/h rate limit anonymously, 1000/h authenticated against the
runner's own repo). Bot-acting calls (PRs, comments, labels) use the
short-lived installation token minted from `APP_ID` + `APP_PRIVATE_KEY`.

Tokens are minted per workflow run via `actions/create-github-app-token`
and expire in 1 hour. They are never stored in long-lived secrets and
never echoed to logs.

## Branch protection (manual configuration)

GitHub branch protection settings cannot be fully provisioned from this
repo. Configure on `main` via Settings -> Branches -> Branch protection
rules:

- Require a pull request before merging.
- Require status checks to pass before merging.
  - Add: `validate / validate` (the validate-pr workflow's job).
  - Add: `ci / test` (the typecheck + unit-test workflow).
- Require linear history.
- Allow squash merging only (disable merge commits and rebase merging).
- Require branches to be up to date before merging.
- Do not require approvals in v1 (one maintainer); enable a 1-approval
  rule when the registry gains a second maintainer.

## Secret rotation

### GitHub App private key

1. In the App's settings page (web), click **Generate a private key**.
   A new `.pem` downloads.
2. Upload it as the new `APP_PRIVATE_KEY`:
   ```bash
   gh secret set APP_PRIVATE_KEY --repo phpvms/addon-registry < phpvms-addon-bot.<date>.private-key.pem
   ```
3. Confirm a workflow run still mints a token successfully (re-run the
   most recent publish or discovery workflow).
4. In the App's settings, revoke the old private key.
5. Shred the local `.pem`.

### R2 credentials

1. In Cloudflare R2, create a new API token scoped to the registry
   bucket (read+write on that bucket only).
2. Update both secrets:
   ```bash
   gh secret set R2_ACCESS_KEY_ID  --repo phpvms/addon-registry --body "<new-key-id>"
   gh secret set R2_SECRET_ACCESS_KEY --repo phpvms/addon-registry --body "<new-secret>"
   ```
3. Re-run the publish workflow on the latest `main` commit; verify it
   uploads cleanly.
4. Revoke the previous token in Cloudflare.

### Worker refresh secret

1. Coordinate with `addon-registry-api`: agree on a new value, deploy
   the worker with the new value.
2. Update `WORKER_REFRESH_SECRET` here:
   ```bash
   gh secret set WORKER_REFRESH_SECRET --repo phpvms/addon-registry --body "<new-secret>"
   ```
3. Run the publish workflow once to confirm refresh succeeds.
4. The worker repo can then drop the old value.

The window between (1) and (3) tolerates publish workflow failures —
they don't roll back R2, only fail the run.

## Manual workflow re-runs

- **publish**: `Actions -> Publish index -> Run workflow` on `main`.
  Idempotent; re-run on the same SHA produces byte-identical R2 objects.
- **discovery**: `Actions -> Discovery -> Run workflow` on `main` for a
  manual sweep.
- **validate-pr**: cannot be manually re-triggered; pushing a new commit
  to the PR (or an empty commit) re-runs it.

## Triaging a failing bot PR

When a bot PR has the `error` label:

1. Read the validator comment for the failure mode.
2. Check the upstream repo's release for breakage (re-uploaded zip,
   broken migration, vendored secret).
3. If the upstream is fixed, push an empty commit to the bot branch to
   re-run validation. On success, the workflow removes the label.
4. If the upstream is broken-and-not-going-to-be-fixed, close the bot
   PR. Discovery will re-open it on the next sweep — to suppress that,
   either delete the upstream release or mark the package archived
   pending author response (see [`revocation.md`](./revocation.md)).

## Common debug commands

```bash
# Validate locally (read-only; no PR comment posted)
npm run validate                          # requires GITHUB_TOKEN env

# Resolve the latest release for a package
npx tsx scripts/resolve-release.ts packages/acme/reports.yml

# Append a release block to a YAML in place
npx tsx scripts/append-release-block.ts packages/acme/reports.yml

# Build the index without uploading (writes to dist/raw/)
npm run build-index -- --no-upload --no-refresh
```
