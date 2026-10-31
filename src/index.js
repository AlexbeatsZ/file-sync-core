// SPDX-License-Identifier: MIT
// Copyright (c) 2026 AlexbeatsZ and xnohat. See THIRD_PARTY_NOTICES.md.
import http from 'node:http';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, open, stat, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSystemErrorMap } from 'node:util';

export const hashPattern = /^[a-f0-9]{64}(?![\s\S])/;
export const idPattern = /^[A-Za-z0-9_-]{16,80}(?![\s\S])/;

const defaultMaxBlobBytes = 1024 * 1024 * 1024;
const maxCommitBytes = 4 * 1024 * 1024;
const safeErrorCodes = new Set([...getSystemErrorMap().values()].map(([name]) => name));
for (const code of ['ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ABORT_ERR']) safeErrorCodes.add(code);
const safeErrorNames = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError']);

function rejectPromise(value, hook) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw new Error(`${hook} must be synchronous`);
  }
}

async function syncDirectory(target) {
  if (process.platform === 'win32') return;
  const directory = await open(target, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function atomicJson(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function acquireLock(root) {
  // Serialize the read-dead-PID/unlink/create sequence. A contender must never unlink
  // a new writer's lock after inspecting the previous dead writer's PID.
  // Crash during this short claim requires manual recovery, just like an empty PID lock.
  const claimPath = path.join(root, 'server.lock.claim');
  await mkdir(claimPath);
  let release;
  try { release = await acquirePidLock(root); }
  finally {
    try { await rmdir(claimPath); }
    catch (error) { if (release) await release(); throw error; }
  }
  return release;
}

async function acquirePidLock(root) {
  const lockPath = path.join(root, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    let lock;
    try {
      lock = await open(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const owner = Number(await readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid lock; manual recovery required');
      try {
        process.kill(owner, 0);
        throw new Error('Sync data root is already in use');
      } catch (failure) {
        if (failure.code !== 'ESRCH') throw failure;
      }
      await unlink(lockPath);
      continue;
    }
    try { await lock.writeFile(String(process.pid)); await lock.sync(); }
    catch (error) { await lock.close(); await unlink(lockPath); throw error; }
    return async () => { await lock.close(); await unlink(lockPath); };
  }
}

function setFile(files, name, entry) {
  Object.defineProperty(files, name, { value: entry, enumerable: true, configurable: true, writable: true });
}

export async function createFileSyncServer(options) {
  if (!options || typeof options !== 'object') throw new Error('Options are required');
  const {
    token,
    routePrefix,
    validPath,
    validateManifest,
    maxBlobBytes = defaultMaxBlobBytes,
    validateToken,
    validateRequest = () => true,
    onError = ({ code }) => console.error('File sync request failed:', code),
  } = options;
  let { root } = options;
  if (typeof root !== 'string' || !root.trim()) throw new Error('root must be a nonempty string');
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('token must be a nonempty string without CR/LF');
  if (typeof routePrefix !== 'string' || !routePrefix.startsWith('/') || routePrefix.length < 2 || routePrefix.endsWith('/') ||
      /[?#\\]/.test(routePrefix) || routePrefix.split('/').some(part => part === '.' || part === '..') ||
      new URL(routePrefix, 'http://localhost').pathname !== routePrefix) throw new Error('Invalid routePrefix');
  if (typeof validPath !== 'function' || typeof validateManifest !== 'function') throw new Error('Path and manifest policies are required');
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes <= 0) throw new Error('maxBlobBytes must be a positive safe integer');
  if (validateToken !== undefined && typeof validateToken !== 'function') throw new Error('validateToken must be a function');
  if (typeof validateRequest !== 'function' || typeof onError !== 'function') throw new Error('Request and error hooks must be functions');
  if (validateToken) rejectPromise(validateToken(token), 'validateToken');

  const acceptsPath = name => {
    if (typeof name !== 'string') return false;
    const accepted = validPath(name);
    rejectPromise(accepted, 'validPath');
    return accepted === true;
  };
  const checkManifest = manifest => {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
        typeof manifest.workspaceId !== 'string' || !idPattern.test(manifest.workspaceId) ||
        !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
        !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
      throw new Error('Invalid stored manifest');
    }
    const paths = new Set();
    for (const [name, entry] of Object.entries(manifest.files)) {
      if (!acceptsPath(name) || paths.has(name.toLowerCase()) || !entry || typeof entry !== 'object' ||
          !Number.isSafeInteger(entry.version) || entry.version <= 0 || entry.version > manifest.revision ||
          (entry.hash !== null && (typeof entry.hash !== 'string' || !hashPattern.test(entry.hash)))) {
        throw new Error('Invalid stored entry');
      }
      paths.add(name.toLowerCase());
    }
    rejectPromise(validateManifest(manifest), 'validateManifest');
  };

  root = path.resolve(root);
  await mkdir(path.join(root, 'blobs'), { recursive: true });
  await mkdir(path.join(root, 'history'), { recursive: true });
  const release = await acquireLock(root);
  const statePath = path.join(root, 'state.json');
  let state;
  try {
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let manifest;
      try { manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')); }
      catch (failure) {
        if (failure.code !== 'ENOENT') throw failure;
        manifest = { workspaceId: randomUUID(), revision: 0, files: {} };
      }
      state = { manifest, receipts: {} };
      checkManifest(manifest);
      await atomicJson(statePath, state);
    }
    checkManifest(state?.manifest);
    if (!state.receipts || typeof state.receipts !== 'object' || Array.isArray(state.receipts)) throw new Error('Invalid stored receipts');
    for (const [key, record] of Object.entries(state.receipts)) {
      const parts = key.split(':');
      const receipt = record?.receipt;
      if (parts.length !== 2 || !parts.every(part => idPattern.test(part)) || !hashPattern.test(record?.fingerprint) ||
          !receipt || receipt.workspaceId !== state.manifest.workspaceId || receipt.operationId !== parts[1] ||
          !Number.isSafeInteger(receipt.revision) || receipt.revision <= 0 || receipt.revision > state.manifest.revision) {
        throw new Error('Invalid stored receipt');
      }
      checkManifest({ workspaceId: receipt.workspaceId, revision: receipt.revision, files: receipt.files });
    }
  } catch (error) {
    await release();
    throw error;
  }

  let commits = Promise.resolve();
  let storageFailed = false;
  let closing = false;
  let closePromise;
  let activeRequests = 0;
  let drainRequests;
  const expectedToken = Buffer.from(`Bearer ${token}`);
  const json = (response, status, body) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const reportError = error => {
    const code = safeErrorCodes.has(error?.code) ? error.code : safeErrorNames.has(error?.name) ? error.name : 'Error';
    try { rejectPromise(onError({ code }), 'onError'); }
    catch { /* Diagnostics must not alter request or storage behavior. */ }
  };

  const handleRequest = async (request, response) => {
    try {
      const auth = Buffer.from(request.headers.authorization ?? '');
      if (auth.length !== expectedToken.length || !timingSafeEqual(auth, expectedToken)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      const url = new URL(request.url, 'http://localhost');
      const requestAccepted = validateRequest(request, url);
      rejectPromise(requestAccepted, 'validateRequest');
      if (requestAccepted !== true) {
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      if (storageFailed) {
        json(response, 503, { error: 'storage_failure' });
        return;
      }
      if (url.pathname === `${routePrefix}/manifest` && request.method === 'GET') {
        json(response, 200, state.manifest);
        return;
      }
      const blobPrefix = `${routePrefix}/blobs/`;
      const blobHash = url.pathname.startsWith(blobPrefix) ? url.pathname.slice(blobPrefix.length) : '';
      if (hashPattern.test(blobHash)) {
        const blobPath = path.join(root, 'blobs', blobHash);
        if (request.method === 'GET') {
          let size;
          try { size = (await stat(blobPath)).size; }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            json(response, 404, { error: 'blob_missing' });
            return;
          }
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
          await pipeline(createReadStream(blobPath), response);
          return;
        }
        if (request.method === 'PUT') {
          const temporary = path.join(root, 'blobs', `${randomUUID()}.tmp`);
          let bytes = 0;
          let oversized = false;
          const hash = createHash('sha256');
          try {
            await pipeline(request, new Transform({
              transform(chunk, encoding, callback) {
                bytes += chunk.length;
                if (bytes > maxBlobBytes) {
                  oversized = true;
                  callback(null);
                  return;
                }
                hash.update(chunk);
                callback(null, chunk);
              },
            }), createWriteStream(temporary, { flags: 'wx' }));
            if (oversized) {
              json(response, 413, { error: 'blob_too_large' });
              return;
            }
            if (hash.digest('hex') !== blobHash) {
              json(response, 422, { error: 'hash_mismatch' });
              return;
            }
            const handle = await open(temporary, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
            try { await rename(temporary, blobPath); }
            catch (error) {
              if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
              await stat(blobPath);
            }
            await syncDirectory(path.dirname(blobPath));
            json(response, 200, { hash: blobHash });
          } finally {
            await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
          }
          return;
        }
      }
      if (url.pathname === `${routePrefix}/commit` && request.method === 'POST') {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes <= maxCommitBytes) chunks.push(chunk);
        }
        if (bytes > maxCommitBytes) {
          json(response, 413, { error: 'request_too_large' });
          return;
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch {
          json(response, 400, { error: 'invalid_json' });
          return;
        }
        if (!body || typeof body.deviceId !== 'string' || typeof body.operationId !== 'string' ||
            !idPattern.test(body.deviceId) || !idPattern.test(body.operationId) ||
            !Array.isArray(body.changes) || !body.changes.length || body.changes.length > 20000 ||
            body.changes.some(change => !change || !acceptsPath(change.path) ||
              !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0 ||
              (change.hash !== null && (typeof change.hash !== 'string' || !hashPattern.test(change.hash)))) ||
            new Set(body.changes.map(change => change.path.toLowerCase())).size !== body.changes.length) {
          json(response, 400, { error: 'invalid_commit' });
          return;
        }
        const changes = body.changes.map(({ path: name, expectedVersion, hash }) => ({ path: name, expectedVersion, hash }))
          .sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
        const fingerprint = createHash('sha256').update(JSON.stringify({ workspaceId: body.workspaceId, changes })).digest('hex');
        const key = `${body.deviceId}:${body.operationId}`;
        const commit = async () => {
          if (storageFailed) {
            json(response, 503, { error: 'storage_failure' });
            return;
          }
          const manifest = state.manifest;
          if (body.workspaceId !== manifest.workspaceId) {
            json(response, 409, { error: 'workspace_mismatch' });
            return;
          }
          const previous = state.receipts[key];
          if (previous) {
            json(response, previous.fingerprint === fingerprint ? 200 : 409,
              previous.fingerprint === fingerprint ? previous.receipt : { error: 'operation_reused' });
            return;
          }
          const aliases = new Map(Object.keys(manifest.files).map(name => [name.toLowerCase(), name]));
          if (changes.some(change => aliases.has(change.path.toLowerCase()) && aliases.get(change.path.toLowerCase()) !== change.path)) {
            json(response, 400, { error: 'invalid_path' });
            return;
          }
          const conflicts = changes.filter(change =>
            (Object.hasOwn(manifest.files, change.path) ? manifest.files[change.path].version : 0) !== change.expectedVersion)
            .map(change => change.path);
          if (conflicts.length) {
            json(response, 409, { error: 'version_conflict', revision: manifest.revision, conflicts });
            return;
          }
          for (const change of changes) {
            if (change.hash === null) continue;
            try { await stat(path.join(root, 'blobs', change.hash)); }
            catch (error) {
              if (error.code !== 'ENOENT') throw error;
              json(response, 422, { error: 'blob_missing' });
              return;
            }
          }
          if (!Number.isSafeInteger(manifest.revision + 1)) throw new Error('Revision exhausted');
          const next = structuredClone(state);
          next.manifest.revision++;
          const files = {};
          for (const change of changes) {
            const entry = { hash: change.hash, version: next.manifest.revision };
            setFile(files, change.path, entry);
            setFile(next.manifest.files, change.path, entry);
          }
          try { checkManifest(next.manifest); }
          catch {
            json(response, 400, { error: 'invalid_path' });
            return;
          }
          const receipt = { workspaceId: manifest.workspaceId, operationId: body.operationId, revision: next.manifest.revision, files };
          next.receipts[key] = { fingerprint, receipt };
          await atomicJson(path.join(root, 'history', `${manifest.revision}.json`), manifest);
          try { await atomicJson(statePath, next); }
          catch (error) {
            storageFailed = true;
            throw error;
          }
          state = next;
          json(response, 200, receipt);
        };
        const pending = commits.then(commit);
        commits = pending.catch(() => {});
        await pending;
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, 500, { error: 'storage_failure' });
      else response.destroy();
      reportError(error);
    }
  };

  const server = http.createServer(async (request, response) => {
    if (closing) {
      json(response, 503, { error: 'server_closing' });
      return;
    }
    activeRequests++;
    try { await handleRequest(request, response); }
    finally {
      activeRequests--;
      if (!activeRequests) drainRequests?.();
    }
  });
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 30000;

  return {
    server,
    close: () => closePromise ??= (async () => {
      closing = true;
      if (server.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      if (activeRequests) await new Promise(resolve => { drainRequests = resolve; });
      await commits;
      await release();
    })(),
  };
}
