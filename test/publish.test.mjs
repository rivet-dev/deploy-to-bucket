import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { main } from "../deploy.mjs";

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
	const objects = new Map(),
		comments = [];
	S3Client.prototype.send = async function (command) {
		const credentials = await this.config.credentials();
		assert.equal(credentials.accessKeyId, "synthetic-access-key");
		assert.equal(credentials.secretAccessKey, "synthetic-secret-key");
		const input = command.input;
		assert.equal(input.Bucket, "example-site");
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
		throw Error(`Unexpected API call: ${method} ${url}`);
	};
	const savedKey = process.env.R2_SECRET_ACCESS_KEY;
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
		objects.get("hosts/pr-7.preview.gameinc.io.json"),
		/releases\/123-1/,
	);
	process.env.GITHUB_RUN_ATTEMPT = "2";
	await main();
	assert.equal(patchComments, 1);
	assert.equal(postComments, 1);
	// Cleanup removes all prior release manifests as well as the current pointer.
	objects.set("hosts/pr-7-r-999-1.preview.gameinc.io.json", "{}");
	objects.set("sites/production/keep", "keep");
	pr.state = "closed";
	event.action = "closed";
	await writeFile(eventPath, JSON.stringify(event));
	process.env.SITE_CONFIG = "missing-generated-config.json";
	await main();
	assert.equal(patchComments, 2);
	assert.deepEqual([...objects.keys()], ["sites/production/keep"]);
	await main();
});
