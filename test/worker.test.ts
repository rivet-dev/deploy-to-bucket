import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare, type Request } from "miniflare";
test("real Worker/R2: isolation, redirects, metadata, 404s, CORS, HEAD and publication", async (t) => {
	const mf = new Miniflare({
		modules: true,
		script: await readFile(
			new URL("../dist/worker.js", import.meta.url),
			"utf8",
		),
		compatibilityDate: "2026-07-30",
		r2Buckets: ["BUCKET"],
	});
	t.after(() => mf.dispose());
	const bucket = await mf.getR2Bucket("BUCKET");
	const config = {
		redirects: { "/old": "/docs/" },
		wildcards: [{ from: "/legacy", to: "/docs/", keepSuffix: true }],
		cors: [{ path: "/changelog.json", domain: "gameinc.io" }],
	};
	const host = "pr-42--site.gameinc.io";
	const manifest = {
		target: "pr-42",
		prefix: "sites/pr-42/releases/1/",
		preview: true,
		config,
	};
	await bucket.put(`hosts/${host}.json`, JSON.stringify(manifest));
	for (const [key, value, type] of [
		["index.html", "home", "text/html"],
		["docs/index.html", "docs", "text/html"],
		["404.html", "custom missing", "text/html"],
		["changelog.json", "{}", "application/json"],
	])
		await bucket.put(manifest.prefix + key, value, {
			httpMetadata: { contentType: type },
		});
	await bucket.put("sites/pr-42/assets/_astro/old.js", "old chunk", {
		httpMetadata: { contentType: "application/javascript" },
	});
	const get = (path: string, init?: Parameters<typeof mf.dispatchFetch>[1]) =>
		mf.dispatchFetch(`https://${host}${path}`, {
			redirect: "manual",
			...init,
		});
	let res = await get("/");
	assert.equal(await res.text(), "home");
	assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
	res = await get("/docs?q=1");
	assert.equal(res.status, 301);
	assert.equal(res.headers.get("Location"), `https://${host}/docs/?q=1`);
	res = await get("/old/?q=1");
	assert.equal(res.status, 301);
	assert.equal(res.headers.get("Location"), `https://${host}/docs/?q=1`);
	res = await get("/legacy/deep");
	assert.equal(res.headers.get("Location"), `https://${host}/docs/deep/`);
	res = await get("/missing.js");
	assert.equal(res.status, 404);
	assert.equal(res.headers.get("Cache-Control"), "no-store");
	assert.equal(await res.text(), "custom missing");
	res = await get("/_astro/old.js");
	assert.match(res.headers.get("Cache-Control") ?? "", /immutable/);
	const etag = res.headers.get("ETag");
	assert.ok(etag);
	assert.equal(
		(await get("/_astro/old.js", { headers: { "If-None-Match": etag } }))
			.status,
		304,
	);
	res = await get("/docs/", { method: "HEAD" });
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "");
	assert.equal((await get("/", { method: "POST" })).status, 405);
	res = await get("/changelog.json", {
		method: "OPTIONS",
		headers: { Origin: "https://dashboard.gameinc.io" },
	});
	assert.equal(res.status, 204);
	assert.equal(
		res.headers.get("Access-Control-Allow-Origin"),
		"https://dashboard.gameinc.io",
	);
	assert.equal(
		(
			await get("/changelog.json", {
				headers: { Origin: "https://evilgameinc.io" },
			})
		).headers.get("Access-Control-Allow-Origin"),
		null,
	);
	assert.equal(
		(await mf.dispatchFetch("https://other.gameinc.io/")).status,
		404,
	);
	await bucket.put("sites/pr-42/releases/2/index.html", "new home");
	assert.equal(await (await get("/")).text(), "home");
	await bucket.put(
		`hosts/${host}.json`,
		JSON.stringify({ ...manifest, prefix: "sites/pr-42/releases/2/" }),
	);
	assert.equal(await (await get("/")).text(), "new home");
	assert.equal(await (await get("/_astro/old.js")).text(), "old chunk");
	await bucket.delete(`hosts/${host}.json`);
	assert.equal((await get("/")).status, 404);
});

test("production aliases and MCP proxy preserve requests and upstream redirects", async (t) => {
	const received: {
		url: string;
		method: string;
		body: string;
		auth: string | null;
	}[] = [];
	const mf = new Miniflare({
		modules: true,
		script: await readFile(
			new URL("../dist/worker.js", import.meta.url),
			"utf8",
		),
		compatibilityDate: "2026-07-30",
		r2Buckets: ["BUCKET"],
		outboundService: async (request: Request) => {
			received.push({
				url: request.url,
				method: request.method,
				body: await request.text(),
				auth: request.headers.get("Authorization"),
			});
			return new Response("upstream", {
				status: 307,
				headers: { Location: "https://login.gameinc.io/" },
			});
		},
	});
	t.after(() => mf.dispose());
	const bucket = await mf.getR2Bucket("BUCKET");
	const config = {
		canonicalOrigin: "https://site.gameinc.io",
		aliases: ["www.gameinc.io"],
		proxies: [
			{
				host: "mcp.gameinc.io",
				origin: "https://backend.gameinc.io",
				root: "https://site.gameinc.io/docs/mcp/",
				paths: ["/mcp", "/health"],
			},
		],
	};
	for (const host of ["www.gameinc.io", "mcp.gameinc.io"])
		await bucket.put(
			`hosts/${host}.json`,
			JSON.stringify({
				target: "production",
				prefix: "sites/production/releases/1/",
				config,
			}),
		);
	let response = await mf.dispatchFetch("https://www.gameinc.io/docs/?q=1", {
		redirect: "manual",
	});
	assert.equal(
		response.headers.get("Location"),
		"https://site.gameinc.io/docs/?q=1",
	);
	response = await mf.dispatchFetch("https://mcp.gameinc.io/mcp?session=1", {
		method: "POST",
		body: "rpc",
		headers: { Authorization: "Bearer synthetic" },
		redirect: "manual",
	});
	assert.equal(response.status, 307);
	assert.deepEqual(received, [
		{
			url: "https://backend.gameinc.io/mcp?session=1",
			method: "POST",
			body: "rpc",
			auth: "Bearer synthetic",
		},
	]);
	response = await mf.dispatchFetch("https://mcp.gameinc.io/", {
		redirect: "manual",
	});
	assert.equal(
		response.headers.get("Location"),
		"https://site.gameinc.io/docs/mcp/",
	);
});
