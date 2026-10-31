import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const archive = path.resolve(process.argv[2]);
const parent = path.join(os.tmpdir(), '.agents');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, 'file-sync-core-package-'));
assert.equal(path.dirname(root), parent);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
try {
  assert(process.env.npm_execpath, 'Run through npm run test:package');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true, type: 'module',
    dependencies: { '@alexbeatsz/file-sync-core': pathToFileURL(archive).href },
  }));
  run(process.execPath, [process.env.npm_execpath, 'install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']);
  run(process.execPath, [process.env.npm_execpath, 'ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']);
  const installed = path.join(root, 'node_modules/@alexbeatsz/file-sync-core');
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@alexbeatsz/file-sync-core');
  assert.equal(metadata.version, '0.1.0');
  assert.equal(metadata.dependencies, undefined);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'provenance.json', 'README.md', 'docs/design/api.md']) {
    assert((await readFile(path.join(installed, file), 'utf8')).length > 0);
  }
  const source = `
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createFileSyncServer,hashPattern,idPattern} from '@alexbeatsz/file-sync-core';
import metadata from '@alexbeatsz/file-sync-core/package.json' with {type:'json'};
assert.equal(metadata.version,'0.1.0');
const service=await createFileSyncServer({
  root:'./isolated-data',token:'isolated-package-test',routePrefix:'/test/v1',
  validPath:name=>name==='document.md',validateManifest(){},
});
try {
  service.server.listen(0,'127.0.0.1'); await once(service.server,'listening');
  const base='http://127.0.0.1:'+service.server.address().port+'/test/v1/';
  const headers={Authorization:'Bearer isolated-package-test'};
  const manifest=await (await fetch(base+'manifest',{headers})).json();
  assert(idPattern.test(manifest.workspaceId));
  assert(hashPattern.test('a'.repeat(64)));
  const body={workspaceId:manifest.workspaceId,deviceId:'package-device-01',operationId:'package-operation-01',
    changes:[{path:'document.md',expectedVersion:0,hash:null}]};
  const response=await fetch(base+'commit',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).revision,1);
} finally {await service.close();}
`;
  await writeFile(path.join(root, 'smoke.mjs'), source);
  run(process.execPath, ['smoke.mjs']);
  console.log(`Package smoke passed: ${metadata.name}@${metadata.version}; offline npm ci, public exports, HTTP commit, notices.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
