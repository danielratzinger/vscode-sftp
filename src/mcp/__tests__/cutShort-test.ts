jest.mock('fs');

import { vol } from 'memfs';
import { createDispatcher } from '../protocol';
import { createTools, ToolContext } from '../tools';
import { ServiceLike } from '../exposure';
import { FileType } from '../../core/fs';

/**
 * A walk too slow to finish must come back with what it found, not with an
 * error. That is what the budget is for - "partial results answer the question
 * better than an error does" - but a looping tool only notices its time is up
 * *between* round trips, so it stops a moment after the deadline rather than
 * before it. Hand the tool and the dispatcher's backstop the same ceiling and
 * the backstop always wins, and the model is told to ask for less instead of
 * being given the matches that were already in hand.
 */

const SERVICE: ServiceLike = {
  id: 1,
  name: 'Staging',
  workspace: '/work/site',
  baseDir: '/work/site',
  getConfig: () => ({
    name: 'Staging',
    protocol: 'sftp',
    host: 'staging.example.com',
    port: 22,
    remotePath: '/srv/app',
  }),
};

const CALL_TIMEOUT = 2000;
const PER_LIST = 100;

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

const file = (dir: string, name: string) => ({
  name,
  fspath: `${dir}/${name}`,
  type: FileType.File,
  size: 20,
  mtime: 1,
  atime: 1,
  mode: 0o644,
});

const folder = (dir: string, name: string) => ({
  ...file(dir, name),
  type: FileType.Directory,
  size: 0,
  mode: 0o755,
});

/**
 * A broad tree whose every listing costs a round trip: more directories than
 * the budget can pay for, but finite, so a run that ignored the budget would
 * end rather than hang the suite.
 */
const remote = {
  async list(dir: string) {
    await wait(PER_LIST);
    return [
      file(dir, 'a.php'),
      folder(dir, 's0'),
      folder(dir, 's1'),
      folder(dir, 's2'),
      folder(dir, 's3'),
    ];
  },
  async lstat() {
    return { type: FileType.File, size: 20, mtime: 1 };
  },
  async readFile() {
    return 'nothing to find here';
  },
};

// Wired the way the extension wires it: one ceiling, read by the tools and by
// the dispatcher behind them.
const callTimeout = () => CALL_TIMEOUT;

const context: ToolContext = {
  services: () => [SERVICE],
  exposure: () => ({ exposedByDefault: true }),
  cacheOption: () => ({ cacheRoot: '/cache' }),
  remoteFs: async () => remote as any,
  callTimeout,
};

beforeEach(() => vol.reset());

it('answers a search it could not finish with what it found', async () => {
  const dispatcher = createDispatcher(
    { name: 'test', version: '1', instructions: '' },
    () => createTools(context) as any,
    { callTimeout }
  );

  const response: any = await dispatcher.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search', arguments: { server: 'Staging', query: 'mastermind' } },
  });

  const text = response.result.content[0].text;
  expect(text).not.toContain('was stopped');
  expect(response.result.isError).toBeFalsy();
  expect(text).toContain('ran out of time');
});
