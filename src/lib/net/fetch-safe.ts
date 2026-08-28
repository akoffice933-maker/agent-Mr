// SSRF-safe remote image fetch (Phase 0.3, review 27.08.2026).
//
// The agent accepts image URLs from user chat (ad creatives). A naive
// fetch(url) is an SSRF hole: http://169.254.169.254/… (cloud metadata),
// http://127.0.0.1:5432 (the database), http://10.0.0.x (internal services).
// This module fails CLOSED on anything that cannot be proven public:
//
//   1. protocol: only http/https;
//   2. hostname: no localhost-like names, no IP literals in private ranges;
//   3. DNS: ALL resolved addresses must be public (a domain that resolves to
//      ANY private address is rejected — DNS-rebinding mitigation v1);
//   4. transfer: no redirects (redirect: "error" — a 302 to an internal URL
//      is rejected, not followed), 15 s timeout, hard size cap, strict
//      Content-Type allowlist (jpeg/png/gif);
//   5. optional domain allowlist: IMAGE_FETCH_ALLOWLIST (comma-separated,
//      exact or suffix match) — if set, only listed domains are fetched.
//
// Tests inject `lookup`/`fetchImpl` — production uses node:dns + global fetch.

import { lookup as dnsLookup } from "node:dns/promises";

export interface SafeImageResult {
  base64: string;
  contentType: string;
  bytes: number;
}
export interface FetchImageOptions {
  /** test seam: DNS resolution (default: node:dns/promises.lookup, all: true) */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** test seam: fetch implementation (default: global fetch) */
  fetchImpl?: typeof fetch;
  /** hard response size cap, bytes (default 512 KB — the Direct API limit) */
  maxBytes?: number;
  /** domain allowlist override (default: IMAGE_FETCH_ALLOWLIST env, empty = off) */
  allowlist?: string[];
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPublicIpv4(ip: string): boolean {
  const n = ipv4ToLong(ip);
  if (n === null) return false; // unparseable → unsafe (fail-closed)
  const inRange = (lo: number, hi: number) => n >= lo && n <= hi;
  return !(
    inRange(0x00000000, 0x000000ff) || // 0.0.0.0/8 "this" network
    inRange(0x0a000000, 0x0affffff) || // 10.0.0.0/8 private
    inRange(0x64400000, 0x647fffff) || // 100.64.0.0/10 CGNAT
    inRange(0x7f000000, 0x7fffffff) || // 127.0.0.0/8 loopback
    inRange(0xa9fe0000, 0xa9feffff) || // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
    inRange(0xac100000, 0xac1fffff) || // 172.16.0.0/12 private
    inRange(0xc0000000, 0xc00000ff) || // 192.0.0.0/24 IETF reserved
    inRange(0xc0a80000, 0xc0a8ffff) || // 192.168.0.0/16 private
    inRange(0xc6120000, 0xc613ffff) || // 198.18.0.0/15 benchmarking
    inRange(0xe0000000, 0xffffffff) // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  );
}

export function isPublicIpv6(ip: string): boolean {
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);
  // Global unicast is 2000::/3 (2xxx/3xxx); everything else (loopback, ULA
  // fc00::/7, link-local fe80::/10, multicast, unspecified) is rejected.
  return v6.startsWith("2") || v6.startsWith("3");
}

export function isPublicAddress(address: string, family: number): boolean {
  return family === 6 ? isPublicIpv6(address) : isPublicIpv4(address);
}

const LOCALHOST_NAMES = ["localhost", "ip6-localhost", "ip6-loopback", "metadata", "metadata.google.internal"];
const LOCALHOST_TLDS = [".local", ".localhost", ".internal", ".lan", ".home", ".home.arpa"];

export function isHostnameSafe(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (LOCALHOST_NAMES.includes(h)) return false;
  if (LOCALHOST_TLDS.some((t) => h.endsWith(t))) return false;
  if (LOCALHOST_NAMES.some((n) => h.endsWith("." + n))) return false;
  return true;
}

function allowlistFrom(opts?: FetchImageOptions): string[] {
  if (opts?.allowlist) return opts.allowlist.map((d) => d.toLowerCase());
  const env = process.env.IMAGE_FETCH_ALLOWLIST ?? "";
  return env.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

function hostnameAllowed(hostname: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const h = hostname.toLowerCase();
  return allowlist.some((d) => h === d || h.endsWith("." + d));
}

/**
 * Fetch a remote image with SSRF protection. Throws with a human-readable
 * reason (surfaced to the user in the preview/execution error path).
 */
export async function fetchSafeImage(url: string, opts?: FetchImageOptions): Promise<SafeImageResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`image URL: некорректный URL: ${String(url).slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`image URL: протокол ${u.protocol} не поддерживается (только http/https)`);
  }
  const host = u.hostname;
  if (!isHostnameSafe(host)) {
    throw new Error(`image URL: имя хоста «${host}» похоже на внутренний адрес — запрещено`);
  }
  if (!hostnameAllowed(host, allowlistFrom(opts))) {
    throw new Error(`image URL: домен «${host}» вне разрешённого списка (IMAGE_FETCH_ALLOWLIST)`);
  }

  // IP literal: check the address itself (no DNS involved).
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (isIpLiteral) {
    if (!isPublicAddress(host.replace(/^\[|\]$/g, ""), host.includes(":") ? 6 : 4)) {
      throw new Error(`image URL: IP ${host} в приватном/служебном диапазоне — запрещено`);
    }
  } else {
    // DNS: EVERY resolved address must be public (fail-closed).
    const lookup = opts?.lookup ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(host);
    } catch {
      throw new Error(`image URL: DNS-резолв «${host}» не удался`);
    }
    if (!addresses.length) throw new Error(`image URL: «${host}» не резолвится в адреса`);
    const unsafe = addresses.find((a) => !isPublicAddress(a.address, a.family));
    if (unsafe) {
      throw new Error(`image URL: «${host}» резолвится в служебный адрес ${unsafe.address} — запрещено`);
    }
  }

  const doFetch = opts?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(
      `image URL: ${name === "TimeoutError" ? "таймаут 15 с" : name === "TypeError" ? "сеть недоступна" : "запрос отклонён (возможно, редирект — он запрещён)"}: ${String(url).slice(0, 120)}`
    );
  }
  if (!res.ok) throw new Error(`image URL: сервер ответил ${res.status} для ${String(url).slice(0, 120)}`);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    throw new Error(`image URL: тип «${contentType || "не указан"}» не поддерживается (jpeg/png/gif)`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (declared > maxBytes) throw new Error(`image URL: файл ${declared} байт больше лимита ${maxBytes}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`image URL: файл ${buf.length} байт больше лимита ${maxBytes}`);
  if (!buf.length) throw new Error("image URL: пустой файл");

  return { base64: buf.toString("base64"), contentType, bytes: buf.length };
}
