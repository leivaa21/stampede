import type { Transport, TransportResponse } from "./ports.ts";

/**
 * The real transport: one HTTP request, one response, timed by the dispatcher around it.
 *
 * Deliberately thin. Everything this could helpfully add — retries, connection pooling knobs —
 * would change *what is being measured* without the report saying so, and this repo's whole pitch
 * is that its numbers describe what actually happened. A retry that turns two failures into one
 * success is a lie about the target.
 *
 * **Redirects are not followed.** `fetch` defaults to following up to twenty hops, which is a
 * redirect policy inherited by omission — and the most expensive kind, because it is invisible.
 * Behind an http→https 301 it would fold an extra round trip and a TLS handshake into the p50 and
 * attribute them to the endpoint under test, while a `status === 200` check passed for an endpoint
 * that actually answered 301. With `redirect: "manual"` a 3xx is simply a response: timed like any
 * other, reported as the status it really was, and left for the scenario's own checks to judge.
 */

export interface HttpRequestSpec {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A string is sent as-is; anything else is JSON-encoded and given a JSON content type unless the
   * scenario set one. Note `fetch` labels a string body `text/plain` on its own, so pre-serialised
   * JSON needs an explicit `content-type` header — pass the object instead and let it be encoded. Encoding cost lands inside the measured window either way, which is honest:
   * a client that has to serialise a body really does pay for it.
   */
  readonly body?: unknown;
}

const JSON_CONTENT_TYPE = "application/json";

const bodyOf = (request: HttpRequestSpec): { body?: string; contentType?: string } => {
  if (request.body === undefined) {
    return {};
  }
  if (typeof request.body === "string") {
    return { body: request.body };
  }
  // TypeScript's lib declares `JSON.stringify(value: any): string`, which is not true at runtime:
  // a function, a symbol, or an object whose `toJSON` returns nothing all serialise to `undefined`.
  // The rule below is reasoning from that inaccurate signature, so it is suppressed rather than
  // worked around — the case it calls impossible is exactly the one being guarded.
  const encoded: string | undefined = JSON.stringify(request.body);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (encoded === undefined) {
    // Otherwise this becomes a zero-length body carrying a JSON content type — a request the user
    // did not write, sent silently.
    throw new TypeError(
      "a request body must be JSON-serialisable, or a string — a function or symbol is neither",
    );
  }
  return { body: encoded, contentType: JSON_CONTENT_TYPE };
};

const hasContentType = (headers: Readonly<Record<string, string>>): boolean =>
  Object.keys(headers).some((name) => name.toLowerCase() === "content-type");

/**
 * Encoding is memoised per request object.
 *
 * A scenario's request is built once (`config/to-run.ts`) and then sent N times, so serialising it
 * on every dispatch would charge every sample for re-encoding a value that never changed — a
 * systematic bias, and one a real client does not pay, because a real client serialises a
 * *different* body each time. When per-request variation lands, each distinct request encodes once,
 * which is exactly right.
 */
const encoded = new WeakMap<HttpRequestSpec, { body?: string; headers: Record<string, string> }>();

const encode = (request: HttpRequestSpec): { body?: string; headers: Record<string, string> } => {
  const memo = encoded.get(request);
  if (memo !== undefined) {
    return memo;
  }
  const { body, contentType } = bodyOf(request);
  const headers = { ...request.headers };
  if (contentType !== undefined && !hasContentType(headers)) {
    headers["content-type"] = contentType;
  }
  const built = { body, headers };
  encoded.set(request, built);
  return built;
};

export const httpTransport: Transport<HttpRequestSpec> = {
  async send(request: HttpRequestSpec): Promise<TransportResponse> {
    const { body, headers } = encode(request);

    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      body,
      redirect: "manual",
    });
    // Drained on purpose: without it the timing stops at the response headers, which would report a
    // streaming target as far faster than any client of it experiences.
    await response.arrayBuffer();

    return { status: response.status };
  },
};
