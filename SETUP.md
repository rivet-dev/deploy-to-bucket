# Agent setup guide

Run this once using the user's Cloudflare dashboard session or local setup credentials. Setup creates the bucket and router Worker. CI uploads files and attaches **exact Worker custom domains** as needed; Cloudflare creates their DNS records and certificates. No wildcard DNS, wildcard route, or separate Advanced Certificate Manager subscription is needed, including for nested preview hostnames.

## 1. Confirm and provision the site

Infer the repository, production hostname, account, and output directory from context; ask for anything unclear. Choose a dedicated preview suffix, such as `preview.gameinc.io`, giving `pr-42.preview.gameinc.io` and `production-r-123-1.preview.gameinc.io`. All hostnames, including aliases and proxies, must belong to the same active Cloudflare zone. Use subdomains under `gameinc.io` for testing. Give each website its own bucket, Worker, and preview suffix.

1. Enable R2 and create a private bucket, such as `example-website`. Leave public bucket access disabled. Record its account ID and bucket name. The action uses the default R2 jurisdiction endpoint.
2. Deploy this repository's `worker.ts` with an R2 binding named **`BUCKET`** pointing to the bucket. Run `npm ci`, copy `wrangler.example.jsonc` to a local `wrangler.jsonc`, replace its example values, and run `npx wrangler deploy --config wrangler.jsonc`. For dashboard uploads, use `dist/worker.js`. Record the Worker name and zone ID. Leave `routes` omitted in the Wrangler config so manual Worker upgrades preserve the domains CI attaches.
3. Leave new hostnames without DNS records: CI will attach them on the first deployment. Inspect existing hosting, redirects, headers, and proxy routes before a migration. The action reuses domains already attached to this Worker, but refuses to replace existing DNS records or another Worker's binding. Stage on an unused hostname; handle an existing production hostname's cutover deliberately in the dashboard, then rerun CI.

Use the browser when available; otherwise ask the user for setup credentials or help with dashboard-only steps. Local setup may require Workers Scripts Edit and Workers R2 Storage Edit, plus permissions for any deliberate DNS/domain migration. Do not give CI bucket administration permissions. Keep the local config for manual Worker upgrades; website uploads do not redeploy Worker code.

## 2. Create CI credentials

Create these GitHub repository secrets:

- **`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`**: in **R2 → Manage API Tokens**, create **Object Read & Write** credentials restricted to this website's bucket. CI needs upload, list, and delete access.
- **`CLOUDFLARE_API_TOKEN`**: create a custom API token with **Account → Workers Scripts → Edit**, scoped to this account, and **Zone → Workers Routes → Edit**, **Zone → Zone → Read**, and **Zone → DNS → Read**, scoped to this zone. The action uses the Worker custom-domain API to attach/detach hostnames and reads DNS to detect conflicts; it does not write DNS records directly or manage certificates through the SSL API.

Workers Scripts Edit also allows Worker code changes: Cloudflare's custom-domain API requires this broader permission. Use only trusted same-repository PRs. The R2 credentials remain bucket-scoped; use separate accounts/buckets if production and previews need separate trust boundaries. Never print credentials in chat, logs, or committed files. Revoke temporary setup credentials afterward.

Save these GitHub repository variables:

| Variable | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET` | Existing bucket name |
| `CLOUDFLARE_ZONE_ID` | Zone containing all site hostnames |
| `WEBSITE_WORKER` | Existing router Worker name |
| `WEBSITE_DOMAIN` | Production hostname, without a scheme |
| `WEBSITE_PREVIEW_DOMAIN` | Dedicated preview suffix, without `*.` or a scheme |

## 3. Integrate and verify

Add the separate deployment and cleanup workflows from [README.md](README.md). Keep their concurrency groups identical. The on-demand domain inputs are on `main`; the existing `v0.1.0` release uses the old wildcard setup. Pin a tested commit from `main` for production.

For `rivet-dev/website`, use [the pnpm workflow](examples/website.yml) and [cleanup workflow](examples/website-cleanup.yml). Copy [the routing adapter](examples/website-config.ts) into `scripts/website-config.ts`; run it after the build and pass `config: website-routing.json`. Keep the MCP backend running at a reachable HTTPS origin. Enable aliases/proxies only during the deliberate production cutover.

Run the workflow on the test hostname. Check production, a PR preview, its fixed release URL, redirects, assets, and PR comments. The action uploads first, attaches missing domains, and waits up to 10 minutes for DNS and valid HTTPS before publishing. Increase `hostname-timeout` (seconds, maximum 3600) or rerun if certificate issuance takes longer. A failed upload never changes a hostname; partial domain creation is reused on retry.

Close the PR and confirm its R2 objects and exact custom-domain bindings are removed. Its URLs no longer serve the preview; they may fail DNS resolution rather than return 404. Cleanup preserves production, other PRs, the Worker, and the bucket. It also finds partially provisioned domains even if publication never finished.

Cloudflare currently limits custom domains to **100 per zone**. Each active PR uses one stable hostname plus one per retained release; production release hostnames also accumulate. Closing PRs frees their bindings. Remove unneeded production release bindings in Workers → Settings → Domains & Routes before reaching the limit; this retires those release URLs. The action preserves release URLs rather than expiring them automatically. Cloudflare does not automatically delete the generated certificate when a custom domain is detached; unused certificates can be removed from SSL/TLS → Edge Certificates separately.

When migrating from the wildcard version, verify the new exact domains first, then remove only this site's old wildcard DNS record and Worker route. Historical release hostnames are not backfilled; attach any you need to keep before removing the wildcard. Preserve unrelated records and certificates.

References: [Custom domains and automatic certificates](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [domain API permissions](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/), [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/), [domain limits](https://developers.cloudflare.com/workers/platform/limits/#routes-and-domains), [R2 token scopes](https://developers.cloudflare.com/r2/api/tokens/).
