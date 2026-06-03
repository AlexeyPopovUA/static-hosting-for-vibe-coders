# Demo App Reference

## URL mapping

| Trigger | URL | S3 prefix |
|---------|-----|-----------|
| Push to `main` | `https://{app-slug}.{baseDomain}` | `/{app-slug}/main/` |
| Pull request | `https://{app-slug}--{branch}.dev.{baseDomain}` | `/{app-slug}/{sanitized-branch}/` |

Branch names are sanitized by the deploy workflow (`feature/login` → `feature-login`).

## Deploy workflow template

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  deploy:
    uses: {{PLATFORM_REPO}}/.github/workflows/deploy-app.yml@main
    with:
      app-slug: {{APP_SLUG}}
      build-command: pnpm build
      output-dir: dist
      base-domain: {{BASE_DOMAIN}}
    secrets: inherit
```

## Cleanup workflow template

`.github/workflows/cleanup.yml`:

```yaml
name: Cleanup

on:
  delete:
  pull_request:
    types: [closed]

permissions:
  id-token: write
  contents: read

jobs:
  cleanup:
    if: github.event_name == 'pull_request' || github.event.ref_type == 'branch'
    uses: {{PLATFORM_REPO}}/.github/workflows/cleanup-branch.yml@main
    with:
      app-slug: {{APP_SLUG}}
      branch: ${{ github.event.ref_name || github.head_ref }}
    secrets: inherit
```

## Minimal package.json

```json
{
  "name": "{{REPO_NAME}}",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs"
  },
  "packageManager": "pnpm@10.34.1",
  "engines": {
    "node": ">=24",
    "pnpm": ">=10"
  }
}
```

## Build script (static site + SPA fallback)

`scripts/build.mjs` copies `public/` → `dist/` and duplicates `index.html` as `404.html`.
Required for history-based client-side routing on this platform.

## Common failures

| Symptom | Fix |
|---------|-----|
| Workflow `startup_failure` in ~2s | Add `permissions` block to caller workflow |
| `Could not assume role` / OIDC error | Add repo to IAM trust policy; set `AWS_AUTH_ROLE` var |
| `Invalid app slug` in CI | Use lowercase alphanumeric + hyphens only; no `--` |
| Deep link returns global 404 HTML | Ensure build outputs branch-level `404.html` (= `index.html`) |
| Assets 403 | Wrong path or missing file after `s3 sync --delete` |
| `ERR_PNPM_NO_LOCKFILE` / frozen-lockfile error | Commit `pnpm-lock.yaml` (scaffold runs `pnpm install` automatically) |

## OIDC trust entry format

Add to `token.actions.githubusercontent.com:sub` StringLike list:

```
repo:{{GITHUB_OWNER}}/{{REPO_NAME}}:*
```

Keep the list sorted for easier diffs.

## Optional: test PR preview

After production deploy works:

1. Create branch `feat/demo-preview`
2. Change visible text in `public/index.html`, push, open PR
3. Confirm workflow comment with preview URL
4. Merge PR → cleanup workflow removes branch prefix from S3
