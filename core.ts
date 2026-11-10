import { createHash } from "node:crypto";
import type {
	GitHubEvent,
	Manifest,
	ObjectStore,
	UploadFile,
} from "./types.js";
export const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
export function deployment(
	event: GitHubEvent,
	env: NodeJS.ProcessEnv,
	domain: string,
	main: string,
	previewDomain: string,
	branchDomain?: string,
) {
	const pr = event.pull_request;
	if (pr && pr.head.repo.full_name !== env.GITHUB_REPOSITORY)
		throw new Error(
			"Fork previews require a separate trusted artifact workflow.",
		);
	if (
		!["push", "pull_request", "delete", "workflow_dispatch"].includes(
			env.GITHUB_EVENT_NAME ?? "",
		)
	)
		throw new Error(
			"Unsupported event; never use pull_request_target to build PR code.",
		);
	const branch =
		pr?.head.ref ??
		(env.GITHUB_EVENT_NAME === "delete" ? event.ref : env.GITHUB_REF_NAME);
	if (!branch) throw new Error("Missing GitHub branch name");
	const production = !pr && branch === main;
	const target = production
		? "production"
		: pr
			? `pr-${pr.number}`
			: `branch-${hash(branch).slice(0, 16)}`;
	if (branchDomain) {
		if (production || pr)
			throw new Error(
				"branch-domain is only valid for non-production branch deployments",
			);
		const label = branchDomain.slice(0, -(previewDomain.length + 1));
		if (
			branchDomain === domain ||
			branchDomain === previewDomain ||
			(branchDomain.endsWith(`.${previewDomain}`) &&
				/^(?:pr-|branch-|production-r-)/.test(label))
		)
			throw new Error(
				"branch-domain conflicts with a production or generated preview hostname",
			);
	}
	const hostname = production
		? domain
		: branchDomain || `${target}.${previewDomain}`;
	if (
		hostname.length > 253 ||
		hostname.split(".").some((label) => label.length > 63)
	)
		throw new Error(
			"Hostname label is too long. Use a shorter production domain.",
		);
	const remove =
		event.action === "closed" || env.GITHUB_EVENT_NAME === "delete";
	if (remove && production) throw new Error("Refusing to delete production.");
	return { target, hostname, production, remove, pr: pr?.number };
}
export async function forEachConcurrent<T>(
	items: readonly T[],
	concurrency: number,
	run: (item: T) => Promise<void>,
): Promise<void> {
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128)
		throw new Error(
			"upload-concurrency must be an integer between 1 and 128",
		);
	let next = 0,
		failed = false;
	let failure: unknown;
	await Promise.all(
		Array.from(
			{ length: Math.min(concurrency, items.length) },
			async () => {
				while (!failed && next < items.length) {
					const item = items[next++];
					try {
						await run(item);
					} catch (error) {
						if (!failed) failure = error;
						failed = true;
					}
				}
			},
		),
	);
	if (failed) throw failure;
}

export async function publish(
	store: Pick<ObjectStore, "put">,
	files: UploadFile[],
	manifest: Manifest,
	hosts: string[],
	beforePublish = async () => {},
	{
		concurrency = 32,
		onProgress,
	}: {
		concurrency?: number;
		onProgress?: (completed: number, total: number) => void;
	} = {},
) {
	let completed = 0;
	// Drain in-flight writes on failure before returning; no publication follows.
	await forEachConcurrent(files, concurrency, async (file) => {
		await store.put(file.key, file.body, file.type);
		onProgress?.(++completed, files.length);
	});
	await beforePublish();
	for (const host of hosts)
		await store.put(
			`hosts/${host}.json`,
			JSON.stringify(manifest),
			"application/json",
		);
}
export async function cleanup(
	store: Pick<ObjectStore, "list" | "delete">,
	target: string,
	hosts: string[],
) {
	if (
		target === "production" ||
		!/^(pr-\d+|branch-[a-f0-9]{16})$/.test(target)
	)
		throw new Error("Invalid cleanup target");
	for (const host of hosts) await store.delete([`hosts/${host}.json`]);
	for (;;) {
		const keys = await store.list(`hosts/${target}-r-`);
		if (!keys.length) break;
		await store.delete(keys);
	}
	// Restart listing after each batch: safe across retries and partial failures.
	for (;;) {
		const keys = await store.list(`sites/${target}/`);
		if (!keys.length) break;
		await store.delete(keys);
	}
}
