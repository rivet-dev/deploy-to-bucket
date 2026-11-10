import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	S3Client,
	ListObjectsV2Command,
	GetObjectCommand,
	PutObjectCommand,
	DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
	INVENTORY_FILE,
	pruneProduction,
	retainPreviousProduction,
} from "../retention.js";

const day = 86400000;
const now = Date.UTC(2026, 10, 10);
const asset = (name: string) => `sites/production/assets/_astro/${name}.js`;
const prefix = (id: number) => `sites/production/releases/${id}-1/`;
const host = "hosts/site.gameinc.io.json";
const fixed = (id: number) =>
	`hosts/production-r-${id}-1.preview.gameinc.io.json`;

function fixture(t: TestContext) {
	const objects = new Map<string, { body: string; modified?: Date }>();
	const deleted: string[] = [];
	const client = new S3Client({
		region: "auto",
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
	});
	t.after(() => client.destroy());
	const put = (key: string, body: unknown, age = 10) =>
		objects.set(key, {
			body: JSON.stringify(body),
			modified: new Date(now - age * day),
		});
	const release = (id: number, assets: string[], age = 10) => {
		put(prefix(id) + INVENTORY_FILE, { version: 1, assets }, age);
		put(prefix(id) + "index.html", "html", age);
		put(fixed(id), { target: "production", prefix: prefix(id) }, age);
	};
	t.mock.method(
		client,
		"send",
		async (
			command:
				| ListObjectsV2Command
				| GetObjectCommand
				| PutObjectCommand
				| DeleteObjectsCommand,
		) => {
			if (command instanceof ListObjectsV2Command) {
				const keys = [...objects.keys()]
					.filter((key) => key.startsWith(command.input.Prefix ?? ""))
					.sort();
				const start = Number(command.input.ContinuationToken ?? 0);
				const page = keys.slice(start, start + 1000);
				return {
					Contents: page.map((Key) => ({
						Key,
						LastModified: objects.get(Key)!.modified,
					})),
					IsTruncated: keys.length > start + page.length,
					NextContinuationToken:
						keys.length > start + page.length
							? String(start + page.length)
							: undefined,
				};
			}
			if (command instanceof GetObjectCommand) {
				const value = objects.get(command.input.Key!);
				if (!value)
					throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
				return { Body: { transformToString: async () => value.body } };
			}
			if (command instanceof PutObjectCommand) {
				assert.equal(typeof command.input.Body, "string");
				objects.set(command.input.Key!, {
					body: String(command.input.Body),
					modified: new Date(now),
				});
				return {};
			}
			assert.ok(command instanceof DeleteObjectsCommand);
			assert.ok(command.input.Delete!.Objects!.length <= 1000);
			for (const { Key } of command.input.Delete!.Objects!) {
				deleted.push(Key!);
				objects.delete(Key!);
			}
			return {};
		},
	);
	return { client, objects, deleted, put, release };
}

test("retention protects active/recent/aliased releases and shared assets, deletes expired and failed uploads in batches", async (t) => {
	const f = fixture(t);
	f.release(1, [asset("old")]);
	f.release(2, [asset("current")], 30);
	f.release(3, [asset("recent")], 2);
	f.release(4, [asset("alias")], 30);
	f.put(host, { target: "production", prefix: prefix(2) }, 30);
	f.put(
		"hosts/alias.gameinc.io.json",
		{ target: "production", prefix: prefix(4) },
		30,
	);
	f.put("hosts/pr-7.preview.gameinc.io.json", {
		target: "pr-7",
		prefix: "sites/pr-7/releases/1/",
	});
	f.put("sites/pr-7/keep", "keep");
	for (const name of ["old", "current", "recent", "alias", "orphan"])
		f.put(asset(name), name, 30);
	f.put(asset("fresh-orphan"), "new", 1);
	// Includes failed partial releases with no hostname or inventory.
	for (let i = 0; i < 1201; i++) f.put(prefix(5) + `file-${i}.html`, "failed");
	const result = await pruneProduction(f.client, "example-site", now);
	assert.deepEqual(result, { releases: 2, assets: 2, assetsDeferred: false });
	assert.equal(f.objects.has(fixed(1)), false);
	assert.equal(f.objects.has(asset("old")), false);
	assert.equal(f.objects.has(asset("orphan")), false);
	for (const name of ["current", "recent", "alias", "fresh-orphan"])
		assert.ok(f.objects.has(asset(name)));
	for (const id of [2, 3, 4])
		assert.ok(f.objects.has(prefix(id) + "index.html"));
	assert.ok(f.objects.has("sites/pr-7/keep"));
	assert.ok(
		f.deleted.indexOf(fixed(1)) < f.deleted.indexOf(prefix(1) + "index.html"),
	);
	assert.deepEqual(await pruneProduction(f.client, "example-site", now), {
		releases: 0,
		assets: 0,
		assetsDeferred: false,
	});
});

