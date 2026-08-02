/**
 * The one error type the config layer throws, in its own module.
 *
 * Its own file because both halves of config loading need it — `load.ts` raises it while turning
 * Node's loader failures into something actionable, `assert-shape.ts` raises it while validating
 * what came back — and having either import it from the other made the two modules a cycle. That
 * cycle was harmless while neither touched the other at evaluation time, and would have become a
 * temporal-dead-zone crash at import the first time one of them grew a top-level constant that
 * called into the other. Nothing in the lint config would have caught it.
 */

export class ConfigLoadError extends Error {
  override readonly name = "ConfigLoadError";
}
