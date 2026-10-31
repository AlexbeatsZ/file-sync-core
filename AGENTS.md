# Goal

- Maintain a small, MIT, zero-runtime-dependency Node file-sync kernel for Mojian and
  WebObsidian. Consumers own path/manifest/request/token policy, routes and startup.
- Preserve existing v1 wire payloads, state, receipts, history, blobs and PID locks.

# Current State

- Version 0.1.0 is implemented in src/index.js; all 26 isolated regressions pass on
  Windows/Node24.14.1. Standard npm pack and offline installation smoke pass.
  API is frozen in docs/design/api.md. Public repository: AlexbeatsZ/file-sync-core.
  Version tag/release is v0.1.0; release.json records its exact source SHA and npm metadata.
- Shared coordination contract:
  C:/Users/Meta/Documents/Codex/2026-10-30/yan/outputs/file-sync-core-contract.md.
- Only this project and that contract belong to this task. Other chats own the consumer
  repositories and production deployment. Do not edit those repositories or operate ROG.

# Active Work

- No implementation work remains. Consumer adapters, their independent releases and
  production deployment belong to their respective chats; do not modify those projects.

# Build / Run / Test

- Node >=22. `npm test` runs built-in node:test on disposable Temp/.agents data only.
- No compilation or dependency installation is needed. `npm pack` produces the library.
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
- docs/log/2026-10.md: completed implementation and verification.
- THIRD_PARTY_NOTICES.md and provenance.json: origins and retained licenses.