test("a long-lived release receives seven days after replacement, not seven days after its original upload", async (t) => {
	const f = fixture(t);
	f.release(1, [asset("old")], 100);
	f.put(asset("old"), "old", 100);
	f.put(host, { target: "production", prefix: prefix(1) }, 100);
	await retainPreviousProduction(f.client, "example-site", [
		"site.gameinc.io",
		"new.gameinc.io",
	]);
	f.release(2, [], 0);
	f.put(host, { target: "production", prefix: prefix(2) }, 0);
	await pruneProduction(f.client, "example-site", now + 7 * day);
	assert.ok(f.objects.has(asset("old")));
	assert.ok(f.objects.has(fixed(1)));
	await pruneProduction(f.client, "example-site", now + 7 * day + 1);
	assert.equal(f.objects.has(asset("old")), false);
	assert.equal(f.objects.has(fixed(1)), false);
	assert.ok(f.objects.has(prefix(2) + "index.html"));
});

test("legacy releases defer shared asset cleanup until they expire", async (t) => {
	const f = fixture(t);
	f.release(1, [], 1);
	f.objects.delete(prefix(1) + INVENTORY_FILE);
	f.release(2, [], 0);
	f.put(host, { target: "production", prefix: prefix(2) }, 0);
	f.put(asset("legacy"), "keep", 100);
	assert.equal(
		(await pruneProduction(f.client, "example-site", now)).assetsDeferred,
		true,
	);
	assert.ok(f.objects.has(asset("legacy")));
	await pruneProduction(f.client, "example-site", now + 7 * day);
	assert.equal(f.objects.has(asset("legacy")), false);
});

test("invalid inventory or missing timestamps stop cleanup before any deletion", async (t) => {
	const f = fixture(t);
	f.release(1, []);
	f.release(2, [], 0);
	f.put(host, { target: "production", prefix: prefix(2) });
	f.put(
		prefix(2) + INVENTORY_FILE,
		{ version: 1, assets: ["sites/pr-7/keep"] },
		0,
	);
	await assert.rejects(
		pruneProduction(f.client, "example-site", now),
		/Invalid asset inventory/,
	);
	assert.deepEqual(f.deleted, []);
	f.objects.get(prefix(1) + "index.html")!.modified = undefined;
	await assert.rejects(
		pruneProduction(f.client, "example-site", now),
		/Missing object timestamp/,
	);
	assert.deepEqual(f.deleted, []);
});

test("incomplete listings cannot delete objects; partial deletion errors can be retried", async (t) => {
	const f = fixture(t);
	f.release(1, [asset("old")]);
	f.release(2, [], 0);
	f.put(host, { target: "production", prefix: prefix(2) });
	f.put(asset("old"), "old");
	const originalSend = f.client.send.bind(f.client);
	t.mock.method(f.client, "send", async () => ({ IsTruncated: true }));
	await assert.rejects(
		pruneProduction(f.client, "example-site", now),
		/Incomplete retention listing/,
	);
	assert.deepEqual(f.deleted, []);
	let failed = false;
	t.mock.method(f.client, "send", async (command: DeleteObjectsCommand) => {
		if (command instanceof DeleteObjectsCommand && !failed) {
			failed = true;
			f.objects.delete(command.input.Delete!.Objects![0].Key!);
			return { Errors: [{ Code: "InternalError" }] };
		}
		return originalSend(command);
	});
	await assert.rejects(
		pruneProduction(f.client, "example-site", now),
		/Retention deletion failed/,
	);
	await pruneProduction(f.client, "example-site", now);
	assert.equal(f.objects.has(asset("old")), false);
	assert.equal(f.objects.has(prefix(1) + "index.html"), false);
	assert.ok(f.objects.has(prefix(2) + "index.html"));
});
