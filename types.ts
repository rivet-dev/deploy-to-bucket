export interface RoutingConfig {
	canonicalOrigin?: string;
	aliases?: string[];
	proxies?: { host: string; origin: string; root: string; paths: string[] }[];
	redirects?: Record<string, string>;
	wildcards?: { from: string; to: string; keepSuffix?: boolean }[];
	headers?: { path: string; values: Record<string, string> }[];
	cors?: { path: string; domain: string }[];
	immutablePrefixes?: string[];
	spa?: boolean;
}

export interface Manifest {
	target: string;
	prefix: string;
	preview?: boolean;
	config?: RoutingConfig;
}

export interface GitHubEvent {
	action?: string;
	ref?: string;
	pull_request?: {
		number: number;
		head: { ref: string; sha: string; repo: { full_name: string } };
	};
}

export interface GitHubComment {
	id: number;
	user: { type: string };
	body: string;
}

export interface UploadFile {
	key: string;
	body: string | { file: string; size: number };
	type: string;
}

export interface ObjectStore {
	put(key: string, body: UploadFile["body"], type: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
	delete(keys: string[]): Promise<void>;
}
