/**
 * Programmatic entry point — the engine without the CLI or the TUI.
 *
 * Nothing here may import `src/tui/`: the engine has to stay usable as a library.
 * See docs/decisions.md — "Engine and TUI share nothing but a typed event stream".
 */
export * from "./config/index.ts";
export * from "./engine/index.ts";
export { readVersion } from "./version.ts";
