import { createServer } from "node:http";

/**
 * A target whose behaviour is known in advance, so stampede's numbers can be checked against
 * something other than stampede.
 *
 * The point of the reality gate is that an instrument cannot validate itself. This server is the
 * reference: it answers in a fixed time, serves at most `capacity` requests at once and queues the
 * rest, and keeps its own count of what it saw. If stampede says it achieved 200 rps and the server
 * counted 50, one of them is lying and the run says which.
 *
 *   node scripts/reality-gate/target-server.ts --port 5999 --delay 50
 *   node scripts/reality-gate/target-server.ts --port 5999 --delay 200 --capacity 10
 */

const numericArg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) {
    return fallback;
  }
  const raw = process.argv[at + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw new RangeError(`--${name} needs a finite number, got ${String(raw)}`);
  }
  return value;
};

const port = numericArg("port", 5999);
const delayMs = numericArg("delay", 50);
const capacity = numericArg("capacity", Number.POSITIVE_INFINITY);

interface Pending {
  end: (body: string) => void;
}

let received = 0;
let completed = 0;
let inFlight = 0;
let maxInFlight = 0;
let firstAtMs: number | undefined;
let lastAtMs: number | undefined;
const queue: Pending[] = [];

const serve = (pending: Pending): void => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  setTimeout(() => {
    inFlight -= 1;
    completed += 1;
    lastAtMs = performance.now();
    pending.end(JSON.stringify({ ok: true }));
    const next = queue.shift();
    if (next !== undefined) {
      serve(next);
    }
  }, delayMs);
};

const stats = (): string => {
  const elapsedMs = firstAtMs === undefined ? 0 : (lastAtMs ?? performance.now()) - firstAtMs;
  return JSON.stringify({
    received,
    completed,
    maxInFlight,
    queued: queue.length,
    elapsedMs: Math.round(elapsedMs),
    // The server's own view of throughput — the independent check on stampede's claim.
    achievedRps: elapsedMs > 0 ? Math.round((completed / elapsedMs) * 1000) : 0,
  });
};

createServer((request, response) => {
  if (request.url === "/__stats") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(stats());
    return;
  }

  received += 1;
  firstAtMs ??= performance.now();
  request.resume(); // drain the body; this target does not care what it is

  const pending: Pending = {
    end: (body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    },
  };

  if (inFlight >= capacity) {
    queue.push(pending);
  } else {
    serve(pending);
  }
  // Loopback only: `pnpm gate:two` should not put an unauthenticated server on the local network.
}).listen(port, "127.0.0.1", () => {
  const limit = Number.isFinite(capacity) ? String(capacity) : "unbounded";
  process.stdout.write(
    `reality-gate target on :${String(port)} — ${String(delayMs)}ms, capacity ${limit}\n`,
  );
});
