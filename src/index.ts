/**
 * Programmatic entry point — the engine without the CLI or the TUI.
 *
 * Nothing here may import `src/tui/`: the engine has to stay usable as a library, and a consumer
 * asking for a load engine should not be handed a terminal renderer. The dashboard is reachable
 * only through the binary, which is the one place drawing belongs. Enforced by lint — and it
 * caught an attempt to export it from here, which is why the rule exists rather than the habit.
 * See docs/decisions.md — "Engine and TUI share nothing but a typed event stream".
 */
export * from "./cli/run-command.ts";
export * from "./config/index.ts";
export * from "./engine/index.ts";
export { readVersion } from "./version.ts";
