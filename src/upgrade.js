import path from 'node:path';
import { readdir, readFile, lstat, rm } from 'node:fs/promises';
import { atomicMetadata } from './backup.js';

/** Only self-described, verified rollback directories are eligible, never arbitrary old folders. */
export async function pruneUpgrades(directory, policy, { dryRun = true, now = Date.now() } = {}) {
  let names;
  try { names = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') return { dryRun, remove: [], pending: [] }; throw e; }
  const records = [];
  for (const name of names) {
    if (!/^upgrade-[\w-]+$/.test(name)) continue;
    const folder = path.join(directory, name);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid upgrade directory');
    const receipt = JSON.parse(await readFile(path.join(folder, 'upgrade.json'), 'utf8'));
    if (receipt.format !== 1 || !Number.isFinite(receipt.createdAt)) throw new Error('Invalid upgrade receipt');
    records.push({ folder, ...receipt });
  }
  records.sort((a, b) => b.createdAt - a.createdAt);
  let recent = 0;
  const remove = [], pending = [];
  for (const r of records) {
    if (!Number.isFinite(r.verifiedAt)) { pending.push(r.folder); continue; }
    if (recent++ >= policy.keepLast || now - r.verifiedAt >= policy.retentionDays * 86400000) remove.push(r.folder);
  }
  if (!dryRun) for (const folder of remove) await rm(folder, { recursive: true });
  return { dryRun, remove, pending };
}

export async function verifyUpgrade(directory) {
  const file = path.join(directory, 'upgrade.json');
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  if (receipt.format !== 1 || !Number.isFinite(receipt.createdAt)) throw new Error('Invalid upgrade receipt');
  await atomicMetadata(file, { ...receipt, verifiedAt: Date.now() });
  return { verified: directory };
}
