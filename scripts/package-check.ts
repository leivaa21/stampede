import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Does the **published package** work when a stranger installs it?
 *
 * `pnpm test` runs the source. `pnpm gate:two` runs the source. `pnpm build` proves the bundle
 * compiles. None of them proves that `npm install @leivaa21/stampede && npx stampede run` does
 * anything at all — and the first time anyone actually tried it, it did not: `dist/cli.js` shipped
 * with no shebang, so the shell parsed the JavaScript as shell script and the binary was
 * unrunnable for every user. It had been that way since M1. `pnpm dev` runs `node src/cli.ts`,
 * which needs no shebang, so nothing in the repo ever executed the thing it publishes.
 *
 *   pnpm check:package
 *
 * The gap this closes is the packaging one specifically: what `files` includes, whether the `bin`
 * is executable, whether `exports` resolves for a config that imports the package by name, and
 * whether the whole thing runs against a real server from a directory that is not this repo.
 *
 * Exits 1 if a claim fails, 2 if the check could not be run — the same contract as gate two.
 */

const LINE = "─".repeat(76);
let failures = 0;

const claim = (label: string, holds: boolean, detail: string): void => {
  if (!holds) {
    failures += 1;
  }
  process.stdout.write(`  ${holds ? "PASS" : "FAIL"}  ${label} — ${detail}\n`);
};

/** Loopback only, and outside the workspace's `5 P S V` range so it cannot collide with a service. */
const PORT = 5996;

const CONFIG = `import { defineConfig, constantRate } from "@leivaa21/stampede";

export default defineConfig({
  setup: () => ({ url: "http://127.0.0.1:${String(PORT)}/", seats: ["a", "b", "c"] }),
  scenarios: {
    buy: {
      profile: constantRate({ ratePerSecond: 20, durationMs: 500 }),
      request: (s, ordinal) => ({ url: s.url + "?seat=" + s.seats[ordinal % s.seats.length] }),
      checks: { "answers 200": (r) => r.status === 200 },
    },
  },
  thresholds: [{ name: "p99 under 2s", assert: (r) => (r.scenarios[0]?.latencyMs?.p99 ?? 0) < 2000 }],
});
`;

const repoRoot = path.resolve(import.meta.dirname, "..");
const version = execFileSync("node", ["-p", "require('./package.json').version"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

const workspace = mkdtempSync(path.join(tmpdir(), "stampede-package-"));
const server = createServer((_request, response) => {
  response.writeHead(200);
  response.end("ok");
});

process.stdout.write(
  `\n${LINE}\nPACKAGE CHECK — installing ${version} as a stranger would\n${LINE}\n`,
);

try {
  // `pnpm pack` runs the real `files`/`prepack` path, so this is the tarball npm would publish
  // rather than a copy of `dist`.
  const packed = execFileSync("pnpm", ["pack", "--pack-destination", workspace], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1);
  if (packed === undefined) {
    throw new Error("pnpm pack printed no tarball path");
  }

  writeFileSync(path.join(workspace, "package.json"), '{"name":"stampede-package-check"}\n');
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", packed], {
    cwd: workspace,
    encoding: "utf8",
  });

  const binary = path.join(workspace, "node_modules", ".bin", "stampede");
  claim(
    "the package installs and puts a `stampede` binary on the path",
    lstatSync(binary).isSymbolicLink() || lstatSync(binary).isFile(),
    binary,
  );

  // The one the missing shebang broke. Run through the shell's own resolution — invoking it as
  // `node dist/cli.js` would pass with no shebang at all, which is exactly how this went unnoticed.
  //
  // Caught rather than left to throw, because "the binary does not execute" *is* the claim failing.
  // Letting it reach the outer handler reported the bug this check was written for as "could not
  // run" — the classification that means the opposite, and the one the nightly stays silent about.
  let reported: string;
  try {
    reported = execFileSync(binary, ["--version"], { cwd: workspace, encoding: "utf8" }).trim();
  } catch (error: unknown) {
    reported = `did not execute: ${error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error)}`;
  }
  claim(
    "the binary executes directly, and reports the version being published",
    reported === version,
    reported === version ? `${reported}, from a bin npm linked itself` : reported,
  );

  writeFileSync(path.join(workspace, "scenarios.mts"), CONFIG);
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const run = spawn(binary, ["run", "scenarios.mts"], { cwd: workspace });
  let output = "";
  run.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  run.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number>((resolve) => {
    run.on("close", (value) => {
      resolve(value ?? 1);
    });
  });

  // A config that imports the package **by name**, from a directory that is not this repo. That is
  // what proves `exports` resolves and that `worker-entry.js` shipped next to the pool that spawns
  // it by path — the failure mode a bundler mirroring the source tree would reintroduce silently.
  claim(
    "a config importing the package by name runs to a clean exit",
    code === 0,
    `exit ${String(code)}`,
  );
  claim(
    "it really drove the target",
    output.includes("10 sent · 10 answered"),
    output.split("\n").find((l) => l.includes("requests")) ?? "no request line",
  );
  const checked = output.includes("PASS  answers 200");
  const graded = output.includes("PASS    p99 under 2s");
  claim(
    "checks and thresholds came through the bundle",
    checked && graded,
    // Not a constant: written as one it read "check and threshold both reported" on the run where
    // neither was, which is a detail line contradicting the FAIL two words to its left.
    `check ${checked ? "reported" : "missing"}, threshold ${graded ? "reported" : "missing"}`,
  );
} catch (error: unknown) {
  process.stderr.write(
    `\n${LINE}\nPACKAGE CHECK COULD NOT RUN — this is not a failed claim\n${LINE}\n`,
  );
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  server.close();
  rmSync(workspace, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 2);
}

server.close();
rmSync(workspace, { recursive: true, force: true });
process.stdout.write(`${LINE}\n`);
process.stdout.write(
  failures === 0
    ? "PACKAGE CHECK PASSED — the published tarball runs\n"
    : `PACKAGE CHECK FAILED — ${String(failures)} claim(s) did not hold\n`,
);
process.stdout.write(`${LINE}\n`);
process.exitCode = failures === 0 ? 0 : 1;
