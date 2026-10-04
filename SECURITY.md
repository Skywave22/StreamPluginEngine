# Security

This document describes what the engine defends against, what it does
**not** defend against, and how to report a problem. It reflects the code
as merged; the same caveats are stated in `ARCHITECTURE.md` and the README
so they cannot drift away from the implementation.

## Reporting a vulnerability

Open a private security advisory on the repository
(**Security → Advisories → New draft advisory**) rather than a public
issue. Please include:

- the affected version (or commit),
- a minimal reproduction (a plugin manifest + entry file is ideal),
- what the engine does and what you expected,
- whether the issue is reachable with **default** runtime options.

There is no bug-bounty programme and no guaranteed response time, but
security reports are treated as higher priority than feature work, and
fixes are documented in `CHANGELOG.md` with regression tests.

## Threat model

**A plugin is untrusted code.** The host application is trusted. The
engine's job is to run plugin code with the smallest surface it can, and to
keep every failure **structured, bounded, and invisible to the guest**.

| Attacker-controlled input | Engine control |
| --- | --- |
| Plugin entry code | Runs in an isolated QuickJS/Wasm runtime, one per plugin, with no Node.js globals, no host objects, no built-in modules, and imports resolvable only inside the plugin's own directory |
| Plugin CPU use | Interrupt-handler deadline per operation (`timeoutMs`, default 5 s) plus a host deadline for promises that never settle |
| Plugin memory use | Per-plugin guest heap cap (`memoryLimitBytes`, default 64 MiB) |
| Plugin network access | Only `context.http`; each request is scheme-validated, header-validated, limit-clamped, and target-checked before I/O |
| Request target (SSRF) | `src/network.ts`: loopback, RFC 1918, CGNAT, link-local (incl. cloud metadata), multicast, reserved, IPv4-mapped IPv6, and IPv4-embedding tunnel prefixes are blocked by default — on the initial URL **and every redirect hop**; hostnames are DNS-resolved and every resolved address is checked |
| Request target (declared surface) | `domains` in the manifest is an **enforced allowlist** when declared: requests and redirect hops outside it fail with `HTTP_DOMAIN_NOT_ALLOWED` before any I/O |
| Response size / redirects | Hard engine caps (10 MiB response, 10 hops by default); oversized bodies abort the connection without streaming into the guest |
| Malicious HTML/JSON | Parsing is data-only: no script execution, no event handlers, no resource loading, no `href`/`src` fetching; bounded input, node count, and result count |
| Plugin result data | `normalizeSourceResults()` treats it as untrusted: strict typing, URL scheme policy, prototype-pollution-safe metadata rebuilt as a fresh object |
| Persisted plugin data | Treated as untrusted on the way back IN: every entry is re-validated at load and dropped if invalid (bad key, oversized, forbidden key, wrong type), so a hand-edited or corrupted store cannot inject state |
| Store writes from the guest | Validated host-side: key pattern, JSON-serializable value, size/depth/count quotas, prototype-polluting names refused as keys and anywhere in a value, guest functions refused (they would otherwise be stored as source text) |
| Unbounded storage growth | Quotas per plugin (256 keys, 4 KiB per value, 64 KiB total) enforced before a write lands |
| Registry installs | The feed is untrusted: sha256 is REQUIRED, the downloaded bytes must match it, and the manifest must agree on id + version — all verified before anything is written. Installs are staged and renamed, so a partial plugin directory can never be executed. Registry fetches use the same `HttpClient` policy as plugin HTTP |
| `mirrors` (declared alternate hosts) | Join the enforced allowlist beside `domains`; a `mirror`-typed setting can only hold a declared mirror, refused at write time |
| Playback headers on results | Validated like request headers (token names, no CR/LF/NUL, bounded length/count) and a denylist of hop-by-hop / request-forging names is dropped — `host`, `connection`, `content-length`, `transfer-encoding`, `upgrade`, `keep-alive`, `te`, `trailer`, `proxy-connection` — because an application hands these to a player |
| Unbounded request fan-out inside one plugin | `http.maxInFlightPerPlugin` (default 8) returns `HTTP_TOO_MANY_REQUESTS` for the surplus instead of opening more sockets |
| HTML boundary payloads (API v1) | Only the JSON document model crosses; with API v2 the tree never enters the guest at all, so a plugin cannot hand a forged document to the selector engine |
| Cross-call HTML state (API v2) | The handle table is bounded per call and cleared when the call ends: a stashed handle yields `HTML_STALE_HANDLE`, never a stale host object |
| Plugin concurrency | Operations on one plugin are serialized (a QuickJS runtime has one interrupt slot and one job queue, so overlapping work would race the deadline guard); different plugins run concurrently |
| Teardown races | Disposal releases in-flight guest handles before freeing the runtime, aborts in-flight HTTP, and is idempotent |
| Host-leak in errors | Errors reaching the guest are engine-authored `{ code, message }` objects; host stack traces, paths, and internals are never included |

