import type { Transport, TransportResponse } from "./ports.ts";

/**
 * The real transport: one HTTP request, one response, timed by the dispatcher around it.
 *
 * Deliberately thin. Everything this could helpfully add — retries, redirect policy, connection
 * pooling knobs — would change *what is being measured* without the report saying so, and this
 * repo's whole pitch is that its numbers describe what actually happened. A retry that turns two
 * failures into one success is a lie about the target.
 */

export interface HttpRequestSpec {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A string is sent as-is; anything else is JSON-encoded and given a JSON content type unless the
   * scenario set one. Encoding cost lands inside the measured window either way, which is honest:
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
  return { body: JSON.stringify(request.body), contentType: JSON_CONTENT_TYPE };
};

const hasContentType = (headers: Readonly<Record<string, string>>): boolean =>
  Object.keys(headers).some((name) => name.toLowerCase() === "content-type");

export const httpTransport: Transport<HttpRequestSpec> = {
  async send(request: HttpRequestSpec): Promise<TransportResponse> {
    const { body, contentType } = bodyOf(request);
    const headers = { ...request.headers };
    if (contentType !== undefined && !hasContentType(headers)) {
      headers["content-type"] = contentType;
    }

    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      body,
    });
    // Drained on purpose: without it the timing stops at the response headers, which would report a
    // streaming target as far faster than any client of it experiences.
    await response.arrayBuffer();

    return { status: response.status };
  },
};
