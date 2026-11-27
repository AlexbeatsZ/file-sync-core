import path from 'node:path';
import { BackupRepository, lifecyclePolicy } from './backup.js';
import { pruneUpgrades, verifyUpgrade, prepareUpgrade } from './upgrade.js';

/** Product wrappers supply credentials and the original private endpoint, never command-line tokens. */
export async function lifecycleCli({ root, token, baseUrl, configuration = {}, configFile }, args) {
  const [command = 'status', ...rest] = args;
  const policy = lifecyclePolicy(configuration);
  const directory = path.resolve(configuration.backup?.directory ?? root + '-backups');
  const repository = new BackupRepository(directory, policy.backup);
  if (command === 'upgrade-prepare') {
    if (!configFile || rest[0] !== '--current' || !rest[1] ||
        !(rest.length === 2 || rest.length === 4 && rest[2] === '--migration')) throw new Error('upgrade-prepare --current PROGRAM [--migration schema|format|full]');
    return prepareUpgrade({ root, current: rest[1], configFile, directory: configuration.backup?.upgrade?.directory ?? root + '-upgrades', migration: rest[3] ?? 'code' });
  }
  if (command === 'restore') {
    if (rest.length !== 3 || rest[1] !== '--destination') throw new Error('restore ID --destination NEW_DIRECTORY');
    return repository.restore(rest[0], path.resolve(rest[2]));
  }
  if (command === 'backup-list') return (await repository.snapshots()).map(({ id, createdAt, pinned, metadata }) => ({ id, createdAt, pinned, metadata }));
  if (command === 'upgrade-prune') {
    if (rest.some(a => a !== '--apply')) throw new Error('Unexpected argument');
    return pruneUpgrades(configuration.backup?.upgrade?.directory ?? root + '-upgrades', policy.backup.upgrade, { dryRun: !rest.includes('--apply') });
  }
  if (command === 'upgrade-verified') {
    if (rest.length !== 1) throw new Error('upgrade-verified DIRECTORY');
    // Verify the running server before marking its previous program safe to expire.
    const response = await fetch(new URL('manifest', baseUrl), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    if (!response.ok) throw new Error('Running server verification failed');
    const m = await response.json();
    if (!m.workspaceId || !Number.isSafeInteger(m.revision)) throw new Error('Invalid running manifest');
    return verifyUpgrade(path.resolve(rest[0]));
  }
  if (!['status', 'cleanup', 'backup', 'git-backup'].includes(command) || rest.some(a => a !== '--apply')) throw new Error('status|cleanup|backup [--apply]|backup-list|restore ID --destination DIR|upgrade-prune [--apply]');
  const response = await fetch(new URL('maintenance', baseUrl), {
    method: command === 'status' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(command !== 'status' ? { body: JSON.stringify({ action: command, dryRun: !rest.includes('--apply') }) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(3600000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
