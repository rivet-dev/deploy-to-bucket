import { readFile, readdir, lstat, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	S3Client,
	PutObjectCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import mime from "mime-types";
import { hash, deployment, publish, cleanup } from "./core.mjs";

const env = process.env;
async function cf(path, method = "GET", body, absent = false) {
	for (let attempt = 0; attempt < 6; attempt++) {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4${path}`,
			{
				method,
				headers: {
					Authorization: `Bearer ${env.CF_TOKEN}`,
					...(body && !(body instanceof FormData)
						? { "Content-Type": "application/json" }
						: {}),
				},
				body:
					body instanceof FormData
						? body
						: body
							? JSON.stringify(body)
							: undefined,
				signal: AbortSignal.timeout(60000),
			},
		);
		if (
			(response.status === 429 || response.status >= 500) &&
			attempt < 5
		) {
			await new Promise((r) =>
				setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)),
			);
			continue;
		}
		if (absent && response.status === 404) return null;
		const data = await response.json();
		if (!response.ok || !data.success)
			throw new Error(
				`Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(data.errors)}`,
			);
		return data.result;
	}
}
async function allDomains(account) {
	const result = [];
	for (let page = 1; ; page++) {
		const batch = await cf(
			`/accounts/${account}/workers/domains?per_page=100&page=${page}`,
		);
		result.push(...batch);
		if (batch.length < 100) return result;
	}
}
export async function main() {
	const domain = env.SITE_DOMAIN.toLowerCase();
	if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))
		throw new Error("domain must be a hostname, without scheme or path");
	const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
	const plan = deployment(event, env, domain, env.SITE_MAIN || "main");
	async function assertCurrent() {
		if (!env.GH_TOKEN)
			throw new Error("github-token is required for stale-run checks");
		const endpoint = plan.pr
			? `pulls/${plan.pr}`
			: `commits/${encodeURIComponent(plan.remove ? event.ref : env.GITHUB_REF_NAME)}`;
		const response = await fetch(
			`${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/${endpoint}`,
			{
				headers: {
					Authorization: `Bearer ${env.GH_TOKEN}`,
					Accept: "application/vnd.github+json",
				},
				signal: AbortSignal.timeout(30000),
			},
		);
		if (plan.remove && !plan.pr) {
			if (response.status === 404) return;
			throw new Error(
				"Branch exists again or cannot be checked; refusing stale cleanup.",
			);
		}
		if (!response.ok)
			throw new Error(`Cannot check current ref (${response.status})`);
		const current = await response.json();
		if (
			plan.pr
				? plan.remove
					? current.state !== "closed"
					: current.state !== "open" ||
						current.head.sha !== event.pull_request.head.sha
				: current.sha !== env.GITHUB_SHA
		)
			throw new Error(
				"Stale workflow: branch or PR has changed; refusing to publish or delete.",
			);
	}
	await assertCurrent();
	const workdir = resolve(env.SITE_WORKDIR || ".");
	const config =
		env.SITE_CONFIG && !plan.remove
			? JSON.parse(
					await readFile(resolve(workdir, env.SITE_CONFIG), "utf8"),
				)
			: {};
	for (const proxy of config.proxies ?? []) {
		const origin = new URL(proxy.origin);
		if (
			origin.protocol !== "https:" ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash ||
			origin.hostname === proxy.host
		)
			throw new Error(
				"Proxy upstream must be a distinct HTTPS origin without credentials or a path.",
			);
	}
	// Preview code may not attach production aliases or proxy hosts.
	if (!plan.production) {
		delete config.aliases;
		delete config.proxies;
	}
	const release = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
	if (!/^\d+-\d+$/.test(release))
		throw new Error("Missing GitHub run identity");
	const releaseHost = `${plan.target}-r-${release}--${domain}`;
	if (releaseHost.split(".").some((label) => label.length > 63))
		throw new Error("Release hostname is too long; use a shorter domain.");
	const hosts = [
		plan.hostname,
		releaseHost,
		...(config.aliases ?? []),
		...(config.proxies ?? []).map((p) => p.host),
	];
	let zone;
	const labels = domain.split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		const zones = await cf(
			`/zones?name=${labels.slice(i).join(".")}&status=active`,
		);
		if (zones.length === 1) {
			zone = zones[0];
			break;
		}
	}
	if (!zone) throw new Error("No active Cloudflare zone found for domain");
	if (hosts.some((h) => h !== zone.name && !h.endsWith(`.${zone.name}`)))
		throw new Error(
			"All hostnames must belong to the production Cloudflare zone",
		);
	const account = zone.account.id;
	const resource = `website-${hash(`${env.GITHUB_REPOSITORY}:${domain}`).slice(0, 20)}`;
	const bucketPath = `/accounts/${account}/r2/buckets/${resource}`;
	const bucket = await cf(bucketPath, "GET", undefined, true);
	if (!bucket && plan.remove) {
		console.log("Bucket already absent; nothing to clean up.");
		return;
	}
	if (!bucket) {
		try {
			await cf(`/accounts/${account}/r2/buckets`, "POST", {
				name: resource,
			});
		} catch (error) {
			if (!(await cf(bucketPath, "GET", undefined, true))) throw error;
		}
	}
	// Cloudflare documents S3 credentials as token ID + SHA-256(token value).
	const token = await cf("/user/tokens/verify");
	if (token.status !== "active")
		throw new Error("Cloudflare token is not active");
	const s3 = new S3Client({
		region: "auto",
		endpoint: `https://${account}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: token.id,
			secretAccessKey: hash(env.CF_TOKEN),
		},
		maxAttempts: 5,
	});
	const store = {
		put: async (key, body, type) => {
			// Open streams here, so only the current bounded upload batch holds descriptors.
			const data =
				typeof body === "object" && body.file
					? createReadStream(body.file)
					: body;
			await s3.send(
				new PutObjectCommand({
					Bucket: resource,
					Key: key,
					Body: data,
					ContentLength: body?.size,
					ContentType: type,
				}),
			);
		},
		list: async (prefix) =>
			(
				await s3.send(
					new ListObjectsV2Command({
						Bucket: resource,
						Prefix: prefix,
						MaxKeys: 1000,
					}),
				)
			).Contents?.map((o) => o.Key) ?? [],
		delete: async (keys) => {
			const result = await s3.send(
				new DeleteObjectsCommand({
					Bucket: resource,
					Delete: { Objects: keys.map((Key) => ({ Key })) },
				}),
			);
			if (result.Errors?.length)
				throw new Error(
					`R2 deletion failed for ${result.Errors.length} objects`,
				);
		},
	};
	const domains = await allDomains(account);
	const comment = async (removed) => {
		if (!plan.pr || !env.GH_TOKEN) return;
		const base = `${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
		async function gh(path, method = "GET", body) {
			const res = await fetch(base + path, {
				method,
				headers: {
					Authorization: `Bearer ${env.GH_TOKEN}`,
					Accept: "application/vnd.github+json",
					"Content-Type": "application/json",
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(30000),
			});
			if (!res.ok)
				throw new Error(
					`GitHub comment failed (${res.status}); deployment state has already been updated`,
				);
			return res.json();
		}
		const marker = `<!-- r2-website:${resource} -->`;
		let existing;
		for (let page = 1; ; page++) {
			const batch = await gh(
				`/issues/${plan.pr}/comments?per_page=100&page=${page}`,
			);
			existing = batch.find(
				(c) => c.user.type === "Bot" && c.body.includes(marker),
			);
			if (existing || batch.length < 100) break;
		}
		const body = `${marker}\n${removed ? "Preview removed; R2 assets deleted." : `Website preview: https://${plan.hostname}\n\nRelease: https://${releaseHost}\n\nCommit: ${event.pull_request.head.sha}`}`;
		await gh(
			existing
				? `/issues/comments/${existing.id}`
				: `/issues/${plan.pr}/comments`,
			existing ? "PATCH" : "POST",
			{ body },
		);
	};
	if (plan.remove) {
		const owned = domains.filter(
			(d) =>
				d.service === resource &&
				(d.hostname === plan.hostname ||
					(d.hostname.startsWith(`${plan.target}-r-`) &&
						d.hostname.endsWith(`--${domain}`))),
		);
		await cleanup(store, plan.target, [
			...new Set([plan.hostname, ...owned.map((d) => d.hostname)]),
		]);
		for (const item of owned)
			await cf(
				`/accounts/${account}/workers/domains/${item.id}`,
				"DELETE",
			);
		await comment(true);
		return;
	}
	// Check ownership before uploading or attaching anything. Never take over existing DNS.
	for (const hostname of hosts) {
		const existing = domains.find((d) => d.hostname === hostname);
		if (existing && existing.service !== resource)
			throw new Error(`Hostname ${hostname} belongs to another Worker`);
		if (!existing) {
			const records = await cf(
				`/zones/${zone.id}/dns_records?name=${hostname}`,
			);
			if (records.length)
				throw new Error(
					`Hostname ${hostname} already has DNS records. Review the DNS cutover before retrying.`,
				);
		}
	}
	const form = new FormData();
	form.set(
		"metadata",
		new Blob(
			[
				JSON.stringify({
					main_module: "worker.mjs",
					compatibility_date: "2026-11-09",
					bindings: [
						{
							type: "r2_bucket",
							name: "BUCKET",
							bucket_name: resource,
						},
					],
					observability: { enabled: true },
				}),
			],
			{ type: "application/json" },
		),
	);
	form.set(
		"worker.mjs",
		new Blob([await readFile(new URL("./worker.mjs", import.meta.url))], {
			type: "application/javascript+module",
		}),
		"worker.mjs",
	);
	await cf(`/accounts/${account}/workers/scripts/${resource}`, "PUT", form);
	const output = resolve(workdir, env.SITE_DIRECTORY || "dist");
	const prefix = `sites/${plan.target}/releases/${release}/`;
	const files = [];
	async function walk(dir) {
		for (const name of await readdir(dir)) {
			const file = resolve(dir, name),
				stat = await lstat(file);
			if (stat.isSymbolicLink())
				throw new Error(`Build output contains symlink: ${file}`);
			if (stat.isDirectory()) {
				await walk(file);
				continue;
			}
			if (!stat.isFile())
				throw new Error(`Unsupported build output: ${file}`);
			const key = relative(output, file).split("\\").join("/");
			if (key.startsWith(".") && !key.startsWith(".well-known/"))
				continue;
			if (stat.size > 5 * 1024 ** 3)
				throw new Error("Files over 5 GiB require multipart uploads");
			const immutable = (config.immutablePrefixes ?? ["_astro/"]).some(
				(p) => key.startsWith(p),
			);
			files.push({
				key:
					(immutable ? `sites/${plan.target}/assets/` : prefix) + key,
				body: { file, size: stat.size },
				type: mime.contentType(
					mime.lookup(key) || "application/octet-stream",
				),
			});
		}
	}
	await walk(output);
	if (!files.some((f) => f.key === prefix + "index.html"))
		throw new Error("Build output must contain index.html");
	await publish(
		store,
		files,
		{ target: plan.target, prefix, preview: !plan.production, config },
		hosts.filter((h) => h !== releaseHost),
		assertCurrent,
	);
	// Immutable release URLs are always excluded from search indexes.
	await store.put(
		`hosts/${releaseHost}.json`,
		JSON.stringify({ target: plan.target, prefix, preview: true, config }),
		"application/json",
	);
	for (const hostname of hosts)
		if (!domains.some((d) => d.hostname === hostname))
			await cf(`/accounts/${account}/workers/domains`, "PUT", {
				hostname,
				service: resource,
				environment: "production",
				zone_id: zone.id,
			});
	await appendFile(
		env.GITHUB_OUTPUT,
		`url=https://${plan.hostname}\nrelease-url=https://${releaseHost}\n`,
	);
	if (env.GITHUB_STEP_SUMMARY)
		await appendFile(
			env.GITHUB_STEP_SUMMARY,
			`Website: https://${plan.hostname}\n\nUploaded ${files.length} files. First-time TLS provisioning may take several minutes.\n`,
		);
	await comment(false);
	console.log(`Published https://${plan.hostname}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
