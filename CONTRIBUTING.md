# Contributing

Thanks for taking a look. This repository is the **engine only** — no UI,
no media application, no browser automation. Small, surgical, well-tested
changes are the house style; the existing code and `ARCHITECTURE.md` are
the specification.

## Setup

Requires Node.js >= 20.19 (the HTML parsing stack declares it).

```bash
npm install
npm run build
npm test
```

## The commands that matter

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint (flat config, type-aware) |
| `npm test` | Build, then run the full suite with `node --test` |
| `npm run bench` | Developer-only benchmark harness (never part of `npm test`) |
| `npm run plugins:list` | List plugins discovered in `./plugins` |
| `npm run plugin:run -- <id> <capability> [jsonArgs]` | Execute one capability |
| `npm run plugins:validate -- <dir\|manifest.json>` | Validate a plugin |

`npm test` is the quality gate. It is **offline and deterministic** on
purpose: HTTP tests use a local fixture server, DNS is injected, and the
suite must pass with no network access. Do not add tests that depend on the
public internet.

## What a change should include

1. **A test that fails before the change and passes after it.** Security,
   lifecycle, and boundary behaviour get a regression test with a comment
   saying what the test protects against.
2. **Structured errors, never thrown internals.** Anything a plugin can
   observe must be an engine-authored `{ code, message }` object. No host
   paths, stack traces, or object internals.
3. **Explicit limits.** Any new capability or input path needs a bound, as
   an engine constant that a plugin cannot raise.
4. **Docs in the same commit.** `README.md`/`ARCHITECTURE.md` state the
   behaviour, the limits, and the deliberate non-provisions; keep
   `CHANGELOG.md` current.
5. **`npm run typecheck && npm run lint && npm test` all green.**

## Rules for maintainers

1. Inspect the repository before modifying it.
2. Run `npm test` before declaring a change complete.
3. Keep changes small and understandable.
4. Do not add new phases or new capabilities without an explicit project
   decision — and never add CAPTCHA/Cloudflare/DRM/authentication bypass,
   browser automation, or in-page JavaScript execution. Those are
   permanently out of scope.
5. Never commit secrets, tokens, or credentials.
6. Do not add dependencies casually. The dependency set is deliberately
   small; a new dependency needs a written justification in the same
   commit (correctness that hand-rolled code cannot reach is the accepted
   reason — see the htmlparser2 decision).

## Adding a capability to the plugin API

The plugin API is the surface a plugin may call; it is versioned by
`ENGINE_API_VERSION`. If a change is incompatible for existing plugins,
bump that constant so older manifests fail loudly at validation time
instead of mysteriously at runtime.

Capabilities are **deny-by-default at the host, not the guest**: a new
capability must be (a) gated by `PluginPermissions`, (b) bounded by
engine constants, and (c) covered by a test that asserts the *exact*
context surface, since `tests/security.test.ts` and
`tests/permissions.test.ts` pin it deliberately.

## Reporting security issues

See `SECURITY.md` — please use a private advisory rather than a public
issue.
