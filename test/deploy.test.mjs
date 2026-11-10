import { test } from "node:test";
import assert from "node:assert/strict";
import { deployment, publish, cleanup } from "../core.mjs";
const env = {
	GITHUB_REPOSITORY: "example/site",
	GITHUB_REF_NAME: "main",
	GITHUB_EVENT_NAME: "push",
};
test("production, PR and collision-safe branch hosts; destructive and fork guards", () => {
	assert.equal(
		deployment({}, env, "site.gameinc.io", "main").hostname,
		"site.gameinc.io",
	);
	const pr = {
		number: 42,
		head: { ref: "feature", repo: { full_name: "example/site" } },
	};
	assert.equal(
		deployment(
			{ pull_request: pr },
			{ ...env, GITHUB_EVENT_NAME: "pull_request" },
			"site.gameinc.io",
			"main",
		).hostname,
		"pr-42--site.gameinc.io",
	);
	assert.throws(() =>
		deployment(
			{
				pull_request: {
					...pr,
					head: { ...pr.head, repo: { full_name: "fork/site" } },
				},
			},
			env,
			"site.gameinc.io",
			"main",
		),
	);
	assert.throws(() =>
		deployment(
			{ ref: "main" },
			{ ...env, GITHUB_EVENT_NAME: "delete" },
			"site.gameinc.io",
			"main",
		),
	);
	assert.throws(() =>
		deployment(
			{},
			{ ...env, GITHUB_EVENT_NAME: "pull_request_target" },
			"site.gameinc.io",
			"main",
		),
	);
	const branch = (ref) =>
		deployment(
			{},
			{ ...env, GITHUB_REF_NAME: ref },
			"site.gameinc.io",
			"main",
		).target;
	assert.notEqual(branch("a/b"), branch("a-b"));
});
test("failed upload and stale runs never publish; manifest is last", async () => {
	const calls = [];
	const store = {
		put: async (key) => {
			calls.push(key);
			if (key === "fail") throw Error("upload");
		},
	};
	await assert.rejects(
		publish(store, [{ key: "fail" }], {}, ["site.gameinc.io"]),
	);
	assert.deepEqual(calls, ["fail"]);
	calls.length = 0;
	await assert.rejects(
		publish(store, [{ key: "ok" }], {}, ["site.gameinc.io"], async () => {
			throw Error("stale");
		}),
	);
	assert.deepEqual(calls, ["ok"]);
	calls.length = 0;
	await publish(store, [{ key: "a" }, { key: "b" }], {}, ["site.gameinc.io"]);
	assert.equal(calls.at(-1), "hosts/site.gameinc.io.json");
});
test("cleanup removes every batch and only the selected PR; retry is harmless", async () => {
	const keys = new Set([
		"hosts/pr-4--site.gameinc.io.json",
		"sites/pr-40/x",
		"sites/production/x",
		...Array.from({ length: 1201 }, (_, i) => `sites/pr-4/${i}`),
	]);
	const store = {
		list: async (prefix) =>
			[...keys].filter((k) => k.startsWith(prefix)).slice(0, 1000),
		delete: async (batch) => batch.forEach((k) => keys.delete(k)),
	};
	await cleanup(store, "pr-4", ["pr-4--site.gameinc.io"]);
	await cleanup(store, "pr-4", ["pr-4--site.gameinc.io"]);
	assert.deepEqual([...keys], ["sites/pr-40/x", "sites/production/x"]);
	await assert.rejects(cleanup(store, "production", []));
});
