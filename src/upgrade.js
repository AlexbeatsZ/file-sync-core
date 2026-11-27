import path from 'node:path';
import { readdir, readFile, lstat, rm, mkdir, cp, realpath, rmdir, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

export async function prepareUpgrade({ root, current, configFile, directory = root + '-upgrades', migration = 'code' }) {
  if (!['code', 'schema', 'format', 'full'].includes(migration)) throw new Error('Invalid migration kind');
  const [data, program, config] = await Promise.all([root, current, configFile].map(f => realpath(path.resolve(f))));
  const inside = (a, b) => { const r = path.relative(a, b); return !r || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
  if (inside(data, program) || inside(program, data) || inside(program, config)) throw new Error('Keep program, config and live data separate');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await realpath(directory);
  if ([data, program].some(r => inside(r, directory) || inside(directory, r))) throw new Error('Invalid upgrade repository location');
  const claim = path.join(data, 'server.lock.claim');
  await mkdir(claim);
  const destination = path.join(directory, `upgrade-${Date.now()}-${randomUUID()}`);
  try {
    try {
      const pid = Number(await readFile(path.join(data, 'server.lock'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid writer lock');
      try { process.kill(pid, 0); throw new Error('Stop the existing sync writer before upgrade preparation'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await mkdir(destination, { mode: 0o700 });
    await cp(program, path.join(destination, 'program'), { recursive: true, force: false, errorOnExist: true });
    await cp(config, path.join(destination, 'server.json'), { force: false, errorOnExist: true });
    await chmod(path.join(destination, 'server.json'), 0o600);
    if (migration !== 'code') await cp(data, path.join(destination, 'data'), { recursive: true,
      filter: f => !/^(server\.lock(?:\.claim)?|backups?|recovery-backups|upgrades)$/i.test(path.basename(f)) });
    await atomicMetadata(path.join(destination, 'upgrade.json'), { format: 1, createdAt: Date.now(), migration, verifiedAt: null });
    return { prepared: destination, migration };
  } catch (e) {
    await rm(destination, { recursive: true, force: true });
    throw e;
  } finally { await rmdir(claim); }
}
