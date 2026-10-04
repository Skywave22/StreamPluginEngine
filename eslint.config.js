// ESLint flat config.
//
// Scope: catch real mistakes that `tsc --strict` cannot see — floating
// promises, misused async functions, and `any` leaking into the public
// surface. Formatting rules are deliberately NOT enabled: the project has
// no formatter and does not need one for a codebase this size.
//
// Type-aware rules require the TypeScript project service, so lint runs
// over src/ and tests/ only (the build output and tooling scripts are not
// part of the type-checked program).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The engine treats plugin input as `unknown` and narrows it; `any`
      // would undo that discipline at exactly the wrong boundary.
      "@typescript-eslint/no-explicit-any": "error",
      // Unused code is already an error in tsconfig, but this also covers
      // unused catch bindings and imports that survive type-erasure.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // A dropped promise in an engine that owns timeouts, aborts, and
      // teardown ordering is a real defect class, not a style nit.
      // `node:test`'s `test()/before()/after()` return a promise that the
      // test runner owns and awaits itself, so those calls are safe.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "it", "describe", "before", "after", "beforeEach", "afterEach"],
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "off",
      // Empty catch blocks are intentional in teardown paths (see the
      // comments there); allow them when they carry a comment.
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
    },
  },
  {
    // The pure guest-source strings and fixtures are string literals; the
    // rules above do not apply to their contents.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);
