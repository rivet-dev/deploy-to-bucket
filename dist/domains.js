import { setTimeout } from "node:timers/promises";
// Use exact Custom Domains: Cloudflare manages each hostname's DNS and TLS.
// Never publish the Worker's complete domain list: other deployments share it.
export class Domains {
    options;
    path;
    constructor(options) {
        this.options = options;
        if (!/^[a-f0-9]{32}$/.test(options.accountId) ||
            !/^[a-f0-9]{32}$/.test(options.zoneId))
            throw new Error("account-id and zone-id must be Cloudflare IDs");
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.worker) || !options.token)
            throw new Error("worker and cloudflare-token are required; follow SETUP.md");
        this.path = `/accounts/${options.accountId}/workers/domains`;
    }
    async api(path, method = "GET", body) {
        for (let attempt = 0;; attempt++) {
            const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.options.token}`,
                    "Content-Type": "application/json",
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(30000),
            });
            if ((response.status === 429 || response.status >= 500) &&
                attempt < 3) {
                await response.body?.cancel();
                await setTimeout(1000 * 2 ** attempt);
                continue;
            }
            const data = (await response.json());
            if (!response.ok || !data.success)
                throw new Error(`Cloudflare ${method} ${path} failed (HTTP ${response.status}, codes: ${data.errors?.map((e) => e.code).join(", ") || "unknown"}). Check the token permissions and hostname conflicts.`);
            return data.result;
        }
    }
    owns(domain) {
        return (domain.service === this.options.worker &&
            domain.zone_id === this.options.zoneId &&
            (!domain.environment || domain.environment === "production"));
    }
    async ensure(hosts) {
        const zone = await this.api(`/zones/${this.options.zoneId}`);
        const missing = [];
        // Check the whole deployment before changing any host. Existing records
        // must be migrated deliberately, never overwritten as a CI side effect.
        for (const hostname of new Set(hosts)) {
            if (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`))
                throw new Error(`${hostname} is outside the configured Cloudflare zone`);
            const domains = await this.api(`${this.path}?${new URLSearchParams({ hostname })}`);
            const existing = domains.find((d) => d.hostname === hostname);
            if (existing) {
                if (!this.owns(existing) ||
                    existing.enabled === false ||
                    existing.previews_enabled === true)
                    throw new Error(`Refusing to replace the existing Worker binding for ${hostname}`);
                continue;
            }
            const records = await this.api(`/zones/${this.options.zoneId}/dns_records?${new URLSearchParams({ name: hostname, per_page: "1" })}`);
            if (records.length)
                throw new Error(`DNS records already exist for ${hostname}; migrate them in the setup guide before deploying`);
            missing.push(hostname);
        }
        for (const hostname of missing) {
            await this.api(this.path, "PUT", {
                hostname,
                service: this.options.worker,
                zone_id: this.options.zoneId,
                enabled: true,
                previews_enabled: false,
            });
        }
    }
    async cleanup(target, previewDomain) {
        if (!/^(pr-\d+|branch-[a-f0-9]{16})$/.test(target))
            throw new Error("Invalid domain cleanup target");
        // This endpoint returns a single-page list. Filter again locally before
        // deleting so another Worker, zone, PR, or production is never affected.
        const domains = await this.api(`${this.path}?${new URLSearchParams({ service: this.options.worker, zone_id: this.options.zoneId })}`);
        for (const domain of domains) {
            if (!this.owns(domain))
                continue;
            const suffix = `.${previewDomain}`;
            if (!domain.hostname.endsWith(suffix))
                continue;
            const label = domain.hostname.slice(0, -suffix.length);
            if (label !== target &&
                !new RegExp(`^${target}-r-\\d+-\\d+$`).test(label))
                continue;
            await this.api(this.path + "/" + encodeURIComponent(domain.id), "DELETE");
        }
    }
}
export async function waitForHttps(hosts, timeoutMs, { fetcher = fetch, sleep = setTimeout, now = Date.now, } = {}) {
    const pending = new Set(hosts);
    const deadline = now() + timeoutMs;
    while (pending.size) {
        await Promise.all([...pending].map(async (hostname) => {
            try {
                // HEAD avoids downloading the site. A 404 is expected until its
                // manifest is published; the HTTPS connection validates the cert.
                const response = await fetcher(`https://${hostname}/`, {
                    method: "HEAD",
                    redirect: "manual",
                    signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))),
                });
                await response.body?.cancel();
                if (response.status < 500)
                    pending.delete(hostname);
            }
            catch {
                /* DNS and certificate issuance are asynchronous. */
            }
        }));
        if (!pending.size)
            return;
        if (now() >= deadline)
            throw new Error(`HTTPS is not ready for ${[...pending].join(", ")}. The Custom Domains were created; rerun after Cloudflare finishes DNS/certificate provisioning, or increase hostname-timeout.`);
        await sleep(Math.min(5000, deadline - now()));
    }
}
