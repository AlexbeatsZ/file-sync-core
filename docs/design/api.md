# @alexbeatsz/file-sync-core 0.1.0 API contract

Status: API frozen 2026-10-30; implementation verified 2026-10-31 (America/New_York).
Project: C:/Users/Meta/Project/Scripts/JavaScript/file-sync-core.
ES modules, Node >=22, zero runtime dependencies, MIT. No CLI, listener binding,
configuration discovery, product path rules, TLS, gateway, service installation or product configuration discovery.

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
Entries are files `{hash,version}`, directories `{hash:null,version,directory:true}` (0.4.0) or
tombstones `{hash:null,version}`; a change may carry `directory:true` with a null hash. As in
Syncthing, directories are versioned items, so empty folders, folder deletion and folder renames
replicate instead of being inferred from files. Case-insensitive uniqueness applies to live
entries only: a batch may retire `A` and create `a` (case-only rename); a second live spelling and
duplicate exact paths in one batch are rejected. Consumer `validateManifest` owns shape rules.
Receipt key remains `deviceId:operationId`. Fingerprint remains SHA-256 of JSON.stringify of
`{workspaceId, changes}` with changes normalized to `{path,expectedVersion,hash}` (plus `directory:true`
only for directory changes, so file fingerprints are unchanged) and sorted
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

## Optional transport extensions in 0.2.0

The routes below share the existing authenticated `routePrefix`. Legacy requests
continue to use the original JSON and write semantics. Consumers that reject query
strings in their request hook must explicitly allow them on the two exact paging
routes. A 404 on the first paging request supports fallback to the original manifest
endpoint. Other errors keep their ordinary transport and recovery meanings.

### Snapshot and changes

- `GET /manifest/pages?limit=500` starts a full snapshot. `GET /changes?since=R&limit=500`
  instead returns each changed path's latest entry in `(R, revision]`, including tombstones.
  Entries use v1's path keys and `{hash,version}` values. `limit` is optional, 1–1000.
- The successful body is `{workspaceId,revision,files,nextCursor}`. The first page fixes
  identity, revision and sorted path order. An empty/final page has `nextCursor:null`.
  Continue at the same route with only `?cursor=TOKEN`. Replaying a valid cursor yields
  the same page even after concurrent commits. Cursors expire after restart, 15 minutes of
  inactivity or eviction from the 32 retained snapshots. A forged, expired or cross-mode
  cursor returns 410 `cursor_expired`. Missing history for an initial delta returns the
  same result. The caller may recover with a fresh full snapshot and exact outbox replay.
- A future base gets 409 `revision_ahead` and the server revision. An invalid parameter
  gets 400 `invalid_page_request`. A damaged historical boundary is a server storage
  error; the client keeps local records and reports the failed operation.
- Verify workspace identity before processing any page. Persist page work and its
  continuation atomically. Update the continuous accounted revision only after the last
  page, with every affected item durable, including pending and blocked work. Individual
  paths advance their applied bases when applied or confirmed. Full snapshots are sorted
  once per session, historical boundary validation reads one snapshot on the first delta
  page, and continuation does not scan disk history.

### Blob ranges and resumable upload

- Legacy `GET /blobs/<hash>` accepts a single `Range: bytes=N-` or `bytes=N-M` in
  0.2.0. A satisfiable range returns 206 with `Content-Range`; an invalid or unsatisfiable
  range returns 416 with `Content-Range: bytes */SIZE`. A normal full GET returns 200
  and `Accept-Ranges: bytes`. If a legacy server ignores Range and returns 200,
  the client must replace its local partial copy. Verify the final complete blob digest.
- `GET /uploads/<hash>` reports `{offset,total,complete}`, including an existing blob
  uploaded through either API. A missing session returns 404 `upload_missing`. The
  client may start by PUT, or query when a response was uncertain.
- `PUT /uploads/<hash>` sends one non-empty chunk, up to 8 MiB, with
  `Content-Range: bytes START-END/TOTAL` (inclusive end). `TOTAL` is bounded by
  `maxBlobBytes`. Successful responses use the same progress object. Once the hash is fully
  published, a retry returns completed progress. Before completion, a stale or out-of-order
  offset or a different total returns 409 `upload_offset_mismatch` with the stored
  `offset` and `total`. Use the indicated offset or GET it again after a lost response.
  400 identifies malformed range or length, 413 exceeds bounds, and 503 `upload_busy`
  requests a retry. An HTTP 404 on PUT is sufficient for a legacy PUT fallback.
