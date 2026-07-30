import { readFileSync } from "node:fs";

/**
 * Read at runtime rather than baked in at build time, so a published binary and a `pnpm dev` run
 * can never disagree about which version produced a report.
 */
export const readVersion = (packageJsonUrl: URL): string => {
  // The repo promises actionable errors, never raw stack traces — so the parse gets the same
  // guard treatment as the two shape checks below, rather than leaking a bare SyntaxError.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${packageJsonUrl.pathname}: ${detail}`, { cause: error });
  }

  if (typeof raw !== "object" || raw === null || !("version" in raw)) {
    throw new Error(`No "version" field in ${packageJsonUrl.pathname}`);
  }
  const { version } = raw;
  if (typeof version !== "string") {
    throw new Error(`"version" is not a string in ${packageJsonUrl.pathname}`);
  }
  return version;
};
