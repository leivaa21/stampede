import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpTransport, type HttpRequestSpec } from "./http-transport.ts";

/**
 * The transport every published latency number is measured around.
 *
 * Tested against a real server rather than a mocked `fetch`, because the claims worth making here
 * are about what actually goes over the wire — the method, the body, the content type, and above
 * all which response the timing window closes on.
 */

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly contentType: string | undefined;
}

let server: Server;
let baseUrl: string;
let seen: Seen[];
let handler: (path: string) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  bytes?: Buffer;
};

beforeEach(async () => {
  seen = [];
  handler = () => ({ status: 200 });
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks).toString(),
        contentType: request.headers["content-type"],
      });
      const { status, headers, body, bytes } = handler(request.url ?? "");
      response.writeHead(status, headers);
      response.end(bytes ?? body ?? "ok");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

const send = (request: Omit<HttpRequestSpec, "url"> & { path?: string }) =>
  httpTransport.send({ ...request, url: `${baseUrl}${request.path ?? "/"}` });

describe("httpTransport", () => {
  it("GETs by default and reports the status", async () => {
    const response = await send({});

    expect(response.status).toBe(200);
    expect(seen[0]?.method).toBe("GET");
  });

  it("hands back the response body it already had to read", async () => {
    // D2-01: the bytes are drained for timing honesty regardless, so decoding them is the only new
    // cost — and it is what makes checks and `onResponse` possible at all.
    handler = () => ({ status: 200, body: '{"behindMs":42}' });

    const response = await send({});

    expect(response.text).toBe('{"behindMs":42}');
  });

  it("hands back headers lower-cased, so a check need not guess the casing", async () => {
    handler = () => ({ status: 200, headers: { "X-Retry-Count": "3" } });

    const response = await send({});

    expect(response.headers["x-retry-count"]).toBe("3");
  });

  it("freezes the headers, so user code cannot edit the record of what was sent", async () => {
    const response = await send({});

    expect(Object.isFrozen(response.headers)).toBe(true);
  });

  it("returns an empty string for a body-less response rather than undefined", async () => {
    // A check reading `response.text` should never have to handle two shapes.
    handler = () => ({ status: 204, body: "" });

    const response = await send({});

    expect(response.text).toBe("");
  });

  it("does not throw on a body that is not valid UTF-8", async () => {
    // `text()` replaces malformed sequences rather than rejecting, which is the behaviour worth
    // pinning: a binary response must not fail a run that never looks at the body.
    handler = () => ({ status: 200, bytes: Buffer.from([0xff, 0xfe, 0x00, 0x41]) });

    const response = await send({});

    expect(response.status).toBe(200);
    expect(typeof response.text).toBe("string");
  });

  it("treats a non-2xx as a response, not a failure", async () => {
    // A 500 is a perfectly good response to time — the target answered. Only a transport-level
    // failure is kept out of the latency percentiles, and turning an error status into a rejection
    // would silently delete the slowest, most interesting samples in a run.
    handler = () => ({ status: 500 });

    await expect(send({})).resolves.toMatchObject({ status: 500 });
  });

  it("does not follow redirects, and reports the 3xx it actually got", async () => {
    // `fetch` follows up to twenty hops by default. Behind an http→https 301 that would fold an
    // extra round trip into the p50 and attribute it to the endpoint under test, while a
    // `status === 200` check passed for an endpoint that answered 301.
    handler = (path) =>
      path === "/start" ? { status: 302, headers: { location: "/final" } } : { status: 200 };

    const response = await send({ path: "/start" });

    expect(response.status).toBe(302);
    expect(seen.map((request) => request.url)).toEqual(["/start"]);
  });

  it("sends a string body untouched, and lets fetch label it text/plain", async () => {
    // The transport adds no content type for a string — but `fetch` does, and it picks
    // text/plain. Worth pinning: a user sending pre-serialised JSON as a string gets text/plain
    // unless they set the header, which is surprising enough that it should not change silently.
    await send({ method: "POST", body: "raw=1" });

    expect(seen[0]?.body).toBe("raw=1");
    expect(seen[0]?.contentType).toBe("text/plain;charset=UTF-8");
  });

  it("JSON-encodes anything else and labels it", async () => {
    await send({ method: "POST", body: { seatIds: ["a1"] } });

    expect(seen[0]?.body).toBe('{"seatIds":["a1"]}');
    expect(seen[0]?.contentType).toBe("application/json");
  });

  it("does not override a content type the scenario set, whatever its casing", async () => {
    await send({
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: { a: 1 },
    });

    expect(seen[0]?.contentType).toBe("application/vnd.api+json");
  });

  it("refuses a body that cannot be JSON-encoded instead of sending an empty one", async () => {
    // `JSON.stringify(() => 1)` is `undefined`, which would otherwise go out as a zero-length body
    // carrying a JSON content type — a request the user never wrote.
    await expect(send({ method: "POST", body: () => 1 })).rejects.toThrow(/JSON-serialisable/);
  });

  it("rejects rather than inventing a status when the target is unreachable", async () => {
    await expect(httpTransport.send({ url: "http://127.0.0.1:1/" })).rejects.toThrow();
  });
});
