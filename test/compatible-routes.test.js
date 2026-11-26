import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { change, digest, json, listen, op, request, temporary, upload } from './helpers.js';

async function putChunk(service, hash, data, start, total) {
  return request(service, `uploads/${hash}`, 'PUT', data, {
    'Content-Range': `bytes ${start}-${start + data.length - 1}/${total}`,
  });
}

test('stable pages exclude concurrent writes; delta collapses repeated changes and keeps deletions', async t => {
  const root = await temporary(t);
  const service = await listen(t, root, { validPath: () => true });
  const { workspaceId } = await json(service);
  const [a, b] = await Promise.all([upload(service, 'first'), upload(service, 'second')]);
  await json(service, 'commit', 'POST', op(workspaceId, [change('A', a), change('B', a)]));
  const first = await json(service, 'manifest/pages?limit=1');
  assert.deepEqual({ ...first, nextCursor: !!first.nextCursor }, {
    workspaceId, revision: 1, files: { A: { hash: a, version: 1 } }, nextCursor: true,
  });
  await json(service, 'commit', 'POST', op(workspaceId, [change('A', b, 1), change('B', null, 1), change('C', b)]));
  await json(service, 'commit', 'POST', op(workspaceId, [change('A', a, 2)]));
  const second = { workspaceId, revision: 1, files: { B: { hash: a, version: 1 } }, nextCursor: null };
  assert.deepEqual(await json(service, `manifest/pages?cursor=${first.nextCursor}`), second);
  assert.deepEqual(await json(service, `manifest/pages?cursor=${first.nextCursor}`), second);
  assert.equal((await request(service, `changes?cursor=${first.nextCursor}`)).status, 410);

  const delta = await json(service, 'changes?since=1&limit=2');
  assert.deepEqual(delta.files, { A: { hash: a, version: 3 }, B: { hash: null, version: 2 } });
  assert.equal(delta.revision, 3);
  await json(service, 'commit', 'POST', op(workspaceId, [change('D', a)]));
  assert.deepEqual(await json(service, `changes?cursor=${delta.nextCursor}`), {
    workspaceId, revision: 3, files: { C: { hash: b, version: 2 } }, nextCursor: null,
  });
  assert.deepEqual((await json(service, 'changes?since=3')).files, { D: { hash: a, version: 4 } });
  assert.deepEqual(await json(service, 'changes?since=4'), { workspaceId, revision: 4, files: {}, nextCursor: null });
  const ahead = await request(service, 'changes?since=5');
  assert.equal(ahead.status, 409);
  assert.deepEqual(await ahead.json(), { error: 'revision_ahead', revision: 4 });
  assert.equal((await request(service, 'changes?since=1&since=2')).status, 400);
  assert.equal((await request(service, 'manifest/pages?limit=0')).status, 400);
  assert.equal((await request(service, 'manifest/pages?extra=1')).status, 400);
  const restartCursor = (await json(service, 'manifest/pages?limit=1')).nextCursor;
  await service.close();
  const restarted = await listen(t, root, { validPath: () => true });
  const expired = await request(restarted, `manifest/pages?cursor=${restartCursor}`);
  assert.equal(expired.status, 410);
  assert.deepEqual(await expired.json(), { error: 'cursor_expired' });
  assert.equal((await json(restarted, 'manifest/pages')).revision, 4);
});

test('delta rejects an unverifiable or damaged legacy history boundary', async t => {
  const root = await temporary(t);
  const workspaceId = 'legacy-workspace-id';
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ workspaceId, files: {}, revision: 7 }));
  const service = await listen(t, root, { validPath: () => true });
  assert.equal((await request(service, 'changes?since=6')).status, 410);
  const hash = await upload(service, 'first change after legacy import');
  await json(service, 'commit', 'POST', op(workspaceId, [change('A', hash)]));
  assert.equal((await json(service, 'changes?since=7')).revision, 8);
  await writeFile(path.join(root, 'history', '7.json'), '{');
  assert.equal((await request(service, 'changes?since=7')).status, 500);
  assert.equal((await json(service)).revision, 8);
});

test('upload offsets survive restart; legacy commit sees only the fully verified blob', async t => {
  const root = await temporary(t);
  let service = await listen(t, root, { validPath: () => true, maxBlobBytes: 40 });
  const { workspaceId } = await json(service);
  const bytes = Buffer.from('part-1part-2');
  const hash = digest(bytes);
  const operation = op(workspaceId, [change('A', hash)]);
  assert.equal((await request(service, `uploads/${hash}`)).status, 404);
  assert.deepEqual(await (await putChunk(service, hash, bytes.subarray(0, 6), 0, 12)).json(), {
    offset: 6, total: 12, complete: false,
  });
  assert.equal((await request(service, `blobs/${hash}`)).status, 404);
  assert.equal((await request(service, 'commit', 'POST', operation)).status, 422);
  await service.close();
  service = await listen(t, root, { validPath: () => true, maxBlobBytes: 40 });
  assert.deepEqual(await json(service, `uploads/${hash}`), { offset: 6, total: 12, complete: false });
  const overlap = await putChunk(service, hash, bytes.subarray(0, 6), 0, 12);
  assert.equal(overlap.status, 409);
  assert.deepEqual(await overlap.json(), { error: 'upload_offset_mismatch', offset: 6, total: 12 });
  const badLength = await request(service, `uploads/${hash}`, 'PUT', Buffer.from('short'), { 'Content-Range': 'bytes 6-11/12' });
  assert.equal(badLength.status, 400);
  assert.equal((await json(service, `uploads/${hash}`)).offset, 6);
  assert.deepEqual(await (await putChunk(service, hash, bytes.subarray(6), 6, 12)).json(), {
    offset: 12, total: 12, complete: true,
  });
  assert.deepEqual(await json(service, `uploads/${hash}`), { offset: 12, total: 12, complete: true });
  const replay = await putChunk(service, hash, bytes.subarray(6), 6, 12);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).complete, true);
  const receipt = await json(service, 'commit', 'POST', operation);
  assert.deepEqual(await json(service, 'commit', 'POST', operation), receipt);
  const range = await request(service, `blobs/${hash}`, 'GET', undefined, { Range: 'bytes=6-' });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), 'bytes 6-11/12');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(6));
  const invalidRange = await request(service, `blobs/${hash}`, 'GET', undefined, { Range: 'bytes=12-' });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('Content-Range'), 'bytes */12');
});

test('bad hash resets staged data and a completed staging file recovers after restart', async t => {
  const root = await temporary(t);
  let service = await listen(t, root);
  const bytes = Buffer.from('correct');
  const hash = digest(bytes);
  assert.equal((await putChunk(service, hash, Buffer.from('another'), 0, 7)).status, 422);
  assert.equal((await request(service, `uploads/${hash}`)).status, 404);
  await service.close();
  const uploads = path.join(root, 'uploads');
  await mkdir(uploads, { recursive: true });
  await writeFile(path.join(uploads, `${hash}.json`), '7');
  await writeFile(path.join(uploads, `${hash}.part`), bytes);
  service = await listen(t, root);
  assert.deepEqual(await json(service, `uploads/${hash}`), { offset: 7, total: 7, complete: true });
  assert.deepEqual(await readFile(path.join(root, 'blobs', hash)), bytes);
  assert.equal((await request(service, `uploads/${hash}`, 'PUT', bytes)).status, 400);
});
