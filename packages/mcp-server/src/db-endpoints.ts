/**
 * Data-plane endpoint classifier (Phase 48, D48-a).
 *
 * Decides, per plane, whether a configured endpoint is the local end of a
 * forwarder (`loopback`), a host and port the operator listed in
 * SUBSTRATE_DB_PROXY_ALLOW (`proxy`), or anything else (`direct`). The result
 * carries no URL, host text or credential; callers report only the plane and
 * the class.
 */

export type DbPlane = "greptime" | "postgres" | "dragonfly";

export type EndpointClass = "loopback" | "proxy" | "direct";

/** Keys are "host:port" with the host lowercased and canonicalised. */
export type ProxyAllow = ReadonlySet<string>;

const ALLOW_ENTRY = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+):([0-9]+)$/i;
const LOOPBACK_IPV4 = /^127(\.\d{1,3}){3}$/;

/** Default ports, used only when a URL names no explicit port. */
const DEFAULT_PORTS: Record<string, string> = {
	"http:": "80",
	"https:": "443",
	"postgres:": "5432",
	"postgresql:": "5432",
	"redis:": "6379",
	"rediss:": "6379",
};

export function parseProxyAllow(raw: string | undefined): ProxyAllow {
	const keys = new Set<string>();
	if (raw === undefined || raw.trim() === "") return keys;
	raw.split(",").forEach((entry, index) => {
		const key = allowKey(entry.trim());
		if (key === undefined) {
			throw new Error(
				`SUBSTRATE_DB_PROXY_ALLOW: entry ${index + 1} is not host:port with a port from 1 to 65535`,
			);
		}
		keys.add(key);
	});
	return keys;
}

export function classifyEndpoint(plane: DbPlane, url: string | undefined, allow: ProxyAllow): EndpointClass {
	if (url === undefined || url === "") return "direct";
	const target = endpointTarget(url);
	if (target === undefined) return "direct";
	if (target.host === "localhost" || target.host === "[::1]" || LOOPBACK_IPV4.test(target.host)) {
		return "loopback";
	}
	return allow.has(`${target.host}:${target.port}`) ? "proxy" : "direct";
}

function allowKey(entry: string): string | undefined {
	const match = ALLOW_ENTRY.exec(entry);
	if (match === null) return undefined;
	const port = Number(match[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	const host = canonicalHost(match[1] ?? "");
	return host === undefined ? undefined : `${host}:${port}`;
}

function endpointTarget(url: string): { host: string; port: string } | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const host = canonicalHost(parsed.hostname);
	if (host === undefined) return undefined;
	const port = parsed.port !== "" ? parsed.port : (DEFAULT_PORTS[parsed.protocol] ?? "");
	return { host, port };
}

/**
 * Reparses a host through the http host rules, so IPv4 spellings and IPv6
 * forms reach one canonical text and matching is case-insensitive for every
 * scheme.
 */
function canonicalHost(text: string): string | undefined {
	try {
		return new URL(`http://${text}/`).hostname.replace(/\.+$/, "");
	} catch {
		return undefined;
	}
}
