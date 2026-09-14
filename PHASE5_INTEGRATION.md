# Phase 5 Integration Notes

This archive is a Phase 5 implementation package for the existing StreamPluginEngine Phase 4 repository.

## Files to add
- `src/phase5.ts`
- `src/phase5-types.ts`
- `tests/phase5.test.ts`

## Required integration

Because Phase 4's `PluginRuntime.buildPluginContext` is private, `phase5.ts` installs the two new capabilities by wrapping that existing method.

Make sure the module is loaded before runtime execution:

### Library entry
In `src/index.ts`, add:

```ts
import "./phase5.js";
```

and change:

```ts
export const ENGINE_PHASE = 5 as const;
```

### CLI
Because the CLI imports `PluginRuntime` directly, add near the top of `src/cli.ts`:

```ts
import "./phase5.js";
```

### Existing runtime tests
If a test directly imports `PluginRuntime` and also expects Phase 5 capabilities, import:

```ts
import "../src/phase5.js";
```

before creating the runtime.

## Important

The Phase 5 implementation intentionally does not replace the Phase 4 HTTP implementation.

Do not add Playwright, Puppeteer, Chromium, browser automation, CAPTCHA bypass, Cloudflare bypass, DRM bypass, or authentication bypass.

After integration:

```bash
npm test
npm run build
```

Then commit the integrated repository as:

`phase 5: add html and json parsing capabilities`
