---
name: create-demo-app
description: >-
  Scaffolds a GitHub demo app repo for the static-hosting-for-vibe-coders
  platform: pnpm build, deploy/cleanup workflows, OIDC trust, and AWS_AUTH_ROLE.
  Use when creating a demo app, test app, sample deployment repo, or wiring an
  app repo to deploy-app.yml on main branch pushes.
---

# Create Demo App for Static Hosting

Creates a **separate GitHub repo** that deploys to the shared S3 bucket + CloudFront
distribution via the reusable `deploy-app.yml` workflow.

Reference implementation: [static-hosting-demo-app](https://github.com/AlexeyPopovUA/static-hosting-demo-app)

## Inputs to collect

| Input | Rules | Example |
|-------|-------|---------|
| `app-slug` | `[a-z0-9-]`, 1–63 chars, no `--` | `hosting-demo` |
| `repo-name` | GitHub repo name | `static-hosting-demo-app` |
| `github-owner` | Org or user | `AlexeyPopovUA` |
| `base-domain` | From `HOSTING_DOMAIN_NAME` var | `demo.oleksiipopov.com` |
| `platform-repo` | This repo | `AlexeyPopovUA/static-hosting-for-vibe-coders` |

Validate the slug before scaffolding:

```bash
pnpm validate:names --app "$APP_SLUG"
```

## Quick scaffold

From the platform repo root:

```bash
.cursor/skills/create-demo-app/scripts/scaffold-demo-app.sh \
  --app-slug hosting-demo \
  --repo-name static-hosting-demo-app \
  --github-owner AlexeyPopovUA \
  --base-domain demo.oleksiipopov.com \
  --output-dir ../static-hosting-demo-app
```

Then:

```bash
cd ../static-hosting-demo-app
pnpm build
git init -b main && git add -A && git commit -m "chore: bootstrap demo app"
```

The scaffold script runs `pnpm install` and generates `pnpm-lock.yaml` (required by CI `--frozen-lockfile`).

## GitHub + AWS setup (required)

Copy this checklist and complete every item:

```
- [ ] Create GitHub repo and push main
- [ ] Set repo variable AWS_AUTH_ROLE (same ARN as platform repo)
- [ ] Add repo to OIDC IAM role trust policy
- [ ] Verify Deploy workflow succeeds on push to main
- [ ] Smoke-test production URL and SPA deep link
```

### 1. Repository variable

```bash
gh variable set AWS_AUTH_ROLE \
  --repo "$GITHUB_OWNER/$REPO_NAME" \
  --body "$(gh variable get AWS_AUTH_ROLE -R "$PLATFORM_REPO")"
```

### 2. OIDC trust policy

The shared GHA OIDC role must trust the new repo. Read current policy, append
`repo:$GITHUB_OWNER/$REPO_NAME:*`, and update:

```bash
ROLE_ARN=$(gh variable get AWS_AUTH_ROLE -R "$PLATFORM_REPO")
ROLE_NAME="${ROLE_ARN##*/}"
aws iam get-role --role-name "$ROLE_NAME" \
  --query 'Role.AssumeRolePolicyDocument' --output json > /tmp/oidc-trust.json
# Append repo:OWNER/REPO:* to StringLike sub list, then:
aws iam update-assume-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-document file:///tmp/oidc-trust.json
```

Skip if the repo is already listed.

### 3. Caller workflow permissions (critical)

Cross-repo reusable workflows **fail at startup** without explicit permissions on
the **caller** workflow. Both `deploy.yml` and `cleanup.yml` must include:

```yaml
permissions:
  id-token: write
  contents: read
  pull-requests: write   # deploy only; cleanup omits this
```

## Post-deploy verification

Production URL: `https://{app-slug}.{base-domain}`

Branch preview: `https://{app-slug}--{branch}.dev.{base-domain}`

```bash
BASE=demo.oleksiipopov.com   # replace with base-domain
APP=hosting-demo             # replace with app-slug

curl -sI "https://${APP}.${BASE}/" | head -1
curl -sI -H 'Accept: text/html' "https://${APP}.${BASE}/about" | head -1   # SPA: 404 + HTML
curl -sI "https://${APP}.${BASE}/styles.css" | head -1

gh run watch --repo "$GITHUB_OWNER/$REPO_NAME" $(gh run list -R "$GITHUB_OWNER/$REPO_NAME" --limit 1 --json databaseId -q '.[0].databaseId')
```

## App requirements

- **pnpm** package manager (platform convention)
- **`pnpm-lock.yaml` committed** (CI uses `pnpm install --frozen-lockfile`; scaffold generates it)
- Build output in `dist/` (or override `output-dir` in deploy workflow)
- For SPAs: build must emit `404.html` identical to `index.html` (scaffold script does this)
- App slug becomes the S3 prefix: `/{app-slug}/{branch}/`

## Customization after scaffold

| Goal | Change |
|------|--------|
| Vite/React/etc. | Replace `public/` + `scripts/build.mjs`; keep `404.html` SPA fallback in build |
| Different output dir | Set `output-dir` in `.github/workflows/deploy.yml` |
| Deploy on PR only | Remove `push: branches: [main]` trigger |
| No branch cleanup | Delete `.github/workflows/cleanup.yml` |

## Additional resources

- File templates and OIDC details: [reference.md](reference.md)
- Platform spec (URL layout, 404 rules): [docs/SPEC.md](../../../docs/SPEC.md)
- Connect-an-app docs: [README.md](../../../README.md)
