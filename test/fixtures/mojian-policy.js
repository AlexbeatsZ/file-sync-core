// MIT, Copyright (c) 2026 AlexbeatsZ. Pinned source in provenance.json.
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
export function validPath(value) {
  return typeof value === 'string' && value.length < 500 &&
    (value === 'library.json' || /^notebooks\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/(pages\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.json|assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*)$/.test(value)) &&
    !value.endsWith('.previous') && !value.endsWith('.tmp') && !value.includes('-sync-conflict-') &&
    value.split('/').every(component => !component.endsWith('.') && !reserved.test(component)) && !/[\r\n]/.test(value);
}
