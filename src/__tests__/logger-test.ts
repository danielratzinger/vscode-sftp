const printed: string[] = [];

jest.mock('../ui/output', () => ({
  print: (...args: any[]) => printed.push(args.join(' ')),
}));
jest.mock('../modules/ext', () => ({
  getExtensionSetting: () => ({ debug: false, printDebugLog: false }),
}));

import logger, { currentConnection, withConnection } from '../logger';

const said = () => printed.map(line => line.replace(/^\[[^\]]+\] /, ''));

beforeEach(() => {
  printed.length = 0;
});

describe('naming the connection a line is about', () => {
  it('leaves a line alone when nothing says whose it is', () => {
    logger.info('connected');

    expect(said()).toEqual(['[info] connected']);
  });

  it('names every level inside a connection', () => {
    withConnection('staging', () => {
      logger.info('connected');
      logger.warn('the clock is off');
      logger.error('gone');
    });

    expect(said()).toEqual([
      '[info:staging] connected',
      '[warn:staging] the clock is off',
      '[error:staging] gone',
    ]);
  });

  it('carries the name across an await, into a callback', async () => {
    await withConnection('live', async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      // Where these lines really come from: a socket event, several turns
      // removed from anything holding the configuration.
      await new Promise<void>(resolve =>
        setImmediate(() => {
          logger.info('226 transfer complete');
          resolve();
        })
      );
    });

    expect(said()).toEqual(['[info:live] 226 transfer complete']);
  });

  it('keeps two connections apart while both are working', async () => {
    const work = (name: string, pause: number) =>
      withConnection(name, async () => {
        await new Promise(resolve => setTimeout(resolve, pause));
        logger.info('listed');
      });

    await Promise.all([work('staging', 10), work('live', 1)]);

    expect(said()).toEqual(['[info:live] listed', '[info:staging] listed']);
  });

  it('keeps the outer name when something inside offers another', () => {
    // The pool names the connection it opened; the command names the
    // connection the user asked for, and two configurations can share one
    // connection. The command is the one that answers "whose was this".
    withConnection('by name', () => {
      withConnection('by host', () => logger.info('listed'));
    });

    expect(said()).toEqual(['[info:by name] listed']);
  });

  it('names lines from a logger bound to a connection, anywhere', () => {
    logger.for('watcher').info('uploading');

    expect(said()).toEqual(['[info:watcher] uploading']);
    expect(currentConnection()).toBeUndefined();
  });

  it('prints raw lines without a level at all', () => {
    logger.log('------ Upload Changed Files Result ------');

    expect(said()).toEqual(['------ Upload Changed Files Result ------']);
  });
});
