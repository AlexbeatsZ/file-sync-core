# @alexbeatsz/file-sync-core

A small durable file-sync server kernel extracted from the Mojian and WebObsidian
servers. Node.js >=22, ES modules, MIT, no runtime dependencies.

The kernel owns streamed content-addressed blobs, exact-version CAS commits, durable
idempotency receipts, history, single-writer locking and restart recovery. Each
application supplies its existing path/manifest/token/request rules and route prefix.
Applications continue to ship and operate independent servers.

## Use

```js
import { createFileSyncServer } from '@alexbeatsz/file-sync-core';
import { validPath, validateManifest } from './protocol.mjs';

const service = await createFileSyncServer({
  root: settings.dataDir,
  token: settings.token,
  routePrefix: '/webobsidian-sync/v1',
  validPath,
  validateManifest,
  validateToken(token) {
    if (!/^[\x21-\x7e]{32,512}$/.test(token)) {
      throw new Error('Expected 32-512 printable ASCII characters');
    }
  },
  validateRequest: (req, url) =>
    !req.headers.origin && !url.search && !req.url.includes('#'),
  onError: ({ code }) => console.error('Sync request failed:', code),
});

service.server.listen(settings.port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    service.close().then(() => process.exit(0), () => process.exit(1));
  });
}
```

`createFileSyncServer` returns the existing `{server, close}` shape without binding a
port. Extra HTTPS listeners can forward to `server.emit('request', request, response)`;
close and drain those listeners before `service.close()`. Hooks are synchronous.
`hashPattern` and `idPattern` are also exported. Read [the complete API](docs/design/api.md)
before adapting an application.

## Existing data

Point the wrapper at its existing data directory after stopping the previous writer.
Keep the same token, routes and product policies. Existing `state.json` is loaded
without rewriting bytes or resetting the workspace identity. Legacy `manifest.json`
is imported only when state is absent. Blob, history, receipt and tombstone retention
is unchanged; there is no garbage collection.

Manifest and receipt publish together through an fsynced temporary file and rename.
After uncertain state-publication failure the process refuses further requests until
restart; retry the same operation ID. POSIX directory fsync is retained; Windows skips
directory fsync as the source implementations did. Tests cover process crashes and I/O
errors, not physical power loss or every filesystem's durability guarantees.

`server.lock` retains the PID text format. Startup also uses a short-lived
`server.lock.claim/` directory to serialize dead-PID reclamation. Live or malformed
locks refuse startup. A crash during this short startup transition may leave the
claim directory and require explicit operator recovery after verifying no writer exists.

## Pin and bundle

Version 0.1.0 is delivered as the standard `npm pack` archive:

```sh
npm install --save-exact https://github.com/AlexbeatsZ/file-sync-core/releases/download/v0.1.0/alexbeatsz-file-sync-core-0.1.0.tgz
```

Commit the consumer's package-lock. An alternative is a GitHub source archive addressed
by the complete 40-character commit SHA recorded in the release's `release.json`.
Never depend on a floating branch. No npm registry account or global install is needed.

The consumer's release build includes the installed package/runtime and retains
LICENSE, THIRD_PARTY_NOTICES.md and provenance.json. Its deployment ZIP is ready to run
with Node; production should not run npm install or import another application's checkout.
This package supplies no CLI, TLS keys, gateway, startup task or production configuration.

## Development

```sh
npm test
npm pack --pack-destination artifacts/current
npm run test:package -- artifacts/current/alexbeatsz-file-sync-core-0.1.0.tgz
```

All regressions use temporary directories under the OS temporary `.agents` directory.
The suite exercises real HTTP, subprocess termination/restart, concurrent writers,
storage failures and the original v1 wire fixture. The package test installs only the
local archive in an isolated temporary project, offline with scripts disabled, and
performs a real authenticated round trip through the public package export.

See [provenance.json](provenance.json), [third-party notices](THIRD_PARTY_NOTICES.md)
and [the implementation log](docs/log/2026-10.md) for version origins and evidence.
