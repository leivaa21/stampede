import type { Clock, Transport, TransportResponse } from "../engine/ports.ts";

/**
 * A target with known behaviour, on the same fake timeline as the generator.
 *
 * Its own latency is a `clock.sleep`, so "the target takes 450 ms" and "the profile dispatches
 * every 100 ms" are two facts about one deterministic timeline — which is what makes "a slow
 * target does not slow the generator down" assertable instead of arguable.
 *
 * The real HTTP transport arrives in a later PR; this is the only implementation of the port in
 * this one.
 */

/** A request the fake understands: a label, so a test can tell one scenario's traffic from another's. */
export interface FakeRequest {
  readonly label: string;
}

export interface FakeTransportOptions {
  readonly clock: Clock;
  /** ms before the target answers. A function lets one run face targets of different speeds. */
  readonly latencyMs?: number | ((request: FakeRequest) => number);
  /** A target that accepts the request and never answers at all. */
  readonly hangs?: boolean;
  /** A target that refuses: `send` rejects, as the port requires of a transport-level failure. */
  readonly fails?: boolean;
  readonly status?: number;
}

interface SentRequest {
  readonly label: string;
  /** The instant the generator handed it over, by the clock both sides share. */
  readonly atMs: number;
}

const OK = 200;

export class FakeTransport implements Transport<FakeRequest> {
  readonly #options: FakeTransportOptions;
  readonly #sent: SentRequest[] = [];

  constructor(options: FakeTransportOptions) {
    this.#options = options;
  }

  get sentCount(): number {
    return this.#sent.length;
  }

  /** When each request went out, optionally narrowed to one scenario's label. */
  sentAtMs(label?: string): readonly number[] {
    return this.#sent
      .filter((sent) => label === undefined || sent.label === label)
      .map((sent) => sent.atMs);
  }

  async send(request: FakeRequest): Promise<TransportResponse> {
    this.#sent.push({ label: request.label, atMs: this.#options.clock.now() });

    if (this.#options.hangs === true) {
      return new Promise<TransportResponse>(() => {
        // A target that accepts the connection and never answers.
      });
    }
    if (this.#options.fails === true) {
      throw new Error(`fake transport refused "${request.label}"`);
    }

    const latencyMs = this.#latencyMsFor(request);
    if (latencyMs > 0) {
      await this.#options.clock.sleep(latencyMs);
    }
    return { status: this.#options.status ?? OK };
  }

  #latencyMsFor(request: FakeRequest): number {
    const { latencyMs } = this.#options;
    if (typeof latencyMs === "function") {
      return latencyMs(request);
    }
    return latencyMs ?? 0;
  }
}
