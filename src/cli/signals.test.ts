import { describe, expect, it } from "vitest";
import { guardTerminal, SIGINT_EXIT, SIGTERM_EXIT, type SignalTarget } from "./signals.ts";

/**
 * Ctrl-C is the normal way to end a long load test, so this is the common path, not the exotic one.
 * The failure it prevents — a shell left with an invisible cursor — is not something a passing run
 * would ever reveal.
 */

const fakeTarget = () => {
  const handlers = new Map<string, (() => void)[]>();
  const exits: number[] = [];
  const target: SignalTarget = {
    once: (signal, handler) => {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler]);
    },
    off: (signal, handler) => {
      handlers.set(
        signal,
        (handlers.get(signal) ?? []).filter((h) => h !== handler),
      );
    },
    exit: (code) => exits.push(code),
  };
  return {
    target,
    exits,
    raise: (signal: string) => {
      for (const handler of handlers.get(signal) ?? []) {
        handler();
      }
    },
    count: (signal: string) => (handlers.get(signal) ?? []).length,
  };
};

describe("guardTerminal", () => {
  it("restores the terminal before exiting on Ctrl-C", () => {
    const order: string[] = [];
    const fake = fakeTarget();
    guardTerminal(() => order.push("restored"), {
      ...fake.target,
      exit: (code) => {
        order.push(`exit ${String(code)}`);
        fake.exits.push(code);
      },
    });

    fake.raise("SIGINT");

    // Order matters: exiting first would leave the escape sequence unwritten.
    expect(order).toEqual(["restored", `exit ${String(SIGINT_EXIT)}`]);
  });

  it("uses the shell's convention for an interrupted process", () => {
    const fake = fakeTarget();
    guardTerminal(() => undefined, fake.target);

    fake.raise("SIGTERM");

    expect(fake.exits).toEqual([SIGTERM_EXIT]);
  });

  it("leaves no handler behind once the run is over", () => {
    // Registered per run, so a run that ended normally does not change what a later Ctrl-C does.
    const fake = fakeTarget();
    const guard = guardTerminal(() => undefined, fake.target);

    guard.release();

    expect(fake.count("SIGINT")).toBe(0);
    expect(fake.count("SIGTERM")).toBe(0);
  });

  it("does not restore anything after it has been released", () => {
    let restores = 0;
    const fake = fakeTarget();
    const guard = guardTerminal(() => (restores += 1), fake.target);

    guard.release();
    fake.raise("SIGINT");

    expect(restores).toBe(0);
    expect(fake.exits).toEqual([]);
  });

  it("can be released twice without complaint", () => {
    const fake = fakeTarget();
    const guard = guardTerminal(() => undefined, fake.target);

    guard.release();

    expect(() => {
      guard.release();
    }).not.toThrow();
  });
});
