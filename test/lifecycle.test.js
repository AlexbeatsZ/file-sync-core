import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, utimes, stat } from 'node:fs/promises';
import { BackupRepository, lifecyclePolicy } from '../src/index.js';
import { temporary, listen, json, upload, op, change, request, token, pause, digest } from './helpers.js';

test('backup deduplicates, rotates calendar buckets, preserves pinned points and restores exact bytes', async t => {
  const root = await temporary(t), source = path.join(root, 'input');
  const repo = new BackupRepository(path.join(root, 'backup'));
  const now = Date.now();
  await writeFile(source, 'shared bytes');
  const first = await repo.snapshot({ 'data/file': source }, { now: now - 100 * 86400000, pinned: true });
  assert.equal((await repo.snapshot({ 'data/file': source }, { now })).status, 'unchanged');
  assert.equal((await readdir(path.join(root, 'backup', 'objects'))).length, 1);
  for (let n = 12; n >= 0; n--) {
    await writeFile(source, 'version ' + n);
    await repo.snapshot({ 'data/file': source }, { now: now - n * 86400000 });
  }
  const before = await repo.snapshots();
  const dry = await repo.prune({ dryRun: true, now });
  assert(dry.removeSnapshots.length > 0);
  assert.equal((await repo.snapshots()).length, before.length);
  assert(!dry.removeSnapshots.includes(first.id));
  await repo.prune({ dryRun: false, now });
  const destination = path.join(root, 'restored');
  await repo.restore(first.id, destination);
  assert.equal(await readFile(path.join(destination, 'data/file'), 'utf8'), 'shared bytes');
  await assert.rejects(repo.restore(first.id, destination), { code: 'EEXIST' });
});

test('corrupt backup halts pruning and restore rejects traversal', async t => {
  const root = await temporary(t), source = path.join(root, 'file');
  const repo = new BackupRepository(path.join(root, 'backup'));
  await writeFile(source, 'original');
  await repo.snapshot({ data: source });
  await assert.rejects(repo.snapshot({ '../escaped': source }));
  const object = (await readdir(path.join(root, 'backup', 'objects')))[0];
  await writeFile(path.join(root, 'backup', 'objects', object), 'corruption');
  await assert.rejects(repo.prune({ dryRun: false }));
  assert.equal((await repo.snapshots()).length, 1);
});

test('capacity never removes latest or pinned backups and reports an unsatisfiable cap', async t => {
  const root = await temporary(t), source = path.join(root, 'file');
  await writeFile(source, 'large enough');
  const repo = new BackupRepository(path.join(root, 'backup'), lifecyclePolicy({ backup: { maxStorageGiB: 0.000000001 } }).backup);
  await repo.snapshot({ data: source });
  const plan = await repo.prune({ dryRun: false });
  assert(plan.overCapacity);
  assert.equal((await repo.snapshots()).length, 1);
});

test('GC keeps current, retained history, fresh upload, active page snapshots and exact CAS after receipt expiry', async t => {
  const root = await temporary(t);
  const service = await listen(t, root, { lifecycle: { history: { maxRevisions: 1, receiptMaxPerDevice: 1 } } });
  const { workspaceId } = await json(service);
  const hashes = [];
  let firstOp;
  for (let n = 0; n < 4; n++) {
    const hash = await upload(service, 'version ' + n); hashes.push(hash);
    const operation = op(workspaceId, [change('library.json', hash, n)]);
    firstOp ??= operation;
    assert.equal((await request(service, 'commit', 'POST', JSON.stringify(operation))).status, 200);
  }
  const fresh = await upload(service, 'uncommitted fresh');
  const old = new Date(Date.now() - 48 * 3600000);
  for (const hash of hashes) await utimes(path.join(root, 'blobs', hash), old, old);
  const before = await readFile(path.join(root, 'state.json'));
  const dry = await service.maintenance('cleanup', true);
  assert.equal(dry.blobs, 2);
  assert.deepEqual(await readFile(path.join(root, 'state.json')), before);
  await service.maintenance('cleanup', false);
  await assert.rejects(stat(path.join(root, 'blobs', hashes[0])), { code: 'ENOENT' });
  for (const hash of [hashes[2], hashes[3], fresh]) assert((await stat(path.join(root, 'blobs', hash))).isFile());
  assert.equal((await request(service, 'changes?since=0')).status, 410);
  assert.equal((await request(service, 'commit', 'POST', JSON.stringify(firstOp))).status, 409);
  const backup = new BackupRepository(root + '-backups');
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root + '-backups', { recursive: true, force: true })));
  const restore = root + '-restore';
  t.after(() => import('node:fs/promises').then(fs => fs.rm(restore, { recursive: true, force: true })));
  await backup.restore((await backup.snapshots())[0].id, restore);
  assert.equal(JSON.parse(await readFile(path.join(restore, 'state.json'))).manifest.revision, 4);
  assert.equal(await readFile(path.join(restore, 'blobs', hashes[3]), 'utf8'), 'version 3');
});

test('an older paginated snapshot pins its blobs after its disk history expires', async t => {
  const root = await temporary(t);
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root + '-backups', { recursive: true, force: true })));
  const service = await listen(t, root, { lifecycle: { history: { maxRevisions: 1 } } });
  const { workspaceId } = await json(service);
  const first = await upload(service, 'old page'), second = await upload(service, 'second');
  await request(service, 'commit', 'POST', JSON.stringify(op(workspaceId, [change('library.json', first), change('notebooks/test/pages/second.json', second)])));
  const snapshot = await (await request(service, 'manifest/pages?limit=1')).json();
  assert(snapshot.nextCursor);
  for (let n = 1; n <= 3; n++) {
    const next = await upload(service, 'next ' + n);
    assert.equal((await request(service, 'commit', 'POST', JSON.stringify(op(workspaceId, [change('library.json', next, n)])))).status, 200);
  }
  const old = new Date(Date.now() - 48 * 3600000);
  await utimes(path.join(root, 'blobs', first), old, old);
  await service.maintenance('cleanup', false);
  assert((await stat(path.join(root, 'blobs', first))).isFile());
  assert.equal((await request(service, 'manifest/pages?cursor=' + snapshot.nextCursor)).status, 200);
});

test('an active upload of an old uncommitted hash is protected throughout GC', async t => {
  const root = await temporary(t);
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root + '-backups', { recursive: true, force: true })));
  const service = await listen(t, root, { lifecycle: {} });
  const bytes = Buffer.from('a stream which is still uploading'), hash = await upload(service, bytes);
  const old = new Date(Date.now() - 48 * 3600000);
  await utimes(path.join(root, 'blobs', hash), old, old);
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  async function* body() { yield bytes.subarray(0, 5); await hold; yield bytes.subarray(5); }
  const put = fetch(service.url + `blobs/${hash}`, { method: 'PUT', body: body(), duplex: 'half', headers: { Authorization: `Bearer ${token}` } });
  for (let n = 0; n < 100 && !(await readdir(path.join(root, 'blobs'))).some(f => f.endsWith('.tmp')); n++) await pause();
  assert((await readdir(path.join(root, 'blobs'))).some(f => f.endsWith('.tmp')));
  try {
    await service.maintenance('cleanup', false);
    assert((await stat(path.join(root, 'blobs', hash))).isFile());
  } finally { finish(); }
  assert.equal((await put).status, 200);
  assert.equal(hash, digest(bytes));
});
