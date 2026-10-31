# @alexbeatsz/file-sync-core 0.1.0 API contract

Status: API frozen 2026-10-30; implementation verified 2026-10-31 (America/New_York).
Project: C:/Users/Meta/Project/Scripts/JavaScript/file-sync-core.
ES modules, Node >=22, zero runtime dependencies, MIT. No CLI, listener binding,
configuration discovery, product path rules, TLS, gateway, service installation or GC.

## Exports

```js
import { createFileSyncServer, hashPattern, idPattern } from '@alexbeatsz/file-sync-core';
const service = await createFileSyncServer({
  root, token, routePrefix: '/mojian-sync/v1', validPath, validateManifest,
  maxBlobBytes: 1024 * 1024 * 1024,
  validateToken: token => { /* product-specific rule; throw on failure */ },
  validateRequest: (request, url) => true,
  onError: ({ code }) => console.error('Sync request failed:', code),
});
service.server.listen(port, host);
await service.close();
```

- `createFileSyncServer(options): Promise<{server: http.Server, close(): Promise<void>}>`.
  Returns an unbound Node HTTP server with one async request handler. Existing TLS wrappers
  may forward requests to `server.emit('request', request, response)`; the consumer must
  drain and close its extra listeners BEFORE calling service.close().
- `root`: required nonempty string, resolved to an absolute persistent data directory.
- `token`: required nonempty string without CR/LF. Bearer comparison is constant-time after
  byte-length check. Product wrappers retain their stricter existing token rules.
- `routePrefix`: required absolute URL path, no trailing slash, query, fragment or dot segments.
  Use `/mojian-sync/v1` or `/webobsidian-sync/v1` verbatim.
- `validPath(path): boolean`: REQUIRED synchronous product path policy. Return true to accept.
- `validateManifest(manifest): void`: REQUIRED synchronous product policy; throw to reject.
  Called for loaded state, legacy manifest, each stored receipt manifest, and candidate commit.
  Shared structural/ID/hash/version/case uniqueness validation also runs in the core.
- `maxBlobBytes`: optional positive safe integer, default 1 GiB. Limits streamed upload bytes.
- `validateToken(token): void`: optional synchronous startup check, throw to reject BEFORE
  any filesystem writes. Mojian retains its >=32-byte rule; WebObsidian retains printable
  ASCII 32-512 rule. No product-specific environment-variable name lives in the core.
- `validateRequest(request, url): boolean`: optional synchronous predicate, default true.
  Runs AFTER Bearer authentication and BEFORE routes/storage-failure handling. false returns
  400 `{error:'invalid_request'}`. WebObsidian passes
  `(req,url) => !req.headers.origin && !url.search && !req.url.includes('#')`.
  Mojian may omit it to retain existing behavior. Hooks must not mutate requests/state.
- `onError({code}): void`: optional synchronous diagnostic callback. Receives only a sanitized
  error code/name; never request URL/body, token, root, stack or error message. Defaults to
  `console.error('File sync request failed:', code)`. Callback failures do not alter storage.
- `hashPattern`: lowercase 64-character SHA-256 regex, no global/sticky flags.
- `idPattern`: 16-80 ASCII letters/digits/underscore/hyphen regex, no global/sticky flags.
- The `./package.json` subpath is exported for consumer build/version metadata.
- All hooks are synchronous. Promise-returning hooks are rejected; no async policy hooks.
- `close()` is idempotent; drains the HTTP server/queued commits/in-flight handlers before
  releasing the data-root lock. After closing begins the handler rejects new requests with
  503 `{error:'server_closing'}`. Never release a writer lock while a write is still active.
  Caller owns signals and external TLS listeners. Request/header timeouts remain 10 min/30 s.

## Compatibility and persistence

Authenticated routes below routePrefix: GET `/manifest`, GET/PUT `/blobs/<hash>`, POST `/commit`.
JSON camelCase, unchanged v1 statuses/receipt bodies. Commit cap 4 MiB / 1-20000 changes.
Exact-version CAS for every path; one revision per atomic batch; retain null-hash tombstones.
Receipt key remains `deviceId:operationId`. Fingerprint remains SHA-256 of JSON.stringify of
`{workspaceId, changes}` with changes normalized to `{path,expectedVersion,hash}` and sorted
by case-sensitive path. Replay returns the ORIGINAL affected-path receipt before checking CAS;
key reuse with different content returns 409 `operation_reused`. Receipt retention is unlimited.

Existing `state.json` is authoritative `{manifest,receipts}`. When absent, import the existing
`manifest.json` into a new state with empty receipts; otherwise create revision0 workspace.
Never rewrite an existing valid state on startup, migrate IDs, reset revisions or prune data.
Keep `blobs/<sha256>`, `history/<previousRevision>.json`, `server.lock` PID format unchanged.
History is durable before atomic state publication; manifest+receipt publish in one state rename.
State publication failure freezes the process at 503 `storage_failure` until restart; clients
must retry the same operation because disk may have advanced before an uncertain failure.
History failure fails the operation without changing memory/state. On Windows directory fsync
is skipped, matching the sources; file fsync+rename remain. Power-loss guarantees depend on OS/fs.
A dead PID lock may be reclaimed; live/invalid locks refuse startup. No production data tests.
The additive, temporary `server.lock.claim/` directory serializes startup lock reclamation.
It is removed before the factory returns; concurrent startup contenders fail conservatively.
If a process dies during this short startup transition and leaves the claim directory, verify
there is no writer before manually removing it. Existing/legacy PID locks remain authoritative.

## Consumption and release

Release: v0.1.0; standard npm pack asset `alexbeatsz-file-sync-core-0.1.0.tgz`.
Exact release asset URL:
`https://github.com/AlexbeatsZ/file-sync-core/releases/download/v0.1.0/alexbeatsz-file-sync-core-0.1.0.tgz`.
The release's `release.json` records the complete source commit and upstream origins.
Consumers pin an exact release or full source commit, vendor the tested runtime into their own
independent server release, and retain LICENSE + THIRD_PARTY_NOTICES.md + provenance.
No floating main/master dependency, cross-checkout runtime import, npm registry publication or
runtime npm install is required. Only the public core and this contract are owned by this chat.

Verification: 26/26 isolated Node regressions on Windows / Node24.14.1, including actual original
Mojian state compatibility, real process crash/restart, I/O faults before/after state publication,
and concurrent dead-lock reclamation. Standard TGZ passes offline npm ci and a real package-export
HTTP commit. Node22/POSIX/physical power-loss behavior is not independently verified.
