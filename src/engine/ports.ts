/**
 * The two ports the engine reaches the outside world through: time, and the target.
 *
 * Both are interfaces for the same reason. D1-01's guarantee is a claim about what the numbers say
 * **when the generator itself wakes up late** — and the only way to assert that without a flaky
 * sleep in a test is to be able to make it wake up late on purpose. So no file under `src/engine/`
 * calls `Date.now`, `performance.now` or `setTimeout` directly; `system-clock.ts` is the single
 * adapter that does, and a test swaps it for a clock it drives by hand.
 */

export interface Clock {
  /**
   * Monotonic milliseconds from an arbitrary origin — only differences are meaningful.
   *
   * Monotonic and not wall-clock: an NTP step mid-run would otherwise turn into a negative latency
   * or a free one, and a load test is exactly the kind of long-running process a machine picks to
   * resynchronise during.
   */
  now(): number;

  /**
   * Resolves no earlier than `durationMs` from now — and in practice later, which is the honest
   * half of this contract and the reason the dispatcher re-reads the clock after every wait.
   *
   * `durationMs <= 0` means "hand the event loop one turn", not "sleep zero".
   */
  sleep(durationMs: number): Promise<void>;
}

/**
 * What the target answered.
 *
 * The engine times a response; it does not judge it. Whether a 409 is a failure or the expected
 * outcome of 499 buyers losing a race is a question only the scenario can answer, so status
 * interpretation belongs to its checks (a later PR), not here.
 */
export interface TransportResponse {
  readonly status: number;
  /**
   * Header names lower-cased once, here, so a check can read `headers["x-retry-count"]` without
   * knowing what casing the target chose. HTTP header names are case-insensitive; a check that has
   * to guess is a check that silently reads `undefined`.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The response body, decoded (D2-01).
   *
   * Always present, because the bytes are **already read** — the transport drains the body so the
   * measured window covers the whole response rather than stopping at the headers. The only new
   * cost is decoding them, and it buys an API with no flag to forget and no `undefined` body to
   * explain.
   *
   * A string, not parsed JSON: parsing costs on the hot path and throws on the one response that
   * is not JSON, which is exactly the response a check most wants to catch.
   */
  readonly text: string;
}

/**
 * Sends one request and waits for the response.
 *
 * Generic in the request because the engine does not know what a request *is*. `http-transport.ts`
 * is the shipped implementation; the generic is what let it arrive without the scheduler changing,
 * and what will let a streaming transport arrive the same way.
 *
 * **`send` must reject on a transport-level failure** (connection refused, DNS, timeout) rather
 * than resolving with a synthetic status. The dispatcher counts those separately and deliberately
 * keeps them out of the latency histogram — an instant ECONNREFUSED recorded as a 0.1 ms latency
 * would be the most flattering p99 a broken target could possibly produce.
 */
export interface Transport<TRequest> {
  send(request: TRequest): Promise<TransportResponse>;
}
