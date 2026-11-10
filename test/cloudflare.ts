import assert from "node:assert/strict";

export const accountId = "a".repeat(32);
export const zoneId = "b".repeat(32);
export const worker = "example-site-router";
export const domain = (hostname: string, id = hostname) => ({
	id,
	hostname,
	service: worker,
	zone_id: zoneId,
	environment: "production",
	enabled: true,
	previews_enabled: false,
});

export class CloudflareMock {
	readonly domains = new Map<string, ReturnType<typeof domain>>();
	readonly dns = new Set<string>();
	readonly requests: {
		method: string;
		path: string;
		body?: Record<string, unknown>;
	}[] = [];
	failHostname?: string;
	failDelete?: string;
	unfiltered = false;

	fetch: typeof fetch = async (input, init = {}) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL
				? input
				: input.url,
		);
		const method = init.method || "GET";
		if (url.hostname !== "api.cloudflare.com") {
			assert.equal(url.protocol, "https:");
			assert.equal(method, "HEAD");
			assert.equal(init.redirect, "manual");
			assert.ok(this.domains.has(url.hostname));
			return new Response(null, { status: 404 });
		}
		assert.equal(
			new Headers(init.headers).get("Authorization"),
			"Bearer synthetic-cf-token",
		);
		const path = url.pathname.replace("/client/v4", "");
		const body = init.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: undefined;
		this.requests.push({ method, path, body });
		const result = (value: unknown) =>
			Response.json({ success: true, result: value });
		const failure = () =>
			Response.json(
				{ success: false, errors: [{ code: 10000 }] },
				{ status: 403 },
			);
		if (method === "GET" && path === `/zones/${zoneId}`)
			return result({ name: "gameinc.io" });
		if (method === "GET" && path === `/zones/${zoneId}/dns_records`)
			return result(
				this.dns.has(url.searchParams.get("name") ?? "")
					? [{ id: "existing" }]
					: [],
			);
		const domainsPath = `/accounts/${accountId}/workers/domains`;
		if (path === domainsPath) {
			if (method === "GET")
				return result(
					[...this.domains.values()].filter(
						(d) =>
							this.unfiltered ||
							[...url.searchParams].every(
								([key, value]) =>
									key in d &&
									d[key as keyof typeof d] === value,
							),
					),
				);
			if (method === "PUT") {
				assert.ok(body && typeof body.hostname === "string");
				assert.equal(body.service, worker);
				assert.equal(body.zone_id, zoneId);
				assert.equal(body.enabled, true);
				assert.equal(body.previews_enabled, false);
				if (body.hostname === this.failHostname) return failure();
				assert.ok(
					!this.dns.has(body.hostname),
					"must not overwrite DNS",
				);
				const record = domain(body.hostname);
				this.domains.set(record.hostname, record);
				this.dns.add(record.hostname);
				return result(record);
			}
		}
		if (method === "DELETE" && path.startsWith(domainsPath + "/")) {
			const id = decodeURIComponent(path.slice(domainsPath.length + 1));
			if (id === this.failDelete) return failure();
			const record = [...this.domains.values()].find((d) => d.id === id);
			assert.ok(record);
			this.domains.delete(record.hostname);
			this.dns.delete(record.hostname);
			return Response.json({ success: true });
		}
		throw Error(`Unexpected Cloudflare call: ${method} ${url}`);
	};
}
