/**
 * Redacts secret-looking values before a real command is printed or written to a report. Over-redacting is fine.
 */
const RULES: [RegExp, string][] = [
	// Known token shapes.
	[/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "‹token›"],
	[/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}/g, "‹token›"],
	[/\bxox[abpors]-[A-Za-z0-9-]{8,}/g, "‹token›"],
	[/\bAKIA[A-Z0-9]{12,}/g, "‹token›"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g, "‹jwt›"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "‹private key›"],
	// `Authorization: Bearer x`, `TOKEN=x`, `--password x`, `api_key: x`.
	[/(\bBearer\s+)\S+/gi, "$1‹redacted›"],
	[
		/(\b[\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[\w-]*["']?\s*(?:=|:|\s)\s*["']?)(?!\$)[^\s"'&|;)]{4,}/gi,
		"$1‹redacted›",
	],
	// `https://user:pass@host`.
	[/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1‹redacted›@"],
	// Long opaque strings (hex or base64-ish, 32+ chars, mixed letters and digits).
	[/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g, "‹opaque›"],
];

export function redact(s: string): string {
	let out = s;
	for (const [re, sub] of RULES) out = out.replace(re, sub);
	return out;
}
