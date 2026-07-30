/**
 * Edge validation for everything the engine is handed.
 *
 * Every value guarded here is **config-derived** — a rate, a duration, a burst size, an in-flight
 * cap — so they all follow `metrics/validate.ts`'s rule for config-derived input: they **throw**,
 * at startup, before any load is generated. The same config then fails the same way on every run,
 * which is the kindest possible failure for a mistake that would otherwise surface twenty minutes
 * into a load test. (The other rule — refuse and count — is for data-derived names arriving from
 * responses under load; nothing in this file is data-derived.)
 *
 * Nothing is coerced. A negative rate is a bug in the caller, and a silently clamped one would
 * publish a run nobody asked for.
 */

export const assertRatePerSecond = (value: number, subject: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${subject} must be a finite, non-negative number of requests per second, got ${String(value)}`,
    );
  }
};

export const assertDurationMs = (value: number, subject: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${subject} must be a finite, non-negative number of milliseconds, got ${String(value)}`,
    );
  }
};

export const assertCount = (value: number, subject: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${subject} must be a non-negative safe integer, got ${String(value)}`);
  }
};

export const assertPositiveCount = (value: number, subject: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${subject} must be a safe integer of at least 1, got ${String(value)}`);
  }
};