- Offsets survive restart in additive staging files under `uploads/`. The final byte
  stream is verified against the requested hash before atomic publication into `blobs/`.
  A mismatch returns 422 `hash_mismatch` and discards the staging files. The final GET
  may finish an interrupted publication. Legacy commit sees only published blobs, and
  zero-length blobs still use the legacy PUT. Incomplete staging may retain disk space;
  the server does not garbage-collect it. Backups continue to follow manifest and blob
  references and do not need staging files.

### Cross-language fixtures

Consume the pinned package asset's `@alexbeatsz/file-sync-core/sync-golden-traces.json`
export or this repository's `test/fixtures/sync-golden-traces.json` at the same revision.
`schemaVersion:1` contains named traces with initial normalized state and ordered steps.
A step has an `event` and the affected normalized `expected` projection. The caller
runs its actual planner or state transition, compares the indicated fields, and retains
unchanged fields. `plan` cases exercise common path decisions and explicit blockers.
Fault traces exercise partial conflict resolution and restart, last-page advancement,
preservation of concurrent file edits, and original outbox replay. Product adapters
supply real paths, group boundaries and editor integration for these normalized traces.


## Server data lifecycle (0.3.0)

`createFileSyncServer({lifecycle:{backup,history,garbageCollection}})` enables independent recovery snapshots and maintenance. Defaults: history 100 revisions/30 days (both limits); per-device receipts 1000/30 days for timestamped receipts; GC every 24 hours with 24-hour upload grace; daily 04:00 local backup, 7 daily/4 weekly/3 monthly representatives, 20 GiB capacity, upgrades 1/7 days. Core callers omitting lifecycle retain the original non-maintaining embedding contract; product standalone CLIs enable the default policy. `backup.directory` must be outside the live root, defaults to `<root>-backups`; upgrade directory defaults to `<root>-upgrades`.

History is not required for CAS: current path versions/tombstones stay authoritative. Expired delta bases return 410 and require a full snapshot. Receipt expiry never re-executes an old acknowledged write: its exact expected version is stale (including deleted paths); old callers receive 409 and reconcile. Legacy receipts have no trustworthy time, so only the count bound applies. Receipt hashes do not pin old content indefinitely. A restore contains current state/receipts and all currently referenced blobs, without historical manifests or incomplete transfers.

Authenticated GET `/maintenance` reports current, history, blob, backup and reclaimable bytes plus policy and last success/failure. POST `/maintenance` requires `{action:'backup'|'cleanup',dryRun:boolean}`. The exported `service.maintenance(action,dryRun)` uses the same queue. Backup/GC and commits serialize. During maintenance new blob/discovery requests receive retryable 503; active streams and live pagination snapshots pin hashes. Recent uploads are kept for the grace interval, including repeated PUTs. Old resumable staging is collected only without an active transfer. Dry-run neither rewrites state nor removes files. Corrupt history or missing retained content aborts cleanup.

Recovery snapshots use independent compressed content-addressed objects (no hardlinks to live blobs), immutable metadata, SHA-256/length verification and SQLite caller-provided consistent images. Identical content creates no extra snapshot. Rotation retains latest calendar representatives, plus latest verified and manually pinned snapshots. The byte cap can remove older calendar representatives, never latest/pinned; an unsatisfiable cap is an error. Verify kept points before deleting metadata, then sweep unreferenced backup objects. Repository locks serialize create/prune/restore; dead PID reclamation uses a separate atomic claim. A crash during claim requires operator inspection. Restore writes only a newly created destination. Backup verification hashes are required integrity checks, not routine production re-audits.

`BackupRepository`, `lifecyclePolicy`, `lifecycleCli`, `pruneUpgrades` and `verifyUpgrade` are reusable exports. Upgrade pruning recognizes only `upgrade-*` folders with format-1 `upgrade.json`, a finite creation time and an explicit verifiedAt. Pending/failed upgrades are reported and never silently removed. A successful normal update stores old program/config, not the data root. Mark verified only after startup, current data and core API acceptance; expiry removes older points or points older than seven days, including the last point when expired.

The design follows SQLite's Online Backup API consistency boundary and restic's separation of snapshot forgetting from unreferenced-object pruning; it does not change the sync wire protocol or chunk large note JSON in this release.