## Explicit non-goals

- **The sandbox is engine-level isolation, not an OS-level boundary.**
  QuickJS runs in-process on WebAssembly. A bug in QuickJS, in the Wasm
  boundary, or in this engine's host bridge is outside the sandbox's reach.
  Treat OS-level sandboxing (separate user, container, seccomp, VM) as a
  requirement when running third-party plugins.
- **DNS rebinding (TOCTOU) is not fully closed.** The policy resolves DNS to
  decide and the request resolves DNS again to connect; a hostile
  authoritative server can answer differently the second time. Closing this
  needs connection-level address pinning. Deployments running untrusted
  plugins should add OS/network-level egress controls.
- **No defence against malicious content that is legal to fetch.** The
  engine performs plain HTTP and does not implement CAPTCHA solving,
  Cloudflare/DRM/authentication bypass, or any other circumvention — by
  design, and those features are out of scope permanently.
- **No signature or provenance checking of plugin code.** Anything dropped
  into the plugins directory runs (subject to the above). Install-path trust
  and provenance are the application's responsibility.
- **No per-plugin in-flight request cap or global scheduler yet.** One
  operation per plugin is serialized, and each operation's requests are
  aborted when it ends, but a plugin can still issue many requests inside
  one operation (bounded only by the operation deadline).

## Recommended host configuration

For running untrusted plugins in production:

1. Keep the default network policy (`allowPrivateNetwork: false`).
2. Keep `enforceManifestDomains: true` and review each plugin's declared
   `domains` before installing it.
3. Grant only the capabilities a plugin needs
   (`perPluginPermissions: { "some.plugin": { http: false } }` for plugins
   that should not touch the network at all).
4. Lower `timeoutMs` / `memoryLimitBytes` for plugins you do not control.
5. Disable plugins you are not currently using (`PluginManager.disable`) —
   a disabled plugin's code is never evaluated.
6. Set `{ permissions: { store: false } }` for plugins that do not need
   memory: it removes the capability and any way for the plugin to leave
   data on the device. If you do allow storage, keep the default in-memory
   backend unless you need persistence — a file-backed backend inherits
   your application's file-security posture.
7. Only install from registries you trust EVEN THOUGH hashes are
   verified: the sha256 protects the transport and the mirror, not the
   publisher. A hash that matches a malicious feed is still malicious.
8. Lower `http.maxInFlightPerPlugin` for plugins you do not control, and
   treat result `headers` as attacker-influenced input: they are validated
   for shape, but a plugin can still point a player at any URL and ask it
   to send a `Referer`/`Cookie`-style header of its choosing, so only run
   plugins whose declared `domains` you have reviewed.
9. Add OS-level egress control and sandboxing; treat the engine as defence
   in depth, not as the only barrier.

## Supported versions

Security fixes are applied to the latest released `0.x` line. The project
is pre-1.0 and has no long-term support branches.
