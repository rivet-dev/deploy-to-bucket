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

Use browser or computer-use access to complete the one-time setup guide,
including the bucket, Worker, and CI credentials for uploads and automatic
hostname creation. Otherwise, ask me for the credentials or access you need.
```

## Quickstart

1. Have your agent complete the [one-time setup guide](SETUP.md). It creates the bucket and Worker, bucket-scoped R2 credentials, and a Cloudflare token for hostname creation.
2. Save the three secrets and six repository variables listed in the setup guide.
3. Add the workflows below and adjust your build command and output directory. Use `@main` for on-demand hostnames, or pin a tested commit SHA. `v0.1.0` still uses the old wildcard setup.

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
      - uses: rivet-dev/deploy-to-bucket@main
        with:
          cloudflare-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          zone-id: ${{ vars.CLOUDFLARE_ZONE_ID }}
          worker: ${{ vars.WEBSITE_WORKER }}
          access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
          secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          account-id: ${{ vars.R2_ACCOUNT_ID }}
          bucket: ${{ vars.R2_BUCKET }}
          domain: ${{ vars.WEBSITE_DOMAIN }}
          preview-domain: ${{ vars.WEBSITE_PREVIEW_DOMAIN }}
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
      - uses: rivet-dev/deploy-to-bucket@main
        with:
          cloudflare-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          zone-id: ${{ vars.CLOUDFLARE_ZONE_ID }}
          worker: ${{ vars.WEBSITE_WORKER }}
          access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
          secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          account-id: ${{ vars.R2_ACCOUNT_ID }}
          bucket: ${{ vars.R2_BUCKET }}
          domain: ${{ vars.WEBSITE_DOMAIN }}
          preview-domain: ${{ vars.WEBSITE_PREVIEW_DOMAIN }}
```

Keep the same concurrency group and hostname in both workflows. Cleanup runs without a checkout or build.

`main` publishes to your domain; PRs get preview URLs and a comment. The action creates each exact hostname with automatic DNS and HTTPS—no wildcard or ACM subscription. Closing a PR deletes its files and hostname bindings. The Worker and bucket stay in place. See the setup guide for token permissions, certificate timing, and hostname limits.

For `rivet-dev/website`, use the [pnpm deployment](examples/website.yml) and [cleanup](examples/website-cleanup.yml) workflows, and copy the [routing adapter](examples/website-config.ts) to `scripts/website-config.ts` to preserve redirects and headers. Build in CI, then pass `config: website-routing.json` to the action. Keep Railway serving production until the test hostname is verified; the MCP backend must remain running.
