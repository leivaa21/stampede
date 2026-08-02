import { createServer, type Server } from "node:http";

/**
 * A target that counts what it was asked for.
 *
 * Used where the assertion needs a witness other than stampede itself: "did four shards really send
 * 200 requests" is only worth asking of something that was on the receiving end. It doubles as the
 * proof-of-life signal for worker teardown — a terminated worker stops arriving.
 */
export interface CountingServer {
  readonly url: string;
  readonly received: () => number;
  /** Every path it was asked for, in arrival order — the witness for per-request variation. */
  readonly paths: () => readonly string[];
  readonly close: () => Promise<void>;
}

export const startCountingServer = async (
  options: { failStatus?: number } = {},
): Promise<CountingServer> => {
  let received = 0;
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    // A count the *config under test* can read over HTTP. A teardown asserting on it is how run
    // ordering gets proven: run before the storm it would see zero.
    if (request.url === "/__count") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ received }));
      return;
    }
    received += 1;
    paths.push(request.url ?? "");
    request.resume();
    response.writeHead(options.failStatus ?? 200, { "content-type": "application/json" });
    response.end("{}");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the counting server did not bind a port");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    received: () => received,
    paths: () => paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
};
