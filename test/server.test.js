import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createFileSyncServer, hashPattern, idPattern } from '../src/index.js';
import { validateManifest, validPath as webPath } from './fixtures/webobsidian-policy.js';
import { token, prefix, digest, policies, op, change, temporary, listen, request, json, upload, worker, pause, cleanup } from './helpers.js';

test('exported patterns are exact and have no stateful flags', () => {
  assert(hashPattern.test('a'.repeat(64)));
  assert(!hashPattern.test('a'.repeat(64) + '\n'));
  assert(idPattern.test('a'.repeat(16)));
  assert(!idPattern.test('a'.repeat(16) + '\n'));
  assert(!idPattern.test('a'.repeat(81)));
  assert(!hashPattern.global && !hashPattern.sticky && !idPattern.global && !idPattern.sticky);
});

test('configuration and token policies reject before touching a data root', async t => {
  const root = path.join(await temporary(t), 'must-not-exist');
  const base = { root, token, routePrefix: prefix, ...policies };
  for (const override of [
    { root: '' }, { token: undefined }, { token: 'x\n' }, { routePrefix: '/x/' },
    { routePrefix: '//example.com/a' }, { routePrefix: '/x/../y' }, { routePrefix: '/x?y' },
    { validPath: undefined }, { validateManifest: undefined }, { maxBlobBytes: -1 },
    { maxBlobBytes: 1.5 }, { validateToken: 1 }, { validateRequest: null }, { onError: null },
    { validateToken() { throw new Error('policy rejected'); } }, { validateToken: async () => {} },
  ]) {
    await assert.rejects(createFileSyncServer({ ...base, ...override }));
    await assert.rejects(stat(root), { code: 'ENOENT' });
  }
});

