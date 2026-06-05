#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scaffold-demo-app.sh --app-slug SLUG --repo-name NAME --github-owner OWNER \
       --base-domain DOMAIN [--platform-repo OWNER/REPO] [--output-dir PATH]

Scaffolds a demo app repo for static-hosting-for-vibe-coders.
EOF
}

APP_SLUG=""
REPO_NAME=""
GITHUB_OWNER=""
BASE_DOMAIN=""
PLATFORM_REPO="AlexeyPopovUA/static-hosting-for-vibe-coders"
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-slug) APP_SLUG="$2"; shift 2 ;;
    --repo-name) REPO_NAME="$2"; shift 2 ;;
    --github-owner) GITHUB_OWNER="$2"; shift 2 ;;
    --base-domain) BASE_DOMAIN="$2"; shift 2 ;;
    --platform-repo) PLATFORM_REPO="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$APP_SLUG" || -z "$REPO_NAME" || -z "$GITHUB_OWNER" || -z "$BASE_DOMAIN" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="../$REPO_NAME"
fi

if [[ -e "$OUTPUT_DIR" && -n "$(ls -A "$OUTPUT_DIR" 2>/dev/null || true)" ]]; then
  echo "Output directory is not empty: $OUTPUT_DIR" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"/{public,scripts,.github/workflows}

cat > "$OUTPUT_DIR/package.json" <<EOF
{
  "name": "$REPO_NAME",
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
EOF

cat > "$OUTPUT_DIR/mise.toml" <<'EOF'
[tools]
node = "24.16.0"
pnpm = "10.34.1"
EOF

cat > "$OUTPUT_DIR/.gitignore" <<'EOF'
node_modules/
dist/
.pnpm-store/
EOF

cat > "$OUTPUT_DIR/scripts/build.mjs" <<'EOF'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

mkdirSync(dist, { recursive: true });
cpSync(join(root, 'public'), dist, { recursive: true });

const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
writeFileSync(join(dist, '404.html'), indexHtml);

console.log('Built dist/ with SPA fallback 404.html');
EOF

cat > "$OUTPUT_DIR/public/index.html" <<EOF
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${REPO_NAME}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main>
      <p class="label">Static hosting demo</p>
      <h1 id="title">Home</h1>
      <p class="lead">App <code>${APP_SLUG}</code> at <code id="host"></code></p>
      <nav class="nav" aria-label="Routes">
        <a href="/" data-route="/">Home</a>
        <a href="/about" data-route="/about">About</a>
      </nav>
      <section id="content" class="content"></section>
    </main>
    <script src="/app.js" type="module"></script>
  </body>
</html>
EOF

cat > "$OUTPUT_DIR/public/styles.css" <<'EOF'
:root {
  color-scheme: light dark;
  --bg: #0b1020;
  --card: #121829;
  --text: #eef2ff;
  --muted: #94a3b8;
  --accent: #38bdf8;
  --border: color-mix(in srgb, var(--text) 12%, transparent);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
}
main {
  width: min(92vw, 42rem);
  margin: 4rem auto;
  padding: 2rem;
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: var(--card);
}
.label { color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.875rem; }
.lead { color: var(--muted); }
.nav { display: flex; gap: 0.75rem; margin: 1.5rem 0; }
.nav a { color: var(--accent); }
.content { line-height: 1.7; }
code { font-family: ui-monospace, monospace; }
EOF

cat > "$OUTPUT_DIR/public/app.js" <<'EOF'
const routes = {
  '/': { title: 'Home', html: '<p>Push to <code>main</code> deploys production. PRs get branch preview URLs.</p>' },
  '/about': { title: 'About', html: '<p>History routing works via branch-level <code>404.html</code> SPA fallback.</p>' },
};

function render(pathname) {
  const route = routes[pathname] ?? routes['/'];
  document.getElementById('title').textContent = route.title;
  document.getElementById('content').innerHTML = route.html;
}

function navigate(pathname) {
  history.pushState({ pathname }, '', pathname);
  render(pathname);
}

document.getElementById('host').textContent = location.hostname;
document.querySelector('.nav').addEventListener('click', (event) => {
  const link = event.target.closest('[data-route]');
  if (!link) return;
  event.preventDefault();
  navigate(link.dataset.route);
});
window.addEventListener('popstate', () => render(location.pathname));
render(location.pathname);
EOF

cat > "$OUTPUT_DIR/.github/workflows/deploy.yml" <<EOF
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
    uses: ${PLATFORM_REPO}/.github/workflows/deploy-app.yml@main
    with:
      app-slug: ${APP_SLUG}
      build-command: pnpm build
      output-dir: dist
      base-domain: ${BASE_DOMAIN}
    secrets: inherit
EOF

cat > "$OUTPUT_DIR/.github/workflows/cleanup.yml" <<EOF
name: Cleanup

on:
  delete:

permissions:
  id-token: write
  contents: read

jobs:
  cleanup:
    if: github.event.ref_type == 'branch'
    uses: ${PLATFORM_REPO}/.github/workflows/cleanup-branch.yml@main
    with:
      app-slug: ${APP_SLUG}
      branch: \${{ github.event.ref }}
    secrets: inherit
EOF

cat > "$OUTPUT_DIR/README.md" <<EOF
# ${REPO_NAME}

Demo app for [static-hosting-for-vibe-coders](https://github.com/${PLATFORM_REPO}).

| Environment | URL |
|-------------|-----|
| Production | \`https://${APP_SLUG}.${BASE_DOMAIN}\` |
| Branch preview | \`https://${APP_SLUG}--{branch}.dev.${BASE_DOMAIN}\` |

\`\`\`bash
mise install && pnpm install && pnpm build
\`\`\`

Requires \`AWS_AUTH_ROLE\` repository variable and OIDC trust for this repo.
EOF

(cd "$OUTPUT_DIR" && pnpm install)

echo "Scaffolded demo app at: $OUTPUT_DIR"
echo "Production URL: https://${APP_SLUG}.${BASE_DOMAIN}"
echo ""
echo "Next steps:"
echo "  cd $OUTPUT_DIR"
echo "  pnpm build"
echo "  git init -b main && git add -A && git commit -m \"chore: bootstrap demo app\""
echo "  gh repo create ${GITHUB_OWNER}/${REPO_NAME} --public --source=. --remote=origin --push"
echo "  gh variable set AWS_AUTH_ROLE --repo ${GITHUB_OWNER}/${REPO_NAME} --body \"\$(gh variable get AWS_AUTH_ROLE -R ${PLATFORM_REPO})\""
