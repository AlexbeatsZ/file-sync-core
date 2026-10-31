// MIT, Copyright (c) 2026 xnohat and AlexbeatsZ. Pinned source in provenance.json.
export const prefix = '/webobsidian-sync/v1';
export const defaultPort = 18744;
export const hashPattern = /^[a-f0-9]{64}(?![\s\S])/;
export const idPattern = /^[A-Za-z0-9_-]{16,80}(?![\s\S])/;
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const excluded = new Set(['.git', '.trash', '.stfolder', '.stversions', '.stignore', 'node_modules', '__proto__', 'prototype', 'constructor']);

export function validPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\\\x00-\x1f\x7f:<>"|?*]/.test(value)) return false;
  const parts = value.split('/');
  if (parts[0].toLowerCase() === '.obsidian' && parts[1] !== 'webobsidian') return false;
  return parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !reserved.test(part) && !excluded.has(part.toLowerCase()) && !/\.(tmp|previous)$|\.tmp-|\.sync-conflict-/i.test(part));
}

export function validateManifest(manifest) {
  if (!manifest || !idPattern.test(manifest.workspaceId) || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid sync manifest');
  const names = new Set();
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (!validPath(name) || names.has(name.toLowerCase()) || !entry || !Number.isSafeInteger(entry.version) || entry.version <= 0 ||
        entry.version > manifest.revision || entry.hash !== null && !hashPattern.test(entry.hash)) throw new Error('Invalid sync entry');
    names.add(name.toLowerCase());
  }
  const files = new Set(Object.entries(manifest.files).filter(([, entry]) => entry.hash !== null).map(([name]) => name.toLowerCase()));
  for (const name of files) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (files.has(parts.join('/'))) throw new Error('Sync file/directory collision'); parts.pop(); }
  }
}
