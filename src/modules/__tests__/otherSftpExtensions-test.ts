import {
  activeRivals,
  conflictMessage,
  RIVALS,
} from '../otherSftpExtensions';

describe('activeRivals', () => {
  it('finds another SFTP extension that is running', () => {
    const found = activeRivals(id =>
      id === 'Natizyskunk.sftp' ? { id } : undefined
    );

    expect(found.map(rival => rival.id)).toEqual(['Natizyskunk.sftp']);
  });

  it('says nothing about one that is installed but disabled', () => {
    // `getExtension` returns nothing for a disabled extension, which is the
    // question being asked: a disabled one is harmless.
    expect(activeRivals(() => undefined)).toEqual([]);
  });

  it('finds several at once', () => {
    expect(activeRivals(() => ({}))).toHaveLength(RIVALS.length);
  });
});

describe('conflictMessage', () => {
  it('says what goes wrong, not just that something is installed', () => {
    const message = conflictMessage([{ name: 'SFTP (Natizyskunk)' }]);

    expect(message).toContain('upload twice');
    // The reassuring half: there is nothing to migrate, so disabling the
    // other one costs nothing.
    expect(message).toContain('configuration is shared');
    expect(message).toContain('is enabled');
  });

  it('reads correctly for more than one', () => {
    const message = conflictMessage([{ name: 'A' }, { name: 'B' }]);

    expect(message).toContain('A and B are enabled');
  });
});
