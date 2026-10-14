jest.mock('vscode', () => {
  const URI = require('vscode-uri').default;
  const nothing = jest.requireActual('../../../__mocks__/vscode.js');
  const real: { [key: string]: any } = { Uri: URI };
  return new Proxy(real, { get: (t, k: string) => (k in t ? t[k] : nothing[k]) });
}, { virtual: true });

// Through the package, as the command loads it: the handler modules import
// one another, and loading one of them alone finds the others half-built.
import '../../fileHandlers';
import { UResource } from '../../core';
import { resourceFor } from '../../fileHandlers/createFileHandler';

/**
 * What a restore hands the remover for a file that was not on the server
 * before, and has to go again. The remover reads `remoteFsPath`; the bare
 * remote resource a restore used to pass has no such thing.
 */
describe('the target of a removal in a restore', () => {
  const service: any = { id: 7, baseDir: '/work/clockwork' };
  const config: any = {
    host: 'univers.example',
    port: 2121,
    remotePath: '/httpdocs/clockwork.zng7.com',
  };
  const file = '/httpdocs/clockwork.zng7.com/includes/EventCache.php';

  function remoteUri() {
    return UResource.makeResource({
      remote: { host: config.host, port: config.port },
      fsPath: file,
      remoteId: service.id,
    }).uri;
  }

  it('names the file on the server', () => {
    expect(resourceFor(service, config, remoteUri()).remoteFsPath).toBe(file);
  });

  it('names the copy here too', () => {
    expect(resourceFor(service, config, remoteUri()).localFsPath).toBe(
      '/work/clockwork/includes/EventCache.php'
    );
  });

  // What it was given before: a resource with no server path to read.
  it('is not the bare remote resource', () => {
    const bare: any = UResource.makeResource({
      remote: { host: config.host, port: config.port },
      fsPath: file,
      remoteId: service.id,
    });
    expect(bare.remoteFsPath).toBeUndefined();
  });
});
