import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `scripts/` is in here for one reason: the reality gate's projection model is the arbiter of
    // the lag claim this repo publishes, and an arbiter with no tests is an assertion nobody
    // checked. Everything else under `scripts/` is I/O and stays proven by `pnpm gate:two` itself.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
