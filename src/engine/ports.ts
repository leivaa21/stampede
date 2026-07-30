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
}

/**
 * Sends one request and waits for the response.
 *
 * Generic in the request because the engine does not know what a request *is* — HTTP arrives with
 * the real transport in a later PR, and nothing in the scheduler should have to change when it
 * does. This PR ships only a fake.
 *
 * **`send` must reject on a transport-level failure** (connection refused, DNS, timeout) rather
 * than resolving with a synthetic status. The dispatcher counts those separately and deliberately
 * keeps them out of the latency histogram — an instant ECONNREFUSED recorded as a 0.1 ms latency
 * would be the most flattering p99 a broken target could possibly produce.
 */
export interface Transport<TRequest> {
  send(request: TRequest): Promise<TransportResponse>;
}
