import { test } from "node:test";
import assert from "node:assert/strict";
import { Domains, waitForHttps } from "../domains.js";
import {
	CloudflareMock,
	accountId,
	zoneId,
	worker,
	domain,
} from "./cloudflare.js";

const options = { accountId, zoneId, worker, token: "synthetic-cf-token" };

test("exact domains are idempotent and preflight refuses DNS, Worker, and zone conflicts", async (t) => {
	const cf = new CloudflareMock();
	t.mock.method(globalThis, "fetch", cf.fetch);
	const manager = new Domains(options);
	const hosts = ["pr-7.preview.gameinc.io", "pr-7-r-12-1.preview.gameinc.io"];
	await manager.ensure(hosts);
	await manager.ensure(hosts);
	assert.deepEqual([...cf.domains.keys()], hosts);
	assert.equal(cf.requests.filter((r) => r.method === "PUT").length, 2);
	cf.dns.add("existing.gameinc.io");
	await assert.rejects(
		manager.ensure(["fresh.gameinc.io", "existing.gameinc.io"]),
		/DNS records already exist/,
	);
	assert.ok(!cf.domains.has("fresh.gameinc.io"));
	cf.domains.set("other.gameinc.io", {
		...domain("other.gameinc.io"),
		service: "other-worker",
	});
	await assert.rejects(
		manager.ensure(["other.gameinc.io"]),
		/Refusing to replace/,
	);
	cf.domains.set("disabled.gameinc.io", {
		...domain("disabled.gameinc.io"),
		enabled: false,
	});
	await assert.rejects(
		manager.ensure(["disabled.gameinc.io"]),
		/Refusing to replace/,
	);
	await assert.rejects(manager.ensure(["wronggameinc.io"]), /outside/);
	assert.equal(cf.requests.filter((r) => r.method === "PUT").length, 2);
});

test("partial creation and cleanup can be retried without touching unrelated hosts", async (t) => {
	const cf = new CloudflareMock();
	t.mock.method(globalThis, "fetch", cf.fetch);
	const manager = new Domains(options);
	const stable = "pr-7.preview.gameinc.io",
		release = "pr-7-r-12-1.preview.gameinc.io";
	cf.failHostname = release;
	await assert.rejects(manager.ensure([stable, release]), /HTTP 403/);
	assert.deepEqual([...cf.domains.keys()], [stable]);
	cf.failHostname = undefined;
	await manager.ensure([stable, release]);
	const keep = [
		domain("site.gameinc.io"),
		domain("production-r-12-1.preview.gameinc.io"),
		domain("pr-70.preview.gameinc.io"),
		domain("pr-7-r-not-a-release.preview.gameinc.io"),
		domain("pr-7-r-1-1.other.gameinc.io"),
		{ ...domain("pr-7-r-2-1.preview.gameinc.io"), service: "other-worker" },
		{ ...domain("pr-7-r-3-1.preview.gameinc.io"), zone_id: "c".repeat(32) },
		{ ...domain("pr-7-r-4-1.preview.gameinc.io"), environment: "staging" },
	];
	for (const record of keep) cf.domains.set(record.hostname, record);
	cf.unfiltered = true;
	cf.failDelete = release;
	await assert.rejects(
		manager.cleanup("pr-7", "preview.gameinc.io"),
		/HTTP 403/,
	);
	assert.ok(!cf.domains.has(stable));
	assert.ok(cf.domains.has(release));
	cf.failDelete = undefined;
	await manager.cleanup("pr-7", "preview.gameinc.io");
	await manager.cleanup("pr-7", "preview.gameinc.io");
	assert.deepEqual([...cf.domains.values()], keep);
	await assert.rejects(
		manager.cleanup("production", "preview.gameinc.io"),
		/Invalid/,
	);
	await assert.rejects(
		manager.cleanup("pr-7.*", "preview.gameinc.io"),
		/Invalid/,
	);
});

test("HTTPS readiness retries DNS, TLS, and edge errors, then times out clearly", async () => {
	let clock = 0,
		attempts = 0;
	const fetcher: typeof fetch = async (_input, init) => {
		assert.equal(init?.method, "HEAD");
		assert.equal(init?.redirect, "manual");
		attempts++;
		if (attempts === 1) throw new TypeError("certificate pending");
		return new Response(null, { status: attempts === 2 ? 525 : 404 });
	};
	const sleep = async (ms: number) => {
		clock += ms;
	};
	await waitForHttps(["pr-7.preview.gameinc.io"], 20000, {
		fetcher,
		sleep,
		now: () => clock,
	});
	assert.equal(attempts, 3);
	await assert.rejects(
		waitForHttps(["pending.gameinc.io"], 1, {
			fetcher: async () => {
				throw Error("DNS pending");
			},
			sleep,
			now: () => clock,
		}),
		/HTTPS is not ready.*rerun/,
	);
});
