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
/** Sales the projection can apply per 50ms tick. Low enough to fall behind under a burst. */
const projectionRate = numericArg("projection-rate", 4);

interface Pending {
  /** Called once the target has "done the work" — this is where a reservation is decided. */
  respond: () => void;
}

let received = 0;
let completed = 0;
let inFlight = 0;
let maxInFlight = 0;
let firstAtMs: number | undefined;
let lastAtMs: number | undefined;
const queue: Pending[] = [];

/**
 * Seats, sold at most once each — the referee for the contract runs.
 *
 * The decision happens when the request is *served*, not when it arrives, which is what a
 * serialized reservation really does. A tool claiming "exactly one 201" can then be checked
 * against a count kept by something that is not the tool.
 */
const soldSeats = new Set<string>();

/**
 * A projection that applies sales at a fixed rate, so it can fall behind.
 *
 * `behindMs` is now minus the recorded time of the last applied sale, `0` when caught up — the
 * same definition open-ticket's M4 settled on, so contract run 4's shape can be produced here
 * rather than waited on.
 */
const unapplied: number[] = [];
let lastAppliedAtMs: number | undefined;
let maxBehindMs = 0;

const behindMs = (): number => {
  // Open-ticket's definition, literally: now minus the recorded time of the last *applied* event,
  // and 0 when caught up. Not "now minus the oldest unapplied", which is a different number and
  // would make the gate agree with itself rather than with the contract.
  if (unapplied.length === 0) {
    return 0;
  }
  return Math.round(performance.now() - (lastAppliedAtMs ?? unapplied[0] ?? performance.now()));
};

setInterval(() => {
  // Measured *before* draining: the peak lag is what it was when the projector woke up, and
  // sampling after it caught up would report a serene 0 for a projection that was 400ms behind a
  // moment earlier — the exact flattery this whole repo exists to refuse.
  maxBehindMs = Math.max(maxBehindMs, behindMs());
  // A fixed budget per tick: the projector is the bottleneck when sales arrive faster than this,
  // which is exactly the condition contract run 4 measures.
  for (let applied = 0; applied < projectionRate && unapplied.length > 0; applied += 1) {
    lastAppliedAtMs = unapplied.shift();
  }
}, 50).unref();

const serve = (pending: Pending): void => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  setTimeout(() => {
    inFlight -= 1;
    completed += 1;
    lastAtMs = performance.now();
    pending.respond();
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
    // The referee's own tally: how many seats it really sold, and how far its projection fell
    // behind. Nothing stampede reports about seats is believed unless these agree.
    sold: soldSeats.size,
    unapplied: unapplied.length,
    maxBehindMs,
    lastAppliedAgoMs:
      lastAppliedAtMs === undefined ? 0 : Math.round(performance.now() - lastAppliedAtMs),
  });
};

/** `POST /seats/<id>` is a reservation; anything else is the plain timed endpoint. */
const seatIdFrom = (url: string | undefined): string | undefined => {
  const match = /^\/seats\/([\w-]{1,64})$/.exec(url ?? "");
  return match?.[1];
};

const reply = (
  response: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  },
  status: number,
  body: Record<string, unknown>,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
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

  const seatId = seatIdFrom(request.url);
  const pending: Pending = {
    respond: () => {
      if (seatId === undefined) {
        reply(response, 200, { ok: true });
        return;
      }
      // 409, not 200-with-a-flag: the contract runs assert on the status, and a target that
      // signalled a conflict with a 200 would let a check written against 201 pass by accident.
      if (soldSeats.has(seatId)) {
        reply(response, 409, { ok: false, seatId, reason: "already sold", behindMs: behindMs() });
        return;
      }
      soldSeats.add(seatId);
      unapplied.push(performance.now());
      reply(response, 201, { ok: true, seatId, behindMs: behindMs() });
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
