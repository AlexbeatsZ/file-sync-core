import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFileSyncServer } from '../src/index.js';
import { validPath } from './fixtures/mojian-policy.js';

export const token = 'isolated-file-sync-token-never-for-production';
export const prefix = '/mojian-sync/v1';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const policies = { validPath, validateManifest() {} };
export const op = (workspaceId, changes) => ({ workspaceId, deviceId: 'isolated-device-id', operationId: randomUUID(), changes });
export const change = (name, hash = null, expectedVersion = 0) => ({ path: name, expectedVersion, hash });
export const pause = () => new Promise(resolve => setImmediate(resolve));
const cleanups = new Map();

export function cleanup(t, root, action) {
  if (cleanups.has(root)) cleanups.get(root).push(action);
  else t.after(action);
}

export async function temporary(t) {
  const parent = path.join(os.tmpdir(), '.agents');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'file-sync-core-'));
  assert.equal(path.dirname(root), parent);
  cleanups.set(root, []);
  t.after(async () => {
    try { for (const action of cleanups.get(root).toReversed()) await action(); }
    finally { cleanups.delete(root); await rm(root, { recursive: true, force: true }); }
  });
  return root;
}

export async function listen(t, root, options = {}) {
  const service = await createFileSyncServer({ root, token, routePrefix: prefix, ...policies, onError() {}, ...options });
  cleanup(t, root, () => service.close());
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  return { ...service, url: `http://127.0.0.1:${service.server.address().port}${options.routePrefix ?? prefix}/` };
}

export async function request(service, endpoint, method = 'GET', body, headers = {}) {
  return fetch(service.url + endpoint, {
    method, headers: { Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
  });
}

export async function json(service, endpoint = 'manifest', method = 'GET', body) {
  const response = await request(service, endpoint, method, body);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return response.json();
}

export async function upload(service, bytes) {
  const hash = digest(bytes);
  assert.deepEqual(await json(service, `blobs/${hash}`, 'PUT', bytes), { hash });
  return hash;
}

export async function worker(t, root, fault = '') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), root, fault], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  cleanup(t, root, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`Worker exited ${code}: ${stderr}`); }),
  ]);
  assert.equal(ready.error, undefined, ready.error);
  return { child, url: `http://127.0.0.1:${ready.port}${prefix}/` };
}
