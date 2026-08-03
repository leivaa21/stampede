import { createServer } from "node:http";
import { Projection } from "./projection.ts";

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
 * serialized reservation really does. A tool claiming "exactly one 201" can then be checked against
 * counts kept by something that is not the tool: `soldSeats` for how many *distinct* seats went,
 * `salesIssued` for how many 201s were actually handed out, and `conflicts` for the 409s. The
 * distinct count alone cannot tell one sale from five — it is a `Set` — so "exactly one" needs its
 * own tally or the claim rests entirely on stampede's own counter.
 */
const soldSeats = new Set<string>();
let salesIssued = 0;
let conflicts = 0;

const projection = new Projection(projectionRate);
setInterval(() => {
  projection.tick();
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
    // The referee's own tallies. Nothing stampede reports about seats is believed unless these
    // agree, and they are kept apart on purpose: `sold` is distinct seats, `salesIssued` is 201s,
    // and only the second can tell one sale from five.
    sold: soldSeats.size,
    salesIssued,
    conflicts,
    unapplied: projection.unappliedCount,
    // The peak measured at the instants sales were accepted — not a free-running maximum, which
    // would keep climbing after the load stopped and make the gate's tolerance a race between the
    // run finishing and the gate getting around to asking.
    maxBehindMs: projection.maxBehindAtRecordMs,
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
        conflicts += 1;
        reply(response, 409, {
          ok: false,
          seatId,
          reason: "already sold",
          behindMs: projection.behindMs(performance.now()),
        });
        return;
      }
      soldSeats.add(seatId);
      salesIssued += 1;
      // `record` returns the lag at this instant and latches it into the target's own peak, so the
      // number the gate compares against is the maximum over exactly the instants the responses
      // reported — the same set stampede's trend should have merged.
      reply(response, 201, { ok: true, seatId, behindMs: projection.record(performance.now()) });
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
