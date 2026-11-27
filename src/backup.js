import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, stat, lstat, open, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DAY = 86400000;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[0-9]{13}-[a-f0-9-]{36}$/;
export const lifecycleDefaults = {
  backup: { enabled: true, schedule: '04:00', compression: true, verify: true,
    retention: { daily: 7, weekly: 4, monthly: 3 }, maxStorageGiB: 20,
    upgrade: { keepLast: 1, retentionDays: 7 } },
  history: { maxRevisions: 100, retentionDays: 30, receiptMaxPerDevice: 1000 },
  garbageCollection: { enabled: true, intervalHours: 24, gracePeriodHours: 24 },
};

export function lifecyclePolicy(value = {}) {
  const d = lifecycleDefaults;
  const p = {
    backup: { ...d.backup, ...value.backup,
      retention: { ...d.backup.retention, ...value.backup?.retention },
      upgrade: { ...d.backup.upgrade, ...value.backup?.upgrade } },
    history: { ...d.history, ...value.history },
    garbageCollection: { ...d.garbageCollection, ...value.garbageCollection },
  };
  for (const [key, n] of Object.entries({ ...p.backup.retention, ...p.backup.upgrade, ...p.history }))
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid lifecycle ${key}`);
  for (const [key, n] of Object.entries({ maxStorageGiB: p.backup.maxStorageGiB, ...p.garbageCollection })) {
    if (key === 'enabled') continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`Invalid lifecycle ${key}`);
  }
  for (const b of [p.backup.enabled, p.backup.compression, p.backup.verify, p.garbageCollection.enabled])
    if (typeof b !== 'boolean') throw new Error('Invalid lifecycle boolean');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.backup.schedule)) throw new Error('Invalid backup schedule');
  // A verified recovery point is required before old recovery points can be removed.
  if (!p.backup.verify) throw new Error('Backup verification cannot be disabled');
  return p;
}

export async function atomicMetadata(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    const f = await open(tmp, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
    await rename(tmp, file);
    if (process.platform !== 'win32') {
      const dir = await open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

export async function regularFiles(directory, pattern) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const files = [];
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    const file = path.join(directory, entry.name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unexpected non-regular lifecycle file');
    files.push({ name: entry.name, file, size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

function validName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes(':') &&
    !name.includes('\0') && !name.startsWith('/') && name.split('/').every(p => p && p !== '.' && p !== '..');
}

function checkSnapshot(s) {
  if (s?.format !== 1 || !ID.test(s.id) || !Number.isFinite(s.createdAt) || !s.files ||
      typeof s.files !== 'object' || Array.isArray(s.files)) throw new Error('Invalid backup snapshot');
  for (const [name, f] of Object.entries(s.files)) {
    if (!validName(name) || !HASH.test(f.hash) || !Number.isSafeInteger(f.size) || f.size < 0 ||
        typeof f.compressed !== 'boolean') throw new Error('Invalid backup file');
  }
  return s;
}

const objectName = f => f.hash + (f.compressed ? '.gz' : '.raw');
const digest = text => createHash('sha256').update(text).digest('hex');

/** Incremental, immutable object pool, independent of the live blob/history pool. */
export class BackupRepository {
  constructor(root, policy = lifecyclePolicy().backup) { this.root = path.resolve(root); this.policy = policy; }
  async initialize() {
    await mkdir(path.join(this.root, 'objects'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'snapshots'), { recursive: true, mode: 0o700 });
  }
  async locked(action) {
    await this.initialize();
    const file = path.join(this.root, 'repository.lock');
    const claim = file + '.claim';
    await mkdir(claim);
    let lock;
    try {
      try { lock = await open(file, 'wx', 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = Number(await readFile(file, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid backup repository lock');
        try { process.kill(pid, 0); throw new Error('Backup repository is in use'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        await unlink(file); lock = await open(file, 'wx', 0o600);
      }
      await lock.writeFile(String(process.pid));
    } finally { await rmdir(claim); }
    try { return await action(); }
    finally { await lock.close(); await unlink(file); }
  }
  async snapshots() {
    const result = [];
    for (const f of await regularFiles(path.join(this.root, 'snapshots'), /^[0-9]{13}-[a-f0-9-]{36}\.json$/)) {
      const s = checkSnapshot(JSON.parse(await readFile(f.file, 'utf8')));
      if (s.id + '.json' !== f.name) throw new Error('Backup identity mismatch');
      result.push(s);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }
  async verify(snapshot, destination) {
    checkSnapshot(snapshot);
    for (const [name, f] of Object.entries(snapshot.files)) {
      const source = path.join(this.root, 'objects', objectName(f));
      if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink()) throw new Error('Invalid backup object');
      const hash = createHash('sha256'); let size = 0;
      let output = new Writable({ write(chunk, _, cb) { cb(); } });
      if (destination) {
        const target = path.join(destination, name);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
      }
      const meter = new Transform({ transform(chunk, _, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
      await pipeline(createReadStream(source), ...(f.compressed ? [createGunzip()] : []), meter, output);
      if (size !== f.size || hash.digest('hex') !== f.hash) throw new Error('Backup integrity verification failed');
    }
    return true;
  }
  async snapshot(sources, { now = Date.now(), pinned = false, metadata = {} } = {}) {
    return this.locked(async () => {
      const files = {};
      for (const [name, input] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
        if (!validName(name)) throw new Error('Invalid backup logical path');
        const source = typeof input === 'string' ? input : input.file;
        if (typeof input === 'object' && HASH.test(input.hash)) {
          const info = await lstat(source);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid immutable backup source');
          const cached = { hash: input.hash, size: info.size, compressed: this.policy.compression };
          try { await stat(path.join(this.root, 'objects', objectName(cached))); files[name] = cached; continue; }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        const hash = createHash('sha256'); let size = 0;
        const temporary = path.join(this.root, 'objects', randomUUID() + '.tmp');
        const meter = new Transform({ transform(chunk, _, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
        try {
          const info = await lstat(source);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup source must be a regular file');
          await pipeline(createReadStream(source), meter, ...(this.policy.compression ? [createGzip()] : []),
            createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
          const f = { hash: hash.digest('hex'), size, compressed: this.policy.compression };
          const target = path.join(this.root, 'objects', objectName(f));
          try { await stat(target); } catch (e) { if (e.code !== 'ENOENT') throw e; await rename(temporary, target); }
          files[name] = f;
        } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      }
      if (!Object.keys(files).length) throw new Error('Refusing an empty recovery snapshot');
      const fingerprint = digest(JSON.stringify(files));
      const latest = (await this.snapshots())[0];
      if (latest?.fingerprint === fingerprint && !pinned) {
        await this.verify(latest);
        return { status: 'unchanged', id: latest.id };
      }
      const snapshot = { format: 1, id: `${Math.floor(now)}-${randomUUID()}`, createdAt: now,
        pinned, metadata, fingerprint, files };
      await this.verify(snapshot);
      await atomicMetadata(path.join(this.root, 'snapshots', snapshot.id + '.json'), snapshot);
      return { status: 'created', id: snapshot.id };
    });
  }
  async plan(now = Date.now()) {
    const snapshots = await this.snapshots(), keep = new Set();
    if (snapshots[0]) keep.add(snapshots[0].id);
    const buckets = { daily: new Set(), weekly: new Set(), monthly: new Set() };
    for (const s of snapshots) {
      if (s.pinned) keep.add(s.id);
      const d = new Date(s.createdAt), date = d.toISOString().slice(0, 10);
      const keys = { daily: date, weekly: Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY + 3) / 7),
        monthly: date.slice(0, 7) };
      for (const kind of Object.keys(buckets)) {
        const ageLimit = { daily: 7, weekly: 28, monthly: 93 }[kind] * (this.policy.retention[kind] / { daily: 7, weekly: 4, monthly: 3 }[kind]);
        if (now - s.createdAt <= ageLimit * DAY && buckets[kind].size < this.policy.retention[kind] && !buckets[kind].has(keys[kind])) {
          buckets[kind].add(keys[kind]); keep.add(s.id);
        }
      }
    }
    const objects = await regularFiles(path.join(this.root, 'objects'), /^[a-f0-9]{64}\.(gz|raw)$/);
    const sizes = new Map(objects.map(f => [f.name, f.size]));
    const used = () => {
      const refs = new Set(snapshots.filter(s => keep.has(s.id)).flatMap(s => Object.values(s.files).map(objectName)));
      for (const ref of refs) if (!sizes.has(ref)) throw new Error('Missing retained backup object');
      return { refs, bytes: [...refs].reduce((n, r) => n + sizes.get(r), 0) };
    };
    let storage = used();
    const cap = this.policy.maxStorageGiB * 1024 ** 3;
    // Capacity overrides calendar representatives, never the newest or a pinned snapshot.
    for (const s of [...snapshots].reverse()) {
      if (storage.bytes <= cap) break;
      if (s === snapshots[0] || s.pinned || !keep.has(s.id)) continue;
      keep.delete(s.id); storage = used();
    }
    const removeSnapshots = snapshots.filter(s => !keep.has(s.id));
    const removeObjects = objects.filter(f => !storage.refs.has(f.name));
    return { snapshots, keep, removeSnapshots, removeObjects, bytes: objects.reduce((n, f) => n + f.size, 0),
      retainedBytes: storage.bytes, reclaimableBytes: removeObjects.reduce((n, f) => n + f.size, 0),
      overCapacity: storage.bytes > cap };
  }
  async status() {
    const p = await this.plan();
    return { snapshots: p.snapshots.length, pinned: p.snapshots.filter(s => s.pinned).length,
      bytes: p.bytes, reclaimableBytes: p.reclaimableBytes, overCapacity: p.overCapacity,
      latest: p.snapshots[0]?.id ?? null };
  }
  async prune({ dryRun = true, now = Date.now() } = {}) {
    const action = async () => {
      const p = await this.plan(now);
      if (p.snapshots.length) {
        for (const s of p.snapshots) if (p.keep.has(s.id)) await this.verify(s);
      } else if (p.removeObjects.length) throw new Error('No verified recovery point; orphan pruning refused');
      if (!dryRun) {
        for (const s of p.removeSnapshots) await unlink(path.join(this.root, 'snapshots', s.id + '.json'));
        for (const f of p.removeObjects) await unlink(f.file);
      }
      return { dryRun, removeSnapshots: p.removeSnapshots.map(s => s.id), objects: p.removeObjects.length,
        reclaimableBytes: p.reclaimableBytes, retainedBytes: p.retainedBytes, overCapacity: p.overCapacity };
    };
    return dryRun ? action() : this.locked(action);
  }
  async restore(id, destination) {
    if (!ID.test(id)) throw new Error('Invalid snapshot ID');
    return this.locked(async () => {
      const snapshot = checkSnapshot(JSON.parse(await readFile(path.join(this.root, 'snapshots', id + '.json'), 'utf8')));
      await mkdir(destination, { recursive: false, mode: 0o700 });
      await this.verify(snapshot, destination);
      return { restored: id, destination };
    });
  }
}
