import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { forEachConcurrent } from "./core.js";
export async function* listAssets(s3, bucket, prefix) {
    let token;
    for (;;) {
        const page = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ContinuationToken: token,
        }));
        for (const object of page.Contents ?? []) {
            if (object.Key && object.ETag && object.Size !== undefined)
                yield { key: object.Key, etag: object.ETag, size: object.Size };
        }
        if (!page.IsTruncated)
            return;
        if (!page.NextContinuationToken || page.NextContinuationToken === token)
            throw new Error("R2 returned an incomplete asset listing without a new continuation token");
        token = page.NextContinuationToken;
    }
}
export async function unchangedAssets(files, prefix, inventory) {
    const candidates = new Map(files
        .filter((file) => file.key.startsWith(prefix))
        .map((file) => [file.key, file]));
    const matching = [];
    if (!candidates.size)
        return new Set();
    for await (const object of inventory) {
        const file = candidates.get(object.key);
        if (!file)
            continue;
        candidates.delete(object.key);
        const size = typeof file.body === "string"
            ? Buffer.byteLength(file.body)
            : file.body.size;
        const etag = object.etag.replace(/^"|"$/g, "");
        // R2 single-part ETags are MD5. Multipart/unknown ETags are not a
        // content checksum we can compare, so conservatively upload those.
        if (object.size === size && /^[a-f0-9]{32}$/.test(etag))
            matching.push({ file, etag });
        if (!candidates.size)
            break;
    }
    const unchanged = new Set();
    await forEachConcurrent(matching, 8, async ({ file, etag }) => {
        const digest = createHash("md5");
        if (typeof file.body === "string")
            digest.update(file.body);
        else {
            const stream = createReadStream(file.body.file);
            try {
                for await (const chunk of stream)
                    digest.update(chunk);
            }
            finally {
                stream.destroy();
            }
        }
        if (digest.digest("hex") === etag)
            unchanged.add(file.key);
    });
    return unchanged;
}
