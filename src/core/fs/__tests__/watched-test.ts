const printed: string[] = [];

jest.mock('../../../ui/output', () => ({
  print: (...args: any[]) => printed.push(args.join(' ')),
}));
jest.mock('../../../modules/ext', () => ({
  getExtensionSetting: () => ({ debug: false, printDebugLog: false }),
}));

import logger from '../../../logger';
import { watched } from '../watched';

const said = () => printed.map(line => line.replace(/^\[[^\]]+\] /, ''));

beforeEach(() => {
  printed.length = 0;
});

/** A file system that logs the way the real ones do: from a later turn. */
function fakeFs(fail?: Error) {
  return {
    name: 'plain value',
    async list(dir: string) {
      await new Promise(resolve => setTimeout(resolve, 1));
      logger.info(`listed ${dir}`);
      if (fail) {
        throw fail;
      }
      return ['one.php'];
    },
    end() {
      return 'ended';
    },
  };
}

describe('the watched file system', () => {
  it('names what its calls log, however deep', async () => {
    const fs = watched(fakeFs(), { name: 'staging' });

    await expect(fs.list('/srv')).resolves.toEqual(['one.php']);
    expect(said()).toEqual(['[info:staging] listed /srv']);
  });

  it('passes values and plain returns straight through', () => {
    const fs = watched(fakeFs(), { name: 'staging' });

    expect(fs.name).toBe('plain value');
    expect(fs.end()).toBe('ended');
  });

  it('reads the same method as the same function every time', () => {
    const fs = watched(fakeFs(), { name: 'staging' });

    // Anything that unsubscribes what it subscribed depends on this.
    expect(fs.list).toBe(fs.list);
  });

  it('reports a failure without swallowing it', async () => {
    const trouble = new Error('connection reset');
    const seen: any[] = [];
    const fs = watched(fakeFs(trouble), {
      name: 'staging',
      onTrouble: error => seen.push(error),
    });

    await expect(fs.list('/srv')).rejects.toThrow('connection reset');
    expect(seen).toEqual([trouble]);
  });

  it('works unnamed, for a connection nobody named', async () => {
    const fs = watched(fakeFs(), {});

    await fs.list('/srv');
    expect(said()).toEqual(['[info] listed /srv']);
  });
});
