import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const maxChunkBytes = 8 * 1024 * 1024;
const maxActiveUploads = 8;
const contentRange = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/([1-9][0-9]*)$/;

async function sizeIfPresent(filename) {
  try { return (await stat(filename)).size; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function discard(filename) {
  await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export function byteRange(header, size) {
  const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(header);
  if (!match || !size) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function createUploadHandler(root, maxBlobBytes, atomicJson, syncDirectory) {
  const directory = path.join(root, 'uploads');
  const blobDirectory = path.join(root, 'blobs');
  const active = new Set();

  return async (request, response, hash, json) => {
    let start, end, requestedTotal, length;
    if (request.method === 'PUT') {
      const match = contentRange.exec(request.headers['content-range']);
      if (match) [start, end, requestedTotal] = match.slice(1).map(Number);
      length = end - start + 1;
      if (![start, end, requestedTotal].every(Number.isSafeInteger) || start > end || end >= requestedTotal) {
        return json(response, 400, { error: 'invalid_content_range' });
      }
      if (requestedTotal > maxBlobBytes || length > maxChunkBytes) return json(response, 413, { error: 'blob_too_large' });
    }

    if (active.has(hash) || active.size >= maxActiveUploads) {
      json(response, 503, { error: 'upload_busy' });
      return;
    }
    active.add(hash);
    try {
      const published = path.join(blobDirectory, hash);
      const part = path.join(directory, `${hash}.part`);
      const meta = path.join(directory, `${hash}.json`);
      const doneSize = await sizeIfPresent(published);
      const report = (offset, total, complete) => json(response, 200, { offset, total, complete });
      const offsetMismatch = (offset, total) => json(response, 409, { error: 'upload_offset_mismatch', offset, total });

      if (doneSize !== undefined) {
        if (request.method === 'PUT' && requestedTotal !== doneSize) return offsetMismatch(doneSize, doneSize);
        // A crash after publishing or a concurrent legacy PUT may leave staging files.
        await discard(part);
        await discard(meta);
        return report(doneSize, doneSize, true);
      }

      let total;
      try { total = JSON.parse(await readFile(meta, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0)) throw new Error('Invalid upload metadata');
      if (total > maxBlobBytes) return json(response, 413, { error: 'blob_too_large' });
      const offset = (await sizeIfPresent(part)) ?? 0;
      if (offset && (total === undefined || offset > total)) throw new Error('Invalid upload staging length');

      const finish = async () => {
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(part)) digest.update(chunk);
        if (digest.digest('hex') !== hash) {
          await discard(part);
          await discard(meta);
          await syncDirectory(directory);
          json(response, 422, { error: 'hash_mismatch' });
          return;
        }
        const handle = await open(part, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        try { await rename(part, published); }
        catch (error) {
          if (!['EEXIST', 'EPERM'].includes(error.code) || await sizeIfPresent(published) !== total) throw error;
          await discard(part);
        }
        await syncDirectory(blobDirectory);
        await discard(meta);
        await syncDirectory(directory);
        report(total, total, true);
      };

      if (total !== undefined && offset === total) return await finish();
      if (request.method === 'GET') {
        if (total === undefined) return json(response, 404, { error: 'upload_missing' });
        return report(offset, total, false);
      }

      if (start !== offset || (total !== undefined && total !== requestedTotal)) return offsetMismatch(offset, total ?? requestedTotal);

      const data = Buffer.allocUnsafe(length);
      let count = 0;
      for await (const chunk of request) {
        if (count + chunk.length > length) {
          // Drain the remaining body and reject it without publishing any bytes.
          count = length + 1;
          continue;
        }
        chunk.copy(data, count);
        count += chunk.length;
      }
      if (count !== length) return json(response, 400, { error: 'invalid_chunk_length' });

      if (total === undefined) {
        total = requestedTotal;
        await mkdir(directory, { recursive: true });
        await syncDirectory(root);
        await atomicJson(meta, total);
      }

      const handle = await open(part, 'a');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally { await handle.close(); }
      if (offset === 0) await syncDirectory(directory);
      const nextOffset = offset + length;
      if (nextOffset === total) return await finish();
      report(nextOffset, total, false);
    } finally {
      active.delete(hash);
    }
  };
}
