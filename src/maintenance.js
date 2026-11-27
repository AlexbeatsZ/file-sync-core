import path from 'node:path';
import { readFile, unlink, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { BackupRepository, lifecyclePolicy, atomicMetadata, regularFiles } from './backup.js';
import { pruneUpgrades } from './upgrade.js';

const DAY = 86400000;
const HASH = /^[a-f0-9]{64}$/;
const refs = manifest => Object.values(manifest.files).filter(f => f.hash).map(f => f.hash);

export function createMaintenance({ root, configuration, getState, replaceState, checkManifest, pins }) {
  const policy = lifecyclePolicy(configuration);
  const backupRoot = path.resolve(configuration?.backup?.directory ?? root + '-backups');
  const relative = path.relative(root, backupRoot), reverse = path.relative(backupRoot, root);
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) ||
      !reverse.startsWith('..' + path.sep) && reverse !== '..' && !path.isAbsolute(reverse))
    throw new Error('Backup directory must be separate from live data');
  const repository = new BackupRepository(backupRoot, policy.backup);
  let last = null;
  let lastGc = 0;
  let lastBackupDay = '';
  const stateFile = path.join(root, 'lifecycle.json');
  const ready = readFile(stateFile, 'utf8').then(text => {
    const state = JSON.parse(text); lastGc = state.lastGc ?? 0; lastBackupDay = state.lastBackupDay ?? ''; last = state.last ?? null;
  }).catch(e => { if (e.code !== 'ENOENT') throw e; });

  async function inventory(now = Date.now()) {
    await ready;
    const state = getState(), history = [];
    for (const f of await regularFiles(path.join(root, 'history'), /^(0|[1-9][0-9]*)\.json$/)) {
      const manifest = JSON.parse(await readFile(f.file, 'utf8'));
      checkManifest(manifest);
      if (manifest.workspaceId !== state.manifest.workspaceId || manifest.revision + '.json' !== f.name ||
          manifest.revision > state.manifest.revision) throw new Error('Invalid history identity');
      history.push({ ...f, manifest });
    }
    history.sort((a, b) => b.manifest.revision - a.manifest.revision);
    const kept = history.filter((f, i) => i < policy.history.maxRevisions && now - f.mtimeMs <= policy.history.retentionDays * DAY);
    const removed = history.filter(f => !kept.includes(f));
    const current = new Set(refs(state.manifest)), referenced = new Set(current);
    for (const f of kept) for (const hash of refs(f.manifest)) referenced.add(hash);
    const blobs = await regularFiles(path.join(root, 'blobs'), HASH);
    const present = new Map(blobs.map(f => [f.name, f]));
    for (const hash of referenced) if (!present.has(hash)) throw new Error('Retained manifest references a missing blob');
    const candidates = blobs.filter(f => !referenced.has(f.name) && !pins.has(f.name) &&
      now - f.mtimeMs > policy.garbageCollection.gracePeriodHours * 3600000);
    const uploadFiles = await regularFiles(path.join(root, 'uploads'), /^[a-f0-9]{64}\.(part|json)$/);
    const uploadGroups = new Map();
    for (const f of uploadFiles) {
      const hash = f.name.slice(0, 64);
      if (!uploadGroups.has(hash)) uploadGroups.set(hash, []);
      uploadGroups.get(hash).push(f);
    }
    const staleUploads = [...uploadGroups].filter(([hash, files]) => !pins.has(hash) &&
      files.every(f => now - f.mtimeMs > policy.garbageCollection.gracePeriodHours * 3600000)).flatMap(([, files]) => files);
    const receiptGroups = new Map();
    for (const [key, value] of Object.entries(state.receipts)) {
      const device = key.split(':')[0];
      if (!receiptGroups.has(device)) receiptGroups.set(device, []);
      receiptGroups.get(device).push({ key, ...value });
    }
    const expiredReceipts = [];
    for (const group of receiptGroups.values()) {
      group.sort((a, b) => b.receipt.revision - a.receipt.revision);
      for (let i = 0; i < group.length; i++) {
        const r = group[i];
        if (i >= policy.history.receiptMaxPerDevice || r.createdAt && now - r.createdAt > policy.history.retentionDays * DAY)
          expiredReceipts.push(r.key);
      }
    }
    return { state, history, removed, kept, blobs, current, referenced, candidates, expiredReceipts, staleUploads };
  }
  async function status() {
    const i = await inventory();
    const sizes = new Map(i.blobs.map(f => [f.name, f.size]));
    return { policy, revision: i.state.manifest.revision,
      currentBytes: [...i.current].reduce((n, h) => n + sizes.get(h), 0),
      historyBytes: i.blobs.filter(f => !i.current.has(f.name)).reduce((n, f) => n + f.size, 0),
      blobBytes: i.blobs.reduce((n, f) => n + f.size, 0), historyRevisions: i.history.length,
      retainedRevisions: i.kept.length, reclaimableBytes: i.candidates.reduce((n, f) => n + f.size, 0),
      receipts: Object.keys(i.state.receipts).length, expiredReceipts: i.expiredReceipts.length,
      staleUploadBytes: i.staleUploads.reduce((n, f) => n + f.size, 0),
      backup: await repository.status(), last };
  }
  async function backup() {
    const state = structuredClone(getState());
    const staging = path.join(backupRoot, 'staging');
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const statePath = path.join(staging, 'state.json');
    try {
      await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
      const sources = { 'state.json': statePath };
      for (const hash of new Set(refs(state.manifest))) sources[`blobs/${hash}`] = { file: path.join(root, 'blobs', hash), hash };
      const result = await repository.snapshot(sources, { metadata: { workspaceId: state.manifest.workspaceId, revision: state.manifest.revision } });
      const rotation = await repository.prune({ dryRun: false });
      if (rotation.overCapacity) throw new Error('backup_capacity_exceeded: latest or pinned backups exceed limit');
      return { ...result, rotation };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async function cleanup(dryRun = true) {
    const i = await inventory();
    // Verify a current recovery point BEFORE removing history or blobs.
    if (!dryRun) await backup();
    const result = { dryRun, manifests: i.removed.length, blobs: i.candidates.length,
      uploads: i.staleUploads.length,
      receipts: i.expiredReceipts.length, reclaimableBytes: i.candidates.reduce((n, f) => n + f.size, 0) };
    if (!dryRun) {
      if (i.expiredReceipts.length) {
        const next = structuredClone(getState());
        for (const key of i.expiredReceipts) delete next.receipts[key];
        await replaceState(next);
      }
      // Crash order: remove obsolete manifests before unreferenced objects.
      for (const f of i.removed) await unlink(f.file);
      for (const f of i.staleUploads) if (!pins.has(f.name.slice(0, 64))) await unlink(f.file);
      for (const f of i.candidates) {
        if (pins.has(f.name)) continue;
        // Ingress is gated by the caller throughout this maintenance transaction.
        if (Date.now() - (await stat(f.file)).mtimeMs <= policy.garbageCollection.gracePeriodHours * 3600000) continue;
        await unlink(f.file);
      }
    }
    result.upgrade = await pruneUpgrades(configuration?.backup?.upgrade?.directory ?? root + '-upgrades', policy.backup.upgrade, { dryRun });
    return result;
  }
  async function run(action, dryRun = true) {
    await ready;
    try {
      const result = action === 'status' ? await status() : action === 'cleanup' ? await cleanup(dryRun) :
        action === 'backup' ? dryRun ? { dryRun, ...(await repository.status()) } : await backup() :
        (() => { throw new Error('Invalid maintenance action'); })();
      if (action !== 'status' && !dryRun) {
        last = { at: Date.now(), action, ok: true, result };
        if (action === 'cleanup') lastGc = Date.now();
        lastBackupDay = new Date().toLocaleDateString('en-CA');
        await atomicMetadata(stateFile, { lastGc, lastBackupDay, last });
      }
      return result;
    } catch (e) {
      last = { at: Date.now(), action, ok: false, error: e.message };
      await atomicMetadata(stateFile, { lastGc, lastBackupDay, last });
      throw e;
    }
  }
  async function due() {
    await ready;
    const now = new Date(), day = now.toLocaleDateString('en-CA');
    if (last?.ok === false && now.getTime() - last.at < 3600000) return null;
    if (policy.garbageCollection.enabled && now.getTime() - lastGc >= policy.garbageCollection.intervalHours * 3600000) return 'cleanup';
    if (policy.backup.enabled && day !== lastBackupDay &&
        now.toTimeString().slice(0, 5) >= policy.backup.schedule) return 'backup';
    return null;
  }
  return { run, due, repository, policy, ready };
}
