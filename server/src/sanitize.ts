const MAX_DETAIL = 140;
const REDACTED = "[redacted]";

const patterns: RegExp[] = [
  // Common API key shapes
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value or key: value where the key looks sensitive
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_-]*)\s*[:=]\s*\S+/gi,
  // Long hex or base64 runs
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}/g,
  // Private IPv4 addresses
  /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
  // Absolute home paths
  /(?:\/Users|\/home)\/[^\s/]+/g,
  /[A-Za-z]:\\Users\\[^\s\\]+/g,
];

/** Masks anything that looks like a secret or a private location, then trims to 140 chars. */
export function sanitizeDetail(input: string | undefined): string {
  if (!input) return "";
  let out = input.replace(/\s+/g, " ").trim();
  for (const pattern of patterns) {
    out = out.replace(pattern, (match, key?: string) =>
      typeof key === "string" && pattern.source.includes("token|secret") ? `${key}=${REDACTED}` : REDACTED,
    );
  }
  if (out.length > MAX_DETAIL) out = `${out.slice(0, MAX_DETAIL - 1)}…`;
  return out;
}
