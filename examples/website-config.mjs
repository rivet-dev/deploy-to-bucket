// Run from the website checkout AFTER pnpm build (assemble populates docs first).
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { redirects, wildcardRedirects } = await import(
	pathToFileURL(resolve("redirects.mjs"))
);
const config = {
	canonicalOrigin: "https://rivet.dev",
	redirects: { ...redirects, "/mcp": "/docs/mcp/" },
	wildcards: wildcardRedirects.map(({ from, to }) => ({
		from,
		to: to.endsWith("/") ? to : `${to}/`,
		keepSuffix: to !== from && to.endsWith(from),
	})),
	headers: [
		{ path: "/typedoc/*", values: { "X-Robots-Tag": "noindex" } },
		{
			path: "/.well-known/integrations.json",
			values: { "Content-Type": "application/json" },
		},
	],
	cors: [{ path: "/changelog.json", domain: "rivet.dev" }],
	immutablePrefixes: ["_astro/"],
};
// Enable aliases/proxy only at the deliberate production cutover.
if (process.env.SITE_PRODUCTION_CUTOVER === "true") {
	config.aliases = ["www.rivet.dev"];
	if (!process.env.MCP_UPSTREAM)
		throw new Error(
			"MCP_UPSTREAM is required for the MCP hostname cutover",
		);
	config.proxies = [
		{
			host: "mcp.rivet.dev",
			origin: process.env.MCP_UPSTREAM,
			root: "https://rivet.dev/docs/mcp/",
			paths: [
				"/mcp",
				"/.well-known/oauth-protected-resource",
				"/health",
				"/ready",
			],
		},
	];
}
await writeFile(
	process.argv[2] || "website-routing.json",
	JSON.stringify(config),
);
