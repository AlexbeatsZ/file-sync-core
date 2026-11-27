import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cursorLifetimeMs = 15 * 60 * 1000;
const maxSnapshots = 32;
const nonnegativeInteger = /^(0|[1-9][0-9]*)$/;

function integer(value) {
  if (!nonnegativeInteger.test(value ?? '') || /\s/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function createPageHandler(root, checkManifest) {
  const snapshots = new Map();
  const cursorKey = randomBytes(32);
  const sign = value => createHmac('sha256', cursorKey).update(value).digest('base64url');

  function servePage(response, json, id, snapshot, position) {
    const end = Math.min(position + snapshot.limit, snapshot.entries.length);
    const next = `${id}.${end}`;
    json(response, 200, {
      workspaceId: snapshot.workspaceId,
      revision: snapshot.revision,
      files: Object.fromEntries(snapshot.entries.slice(position, end)),
      nextCursor: end < snapshot.entries.length ? `${next}.${sign(next)}` : null,
    });
  }

  const handler = async (mode, params, manifest, response, json) => {
    const allowed = mode === 'changes' ? ['since', 'limit', 'cursor'] : ['limit', 'cursor'];
    const invalid = () => json(response, 400, { error: 'invalid_page_request' });
    const expired = () => json(response, 410, { error: 'cursor_expired' });
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) return invalid();

    for (const [id, snapshot] of snapshots) {
      if (snapshot.expires <= Date.now()) snapshots.delete(id);
    }

    if (params.has('cursor')) {
      if (params.size !== 1) return invalid();
      const [id, index, signature, extra] = params.get('cursor').split('.');
      const position = integer(index);
      const snapshot = snapshots.get(id);
      if (extra !== undefined || !snapshot || snapshot.mode !== mode || position === undefined ||
          signature !== sign(`${id}.${position}`)) return expired();
      snapshot.expires = Date.now() + cursorLifetimeMs;
      snapshots.delete(id);
      snapshots.set(id, snapshot);
      servePage(response, json, id, snapshot, position);
      return;
    }

    const limit = params.has('limit') ? integer(params.get('limit')) : 500;
    const since = mode === 'changes' ? integer(params.get('since')) : 0;
    if (!limit || limit > 1000 || since === undefined) return invalid();
    if (since > manifest.revision) {
      json(response, 409, { error: 'revision_ahead', revision: manifest.revision });
      return;
    }
    if (mode === 'changes' && since < manifest.revision) {
      // A legacy import can start at a nonzero revision. Require evidence that
      // this server held the requested base so an older client resnapshots.
      let previous;
      try { previous = JSON.parse(await readFile(path.join(root, 'history', `${since}.json`), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return expired();
        throw error;
      }
      checkManifest(previous);
      if (previous.workspaceId !== manifest.workspaceId || previous.revision !== since) throw new Error('Invalid history boundary');
    }

    const entries = Object.entries(manifest.files)
      .filter(([, entry]) => mode === 'manifest' || entry.version > since)
      .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0);
    const id = randomUUID();
    const snapshot = {
      mode, limit, entries, workspaceId: manifest.workspaceId, revision: manifest.revision,
      expires: Date.now() + cursorLifetimeMs,
    };
    if (entries.length > limit) {
      if (snapshots.size >= maxSnapshots) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(id, snapshot);
    }
    servePage(response, json, id, snapshot, 0);
  };
  handler.references = () => {
    const result = new Set();
    for (const [id, s] of snapshots) {
      if (s.expires <= Date.now()) { snapshots.delete(id); continue; }
      for (const [, entry] of s.entries) if (entry.hash) result.add(entry.hash);
    }
    return result;
  };
  return handler;
}
