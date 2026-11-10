import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	S3Client,
	PutObjectCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
	GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { GitHubComment } from "../types.js";
import { main } from "../deploy.js";

test("bucket-only API contract: publish, comments and cleanup without management access", async (t) => {
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
	await mkdir(join(dir, "dist/_astro"), { recursive: true });
	await writeFile(join(dir, "dist/_astro/app.a1.js"), "asset");
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
		R2_ACCOUNT_ID: "a".repeat(32),
		R2_BUCKET: "example-site",
		R2_ACCESS_KEY_ID: "synthetic-access-key",
		R2_SECRET_ACCESS_KEY: "synthetic-secret-key",
		SITE_PREVIEW_DOMAIN: "preview.gameinc.io",
		SITE_DOMAIN: "site.gameinc.io",
		SITE_MAIN: "main",
		SITE_CONFIG: "",
		SITE_WORKDIR: dir,
		SITE_DIRECTORY: "dist",
		SITE_UPLOAD_CONCURRENCY: "4",
		GITHUB_REPOSITORY: "example/site",
		GITHUB_EVENT_NAME: "pull_request",
		GITHUB_EVENT_PATH: eventPath,
		GITHUB_RUN_ID: "123",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_OUTPUT: join(dir, "outputs"),
		GITHUB_STEP_SUMMARY: join(dir, "summary"),
		GH_TOKEN: "synthetic-gh-token",
	});
	let postComments = 0,
		patchComments = 0;
	const objects = new Map<string, string>();
	const uploadedKeys: string[] = [];
	const modified = new Map<string, Date>();
	const comments: GitHubComment[] = [];
	t.mock.method(
		S3Client.prototype,
		"send",
		async function (
			this: S3Client,
			command:
				| PutObjectCommand
				| ListObjectsV2Command
				| DeleteObjectsCommand
				| GetObjectCommand,
		) {
			const credentials = await this.config.credentials();
			assert.equal(credentials.accessKeyId, "synthetic-access-key");
			assert.equal(credentials.secretAccessKey, "synthetic-secret-key");
			const input = command.input;
			assert.equal(input.Bucket, "example-site");
			switch (true) {
				case command instanceof PutObjectCommand: {
					const input = command.input;
					assert.ok(input.Key);
					let body = input.Body;
					if (typeof body !== "string") {
						assert.ok(body instanceof Readable);
						const parts: Buffer[] = [];
						for await (const part of body) parts.push(part);
						body = Buffer.concat(parts).toString();
					}
					objects.set(input.Key, body);
					modified.set(input.Key, new Date());
					uploadedKeys.push(input.Key);
					return {};
				}
				case command instanceof ListObjectsV2Command: {
					const input = command.input;
					return {
						Contents: [...objects.keys()]
							.filter((k) => k.startsWith(input.Prefix ?? ""))
							.slice(0, input.MaxKeys)
							.map((Key) => {
								const body = objects.get(Key);
								assert.ok(body !== undefined);
								return {
									Key,
									Size: Buffer.byteLength(body),
									LastModified: modified.get(Key) ?? new Date(),
									ETag: `"${createHash("md5").update(body).digest("hex")}"`,
								};
							}),
					};
				}
				case command instanceof GetObjectCommand: {
					const body = objects.get(command.input.Key!);
					if (body === undefined)
						throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
					return { Body: { transformToString: async () => body } };
				}
				case command instanceof DeleteObjectsCommand:
					command.input.Delete?.Objects?.forEach((o) => {
						assert.ok(o.Key);
						objects.delete(o.Key);
					});
					return {};
				default:
					throw Error("Unexpected storage command");
			}
		},
	);
	globalThis.fetch = async (input, options = {}) => {
		const url = new URL(
				typeof input === "string" || input instanceof URL ? input : input.url,
			),
			path = url.pathname,
			method = options.method || "GET";
		if (url.hostname === "api.github.com") {
			if (path.endsWith("/commits/main")) return Response.json({ sha: "abc" });
			if (path.endsWith("/pulls/7")) return Response.json(pr);
			if (method === "GET" && path.endsWith("/comments"))
				return Response.json(comments);
			if (method === "POST") {
				postComments++;
				assert.equal(typeof options.body, "string");
				comments.push({
					id: 1,
					user: { type: "Bot" },
					...JSON.parse(String(options.body)),
				});
				return Response.json({});
			}
			if (method === "PATCH") {
				patchComments++;
				assert.equal(typeof options.body, "string");
				comments[0].body = JSON.parse(String(options.body)).body;
				return Response.json({});
			}
		}
		throw Error(`Unexpected API call: ${method} ${url}`);
	};
	const savedKey = process.env.R2_SECRET_ACCESS_KEY;
	process.env.SITE_DOMAIN = "pr-7.preview.gameinc.io";
	await assert.rejects(main(), /Production domain must not be inside/);
	process.env.SITE_DOMAIN = "site.gameinc.io";
	delete process.env.R2_SECRET_ACCESS_KEY;
	await assert.rejects(main(), /Bucket-scoped/);
	process.env.R2_SECRET_ACCESS_KEY = savedKey;
	const objectOnlySend = S3Client.prototype.send;
	S3Client.prototype.send = async () => {
		throw new Error("NoSuchBucket: configured bucket does not exist");
	};
	await assert.rejects(main(), /NoSuchBucket/);
	assert.equal(objects.size, 0);
	assert.equal(postComments, 0);
	S3Client.prototype.send = objectOnlySend;
	await main();
	assert.equal(postComments, 1);
	assert.match(
		objects.get("hosts/pr-7.preview.gameinc.io.json") ?? "",
		/releases\/123-1/,
	);
	process.env.GITHUB_RUN_ATTEMPT = "2";
	await main();
	assert.equal(patchComments, 1);
	assert.equal(postComments, 1);
	const asset = "sites/pr-7/assets/_astro/app.a1.js";
	assert.equal(
		uploadedKeys.filter((key) => key === asset).length,
		1,
		"second release reuses the verified asset",
	);
	assert.ok(objects.has("sites/pr-7/releases/123-2/index.html"));
	await writeFile(join(dir, "dist/_astro/app.a1.js"), "other");
	process.env.GITHUB_RUN_ATTEMPT = "3";
	await main();
	assert.equal(
		uploadedKeys.filter((key) => key === asset).length,
		2,
		"changed bytes must upload even at the same immutable path",
	);
	assert.equal(objects.get(asset), "other");
	// Cleanup removes all prior release manifests as well as the current pointer.
	objects.set("hosts/pr-7-r-999-1.preview.gameinc.io.json", "{}");
	objects.set("sites/production/keep", "keep");
	pr.state = "closed";
	event.action = "closed";
	await writeFile(eventPath, JSON.stringify(event));
	process.env.SITE_CONFIG = "missing-generated-config.json";
	await main();
	assert.equal(patchComments, 3);
	assert.deepEqual([...objects.keys()], ["sites/production/keep"]);
	await main();
	// Production records references for both new and reused shared assets, and
	// gives the previous release a grace period before switching the hostname.
	Object.assign(process.env, {
		GITHUB_EVENT_NAME: "push",
		GITHUB_REF_NAME: "main",
		GITHUB_SHA: "abc",
		GITHUB_RUN_ID: "456",
		GITHUB_RUN_ATTEMPT: "1",
		SITE_CONFIG: "",
	});
	await writeFile(eventPath, "{}");
	await main();
	const inventoryKey = "sites/production/releases/456-1/.deployment.json";
	assert.deepEqual(JSON.parse(objects.get(inventoryKey)!), {
		version: 1,
		assets: ["sites/production/assets/_astro/app.a1.js"],
	});
	process.env.GITHUB_RUN_ATTEMPT = "2";
	await main();
	assert.ok(objects.has("sites/production/releases/456-1/.retained.json"));
	assert.ok(objects.has("sites/production/releases/456-1/index.html"));
	assert.deepEqual(
		JSON.parse(
			objects.get("sites/production/releases/456-2/.deployment.json")!,
		),
		JSON.parse(objects.get(inventoryKey)!),
	);
	// A production hostname can also be the parent of every preview hostname.
	process.env.SITE_PREVIEW_DOMAIN = "site.gameinc.io";
	process.env.GITHUB_RUN_ATTEMPT = "3";
	await main();
	const production = objects.get("hosts/site.gameinc.io.json");
	assert.ok(production);
	Object.assign(process.env, { GITHUB_EVENT_NAME: "pull_request", GITHUB_RUN_ID: "789" });
	pr.state = "open";
	event.action = "reopened";
	await writeFile(eventPath, JSON.stringify(event));
	await main();
	assert.ok(objects.has("hosts/pr-7.site.gameinc.io.json"));
	pr.state = "closed";
	event.action = "closed";
	await writeFile(eventPath, JSON.stringify(event));
	await main();
	assert.equal(objects.has("hosts/pr-7.site.gameinc.io.json"), false);
	assert.equal(objects.get("hosts/site.gameinc.io.json"), production);
});
