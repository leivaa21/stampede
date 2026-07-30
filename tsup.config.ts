import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries on purpose: the CLI, and the engine as a library. The engine must stay usable
  // programmatically without dragging the TUI in — see docs/decisions.md.
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node24",
  clean: true,
});
