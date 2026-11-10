import { createHash } from "node:crypto";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function deployment(event, env, domain, main, previewDomain) {
    const pr = event.pull_request;
    if (pr && pr.head.repo.full_name !== env.GITHUB_REPOSITORY)
        throw new Error("Fork previews require a separate trusted artifact workflow.");
    if (!["push", "pull_request", "delete", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? ""))
        throw new Error("Unsupported event; never use pull_request_target to build PR code.");
    const branch = pr?.head.ref ??
        (env.GITHUB_EVENT_NAME === "delete" ? event.ref : env.GITHUB_REF_NAME);
    if (!branch)
        throw new Error("Missing GitHub branch name");
    const production = !pr && branch === main;
    const target = production
        ? "production"
        : pr
            ? `pr-${pr.number}`
            : `branch-${hash(branch).slice(0, 16)}`;
    const hostname = production ? domain : `${target}.${previewDomain}`;
    if (hostname.length > 253 ||
        hostname.split(".").some((label) => label.length > 63))
        throw new Error("Hostname label is too long. Use a shorter production domain.");
    const remove = event.action === "closed" || env.GITHUB_EVENT_NAME === "delete";
    if (remove && production)
        throw new Error("Refusing to delete production.");
    return { target, hostname, production, remove, pr: pr?.number };
}
export async function publish(store, files, manifest, hosts, beforePublish = async () => { }) {
    // Upload completion is the publication barrier. A failed build/upload never changes a host.
    for (let start = 0; start < files.length; start += 8) {
        await Promise.all(files
            .slice(start, start + 8)
            .map((file) => store.put(file.key, file.body, file.type)));
    }
    await beforePublish();
    for (const host of hosts)
        await store.put(`hosts/${host}.json`, JSON.stringify(manifest), "application/json");
}
export async function cleanup(store, target, hosts) {
    if (target === "production" ||
        !/^(pr-\d+|branch-[a-f0-9]{16})$/.test(target))
        throw new Error("Invalid cleanup target");
    for (const host of hosts)
        await store.delete([`hosts/${host}.json`]);
    for (;;) {
        const keys = await store.list(`hosts/${target}-r-`);
        if (!keys.length)
            break;
        await store.delete(keys);
    }
    // Restart listing after each batch: safe across retries and partial failures.
    for (;;) {
        const keys = await store.list(`sites/${target}/`);
        if (!keys.length)
            break;
        await store.delete(keys);
    }
}
