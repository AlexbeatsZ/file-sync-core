import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createFileSyncServer } from '../src/index.js';

const workspaceId = 'benchmark-workspace-id';
const token = 'synthetic-benchmark-only';
const routePrefix = '/benchmark/v1';
const blobHash = 'a'.repeat(64);

function sample(values) {
  const sorted = values.toSorted((first, second) => first - second);
  return { medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), maxMs: Math.round(sorted.at(-1)) };
}

async function benchmark(parent, fileCount) {
  const root = await mkdtemp(path.join(parent, 'file-sync-benchmark-'));
  let service;
  try {
    const receipts = {};
    const files = {};
    const revision = 2500;
    for (let index = 0; index < fileCount; index++) {
      files[`vault/folder-${Math.floor(index / 100)}/synthetic-note-${index}.md`] = { hash: blobHash, version: 1 };
    }
    for (let index = 1; index <= revision; index++) {
      const operationId = `operation-${String(index).padStart(10, '0')}`;
      receipts[`benchmark-device01:${operationId}`] = {
        fingerprint: blobHash,
        receipt: { workspaceId, operationId, revision: index, files: { 'vault/changing.md': { hash: blobHash, version: index } } },
      };
      files['vault/changing.md'] = { hash: blobHash, version: index };
    }
    const manifest = { workspaceId, revision, files };
    await mkdir(path.join(root, 'history'));
    await writeFile(path.join(root, 'state.json'), JSON.stringify({ manifest, receipts }));
    await writeFile(path.join(root, 'history', `${revision}.json`), JSON.stringify(manifest));

    const startup = performance.now();
    service = await createFileSyncServer({ root, token, routePrefix, validPath: () => true, validateManifest() {} });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const startupMs = Math.round(performance.now() - startup);
    const url = `http://127.0.0.1:${service.server.address().port}${routePrefix}`;

    const timed = async (endpoint, body) => {
      const started = performance.now();
      const response = await fetch(url + endpoint, {
        headers: { Authorization: `Bearer ${token}` }, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Benchmark request failed: ${response.status}`);
      const result = await response.text();
      return { elapsed: performance.now() - started, bytes: Buffer.byteLength(result), data: JSON.parse(result) };
    };
    const commitTimes = [];
    const fullTimes = [];
    const deltaTimes = [];
    const snapshotTimes = [];
    let fullBytes, deltaBytes, snapshotBytes;
    for (let index = 0; index < 6; index++) {
      const operationId = `bench-commit-${String(index).padStart(6, '0')}`;
      const commit = await timed('/commit', {
        workspaceId, deviceId: 'benchmark-device01', operationId,
        changes: [{ path: `vault/added-${index}.md`, expectedVersion: 0, hash: null }],
      });
      const full = await timed('/manifest');
      const delta = await timed(`/changes?since=${commit.data.revision - 1}`);
      const snapshotStarted = performance.now();
      let page = await timed('/manifest/pages?limit=500');
      snapshotBytes = page.bytes;
      while (page.data.nextCursor) {
        page = await timed(`/manifest/pages?cursor=${page.data.nextCursor}`);
        snapshotBytes += page.bytes;
      }
      commitTimes.push(commit.elapsed);
      fullTimes.push(full.elapsed);
      deltaTimes.push(delta.elapsed);
      snapshotTimes.push(performance.now() - snapshotStarted);
      fullBytes = full.bytes;
      deltaBytes = delta.bytes;
    }
    const stateBytes = (await stat(path.join(root, 'state.json'))).size;
    const historyBytes = (await stat(path.join(root, 'history', `${revision + 5}.json`))).size;
    return { fileCount, priorReceipts: revision, startupMs, stateBytes, historyBytes, fullBytes, deltaBytes, snapshotBytes,
      commit: sample(commitTimes), full: sample(fullTimes), delta: sample(deltaTimes), snapshot: sample(snapshotTimes) };
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const parent = path.join(os.tmpdir(), '.agents');
await mkdir(parent, { recursive: true });
for (const fileCount of [1923, 6445]) {
  console.log(JSON.stringify(await benchmark(parent, fileCount)));
}
