import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, } from "@aws-sdk/client-s3";
import { uploadObject } from "./uploads.js";
export const INVENTORY_FILE = ".deployment.json";
const RELEASES = "sites/production/releases/";
const ASSETS = "sites/production/assets/";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function list(s3, bucket, prefix) {
    const objects = [];
    let token;
    for (;;) {
        const page = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ContinuationToken: token,
        }));
        for (const item of page.Contents ?? []) {
            if (!item.Key)
                continue;
            const modified = item.LastModified?.getTime();
            if (modified === undefined || !Number.isFinite(modified))
                throw new Error("Missing object timestamp; refusing retention cleanup");
            objects.push({ key: item.Key, modified });
        }
        if (!page.IsTruncated)
            return objects;
        if (!page.NextContinuationToken || page.NextContinuationToken === token)
            throw new Error("Incomplete retention listing; refusing cleanup");
        token = page.NextContinuationToken;
    }
}
async function read(s3, bucket, key) {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!object.Body)
        throw new Error(`Missing retention metadata: ${key}`);
    return JSON.parse(await object.Body.transformToString());
}
function record(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid retention metadata; refusing cleanup");
    return value;
}
// Start the grace period when a release is replaced, even if that release has
// been live for months. R2's LastModified supplies the clock used by cleanup.
export async function retainPreviousProduction(s3, bucket, hosts) {
    const prefixes = new Set();
    for (const host of hosts) {
        let value;
        try {
            value = await read(s3, bucket, `hosts/${host}.json`);
        }
        catch (error) {
            if (error instanceof Error && error.name === "NoSuchKey")
                continue;
            throw error;
        }
        const manifest = record(value);
        if (manifest.target !== "production" ||
            typeof manifest.prefix !== "string" ||
            !/^sites\/production\/releases\/\d+-\d+\/$/.test(manifest.prefix))
            throw new Error("Unexpected production manifest; refusing publication");
        prefixes.add(manifest.prefix);
    }
    for (const prefix of prefixes)
        await uploadObject(s3, bucket, prefix + ".retained.json", "{}", "application/json");
}
// Run under the same production concurrency group as publication. All decisions
// are made before deleting anything, and any incomplete metadata fails closed.
export async function pruneProduction(s3, bucket, now = Date.now()) {
    const cutoff = now - RETENTION_MS;
    const releases = new Map();
    for (const object of await list(s3, bucket, RELEASES)) {
        const match = object.key.match(/^sites\/production\/releases\/\d+-\d+\//);
        if (!match)
            throw new Error("Unknown production release layout; refusing cleanup");
        const group = releases.get(match[0]) ?? [];
        group.push(object);
        releases.set(match[0], group);
    }
    const retained = new Set();
    const fixedHosts = [];
    // Include old aliases, too: removing an alias from config does not detach its
    // hostname. Never delete a release still served by a stable hostname.
    for (const host of await list(s3, bucket, "hosts/")) {
        const manifest = record(await read(s3, bucket, host.key));
        if (manifest.target !== "production")
            continue;
        const prefix = manifest.prefix;
        if (typeof prefix !== "string" || !releases.has(prefix))
            throw new Error("Production hostname has no release; refusing cleanup");
        if (/^hosts\/production-r-\d+-\d+\./.test(host.key)) {
            fixedHosts.push({ key: host.key, prefix });
            if (host.modified >= cutoff)
                retained.add(prefix);
        }
        else
            retained.add(prefix);
    }
    for (const [prefix, objects] of releases)
        if (objects.some((object) => object.modified >= cutoff))
            retained.add(prefix);
    const liveAssets = new Set();
    let canPruneAssets = true;
    for (const prefix of retained) {
        if (!releases
            .get(prefix)
            .some((object) => object.key === prefix + INVENTORY_FILE)) {
            // Releases made by older action versions have no asset inventory.
            // Keep shared assets until those releases age out, rather than guessing.
            canPruneAssets = false;
            continue;
        }
        const inventory = record(await read(s3, bucket, prefix + INVENTORY_FILE));
        if (inventory.version !== 1 ||
            !Array.isArray(inventory.assets) ||
            inventory.assets.some((key) => typeof key !== "string" || !key.startsWith(ASSETS)))
            throw new Error("Invalid asset inventory; refusing cleanup");
        for (const key of inventory.assets)
            liveAssets.add(key);
    }
    const expired = [...releases.keys()].filter((prefix) => !retained.has(prefix));
    const expiredSet = new Set(expired);
    const assetKeys = canPruneAssets
        ? (await list(s3, bucket, ASSETS))
            .filter((object) => object.modified < cutoff && !liveAssets.has(object.key))
            .map((object) => object.key)
        : [];
    async function remove(keys) {
        for (let start = 0; start < keys.length; start += 1000) {
            const result = await s3.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })),
                },
            }));
            if (result.Errors?.length)
                throw new Error("Retention deletion failed; retry on next deployment");
        }
    }
    // Remove fixed URLs before their contents. Shared assets are removed last.
    await remove(fixedHosts
        .filter((host) => expiredSet.has(host.prefix))
        .map((host) => host.key));
    await remove(expired.flatMap((prefix) => releases.get(prefix).map((object) => object.key)));
    await remove(assetKeys);
    return {
        releases: expired.length,
        assets: assetKeys.length,
        assetsDeferred: !canPruneAssets,
    };
}
