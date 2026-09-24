import { identityOf } from '../connectionIdentity';

/**
 * Two entries in `sftp.json` that reach the same server over the same
 * credentials are one connection. The name is how a person tells them apart and
 * where their password is filed; it is not a different server.
 */

const SERVER = {
  protocol: 'sftp',
  host: 'univers.metanet.ch',
  port: 2121,
  username: 'ratzing',
  password: true,
};

describe('which configurations are the same connection', () => {
  it('is the same server whatever the connection is called', () => {
    // Each name opening a socket of its own is what had one server answering
    // two keepalives every thirty seconds, for ever.
    expect(identityOf({ ...SERVER, connectionName: 'founders.co.at' })).toBe(
      identityOf({ ...SERVER, connectionName: 'founders.co.at (old)' })
    );
  });

  it('is the same whether a name was given at all', () => {
    // The disposal path never sets one, so a mismatch here meant nothing was
    // ever found to be ended: saving sftp.json leaked a live connection.
    expect(identityOf({ ...SERVER, connectionName: 'anything' })).toBe(
      identityOf(SERVER)
    );
  });

  it('keeps another login apart', () => {
    expect(identityOf(SERVER)).not.toBe(
      identityOf({ ...SERVER, username: 'kellerh' })
    );
  });

  it('keeps another port apart', () => {
    expect(identityOf(SERVER)).not.toBe(identityOf({ ...SERVER, port: 22 }));
  });

  it('does not depend on the order the option was built in', () => {
    expect(identityOf({ host: 'a', port: 22 })).toBe(
      identityOf({ port: 22, host: 'a' })
    );
  });

  it('does not run two values together', () => {
    // Joining values alone made these one connection.
    expect(identityOf({ host: 'ex', username: 'ample' })).not.toBe(
      identityOf({ host: 'exam', username: 'ple' })
    );
  });

  it('treats a value that was left out as left out', () => {
    expect(identityOf({ host: 'a', port: undefined })).toBe(
      identityOf({ host: 'a' })
    );
  });
});
