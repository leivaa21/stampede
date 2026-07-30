import { readFileSync } from "node:fs";

/**
 * Read at runtime rather than baked in at build time, so a published binary and a `pnpm dev` run
 * can never disagree about which version produced a report.
 */
export const readVersion = (packageJsonUrl: URL): string => {
  const raw: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  if (typeof raw !== "object" || raw === null || !("version" in raw)) {
    throw new Error(`No "version" field in ${packageJsonUrl.pathname}`);
  }
  const { version } = raw;
  if (typeof version !== "string") {
    throw new Error(`"version" is not a string in ${packageJsonUrl.pathname}`);
  }
  return version;
};
