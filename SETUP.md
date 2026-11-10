# Agent setup guide

Run this once with the user's Cloudflare dashboard session or local administrative credentials. CI must receive only the final bucket-scoped object credentials. It never creates buckets, changes DNS, issues certificates, or deploys Workers.

## 1. Confirm the site

Infer the repository, production hostname, account, and output directory from context; ask for anything unclear. Choose a dedicated preview suffix, for example `preview.gameinc.io`, giving `pr-42.preview.gameinc.io` and `production-r-123-1.preview.gameinc.io`. Use `*.gameinc.io` for testing. One bucket belongs to one website.

Inspect existing hosting, redirects, headers, and proxy routes. Preserve unrelated DNS and Workers. Stage on an unused hostname first; changing a currently served production hostname is a separate cutover.

## 2. Provision hosting outside CI

1. Enable R2 if needed and create a private bucket, for example `example-website`. Leave public R2 access disabled. Record its account ID and bucket name. This action uses the default R2 jurisdiction endpoint.
2. Deploy this repository's `worker.ts` as an ES module Worker with an R2 binding named **`BUCKET`** pointing to that bucket. For a dashboard upload, use the compiled `dist/worker.js`. With Wrangler, run `npm ci` in this repository, copy `wrangler.example.jsonc` to a local `wrangler.jsonc`, replace every example value, and run `npx wrangler deploy --config wrangler.jsonc`. Keep the config for future manual Worker upgrades; uploading a website does not update the Worker.
3. Attach the production hostname as a **Worker custom domain**. Cloudflare provisions its DNS and certificate. Inspect existing records first; do not overwrite another service's records. Attach any production alias or proxy hostname the routing config uses to the same Worker as well.
4. Add a **proxied wildcard DNS record** for `*.preview.gameinc.io`. With no origin server, a proxied A record pointing to the documentation address `192.0.2.1` can back the Worker route. Do not modify a zone-wide wildcard or unrelated records.
5. Add a **Worker route** for `*.preview.gameinc.io/*` in the correct zone, targeting this Worker. This is a route, not a wildcard custom domain: Worker custom domains do not support wildcards. The Wrangler example includes this route.
6. Ensure an **active edge certificate covers `*.preview.gameinc.io`**. In a `gameinc.io` zone, Universal SSL's `*.gameinc.io` certificate does not cover that deeper name. Use an appropriate Advanced or custom edge certificate, or a dedicated preview zone whose certificate covers its first-level subdomains. If the account needs a paid certificate feature or a different domain arrangement, ask the user to choose before proceeding. Complete certificate validation and wait for activation.

If using a local API token for setup, scope it to this account and zone with Workers Scripts Edit, Workers R2 Storage Edit, Zone Read, DNS Edit, and Workers Routes Edit. Certificate provisioning may require additional certificate permissions. Use the browser when available; otherwise ask the user for the needed setup credentials or help with dashboard-only steps. **Do not store these administrative credentials in GitHub Actions.**

## 3. Create the CI credentials

In **R2 → Manage API Tokens**, create a token with **Object Read & Write**, restricted to **only this website's bucket**. Account-owned or user-owned R2 tokens both work because CI uses their S3 credentials, not Cloudflare's management API.

Save the generated credentials as GitHub repository secrets:

- `R2_ACCESS_KEY_ID`: the S3 Access Key ID.
- `R2_SECRET_ACCESS_KEY`: the S3 Secret Access Key.

Save these non-secret GitHub repository variables:

- `R2_ACCOUNT_ID`: Cloudflare account ID.
- `R2_BUCKET`: existing bucket name.
- `WEBSITE_DOMAIN`: production hostname, without a scheme.
- `WEBSITE_PREVIEW_DOMAIN`: wildcard suffix, without `*.` or a scheme.

The CI token needs object upload, read/list, and delete access so it can publish and clean up. It needs **no account, bucket administration, Workers, DNS, zone, or certificate permissions**. Never print credentials in chat, logs, or committed files. Revoke any temporary setup token after setup is complete.

## 4. Integrate and verify

Add the deployment and cleanup workflows from [README.md](README.md), adjusting the build and output directory to the repository. Keep their concurrency groups identical. Only trusted same-repository PRs deploy.

For `rivet-dev/website`, use [the pnpm example](examples/website.yml) and [cleanup workflow](examples/website-cleanup.yml). Copy [the routing adapter](examples/website-config.ts) into `scripts/website-config.ts`; run it after the build and pass `config: website-routing.json`. Set up alias/proxy hostnames before enabling them in the routing config. The MCP backend must remain running at a reachable HTTPS origin.

Verify HTTPS to an arbitrary unused preview hostname returns the Worker's `404` with `Cache-Control: no-store`, without a certificate error. Then run the workflow on the test hostname: check the production URL, a PR preview, its fixed release URL, redirects, assets, and PR comment. Close the PR and confirm its objects are gone and both preview URLs return `404`. **The shared wildcard DNS, route, certificate, Worker, and bucket remain.**

Before any production cutover, verify the site's required routing behavior on the test hostname. CI can update files anywhere in its one bucket, including production; use separate buckets and credentials if production and previews need separate trust boundaries.

References: [R2 token scopes](https://developers.cloudflare.com/r2/api/tokens/), [Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Universal SSL coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).
