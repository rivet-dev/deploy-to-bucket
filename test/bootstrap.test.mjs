import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { main } from "../deploy.mjs";

test("API contract: bootstrap, upload, repeat deployment, comments and close cleanup", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "r2-action-test-"));
	const originalEnv = { ...process.env },
		originalFetch = globalThis.fetch,
		originalSend = S3Client.prototype.send;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		S3Client.prototype.send = originalSend;
		for (const key of Object.keys(process.env))
			if (!(key in originalEnv)) delete process.env[key];
		Object.assign(process.env, originalEnv);
		await rm(dir, { recursive: true });
	});
	await mkdir(join(dir, "dist"));
	await writeFile(join(dir, "dist/index.html"), "<h1>site</h1>");
	const pr = {
		number: 7,
		state: "open",
		head: {
			sha: "abc",
			ref: "feature",
			repo: { full_name: "example/site" },
		},
	};
	const event = { action: "opened", pull_request: pr };
	const eventPath = join(dir, "event.json");
	await writeFile(eventPath, JSON.stringify(event));
	Object.assign(process.env, {
		CF_TOKEN: "synthetic-token",
		SITE_DOMAIN: "site.gameinc.io",
		SITE_MAIN: "main",
		SITE_CONFIG: "",
		SITE_WORKDIR: dir,
		SITE_DIRECTORY: "dist",
		GITHUB_REPOSITORY: "example/site",
		GITHUB_EVENT_NAME: "pull_request",
		GITHUB_EVENT_PATH: eventPath,
		GITHUB_RUN_ID: "123",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_OUTPUT: join(dir, "outputs"),
		GITHUB_STEP_SUMMARY: join(dir, "summary"),
		GH_TOKEN: "synthetic-gh-token",
	});
	let bucket = false,
		uploads = 0,
		postComments = 0,
		patchComments = 0;
	const objects = new Map(),
		domains = [],
		comments = [];
	S3Client.prototype.send = async function (command) {
		const input = command.input;
		switch (command.constructor.name) {
			case "PutObjectCommand": {
				let body = input.Body;
				if (typeof body !== "string") {
					const parts = [];
					for await (const part of body) parts.push(part);
					body = Buffer.concat(parts).toString();
				}
				objects.set(input.Key, body);
				return {};
			}
			case "ListObjectsV2Command":
				return {
					Contents: [...objects.keys()]
						.filter((k) => k.startsWith(input.Prefix))
						.slice(0, input.MaxKeys)
						.map((Key) => ({ Key })),
				};
			case "DeleteObjectsCommand":
				input.Delete.Objects.forEach((o) => objects.delete(o.Key));
				return {};
			default:
				throw Error(command.constructor.name);
		}
	};
	const ok = (result) => Response.json({ success: true, result });
	globalThis.fetch = async (input, options = {}) => {
		const url = new URL(input),
			path = url.pathname,
			method = options.method || "GET";
		if (url.hostname === "api.github.com") {
			if (path.endsWith("/pulls/7")) return Response.json(pr);
			if (method === "GET" && path.endsWith("/comments"))
				return Response.json(comments);
			if (method === "POST") {
				postComments++;
				comments.push({
					id: 1,
					user: { type: "Bot" },
					...JSON.parse(options.body),
				});
				return Response.json({});
			}
			if (method === "PATCH") {
				patchComments++;
				comments[0].body = JSON.parse(options.body).body;
				return Response.json({});
			}
		}
		if (path === "/client/v4/zones")
			return ok(
				url.searchParams.get("name") === "gameinc.io"
					? [
							{
								id: "zone",
								name: "gameinc.io",
								account: { id: "account" },
							},
						]
					: [],
			);
		if (path.endsWith("/dns_records")) return ok([]);
		if (path.endsWith("/user/tokens/verify"))
			return ok({ id: "token-id", status: "active" });
		if (path.endsWith("/r2/buckets") && method === "POST") {
			bucket = true;
			return ok({});
		}
		if (path.includes("/r2/buckets/"))
			return bucket
				? ok({})
				: Response.json({ success: false }, { status: 404 });
		if (path.endsWith("/workers/domains")) {
			if (method === "GET") return ok(domains);
			const data = JSON.parse(options.body);
			assert.equal(data.zone_id, "zone");
			domains.push({ ...data, id: String(domains.length + 1) });
			return ok({});
		}
		if (path.includes("/workers/domains/") && method === "DELETE") {
			domains.splice(
				domains.findIndex((d) => path.endsWith("/" + d.id)),
				1,
			);
			return ok({});
		}
		if (path.includes("/workers/scripts/") && method === "PUT") {
			const metadata = JSON.parse(
				await options.body.get("metadata").text(),
			);
			assert.equal(metadata.bindings[0].type, "r2_bucket");
			assert.equal(metadata.main_module, "worker.mjs");
			uploads++;
			return ok({});
		}
		throw Error(`Unexpected API call: ${method} ${url}`);
	};
	await main();
	assert.equal(domains.length, 2);
	assert.equal(postComments, 1);
	assert.equal(uploads, 1);
	assert.match(
		objects.get("hosts/pr-7--site.gameinc.io.json"),
		/releases\/123-1/,
	);
	process.env.GITHUB_RUN_ATTEMPT = "2";
	await main();
	assert.equal(domains.length, 3);
	assert.equal(patchComments, 1);
	assert.equal(postComments, 1);
	// A failed domain attachment can leave a manifest: cleanup must remove it too.
	objects.set("hosts/pr-7-r-999-1--site.gameinc.io.json", "{}");
	objects.set("sites/production/keep", "keep");
	pr.state = "closed";
	event.action = "closed";
	await writeFile(eventPath, JSON.stringify(event));
	process.env.SITE_CONFIG = "missing-generated-config.json";
	await main();
	assert.equal(domains.length, 0);
	assert.equal(patchComments, 2);
	assert.deepEqual([...objects.keys()], ["sites/production/keep"]);
	await main();
	assert.equal(domains.length, 0);
});
