import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createServer } from "node:http";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { publish } from "../core.js";
import { listAssets, unchangedAssets, uploadObject } from "../uploads.js";
import type { UploadFile } from "../types.js";

test("streamed uploads replay complete files on transient errors, stop at five attempts, and fail fast on 403", { timeout: 20000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "upload-retry-"));
	t.after(() => rm(dir, { recursive: true }));
	const path = join(dir, "asset.js");
	const bytes = Buffer.from("complete upload body\n".repeat(10000));
	await writeFile(path, bytes);
	let status = 503;
	const received: Buffer[] = [];
	const server = createServer(async (request, response) => {
		const parts: Buffer[] = [];
		for await (const chunk of request) parts.push(chunk);
		received.push(Buffer.concat(parts));
		const code = status === 0 ? (received.length < 3 ? 503 : 200) : status;
		response.writeHead(code, { "Content-Type": "application/xml" });
		response.end(code === 200 ? "" : `<Error><Code>${code === 403 ? "AccessDenied" : "SlowDown"}</Code></Error>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const client = new S3Client({
		region: "auto", endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true,
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
		maxAttempts: 5, requestChecksumCalculation: "WHEN_REQUIRED",
	});
	t.after(() => client.destroy());
	const upload = () => uploadObject(client, "example-site", "asset.js", { file: path, size: bytes.length }, "application/javascript");
	status = 0;
	await upload();
	assert.equal(received.length, 3);
	for (const body of received) assert.deepEqual(body, bytes);
	received.length = 0;
	status = 403;
	await assert.rejects(upload(), { name: "AccessDenied" });
	assert.equal(received.length, 1);
	received.length = 0;
	status = 503;
	await assert.rejects(upload(), { name: "SlowDown" });
	assert.equal(received.length, 5);
	for (const body of received) assert.deepEqual(body, bytes);
});

const manifest = {
	target: "production",
	prefix: "sites/production/releases/1/",
};
const file = (key: string, body = "content"): UploadFile => ({
	key,
	body,
	type: "text/html",
});
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test(
	"upload pool fills freed slots without waiting for a slow file, then publishes",
	{ timeout: 2000 },
	async () => {
		const slow = gate(),
			third = gate();
		const calls: string[] = [];
		const progress: number[] = [];
		let active = 0,
			peak = 0;
		const publishing = publish(
			{
				put: async (key) => {
					calls.push(key);
					if (key.startsWith("hosts/")) return;
					peak = Math.max(peak, ++active);
					if (key === "a") await slow.promise;
					if (key === "c") third.resolve();
					active--;
				},
			},
			[file("a"), file("b"), file("c"), file("d")],
			manifest,
			["site.gameinc.io"],
			async () => {},
			{
				concurrency: 2,
				onProgress: (completed) => {
					progress.push(completed);
				},
			},
		);
		await third.promise;
		assert.ok(!calls.some((key) => key.startsWith("hosts/")));
		slow.resolve();
		await publishing;
		assert.equal(peak, 2);
		assert.deepEqual(calls, [
			"a",
			"b",
			"c",
			"d",
			"hosts/site.gameinc.io.json",
		]);
		assert.deepEqual(progress, [1, 2, 3, 4]);
	},
);

test(
	"failed uploads stop queueing and drain active requests before rejecting",
	{ timeout: 2000 },
	async () => {
		const fail = gate(),
			running = gate();
		const calls: string[] = [];
		let settled = false;
		const publishing = publish(
			{
				put: async (key) => {
					calls.push(key);
					if (key === "a") {
						await fail.promise;
						throw new Error("upload failed");
					}
					if (key === "b") await running.promise;
				},
			},
			[file("a"), file("b"), file("c")],
			manifest,
			["site.gameinc.io"],
			async () => {},
			{ concurrency: 2 },
		);
		void publishing.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		fail.resolve();
		await setImmediate();
		assert.equal(settled, false);
		assert.deepEqual(calls, ["a", "b"]);
		running.resolve();
		await assert.rejects(publishing, /upload failed/);
		assert.deepEqual(calls, ["a", "b"]);
		for (const concurrency of [0, 129, 1.5, NaN])
			await assert.rejects(
				publish(
					{ put: async () => assert.fail("unexpected upload") },
					[],
					manifest,
					[],
					undefined,
					{ concurrency },
				),
				/upload-concurrency/,
			);
	},
);

test("reuse requires matching immutable path, size, and checksum; unknown ETags upload", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "upload-assets-"));
	t.after(() => rm(dir, { recursive: true }));
	const local = join(dir, "asset.js");
	await writeFile(local, "same");
	const prefix = "sites/production/assets/";
	const md5 = (body: string) => createHash("md5").update(body).digest("hex");
	const objects = [
		{ key: prefix + "same.js", size: 4, etag: `"${md5("same")}"` },
		{ key: prefix + "changed.js", size: 4, etag: md5("old!") },
		{ key: prefix + "size.js", size: 99, etag: md5("same") },
		{ key: prefix + "multipart.js", size: 4, etag: md5("same") + "-2" },
		{ key: prefix + "unknown.js", size: 4, etag: "unknown" },
		{
			key: "sites/production/releases/1/index.html",
			size: 4,
			etag: md5("same"),
		},
	];
	const files = objects.map((object) => file(object.key, "same"));
	files[0].body = { file: local, size: 4 };
	files.push(file(prefix + "new.js", "same"));
	async function* inventory() {
		yield* objects;
	}
	assert.deepEqual(
		[...(await unchangedAssets(files, prefix, inventory()))],
		[prefix + "same.js"],
	);
	async function* unusedInventory() {
		throw Error("should not list without immutable files");
	}
	assert.equal(
		(
			await unchangedAssets(
				[file("sites/production/releases/2/index.html")],
				prefix,
				unusedInventory(),
			)
		).size,
		0,
	);
});

test("asset inventory follows continuation tokens and rejects incomplete listings", async (t) => {
	const client = new S3Client({
		region: "auto",
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
	});
	t.after(() => client.destroy());
	const tokens: (string | undefined)[] = [];
	t.mock.method(client, "send", async (command: ListObjectsV2Command) => {
		assert.ok(command instanceof ListObjectsV2Command);
		assert.equal(command.input.Bucket, "example-site");
		assert.equal(command.input.Prefix, "sites/production/assets/");
		tokens.push(command.input.ContinuationToken);
		return command.input.ContinuationToken
			? {
					Contents: [{ Key: "second", ETag: '"hash"', Size: 0 }],
					IsTruncated: false,
				}
			: {
					Contents: [{ Key: "first", ETag: '"hash"', Size: 1 }],
					IsTruncated: true,
					NextContinuationToken: "next",
				};
	});
	const keys: string[] = [];
	for await (const object of listAssets(
		client,
		"example-site",
		"sites/production/assets/",
	))
		keys.push(object.key);
	assert.deepEqual(keys, ["first", "second"]);
	assert.deepEqual(tokens, [undefined, "next"]);
	t.mock.method(client, "send", async () => ({ IsTruncated: true }));
	await assert.rejects(async () => {
		for await (const _ of listAssets(
			client,
			"example-site",
			"sites/production/assets/",
		)) {
			/* consume */
		}
	}, /continuation token/);
});
