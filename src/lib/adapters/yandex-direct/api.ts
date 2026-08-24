// Yandex Direct API v5 — low-level JSON client (contract verified against the
// official docs: tech.yandex.com/dev/direct).
//
//   POST https://api.direct.yandex.com/json/v5/{service}
//   Authorization: Bearer <token>
//   body: { "method": "get|update|suspend|resume|...", "params": { ... } }
//   response: { "result": {...}, "errors": [{ Code, Message, Details? }] }
//
// Sandbox endpoint: https://api-sandbox.direct.yandex.com/json/v5/{service}
//
// Transport is injectable (YandexTransport) so the provider contract can be
// verified against a simulator without a real account (Phase E, E8).

export interface YandexApiError {
  Code: number;
  Message: string;
  Details?: string;
}

export interface YandexResponse<T = unknown> {
  result?: T;
  errors?: YandexApiError[];
}

export type YandexTransport = (service: string, method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Errors that are worth retrying (transient). */
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);

export class DirectApi {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly baseUrl: string,
    private readonly transport?: YandexTransport,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** One API call with retry on transient failures (E7). */
  async call<T = unknown>(service: string, method: string, params: Record<string, unknown>, maxAttempts = 3): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const transport = this.transport ?? this.httpTransport();
        const raw = (await transport(service, method, params)) as YandexResponse<T>;
        // API-level errors: retry only transient-looking ones (server-side codes).
        if (raw.errors?.length && !raw.result) {
          const transient = raw.errors.every((e) => e.Code >= 1000 || e.Code === 13); // 13 = server internal
          const err = new Error(`Direct API error: ${raw.errors.map((e) => `${e.Code}: ${e.Message}`).join("; ")}`) as Error & { transient?: boolean };
          err.transient = transient;
          lastError = err;
          if (!transient || attempt === maxAttempts) throw err;
        } else {
          return raw.result as T;
        }
      } catch (e) {
        lastError = e as Error;
        const status = (e as { status?: number }).status;
        const transient =
          (e as { transient?: boolean }).transient === true ||
          (status != null && TRANSIENT_HTTP.has(status)) ||
          ((e as TypeError)?.message ?? "").includes("fetch failed");
        if (!transient || attempt === maxAttempts) throw e;
      }
      // exponential backoff: 400ms, 1200ms
      await sleep(400 * 2 ** (attempt - 1));
    }
    throw lastError ?? new Error("Direct API: unexpected retry loop exit");
  }

  private httpTransport(): YandexTransport {
    return async (service, method, params) => {
      const token = await this.token();
      const res = await this.fetchImpl(`${this.baseUrl}/${service}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ method, params }),
      });
      const status = res.status;
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`Direct HTTP ${status}: ${text.slice(0, 300)}`) as Error & { status?: number };
        err.status = status;
        throw err;
      }
      try {
        return JSON.parse(text);
      } catch {
        // Some services (reports) can return non-JSON bodies; surface as result.
        return { result: text };
      }
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
