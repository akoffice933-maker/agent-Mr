// Phase 0.3: SSRF-safe image fetch. The agent accepts image URLs from user
// chat — a naive fetch() is an SSRF hole (cloud metadata, the database,
// internal services). These tests pin the fail-closed behavior.
import { describe, expect, it } from "vitest";
import { fetchSafeImage, isPublicIpv4, isPublicIpv6, isHostnameSafe } from "@/lib/net/fetch-safe";

const okImage = (contentType = "image/jpeg", bytes = 1024) =>
  new Response(Buffer.alloc(bytes, 7), {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(bytes) },
  });

describe("address classification (fail-closed)", () => {
  it("rejects private/reserved IPv4 ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1", // CGNAT
      "127.0.0.1", // loopback (the database!)
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1", // multicast
      "255.255.255.255",
      "not-an-ip",
    ]) {
      expect(isPublicIpv4(ip), ip).toBe(false);
    }
  });
  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.0.1.1", "93.184.216.34"]) {
      expect(isPublicIpv4(ip), ip).toBe(true);
    }
  });
  it("rejects non-global IPv6, allows global unicast", () => {
    expect(isPublicIpv6("::1")).toBe(false);
    expect(isPublicIpv6("::")).toBe(false);
    expect(isPublicIpv6("fc00::1")).toBe(false);
    expect(isPublicIpv6("fd12:3456::1")).toBe(false);
    expect(isPublicIpv6("fe80::1")).toBe(false);
    expect(isPublicIpv6("ff02::1")).toBe(false);
    expect(isPublicIpv6("::ffff:127.0.0.1")).toBe(false); // mapped loopback
    expect(isPublicIpv6("2001:4860:4860::8888")).toBe(true);
    expect(isPublicIpv6("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects localhost-like hostnames", () => {
    expect(isHostnameSafe("localhost")).toBe(false);
    expect(isHostnameSafe("myhost.local")).toBe(false);
    expect(isHostnameSafe("svc.internal")).toBe(false);
    expect(isHostnameSafe("169.254.169.254.nip.io")).toBe(true); // name itself is fine; DNS check catches the IP
    expect(isHostnameSafe("example.com")).toBe(true);
  });
});

describe("fetchSafeImage: URL validation", () => {
  const noNet = { lookup: async () => { throw new Error("no network in unit tests"); }, fetchImpl: (async () => okImage()) as typeof fetch };
  it("rejects non-http(s) protocols", async () => {
    await expect(fetchSafeImage("ftp://example.com/a.jpg", noNet)).rejects.toThrow("протокол");
    await expect(fetchSafeImage("file:///etc/passwd", noNet)).rejects.toThrow("протокол");
  });
  it("rejects internal hostnames and IP literals", async () => {
    await expect(fetchSafeImage("http://localhost:5432/", noNet)).rejects.toThrow("внутренний адрес");
    await expect(fetchSafeImage("http://169.254.169.254/latest/meta-data/", noNet)).rejects.toThrow("приватном");
    await expect(fetchSafeImage("http://10.0.0.5/x.png", noNet)).rejects.toThrow("приватном");
    await expect(fetchSafeImage("http://127.0.0.1:5432/", noNet)).rejects.toThrow("приватном");
  });
});

describe("fetchSafeImage: DNS is fail-closed", () => {
  it("rejects when ANY resolved address is private (rebinding mitigation)", async () => {
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(
      fetchSafeImage("https://evil.example.com/a.jpg", { lookup, fetchImpl: (async () => okImage()) as typeof fetch })
    ).rejects.toThrow("служебный адрес");
  });
  it("rejects DNS failure", async () => {
    await expect(
      fetchSafeImage("https://missing.example.com/a.jpg", {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      })
    ).rejects.toThrow("DNS");
  });
  it("fetches when all addresses are public", async () => {
    const r = await fetchSafeImage("https://ok.example.com/a.jpg", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: (async () => okImage()) as typeof fetch,
    });
    expect(r.contentType).toBe("image/jpeg");
    expect(r.bytes).toBe(1024);
    expect(r.base64.length).toBeGreaterThan(0);
  });
});

describe("fetchSafeImage: transfer guards", () => {
  const publicDns = { lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetchImpl: undefined as unknown as typeof fetch };
  it("rejects disallowed Content-Type", async () => {
    await expect(
      fetchSafeImage("https://ok.example.com/a.html", {
        ...publicDns,
        fetchImpl: (async () => okImage("text/html")) as typeof fetch,
      })
    ).rejects.toThrow("тип");
  });
  it("rejects oversized files (content-length and actual bytes)", async () => {
    await expect(
      fetchSafeImage("https://ok.example.com/big.jpg", {
        ...publicDns,
        maxBytes: 100,
        fetchImpl: (async () => new Response(Buffer.alloc(101, 7), { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch,
      })
    ).rejects.toThrow("лимит");
    await expect(
      fetchSafeImage("https://ok.example.com/big2.jpg", {
        ...publicDns,
        maxBytes: 100,
        fetchImpl: ((async () =>
          new Response(Buffer.alloc(101, 7), { status: 200, headers: { "content-type": "image/jpeg", "content-length": "99" } })) as typeof fetch),
      })
    ).rejects.toThrow("лимит");
  });
  it("rejects redirects (a 302 to an internal URL must not be followed)", async () => {
    await expect(
      fetchSafeImage("https://ok.example.com/redirect.jpg", {
        ...publicDns,
        fetchImpl: (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:5432/" } })) as typeof fetch,
      })
    ).rejects.toThrow();
  });
  it("rejects HTTP errors", async () => {
    await expect(
      fetchSafeImage("https://ok.example.com/404.jpg", {
        ...publicDns,
        fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch,
      })
    ).rejects.toThrow("404");
  });
});

describe("fetchSafeImage: domain allowlist", () => {
  const publicDns = { lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
  it("blocks domains outside the allowlist", async () => {
    await expect(
      fetchSafeImage("https://cdn.evil.com/a.jpg", {
        ...publicDns,
        allowlist: ["images.trusted.ru"],
        fetchImpl: (async () => okImage()) as typeof fetch,
      })
    ).rejects.toThrow("разрешённого списка");
  });
  it("allows allowlisted domains (exact and subdomain)", async () => {
    const r = await fetchSafeImage("https://sub.images.trusted.ru/a.jpg", {
      ...publicDns,
      allowlist: ["images.trusted.ru"],
      fetchImpl: (async () => okImage()) as typeof fetch,
    });
    expect(r.bytes).toBeGreaterThan(0);
  });
});
