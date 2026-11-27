# Goal

- Maintain a small, MIT, zero-runtime-dependency Node file-sync kernel for Mojian and
  Shale. Consumers own path/manifest/request/token policy, routes and startup.
- Preserve existing v1 wire payloads, state, receipts, history, blobs and PID locks.

# Current State

- Version 0.3.3 adds bounded server lifecycle on top of 0.2.0: independent verified compressed recovery snapshots, calendar/capacity retention, serialized history/blob/upload GC and admin/restore exports. Standalone consumers opt in; embedding callers preserve their original defaults.
- Version 0.2.0 adds stable snapshot/delta pages, blob ranges, resumable uploads, and
  a packaged cross-language fixture. The original v1 commit, state, receipts and locks
  retain their compatibility contract. Public repository: AlexbeatsZ/file-sync-core.

# Active Work

- Consumer integration and production deployment are separate. P2 storage migration
  remains conditional on larger and real-disk capacity evidence.

# Build / Run / Test

- Node >=22. Current core: 38 isolated tests and offline package smoke passed. `npm test` runs built-in node:test on disposable Temp/.agents data only.
- No compilation or dependency installation is needed. `npm pack` produces the library.
- `node scripts/benchmark-pagination.mjs` measures whole-state writes and discovery transfer on synthetic data.
- Preserve one current pack artifact under artifacts/current; never include private data.
- Consumer packages pin a full source commit archive or exact release asset, record it in
  their package-lock and bundle the runtime. ROG must not need npm install.

# Durable Lessons

- A forwarded TLS request is invisible to http.Server.close(): track async handlers and
  drain them before releasing the writer lock. Consumers close external listeners first.
- A receipt and manifest must publish together; after uncertain state publication, stop
  serving writes until restart and require the same operation ID to be retried.
- Dead-PID lock reclamation must serialize the entire read/unlink/create transition.
  A stale observation alone can otherwise unlink a newly started writer's live lock.
  An interrupted server.lock.claim directory requires explicit no-writer recovery.

# Docs Index

- docs/design/api.md: stable factory, hook, disk and wire compatibility contract.
- docs/log/2026-11.md and docs/log/2026-10.md: implementation and verification.
- THIRD_PARTY_NOTICES.md and provenance.json: origins and retained licenses.
