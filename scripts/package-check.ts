import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { plain } from "../src/report/format.ts";

/**
 * Does the **published package** work when a stranger installs it?
 *
 * `pnpm test` runs the source. `pnpm gate:two` runs the source. `pnpm build` proves the bundle
 * compiles. None of them proves that `npm install @leivaa21/stampede && npx stampede run` does
 * anything at all — and the first time anyone actually tried it, it did not: `dist/cli.js` was
 * built with no shebang, so the shell parsed the JavaScript as shell script and the binary was
 * unrunnable once installed. It had been that way since M1. `pnpm dev` runs `node src/cli.ts`,
 * which needs no shebang, so nothing in the repo ever executed the thing it publishes.
 *
 *   pnpm check:package
 *
 * The gap this closes is the packaging one specifically: what `files` includes, whether the `bin`
 * is executable, whether `exports` resolves for a config that imports the package by name, and
 * whether the whole thing runs against a real server from a directory that is not this repo.
 *
 * **Exit codes are gate two's contract**: `1` a claim did not hold, `2` the check could not be run.
 * Getting that backwards is the failure this file cares most about — reporting a real packaging
 * regression as "could not run" is how a gate goes quiet about the only thing it watches. So every
 * claim catches its own throw, and the two process handlers below cover the ways Node reports
 * failure asynchronously, out of reach of any `await`.
 */

const LINE = "─".repeat(76);
let failures = 0;
let claims = 0;
let served = 0;

const claim = (label: string, holds: boolean, detail: string): void => {
  claims += 1;
  if (!holds) {
    failures += 1;
  }
  process.stdout.write(`  ${holds ? "PASS" : "FAIL"}  ${label} — ${plain(detail)}\n`);
};

const describe = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

const firstLine = (error: unknown): string => describe(error).split("\n")[0] ?? "";

const workspace = mkdtempSync(path.join(tmpdir(), "stampede-package-"));
const server = createServer((_request, response) => {
  served += 1;
  response.writeHead(200);
  response.end("ok");
});

const cleanUp = (): void => {
  server.close();
  rmSync(workspace, { recursive: true, force: true });
};

const couldNotRun = (error: unknown): never => {
  process.stderr.write(
    `\n${LINE}\nPACKAGE CHECK COULD NOT RUN — this is not a failed claim\n${LINE}\n`,
  );
  process.stderr.write(
    `${describe(error)
      .split("\n")
      .map((line) => plain(line))
      .join("\n")}\n`,
  );
  // A claim that already failed outranks the crash — exit 2 means "no evidence either way", and
  // that is false once something has been shown not to hold. Same rule as `reality-gate/run.ts`.
  if (failures > 0) {
    process.stderr.write(
      `${LINE}\nPACKAGE CHECK FAILED — ${String(failures)} claim(s) did not hold before the crash\n${LINE}\n`,
    );
  }
  cleanUp();
  process.exit(failures > 0 ? 1 : 2);
};

// `server.listen` and `spawn` report failure by *emitting*, not by rejecting, so no `await` around
// them can catch it. Without these, a port already in use exited 1 — the code reserved for "a claim
// did not hold" — under no banner at all, and leaked a scratch directory holding a `node_modules`.
process.on("uncaughtException", couldNotRun);
process.on("unhandledRejection", couldNotRun);

