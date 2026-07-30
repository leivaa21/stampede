import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries on purpose: the CLI, and the engine as a library. The engine must stay usable
  // programmatically without dragging the TUI in — see docs/decisions.md.
  // `worker-entry` is its own entry because it is loaded by path at runtime, not imported: the
  // pool spawns it with `new Worker(...)`, so it needs to exist as a file in the bundle.
  //
  // Named explicitly rather than given as a path list, because tsup would otherwise mirror the
  // source tree and emit `dist/engine/worker-entry.js`, while the bundled pool lives at
  // `dist/index.js` and looks for a sibling. Naming the outputs keeps "the entry is next to the
  // module that spawns it" true in both `src` and `dist`.
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
    "worker-entry": "src/engine/worker-entry.ts",
  },
  format: ["esm"],
  target: "node24",
  clean: true,
});
