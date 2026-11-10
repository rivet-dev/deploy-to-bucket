// Each hostname resolves to one manifest; no build is visible before publication.
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const manifest = await env.BUCKET.get(`hosts/${url.hostname}.json`);
		if (!manifest)
			return new Response("Not found", {
				status: 404,
				headers: { "Cache-Control": "no-store" },
			});
		const site = await manifest.json();
		const config = site.config ?? {};
		const headers = new Headers({
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "SAMEORIGIN",
			"Cache-Control": "no-cache",
		});
		if (site.preview) headers.set("X-Robots-Tag", "noindex, nofollow");
		const reply = (body, status = 200, extra = {}) => {
			const h = new Headers(headers);
			for (const [k, v] of Object.entries(extra)) h.set(k, v);
			if (status >= 400) h.set("Cache-Control", "no-store");
			return new Response(request.method === "HEAD" ? null : body, {
				status,
				headers: h,
			});
		};
		const redirect = (target, status = 301) => {
			const dest = new URL(target, url);
			if (!dest.search) dest.search = url.search;
			return reply(null, status, { Location: dest.href });
		};
		const proxy = config.proxies?.find((p) => p.host === url.hostname);
		if (proxy) {
			if (
				proxy.paths.some(
					(p) =>
						url.pathname === p || url.pathname.startsWith(`${p}/`),
				)
			) {
				const upstream = new URL(proxy.origin);
				upstream.pathname = url.pathname;
				upstream.search = url.search;
				return fetch(new Request(upstream, request), {
					redirect: "manual",
				});
			}
			return redirect(
				url.pathname === "/"
					? proxy.root
					: `${config.canonicalOrigin}${url.pathname}`,
			);
		}
		if (config.aliases?.includes(url.hostname))
			return redirect(`${config.canonicalOrigin}${url.pathname}`);
		const cors = config.cors?.find((r) => r.path === url.pathname);
		const origin = request.headers.get("Origin");
		if (
			cors &&
			origin &&
			/^https:\/\/[^/:]+$/.test(origin) &&
			new URL(origin).hostname.endsWith(`.${cors.domain}`)
		) {
			headers.set("Access-Control-Allow-Origin", origin);
			headers.set("Vary", "Origin");
			if (request.method === "OPTIONS")
				return reply(null, 204, {
					"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type",
				});
		}
		if (!["GET", "HEAD"].includes(request.method))
			return reply("Method not allowed", 405, { Allow: "GET, HEAD" });
		let path;
		try {
			path = decodeURIComponent(url.pathname);
		} catch {
			return reply("Bad path", 400);
		}
		if (
			path.includes("\\") ||
			path.includes("\0") ||
			path.split("/").some((p) => p === "." || p === "..")
		)
			return reply("Bad path", 400);
		if (path === "/health") return reply("healthy");
		const bare = path === "/" ? "/" : path.replace(/\/$/, "");
		const exact = config.redirects?.[bare];
		if (exact) return redirect(exact);
		for (const rule of config.wildcards ?? []) {
			if (!path.startsWith(`${rule.from}/`)) continue;
			return redirect(
				rule.keepSuffix
					? `${rule.to.replace(/\/$/, "")}${path.slice(rule.from.length).replace(/\/$/, "")}/`
					: rule.to,
			);
		}
		for (const rule of config.headers ?? []) {
			if (
				path === rule.path ||
				(rule.path.endsWith("*") &&
					path.startsWith(rule.path.slice(0, -1)))
			) {
				for (const [k, v] of Object.entries(rule.values))
					headers.set(k, v);
			}
		}
		const key = path.slice(1);
		const immutable = (config.immutablePrefixes ?? ["_astro/"]).some((p) =>
			key.startsWith(p),
		);
		const prefix = immutable ? `sites/${site.target}/assets/` : site.prefix;
		let object =
			key && !key.endsWith("/")
				? await env.BUCKET.get(prefix + key)
				: null;
		if (!object) {
			object = await env.BUCKET.get(
				site.prefix +
					(key ? key.replace(/\/$/, "") + "/" : "") +
					"index.html",
			);
			if (object && !path.endsWith("/"))
				return redirect(`${url.pathname}/`);
		}
		let status = 200;
		if (!object && config.spa && !key.split("/").pop().includes("."))
			object = await env.BUCKET.get(site.prefix + "index.html");
		if (!object) {
			status = 404;
			object = await env.BUCKET.get(site.prefix + "404.html");
		}
		if (!object) return reply("Not found", 404);
		object.writeHttpMetadata(headers);
		headers.set("ETag", object.httpEtag);
		headers.set(
			"Cache-Control",
			status === 404
				? "no-store"
				: immutable
					? "public, max-age=31536000, immutable"
					: "no-cache",
		);
		if (
			status === 200 &&
			request.headers
				.get("If-None-Match")
				?.split(/,\s*/)
				.some(
					(tag) =>
						tag === "*" ||
						tag.replace(/^W\//, "") === object.httpEtag,
				)
		)
			return reply(null, 304);
		return reply(object.body, status);
	},
};
