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
including the bucket, Worker, wildcard routing, TLS, and bucket-scoped CI
credentials. Otherwise, ask me for the credentials or access you need.
```

## Quickstart

1. Have your agent complete the [one-time setup guide](SETUP.md). It provisions hosting and creates R2 Object Read & Write credentials scoped to one bucket. CI gets no Cloudflare management permissions.
2. Save the two secrets and four repository variables listed in the setup guide.
3. Add the workflows below and adjust your build command and output directory. Use `@v2`, or pin a release commit SHA.

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
      - uses: rivet-dev/deploy-to-bucket@v2
        with:
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
      - uses: rivet-dev/deploy-to-bucket@v2
        with:
          access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
          secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          account-id: ${{ vars.R2_ACCOUNT_ID }}
          bucket: ${{ vars.R2_BUCKET }}
          domain: ${{ vars.WEBSITE_DOMAIN }}
          preview-domain: ${{ vars.WEBSITE_PREVIEW_DOMAIN }}
```

Keep the same concurrency group and hostname in both workflows. Cleanup runs without a checkout or build.

`main` publishes to your domain; PRs get preview URLs and a comment. Closing a PR deletes its files and release pointers, so its URLs return 404. The action only changes objects in the preconfigured bucket; hosting infrastructure stays in place.

For `rivet-dev/website`, use the [pnpm deployment](examples/website.yml) and [cleanup](examples/website-cleanup.yml) workflows, and copy the [routing adapter](examples/website-config.mjs) to `scripts/website-config.mjs` to preserve redirects and headers. Build in CI, then pass `config: website-routing.json` to the action. Keep Railway serving production until the test hostname is verified; the MCP backend must remain running.
