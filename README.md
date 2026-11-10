# Deploy to Bucket

## What is this?

A GitHub Action that publishes static websites to your own Cloudflare R2 bucket and serves them through a Worker.

- Build your frontend directly in CI.
- No reliance on flaky, overpriced build infrastructure.
- Improve build speeds with better caching, faster machines, and self-hosted CI.
- Stored in object storage, cheap to serve.

## Agent prompt

```text
Follow the quickstart in this README:
https://github.com/rivet-dev/deploy-to-bucket/blob/main/README.md

If you have browser or computer-use access, use it to create the Cloudflare
API token. Otherwise, ask me to provide the token.
```

## Quickstart

1. Enable R2 in the Cloudflare account hosting your domain's DNS zone.
2. Open [User API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token → Custom token**. Grant **Account: Workers Scripts Edit, Workers R2 Storage Edit** and **Zone: Zone Read, DNS Edit, Workers Routes Edit**. Scope to your account and DNS zone; save the user token as the GitHub Actions secret `CLOUDFLARE_API_TOKEN`.
3. Add the two workflows below. Choose your hostname and adjust the build command and output directory. For an immutable action version, replace `@v1` with a release commit SHA.

**`.github/workflows/website.yml`**

```yaml
name: Website
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: website-r2-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: false
jobs:
  deploy:
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Build
        run: npm ci && npm run build
      - uses: rivet-dev/deploy-to-bucket@v1
        with:
          cloudflare-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          domain: website.gameinc.io
          directory: dist
```

**`.github/workflows/website-cleanup.yml`**

```yaml
name: Website cleanup
on:
  pull_request:
    types: [closed]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: website-r2-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: false
jobs:
  cleanup:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: rivet-dev/deploy-to-bucket@v1
        with:
          cloudflare-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          domain: website.gameinc.io
```

Keep the same concurrency group and hostname in both workflows. Cleanup runs without a checkout or build.

`main` publishes to your domain; PRs get preview URLs and a comment. Closing a PR deletes its assets and hostnames. The action creates the Worker, bucket, DNS, and TLS; use an unused hostname, since it refuses to overwrite existing DNS.

For `rivet-dev/website`, use the [pnpm deployment](examples/website.yml) and [cleanup](examples/website-cleanup.yml) workflows, and copy the [routing adapter](examples/website-config.mjs) to `scripts/website-config.mjs` to preserve redirects and headers. Build in CI, then pass `config: website-routing.json` to the action. Keep Railway serving production until the test hostname is verified; the MCP backend must remain running.
