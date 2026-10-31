import { createFileSyncServer } from '../src/index.js';
import { token, prefix, policies } from './helpers.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

try {
  const service = await createFileSyncServer({ root: process.argv[2], token, routePrefix: prefix, ...policies });
  // Fault injection exists only in this disposable subprocess, never in the runtime API.
  if (process.argv[3]) {
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      await rename(from, to);
      if (path.basename(to) === 'state.json') {
        if (process.argv[3] === 'crash-after-state-rename') process.kill(process.pid, 'SIGKILL');
        else throw Object.assign(new Error('Injected post-rename I/O failure'), { code: 'EIO' });
      }
    };
    syncBuiltinESMExports();
  }
  service.server.listen(0, '127.0.0.1', () => process.send({ port: service.server.address().port }));
  process.on('message', async message => {
    if (message === 'close') { await service.close(); process.exit(0); }
  });
} catch (error) {
  process.send({ error: error.message });
  process.exitCode = 1;
  process.disconnect();
}