const repoRoot = path.resolve(import.meta.dirname, "..");
const version = execFileSync("node", ["-p", "require('./package.json').version"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

/**
 * The config the gate installs and runs — deliberately the README's own shape.
 *
 * `?? Infinity`, not `?? 0`. The first draft wrote `p99` (the field is `p99Ms`) with `?? 0`, so the
 * threshold read `(undefined ?? 0) < 2000` and passed no matter what: a bundling regression that
 * dropped `latencyMs` from the summary — exactly the "is the artifact the artifact" failure this
 * gate exists for — would still have printed PASS. `metrics/summaries.ts` warns about that exact
 * `?? 0` in prose, and this file is one a stranger will read as canonical usage. It escaped
 * `pnpm typecheck` because it is a string literal written to a scratch file.
 *
 * The keyed counter and the plain counter are here because `onResponse` and declared key spaces are
 * 0.2.0's headline additions and the surface most likely to break across a bundle boundary. Written
 * against the real API: the first draft called `record.trend`, which does not exist, and the run
 * reported ten broken observations — the three-state check design catching this file's own bug,
 * which is a fair advertisement for it but not something to ship in a usage example.
 */
const configFor = (
  port: number,
): string => `import { defineConfig, constantRate } from "@leivaa21/stampede";

export default defineConfig({
  setup: () => ({ url: "http://127.0.0.1:${String(port)}/", seats: ["a", "b", "c"] }),
  scenarios: {
    buy: {
      profile: constantRate({ ratePerSecond: 20, durationMs: 500 }),
      request: (s, ordinal) => ({ url: s.url + "?seat=" + s.seats[ordinal % s.seats.length] }),
      checks: { "answers 200": (r) => r.status === 200 },
      counters: { byStatus: { keys: ["2xx", "5xx"] } },
      onResponse: (r, record) => {
        record.countKeyed("byStatus", r.status < 300 ? "2xx" : "5xx");
        record.count("answered");
      },
    },
  },
  thresholds: [
    { name: "p99 under 2s", assert: (r) => (r.scenarios[0]?.latencyMs?.p99Ms ?? Infinity) < 2000 },
    { name: "every response was 2xx", assert: (r) => r.scenarios[0]?.keyedCounters.byStatus?.["2xx"] === 10 },
    { name: "onResponse ran for each", assert: (r) => r.scenarios[0]?.counters.answered === 10 },
  ],
});
`;

process.stdout.write(
  `\n${LINE}\nPACKAGE CHECK — installing ${version} as a stranger would\n${LINE}\n`,
);

try {
  // `pnpm pack` runs the real `files` path, so this is the tarball npm would publish rather than a
  // copy of `dist`. The name is *asserted* rather than read off the last line: pnpm prints update
  // notices, and a trailing one would otherwise be handed straight to `npm install`.
  const expected = `leivaa21-stampede-${version}.tgz`;
  const packOutput = execFileSync("pnpm", ["pack", "--pack-destination", workspace], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const packed = packOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(expected));
  claim(
    "`pnpm pack` produces the tarball this version would publish",
    packed !== undefined,
    packed ?? `nothing named ${expected}; pnpm said: ${packOutput.trim()}`,
  );
  if (packed === undefined) {
    throw new Error("cannot continue without a tarball");
  }

  // `"type": "module"` and a `.ts` config, because that is what the README's quickstart tells
  // people to write. A `.mts` file in a typeless package would pass while the documented layout
  // was broken.
  writeFileSync(
    path.join(workspace, "package.json"),
    '{"name":"stampede-package-check","type":"module"}\n',
  );
  let installFailure = "";
  try {
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", packed], {
      cwd: workspace,
      encoding: "utf8",
    });
  } catch (error: unknown) {
    installFailure = firstLine(error);
  }
  // Its own claim rather than a bare call: a tarball that will not install is an artifact defect,
  // and letting the throw reach the outer handler would report it as "could not run". Today the
  // package has no runtime dependencies, which is a fact about today and not about the gate.
  claim(
    "the tarball installs into an empty package",
    installFailure === "",
    installFailure === "" ? "npm install clean" : installFailure,
  );

  // Every claim catches its own throw. `lstatSync` throws when the binary is absent, so leaving it
  // bare reported a missing `bin` — the exact regression this gate exists for — as "could not run".
  const binary = path.join(workspace, "node_modules", ".bin", "stampede");
  let installed = false;
  try {
    const entry = lstatSync(binary);
    installed = entry.isSymbolicLink() || entry.isFile();
  } catch {
    installed = false;
  }
  claim(
    "the package installs and puts a `stampede` binary on the path",
    installed,
    installed ? binary : `nothing at ${binary}`,
  );

  // The one the missing shebang broke. Run through the shell's own resolution — invoking it as
  // `node dist/cli.js` would pass with no shebang at all, which is exactly how this went unnoticed.
  let reported: string;
  try {
    reported = execFileSync(binary, ["--version"], { cwd: workspace, encoding: "utf8" }).trim();
  } catch (error: unknown) {
    reported = `did not execute: ${firstLine(error)}`;
  }
  claim(
    "the binary executes directly, and reports the version being published",
    reported === version,
    reported === version ? `${reported}, from a bin npm linked itself` : reported,
  );

  // Port 0: the OS picks a free one. A fixed port made this gate fail for a reason that had nothing
  // to do with the package, which on a shared runner is how a check earns being ignored.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the check's own server did not report a port");
  }
  writeFileSync(path.join(workspace, "scenarios.ts"), configFor(address.port));

  const run = spawn(binary, ["run", "scenarios.ts"], { cwd: workspace });
  let output = "";
  run.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  run.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  // A wedged run would otherwise hold a CI runner until the job timeout. 60s against a run the
  // config bounds to 500ms of arrivals plus a drain.
  const killer = setTimeout(() => run.kill("SIGKILL"), 60_000);
  const code = await new Promise<number>((resolve) => {
    run.on("error", (error: unknown) => {
      output += describe(error);
      resolve(-1);
    });
    run.on("close", (value, signal) => {
      // `close` gives a null code on a signal, and `?? 1` would map a killed run onto the code that
      // means "a threshold was violated".
      resolve(signal === null ? (value ?? 1) : -2);
    });
  });
  clearTimeout(killer);

  // A config that imports the package **by name**, from a directory that is not this repo. That is
  // what proves `exports` resolves and that `worker-entry.js` shipped next to the pool that spawns
  // it by path — the failure mode a bundler mirroring the source tree would reintroduce silently.
  claim(
    "a config importing the package by name runs to a clean exit",
    code === 0,
    code === -2 ? "killed after 60s without finishing" : `exit ${String(code)}`,
  );
  // Counted by the server, not read out of stampede's own summary. A claim that the tool drove the
  // target, checked against the tool's own report of driving the target, is not a claim.
  claim(
    "it really drove the target",
    served === 10,
    `${String(served)} requests reached the server, of 10 scheduled`,
  );
  // Whitespace-tolerant on purpose: matching exact column widths would redden every PR on a
  // cosmetic change in `cli/render.ts` — a false negative on a required check, which is how a gate
  // earns being ignored. The claim is that they were reported, not how they were aligned.
  const checked = /PASS\s+answers 200/.test(output) && !output.includes("broken observations");
  const graded =
    /PASS\s+p99 under 2s/.test(output) &&
    /PASS\s+every response was 2xx/.test(output) &&
    /PASS\s+onResponse ran for each/.test(output);
  claim(
    "checks and thresholds came through the bundle",
    checked && graded,
    // Not a constant: written as one it read "check and threshold both reported" on the run where
    // neither was, which is a detail line contradicting the FAIL two words to its left.
    `check ${checked ? "reported" : "missing"}, threshold ${graded ? "reported" : "missing"}`,
  );
} catch (error: unknown) {
  couldNotRun(error);
}

cleanUp();
process.stdout.write(`${LINE}\n`);
process.stdout.write(
  claims === 0
    ? "PACKAGE CHECK COULD NOT RUN — no claims were made\n"
    : failures === 0
      ? `PACKAGE CHECK PASSED — ${String(claims)} claims, the published tarball runs\n`
      : `PACKAGE CHECK FAILED — ${String(failures)} claim(s) did not hold\n`,
);
process.stdout.write(`${LINE}\n`);
process.exitCode = claims === 0 ? 2 : failures === 0 ? 0 : 1;
