import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The two web tools agents get: a search (DuckDuckGo's HTML page, no key needed) and reading a page as
 * plain text. Pages on private or local addresses are refused, so an agent can't be steered into the
 * server's own network.
 */

const UA = "Mozilla/5.0 (compatible; BarnacleAgent/0.1; +https://github.com/)";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 12_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivate(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Only http(s) URLs whose host resolves to public addresses. */
async function checkUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https pages can be read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("local addresses are not allowed");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivate(a.address))) throw new Error("private or local addresses are not allowed");
  return url;
}

/** GET with a size cap, following up to 3 redirects (each one checked again). */
async function get(raw: string, signal: AbortSignal): Promise<{ url: string; type: string; body: string }> {
  let url = await checkUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await checkUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`the page answered ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text|json|xml/.test(type)) throw new Error(`can't read this kind of file (${type.split(";")[0] || "unknown"})`);
    const reader = res.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    return { url: url.toString(), type, body: new TextDecoder().decode(Buffer.concat(chunks)) };
  }
  throw new Error("too many redirects");
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

/** HTML → readable text: drops scripts, styles and navigation, keeps headings and paragraphs on their own lines. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<h[1-6][^>]*>/gi, "\n## ")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

/** Reads a web page as text (truncated to keep the model's context small). */
export async function webFetch(url: string, signal: AbortSignal): Promise<string> {
  const page = await get(url, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]));
  const { title, text } = /html/.test(page.type) ? htmlToText(page.body) : { title: "", text: page.body };
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(truncated)` : text;
  return `${title ? `# ${title}\n` : ""}URL: ${page.url}\n\n${clipped}`;
}

/** Searches the web (DuckDuckGo). */
export async function webSearch(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!res.ok) throw new Error(`search answered ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const strip = (x: string) => decodeEntities(x.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  // Each result: a title link (result__a), then a snippet link (result__snippet) before the next title.
  const parts = html.split(/<a[^>]+class="result__a"/).slice(1);
  for (const part of parts) {
    if (results.length >= 8) break;
    const title = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(part);
    if (!title) continue;
    let href = decodeEntities(title[1]);
    const redirect = /[?&]uddg=([^&]+)/.exec(href);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.startsWith("//")) href = `https:${href}`;
    if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(part)?.[1] ?? "";
    results.push({ title: strip(title[2]), url: href, snippet: strip(snippet) });
  }
  return results;
}