test('authentication, per-consumer routes, method/URL and request policy', async t => {
  const service = await listen(t, await temporary(t), {
    routePrefix: '/webobsidian-sync/v1',
    validPath: webPath, validateManifest,
    validateRequest: (req, url) => !req.headers.origin && !url.search && !req.url.includes('#'),
  });
  assert.equal((await request(service, 'manifest', 'GET', undefined, { Authorization: '' })).status, 401);
  assert.equal((await request(service, 'manifest', 'GET', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(service, 'manifest', 'GET', undefined, { Origin: 'https://example.invalid' })).status, 400);
  assert.equal((await request(service, 'manifest?q=1')).status, 400);
  assert.equal((await request(service, 'manifest', 'POST', '')).status, 404);
  assert.equal((await fetch(service.url.replace('/webobsidian-sync/', '/mojian-sync/') + 'manifest',
    { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  const response = await request(service, 'manifest');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).revision, 0);
});

test('streamed binary upload/download, empty blobs, duplicates and rejection cleanup', async t => {
  const root = await temporary(t);
  const service = await listen(t, root, { maxBlobBytes: 131072 });
  const bytes = Buffer.alloc(131072);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const hash = digest(bytes);
  async function* chunks() { for (let i = 0; i < bytes.length; i += 8192) { yield bytes.subarray(i, i + 8192); await pause(); } }
  const uploaded = await fetch(service.url + `blobs/${hash}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: chunks(), duplex: 'half',
  });
  assert.equal(uploaded.status, 200);
  await upload(service, bytes);
  await upload(service, Buffer.alloc(0));
  const downloaded = await request(service, `blobs/${hash}`);
  assert.equal(downloaded.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await request(service, `blobs/${digest('missing')}`)).status, 404);
  assert.equal((await request(service, `blobs/${digest('wrong')}`, 'PUT', 'other')).status, 422);
  assert.equal((await request(service, `blobs/${digest(Buffer.alloc(131073))}`, 'PUT', Buffer.alloc(131073))).status, 413);
  const names = await readdir(path.join(root, 'blobs'));
  assert.deepEqual(names.sort(), [digest(Buffer.alloc(0)), hash].sort());
  assert.equal((await json(service)).revision, 0);
});

test('aborted upload leaves no published blob or temporary file', async t => {
  const root = await temporary(t);
  const service = await listen(t, root);
  const req = http.request(service.url + `blobs/${digest('aborted')}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` },
  });
  req.on('error', () => {});
  req.write('partial');
  // Observing the temp file establishes that the server is actually processing the stream.
  for (let i = 0; i < 200 && !(await readdir(path.join(root, 'blobs'))).length; i++) await pause();
  req.destroy();
  await service.close();
  assert.deepEqual(await readdir(path.join(root, 'blobs')), []);
});

test('malformed and oversized commits never publish state', async t => {
  const root = await temporary(t);
  const service = await listen(t, root);
  const { workspaceId } = await json(service);
  const before = await readFile(path.join(root, 'state.json'), 'utf8');
  const bodies = [
    null, {}, op(workspaceId, []), op(workspaceId, [change('unsupported/file')]),
    op(workspaceId, [change('library.json', 'a'.repeat(63))]),
    op(workspaceId, [change('library.json', null, -1)]),
    op(workspaceId, [change('library.json'), change('library.json')]),
    op(workspaceId, [change('notebooks/b/pages/A.json'), change('notebooks/b/pages/a.json')]),
    op(workspaceId, Array.from({ length: 20001 }, () => change('library.json'))),
    { ...op(workspaceId, [change('library.json')]), deviceId: 'bad' },
  ];
  for (const body of bodies) assert.equal((await request(service, 'commit', 'POST', body)).status, 400);
  assert.equal((await request(service, 'commit', 'POST', '{')).status, 400);
  assert.equal((await request(service, 'commit', 'POST', ' '.repeat(4 * 1024 * 1024 + 1))).status, 413);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
  assert.deepEqual(await readdir(path.join(root, 'history')), []);
});

test('CAS batches, original receipt replay, device scope, tombstones and historical bytes', async t => {
  const root = await temporary(t);
  let service = await listen(t, root);
  const initial = await json(service);
  const hash = await upload(service, 'immutable bytes');
  const first = op(initial.workspaceId, [
    change('library.json', hash),
    change('notebooks/book/pages/p.json', hash),
  ]);
  const receipt = await json(service, 'commit', 'POST', first);
  assert.equal(receipt.revision, 1);
  const deletion = op(initial.workspaceId, [change('library.json', null, 1)]);
  assert.equal((await json(service, 'commit', 'POST', deletion)).revision, 2);
  const replay = { ...first, changes: first.changes.toReversed().map(item => ({ ignored: true, ...item })) };
  assert.deepEqual(await json(service, 'commit', 'POST', replay), receipt);
  assert.equal((await request(service, 'commit', 'POST', { ...first, changes: [change('library.json')] })).status, 409);
  assert.equal((await request(service, 'commit', 'POST', { ...first, workspaceId: 'other-workspace-id' })).status, 409);
  assert.equal((await request(service, 'commit', 'POST', { ...first, deviceId: 'other-device-0000' })).status, 409);
  const before = await readFile(path.join(root, 'state.json'), 'utf8');
  const conflict = await request(service, 'commit', 'POST', op(initial.workspaceId, [
    change('library.json', hash, 0), change('notebooks/book/pages/new.json', hash),
  ]));
  assert.deepEqual(await conflict.json(), { error: 'version_conflict', revision: 2, conflicts: ['library.json'] });
  const missing = await request(service, 'commit', 'POST', op(initial.workspaceId, [change('notebooks/book/pages/new.json', digest('missing'))]));
  assert.equal(missing.status, 422);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
  await service.close();
  service = await listen(t, root);
  assert.deepEqual(await json(service, 'commit', 'POST', replay), receipt);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'history/0.json'), 'utf8')), initial);
  assert.deepEqual((await json(service)).files['library.json'], { hash: null, version: 2 });
  assert.deepEqual(await readdir(path.join(root, 'history')), ['0.json', '1.json']);
  assert.equal(await (await request(service, `blobs/${hash}`)).text(), 'immutable bytes');
});

test('concurrent CAS commits serialize; case aliases stay rejected including tombstones', async t => {
  const service = await listen(t, await temporary(t));
  const { workspaceId } = await json(service);
  const name = 'notebooks/book/pages/A.json';
  const results = await Promise.all(Array.from({ length: 8 }, () => request(service, 'commit', 'POST', op(workspaceId, [change(name)]))));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 7);
  assert.equal((await request(service, 'commit', 'POST', op(workspaceId, [change(name.toLowerCase())]))).status, 400);
  assert.equal((await json(service)).revision, 1);
});

test('consumer manifest policy rejects file/directory collisions atomically', async t => {
  const root = await temporary(t);
  const service = await listen(t, root, { validPath: webPath, validateManifest });
  const { workspaceId } = await json(service);
  const hash = await upload(service, 'data');
  assert.equal((await request(service, 'commit', 'POST', op(workspaceId, [change('notes', hash), change('notes/a.md', hash)]))).status, 400);
  assert.equal((await json(service)).revision, 0);
  assert.equal((await request(service, 'commit', 'POST', op(workspaceId, [change('笔记/文字.md', hash)]))).status, 200);
  assert.equal((await json(service)).files['笔记/文字.md'].version, 1);
});

test('own-property file keys work even under a deliberately permissive product policy', async t => {
  const service = await listen(t, await temporary(t), { validPath: () => true });
  const { workspaceId } = await json(service);
  const receipt = await json(service, 'commit', 'POST', op(workspaceId, [change('__proto__'), change('constructor')]));
  assert(Object.hasOwn(receipt.files, '__proto__'));
  assert.deepEqual(receipt.files.__proto__, { hash: null, version: 1 });
  assert(Object.hasOwn((await json(service)).files, 'constructor'));
});

test('the original v1 interoperability fixture matches exact receipts and fingerprints', async t => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/v1-wire.json', import.meta.url), 'utf8'));
  const root = await temporary(t);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ workspaceId: fixture.commit.workspaceId, revision: 0, files: {} }));
  const service = await listen(t, root);
  assert.equal(await upload(service, fixture.utf8), fixture.hash);
  assert.deepEqual(await json(service, 'commit', 'POST', fixture.commit), fixture.receipt);
  assert.deepEqual(await json(service, 'commit', 'POST', fixture.deletion), fixture.deletionReceipt);
  const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
  const normalized = fixture.commit.changes.map(({ path, expectedVersion, hash }) => ({ path, expectedVersion, hash }));
  const expected = digest(JSON.stringify({ workspaceId: fixture.commit.workspaceId, changes: normalized }));
  assert.equal(state.receipts[`${fixture.commit.deviceId}:${fixture.commit.operationId}`].fingerprint, expected);
  assert.deepEqual(await json(service, 'commit', 'POST', fixture.commit), fixture.receipt);
});

test('legacy manifest imports once; existing state/receipts and unknown fields remain byte intact on startup', async t => {
  const root = await temporary(t);
  const manifest = { workspaceId: 'legacy-workspace-1', revision: 7, files: { 'library.json': { hash: null, version: 7 } }, extra: 'preserve' };
  const legacyBytes = JSON.stringify(manifest, null, 2);
  await writeFile(path.join(root, 'manifest.json'), legacyBytes);
  let service = await listen(t, root);
  assert.deepEqual(await json(service), manifest);
  await service.close();
  const before = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
  before.extra = { untouched: true };
  const stateBytes = JSON.stringify(before, null, 2);
  await writeFile(path.join(root, 'state.json'), stateBytes);
  await writeFile(path.join(root, 'manifest.json'), '{old ignored data');
  service = await listen(t, root);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), stateBytes);
  await json(service, 'commit', 'POST', op(manifest.workspaceId, [change('library.json', null, 7)]));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).extra, before.extra);
  assert.equal(await readFile(path.join(root, 'manifest.json'), 'utf8'), '{old ignored data');
  assert(legacyBytes.length > 0);
});

test('state generated by the pinned original server replays receipts without rewriting its bytes', async t => {
  const root = await temporary(t);
  const fixture = JSON.parse(await readFile(new URL('./fixtures/v1-wire.json', import.meta.url), 'utf8'));
  const oldBytes = await readFile(new URL('./fixtures/legacy-state.json', import.meta.url), 'utf8');
  await writeFile(path.join(root, 'state.json'), oldBytes);
  await mkdir(path.join(root, 'blobs'));
  await writeFile(path.join(root, 'blobs', fixture.hash), fixture.utf8);
  const service = await listen(t, root);
  assert.deepEqual(await json(service, 'commit', 'POST', fixture.commit), fixture.receipt);
  assert.deepEqual(await json(service, 'commit', 'POST', fixture.deletion), fixture.deletionReceipt);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), oldBytes);
  assert.equal((await json(service)).revision, 2);
  assert.deepEqual(await readdir(path.join(root, 'history')), []);
});

test('malformed stored state and receipts fail closed, preserve bytes and release the lock', async t => {
  const root = await temporary(t);
  const goodManifest = { workspaceId: 'legacy-workspace-1', revision: 1, files: {} };
  for (const bad of [
    '{corrupt', JSON.stringify(null), JSON.stringify({ manifest: { ...goodManifest, files: 'bad' }, receipts: {} }),
    JSON.stringify({ manifest: goodManifest, receipts: [] }),
    JSON.stringify({ manifest: goodManifest, receipts: { 'bad:key': {} } }),
    JSON.stringify({ manifest: goodManifest, receipts: { 'device-0000000000:operation-0000000': { fingerprint: 'a'.repeat(64), receipt: {
      workspaceId: goodManifest.workspaceId, operationId: 'operation-0000000', revision: 2, files: {},
    } } } }),
  ]) {
    await writeFile(path.join(root, 'state.json'), bad);
    await assert.rejects(createFileSyncServer({ root, token, routePrefix: prefix, ...policies }));
    assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), bad);
    await assert.rejects(stat(path.join(root, 'server.lock')), { code: 'ENOENT' });
  }
});

test('history write failure leaves state unchanged and the same operation can retry', async t => {
  const root = await temporary(t);
  const service = await listen(t, root);
  const { workspaceId } = await json(service);
  const operation = op(workspaceId, [change('library.json')]);
  const before = await readFile(path.join(root, 'state.json'), 'utf8');
  await mkdir(path.join(root, 'history/0.json'));
  assert.equal((await request(service, 'commit', 'POST', operation)).status, 500);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
  assert.equal((await json(service)).revision, 0);
  await rm(path.join(root, 'history/0.json'), { recursive: true });
  assert.equal((await json(service, 'commit', 'POST', operation)).revision, 1);
});

test('state publication failure freezes requests until restart without losing the old snapshot', async t => {
  const root = await temporary(t);
  let service = await listen(t, root);
  const { workspaceId } = await json(service);
  const operation = op(workspaceId, [change('library.json')]);
  await rename(path.join(root, 'state.json'), path.join(root, 'saved-state.json'));
  await mkdir(path.join(root, 'state.json'));
  assert.equal((await request(service, 'commit', 'POST', operation)).status, 500);
  assert.equal((await request(service, 'manifest')).status, 503);
  assert.equal((await request(service, 'commit', 'POST', operation)).status, 503);
  await service.close();
  await rm(path.join(root, 'state.json'), { recursive: true });
  await rename(path.join(root, 'saved-state.json'), path.join(root, 'state.json'));
  service = await listen(t, root);
  const receipt = await json(service, 'commit', 'POST', operation);
  assert.equal(receipt.revision, 1);
  assert.deepEqual(await json(service, 'commit', 'POST', operation), receipt);
});

test('real second process is refused; SIGKILL leaves a reclaimable lock and durable receipts', async t => {
  const root = await temporary(t);
  const first = await worker(t, root);
  const { workspaceId } = await json(first);
  const hash = await upload(first, 'before crash');
  const operation = op(workspaceId, [change('library.json', hash)]);
  const receipt = await json(first, 'commit', 'POST', operation);
  const before = await readFile(path.join(root, 'state.json'), 'utf8');
  await assert.rejects(worker(t, root), /already in use|EEXIST/);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
  const exited = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await exited;
  const second = await worker(t, root);
  assert.deepEqual(await json(second, 'commit', 'POST', operation), receipt);
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
  assert.equal(await (await request(second, `blobs/${hash}`)).text(), 'before crash');
  const cleanExit = once(second.child, 'exit');
  second.child.send('close');
  await cleanExit;
  await assert.rejects(stat(path.join(root, 'server.lock')), { code: 'ENOENT' });
});

test('invalid PID locks and live owner PID locks are never removed', async t => {
  const root = await temporary(t);
  for (const owner of ['invalid', '0', String(process.pid)]) {
    await writeFile(path.join(root, 'server.lock'), owner);
    await assert.rejects(createFileSyncServer({ root, token, routePrefix: prefix, ...policies }));
    assert.equal(await readFile(path.join(root, 'server.lock'), 'utf8'), owner);
  }
});

for (const mode of ['crash-after-state-rename', 'error-after-state-rename']) {
  test(`${mode}: uncertain operation replays the durable original receipt after restart`, async t => {
    const root = await temporary(t);
    const first = await worker(t, root, mode);
    const { workspaceId } = await json(first);
    const operation = op(workspaceId, [change('library.json')]);
    const exited = once(first.child, 'exit');
    if (mode.startsWith('crash')) await assert.rejects(request(first, 'commit', 'POST', operation));
    else {
      assert.equal((await request(first, 'commit', 'POST', operation)).status, 500);
      assert.equal((await request(first, 'manifest')).status, 503);
      first.child.send('close');
    }
    await exited;
    const stateBytes = await readFile(path.join(root, 'state.json'), 'utf8');
    const stored = JSON.parse(stateBytes);
    assert.equal(stored.manifest.revision, 1);
    const original = stored.receipts[`${operation.deviceId}:${operation.operationId}`].receipt;
    const restarted = await listen(t, root);
    assert.deepEqual(await json(restarted, 'commit', 'POST', operation), original);
    assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), stateBytes);
    assert.equal((await json(restarted)).revision, 1);
  });
}

test('parallel process startups reclaim a dead PID with exactly one surviving writer', async t => {
  const root = await temporary(t);
  const old = await worker(t, root);
  const exited = once(old.child, 'exit');
  old.child.kill('SIGKILL');
  await exited;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => worker(t, root)));
  const winners = results.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(await readFile(path.join(root, 'server.lock'), 'utf8'), String(winners[0].value.child.pid));
  await assert.rejects(stat(path.join(root, 'server.lock.claim')), { code: 'ENOENT' });
  assert.equal((await json(winners[0].value)).revision, 0);
});

test('an interrupted startup claim is preserved for explicit recovery', async t => {
  const root = await temporary(t);
  await mkdir(path.join(root, 'server.lock.claim'));
  await assert.rejects(createFileSyncServer({ root, token, routePrefix: prefix, ...policies }), { code: 'EEXIST' });
  assert((await stat(path.join(root, 'server.lock.claim'))).isDirectory());
  await assert.rejects(stat(path.join(root, 'state.json')), { code: 'ENOENT' });
});

test('close drains an in-progress upload and commit body, remains idempotent and holds its lock', async t => {
  const root = await temporary(t);
  let started = 0;
  let onBothStarted;
  const bothStarted = new Promise(resolve => { onBothStarted = resolve; });
  const service = await listen(t, root, { validateRequest(req) {
    if ((req.method === 'POST' || req.method === 'PUT') && ++started === 2) onBothStarted();
    return true;
  } });
  const { workspaceId } = await json(service);
  const bytes = Buffer.from('stream drain');
  const operation = op(workspaceId, [change('library.json')]);
  const body = JSON.stringify(operation);
  const send = endpoint => {
    const req = http.request(service.url + endpoint, { method: endpoint === 'commit' ? 'POST' : 'PUT', headers: { Authorization: `Bearer ${token}` } });
    const done = new Promise((resolve, reject) => {
      req.once('error', reject);
      req.once('response', response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    });
    return { req, done };
  };
  const uploading = send(`blobs/${digest(bytes)}`);
  const committing = send('commit');
  uploading.req.write(bytes.subarray(0, 3));
  committing.req.write(body.slice(0, 4));
  await bothStarted;
  const closing = service.close();
  assert.equal(service.close(), closing);
  await assert.rejects(createFileSyncServer({ root, token, routePrefix: prefix, ...policies }), /already in use|EEXIST/);
  uploading.req.end(bytes.subarray(3));
  committing.req.end(body.slice(4));
  assert.equal(await uploading.done, 200);
  assert.equal(await committing.done, 200);
  await closing;
  const restarted = await listen(t, root);
  assert.equal((await json(restarted)).revision, 1);
  assert.equal(await (await request(restarted, `blobs/${digest(bytes)}`)).text(), bytes.toString());
});

test('forwarded listener requests also drain before releasing the lock', async t => {
  const root = await temporary(t);
  const service = await createFileSyncServer({ root, token, routePrefix: prefix, ...policies });
  cleanup(t, root, () => service.close());
  let handlerStarted;
  const started = new Promise(resolve => { handlerStarted = resolve; });
  const proxy = http.createServer((req, res) => { service.server.emit('request', req, res); handlerStarted(); });
  cleanup(t, root, () => new Promise(resolve => proxy.close(resolve)));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const bytes = 'forwarded body';
  const req = http.request(`http://127.0.0.1:${proxy.address().port}${prefix}/blobs/${digest(bytes)}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` },
  });
  const response = once(req, 'response');
  req.write(bytes.slice(0, 3));
  await started;
  const closing = service.close();
  await assert.rejects(createFileSyncServer({ root, token, routePrefix: prefix, ...policies }), /already in use|EEXIST/);
  req.end(bytes.slice(3));
  const [res] = await response;
  res.resume();
  await once(res, 'end');
  await closing;
  // New forwarded requests are explicitly refused after close, rather than writing without a lock.
  const refused = await fetch(`http://127.0.0.1:${proxy.address().port}${prefix}/manifest`);
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: 'server_closing' });
});

test('diagnostics expose only safe codes and a throwing logger cannot break requests', async t => {
  const root = await temporary(t);
  const seen = [];
  const service = await listen(t, root, {
    validateRequest() { const error = new Error('secret token and request body'); error.code = 'sensitive-value'; error.name = 'private-name'; throw error; },
    onError(event) { seen.push(event); throw new Error('logger failed'); },
  });
  assert.equal((await request(service, 'manifest')).status, 500);
  assert.deepEqual(seen, [{ code: 'Error' }]);
});

test('async policy results fail closed and never publish a commit', async t => {
  const root = await temporary(t);
  const service = await listen(t, root, { validateRequest: async () => true });
  assert.equal((await request(service, 'manifest')).status, 500);
  await service.close();
  await assert.rejects(createFileSyncServer({ root, token, routePrefix: prefix, ...policies, validateManifest: async () => {} }), /synchronous/);
});
