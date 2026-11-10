import { readFile, readdir, lstat, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, } from "@aws-sdk/client-s3";
import mime from "mime-types";
import { deployment, publish, cleanup } from "./core.js";
import { listAssets, unchangedAssets } from "./uploads.js";
const env = process.env;
function requiredEnv(name) {
    const value = env[name];
    if (!value)
        throw new Error(`Missing environment variable: ${name}`);
    return value;
}
export async function main() {
    const hostname = (value) => {
        if (!value ||
            !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value) ||
            value.length > 253 ||
            value.split(".").some((label) => label.length > 63))
            throw new Error("domain and preview-domain must be valid hostnames without a scheme or path");
        return value;
    };
    const domain = hostname(env.SITE_DOMAIN?.toLowerCase());
    const previewDomain = hostname(env.SITE_PREVIEW_DOMAIN?.toLowerCase());
    if (domain === previewDomain || domain.endsWith(`.${previewDomain}`))
        throw new Error("Use a dedicated preview-domain outside the production hostname namespace");
    if (!/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID ?? ""))
        throw new Error("account-id must be a Cloudflare account ID");
    const bucket = env.R2_BUCKET;
    if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
        throw new Error("bucket must name an existing R2 bucket");
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY)
        throw new Error("Bucket-scoped R2 access-key-id and secret-access-key are required; follow SETUP.md");
    const concurrency = Number(env.SITE_UPLOAD_CONCURRENCY || "32");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128)
        throw new Error("upload-concurrency must be an integer between 1 and 128");
    const event = JSON.parse(await readFile(requiredEnv("GITHUB_EVENT_PATH"), "utf8"));
    const plan = deployment(event, env, domain, env.SITE_MAIN || "main", previewDomain);
    async function assertCurrent() {
        if (!env.GH_TOKEN)
            throw new Error("github-token is required for stale-run checks");
        const endpoint = plan.pr
            ? `pulls/${plan.pr}`
            : `commits/${encodeURIComponent(plan.remove ? (event.ref ?? "") : requiredEnv("GITHUB_REF_NAME"))}`;
        const response = await fetch(`${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/${endpoint}`, {
            headers: {
                Authorization: `Bearer ${env.GH_TOKEN}`,
                Accept: "application/vnd.github+json",
            },
            signal: AbortSignal.timeout(30000),
        });
        if (plan.remove && !plan.pr) {
            if (response.status === 404)
                return;
            throw new Error("Branch exists again or cannot be checked; refusing stale cleanup.");
        }
        if (!response.ok)
            throw new Error(`Cannot check current ref (${response.status})`);
        const current = (await response.json());
        if (plan.pr
            ? plan.remove
                ? current.state !== "closed"
                : current.state !== "open" ||
                    !current.head?.sha ||
                    current.head.sha !== event.pull_request?.head.sha
            : current.sha !== env.GITHUB_SHA)
            throw new Error("Stale workflow: branch or PR has changed; refusing to publish or delete.");
    }
    await assertCurrent();
    const workdir = resolve(env.SITE_WORKDIR || ".");
    const config = env.SITE_CONFIG && !plan.remove
        ? JSON.parse(await readFile(resolve(workdir, env.SITE_CONFIG), "utf8"))
        : {};
    for (const proxy of config.proxies ?? []) {
        const origin = new URL(proxy.origin);
        if (origin.protocol !== "https:" ||
            origin.username ||
            origin.password ||
            origin.pathname !== "/" ||
            origin.search ||
            origin.hash ||
            origin.hostname === proxy.host)
            throw new Error("Proxy upstream must be a distinct HTTPS origin without credentials or a path.");
    }
    // Preview code may not attach production aliases or proxy hosts.
    if (!plan.production) {
        delete config.aliases;
        delete config.proxies;
    }
    const release = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
    if (!/^\d+-\d+$/.test(release))
        throw new Error("Missing GitHub run identity");
    const releaseHost = `${plan.target}-r-${release}.${previewDomain}`;
    if (releaseHost.length > 253 ||
        releaseHost.split(".").some((label) => label.length > 63))
        throw new Error("Release hostname is too long; use a shorter domain.");
    const hosts = [
        plan.hostname,
        releaseHost,
        ...(config.aliases ?? []),
        ...(config.proxies ?? []).map((p) => p.host),
    ].map(hostname);
    const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
        maxAttempts: 5,
        requestHandler: {
            httpsAgent: { keepAlive: true, maxSockets: concurrency },
        },
    });
    const store = {
        put: async (key, body, type) => {
            // Open streams lazily: only active uploads hold file descriptors.
            const data = typeof body === "object" ? createReadStream(body.file) : body;
            await s3.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: data,
                ContentLength: typeof body === "object" ? body.size : undefined,
                ContentType: type,
            }));
        },
        list: async (prefix) => (await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
        }))).Contents?.flatMap((o) => (o.Key ? [o.Key] : [])) ?? [],
        delete: async (keys) => {
            const result = await s3.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: keys.map((Key) => ({ Key })) },
            }));
            if (result.Errors?.length)
                throw new Error(`R2 deletion failed for ${result.Errors.length} objects`);
        },
    };
    const comment = async (removed) => {
        if (!plan.pr || !env.GH_TOKEN)
            return;
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
                throw new Error(`GitHub comment failed (${res.status}); deployment state has already been updated`);
            return (await res.json());
        }
        const marker = `<!-- deploy-to-bucket:${bucket}:${domain} -->`;
        let existing;
        for (let page = 1;; page++) {
            const batch = await gh(`/issues/${plan.pr}/comments?per_page=100&page=${page}`);
            existing = batch.find((c) => c.user.type === "Bot" && c.body.includes(marker));
            if (existing || batch.length < 100)
                break;
        }
        const body = `${marker}\n${removed ? "Preview removed; R2 assets deleted." : `Website preview: https://${plan.hostname}\n\nRelease: https://${releaseHost}\n\nCommit: ${event.pull_request?.head.sha}`}`;
        await gh(existing
            ? `/issues/comments/${existing.id}`
            : `/issues/${plan.pr}/comments`, existing ? "PATCH" : "POST", { body });
    };
    if (plan.remove) {
        await cleanup(store, plan.target, [plan.hostname]);
        await comment(true);
        return;
    }
    const output = resolve(workdir, env.SITE_DIRECTORY || "dist");
    const prefix = `sites/${plan.target}/releases/${release}/`;
    const files = [];
    async function walk(dir) {
        for (const name of await readdir(dir)) {
            const file = resolve(dir, name), stat = await lstat(file);
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
            const immutable = (config.immutablePrefixes ?? ["_astro/"]).some((p) => key.startsWith(p));
            files.push({
                key: (immutable ? `sites/${plan.target}/assets/` : prefix) + key,
                body: { file, size: stat.size },
                type: mime.contentType(mime.lookup(key) || "application/octet-stream") || "application/octet-stream",
            });
        }
    }
    await walk(output);
    if (!files.some((f) => f.key === prefix + "index.html"))
        throw new Error("Build output must contain index.html");
    console.log(`Found ${files.length} files. Checking existing immutable assets...`);
    const checkStarted = Date.now();
    const assetPrefix = `sites/${plan.target}/assets/`;
    const skipped = await unchangedAssets(files, assetPrefix, listAssets(s3, bucket, assetPrefix));
    const size = (file) => typeof file.body === "string"
        ? Buffer.byteLength(file.body)
        : file.body.size;
    const uploads = files
        .filter((file) => !skipped.has(file.key))
        .sort((a, b) => size(b) - size(a));
    const bytes = uploads.reduce((total, file) => total + size(file), 0);
    console.log(`Checked assets in ${((Date.now() - checkStarted) / 1000).toFixed(1)}s. Skipping ${skipped.size} unchanged assets.`);
    console.log(`Uploading ${uploads.length} files (${(bytes / 1024 ** 2).toFixed(1)} MiB), concurrency ${concurrency}...`);
    const uploadStarted = Date.now();
    let lastProgress = uploadStarted;
    let uploadSeconds = 0;
    await publish(store, uploads, { target: plan.target, prefix, preview: !plan.production, config }, hosts.filter((h) => h !== releaseHost), async () => {
        uploadSeconds = (Date.now() - uploadStarted) / 1000;
        console.log(`Uploaded ${uploads.length} files in ${uploadSeconds.toFixed(1)}s. Publishing hostnames...`);
        await assertCurrent();
    }, {
        concurrency,
        onProgress: (completed, total) => {
            const now = Date.now();
            if (now - lastProgress >= 10000) {
                console.log(`Uploaded ${completed}/${total} files (${((now - uploadStarted) / 1000).toFixed(0)}s elapsed)`);
                lastProgress = now;
            }
        },
    });
    // Immutable release URLs are always excluded from search indexes.
    await store.put(`hosts/${releaseHost}.json`, JSON.stringify({ target: plan.target, prefix, preview: true, config }), "application/json");
    await appendFile(requiredEnv("GITHUB_OUTPUT"), `url=https://${plan.hostname}\nrelease-url=https://${releaseHost}\n`);
    if (env.GITHUB_STEP_SUMMARY)
        await appendFile(env.GITHUB_STEP_SUMMARY, `Website: https://${plan.hostname}\n\nUploaded ${uploads.length} files in ${uploadSeconds.toFixed(1)}s; reused ${skipped.size} unchanged assets. Routing and TLS must already be configured by the setup guide.\n`);
    await comment(false);
    console.log(`Published https://${plan.hostname}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
