import { test } from "node:test";
import assert from "node:assert/strict";
import { deployment as planDeployment, publish, cleanup } from "../core.js";
import type { GitHubEvent, Manifest, UploadFile } from "../types.js";
const deployment = (
	event: GitHubEvent,
	env: NodeJS.ProcessEnv,
	domain: string,
	main: string,
) => planDeployment(event, env, domain, main, "preview.gameinc.io");
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
		head: {
			ref: "feature",
			sha: "abc",
			repo: { full_name: "example/site" },
		},
	};
	assert.equal(
		deployment(
			{ pull_request: pr },
			{ ...env, GITHUB_EVENT_NAME: "pull_request" },
			"site.gameinc.io",
			"main",
		).hostname,
		"pr-42.preview.gameinc.io",
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
	const branch = (ref: string) =>
		deployment(
			{},
			{ ...env, GITHUB_REF_NAME: ref },
			"site.gameinc.io",
			"main",
		).target;
	assert.notEqual(branch("a/b"), branch("a-b"));
});
test("failed upload and stale runs never publish; manifest is last", async () => {
	const calls: string[] = [];
	const manifest: Manifest = {
		target: "production",
		prefix: "sites/production/releases/1/",
	};
	const file = (key: string): UploadFile => ({
		key,
		body: "content",
		type: "text/html",
	});
	const store = {
		put: async (key: string) => {
			calls.push(key);
			if (key === "fail") throw Error("upload");
		},
	};
	await assert.rejects(
		publish(store, [file("fail")], manifest, ["site.gameinc.io"]),
	);
	assert.deepEqual(calls, ["fail"]);
	calls.length = 0;
	await assert.rejects(
		publish(
			store,
			[file("ok")],
			manifest,
			["site.gameinc.io"],
			async () => {
				throw Error("stale");
			},
		),
	);
	assert.deepEqual(calls, ["ok"]);
	calls.length = 0;
	await publish(store, [file("a"), file("b")], manifest, ["site.gameinc.io"]);
	assert.equal(calls.at(-1), "hosts/site.gameinc.io.json");
});
test("cleanup removes every batch and only the selected PR; retry is harmless", async () => {
	const keys = new Set([
		"hosts/pr-4.preview.gameinc.io.json",
		"sites/pr-40/x",
		"sites/production/x",
		...Array.from({ length: 1201 }, (_, i) => `sites/pr-4/${i}`),
	]);
	const store = {
		list: async (prefix: string) =>
			[...keys].filter((k) => k.startsWith(prefix)).slice(0, 1000),
		delete: async (batch: string[]) => batch.forEach((k) => keys.delete(k)),
	};
	await cleanup(store, "pr-4", ["pr-4.preview.gameinc.io"]);
	await cleanup(store, "pr-4", ["pr-4.preview.gameinc.io"]);
	assert.deepEqual([...keys], ["sites/pr-40/x", "sites/production/x"]);
	await assert.rejects(cleanup(store, "production", []));
});
