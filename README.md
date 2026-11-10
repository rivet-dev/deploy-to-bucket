# Deploy to Bucket

## What is this?

Deploy static websites from CI to Cloudflare R2.

- Build directly in CI.
- Avoid flaky, expensive build infrastructure.
- Use better caching, faster machines, and self-hosted runners.
- Serve cheaply from object storage.

## Features

- Production domains, PR previews, and a separate URL for each release.
- PR comments with preview links; automatic asset cleanup when PRs close.
- Parallel uploads, retries, and reuse of unchanged content-hashed assets.
- Shared hashed assets keep older tabs working while their releases are retained. Defaults to `_astro/`; configure `immutablePrefixes` for other builds. Never reuse an immutable filename for different content.
- Seven-day retention after replacing production releases, with cleanup on subsequent deployments. The active release is always kept.
- Configurable redirects, headers, SPA fallback, and proxy routes.

## Not supported

- Server-side rendering or application server runtimes; deploy static build output only.
- Framework-aware version-skew protection such as [Next.js deployment-ID detection and automatic reloads](https://nextjs.org/docs/app/guides/self-hosting#version-skew).
- HTTP Range requests. Host media needing seeking or partial downloads on a separate asset service.
- Previews from forked PRs; only trusted same-repository PRs deploy.
- Worker edge caching or background cache refresh. Immutable assets have browser caching.

## Agent prompt

```text
Follow the quickstart in this README:
https://github.com/rivet-dev/deploy-to-bucket/blob/main/README.md

Use browser or computer-use access to complete the one-time setup guide,
including the bucket, Worker, wildcard routing, TLS, and bucket-scoped CI
credentials. Otherwise, ask me for the credentials or access you need.
```

## Quickstart

1. Follow the [one-time setup guide](SETUP.md) to create the bucket, Worker, wildcard routing, and bucket-scoped CI credentials.
2. Save the two secrets and four repository variables listed in the setup guide.
3. Add the workflows below and adjust your build command and output directory. Use `@main` below, or pin a tested commit SHA.

### ACM requirement

**Nested preview hostnames require ACM or equivalent certificate coverage.** For `pr-42.preview.gameinc.io`, provision a certificate for `*.preview.gameinc.io`. Cloudflare Universal SSL already covers first-level names such as `pr-42.gameinc.io`; a wildcard DNS record alone does not extend that coverage.

### Workflows

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
          access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
          secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          account-id: ${{ vars.R2_ACCOUNT_ID }}
          bucket: ${{ vars.R2_BUCKET }}
          domain: ${{ vars.WEBSITE_DOMAIN }}
          preview-domain: ${{ vars.WEBSITE_PREVIEW_DOMAIN }}
```

Keep the same concurrency group and hostname in both workflows. Cleanup runs without a checkout or build.

To give a non-production branch a stable hostname, set `branch-domain` only on that branch's push runs (for example, `staging.example.com`). Provision its routing and TLS first. Branch storage stays isolated from production; PR names remain `pr-N`. Leave this input empty for production and PRs.

For `rivet-dev/website`, follow the [integration guide](SETUP.md#4-integrate-and-verify).

## License

[MIT](LICENSE).
