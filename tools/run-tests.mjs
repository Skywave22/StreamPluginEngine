/**
 * Runs the compiled test suite in `dist/tests/`.
 *
 * WHY THIS EXISTS INSTEAD OF `node --test dist/tests/`
 *
 *   Node 20 expands a directory argument into the test files it contains.
 *   Node 22 and later do not: every positional argument is treated as a
 *   file path or a glob pattern, so `node --test dist/tests/` dies with
 *
 *       Error: Cannot find module '<repo>/dist/tests'
 *
 *   before a single test runs. This is a runner change, not a packaging
 *   mistake -- it reproduces on a three-line throwaway project that has
 *   nothing to do with this repository.
 *
 *   Reaching for a glob fixes 22 and 24 but breaks 20, which has no glob
 *   support and answers `Could not find '<pattern>'`. Between the two,
 *   every version in `engines` (>= 20.19.0) has to be satisfied, and that
 *   rules both out.
 *
 *   So this script resolves the file list itself and hands `node --test`
 *   explicit paths. That is the one form that behaves identically on every
 *   Node version and every OS in the CI matrix, it needs no shell quoting
 *   (which differs between POSIX and Windows), and -- the part that matters
 *   for a gate -- it can refuse to exit 0 when the build produced no tests
 *   at all. A bare `node --test` exits 0 having run nothing, which would
 *   turn a red build green.
 *
 * USAGE
 *
 *   node tools/run-tests.mjs                          every compiled test
 *   node tools/run-tests.mjs dist/tests/store.test.js  a single file
 *   node tools/run-tests.mjs --test-name-pattern=store  any node --test flag
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledTests = path.join(repoRoot, "dist", "tests");

// Anything on the command line is forwarded verbatim: a single file while
// debugging, or a runner flag such as --test-name-pattern.
const explicitArgs = process.argv.slice(2);

if (explicitArgs.length === 0) {
  const discovered = listCompiledTests();
  if (discovered.length === 0) {
    console.error(
      `run-tests: no compiled tests found in ${compiledTests}.\n` +
        "The build must run before the tests do (`npm run build`)."
    );
    process.exit(1);
  }
  explicitArgs.push(...discovered);
}

const result = spawnSync(process.execPath, ["--test", ...explicitArgs], {
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

// A signal-killed run has no exit status; treat it as failure rather than
// falling through to 0.
process.exit(result.status ?? 1);

/**
 * The compiled `*.test.js` files, sorted so the run order is stable across
 * machines and filesystems.
 * @returns {string[]} absolute paths
 */
function listCompiledTests() {
  let entries;
  try {
    entries = readdirSync(compiledTests);
  } catch (cause) {
    console.error(
      `run-tests: cannot read ${compiledTests} (${cause.code ?? cause.message}).\n` +
        "Run `npm run build` first."
    );
    process.exit(1);
  }
  return entries
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join(compiledTests, name));
}
