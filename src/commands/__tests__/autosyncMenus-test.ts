import * as fs from 'fs';
import * as path from 'path';

/**
 * Where "the autosynced folder" is offered. It names a different place only
 * while a connection deploys a folder other than this window's own, so every
 * menu that shows it has to ask that - in the palette, the Remote Explorer and
 * the file explorer alike.
 */
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')
);
const menus = manifest.contributes.menus;
const AWAY_COMMANDS = [
  'sftp.autosyncOpenWindow',
  'sftp.autosyncReveal.mac',
  'sftp.autosyncReveal.windows',
  'sftp.autosyncReveal.linux',
];

function entries(menu: string, command: string) {
  return (menus[menu] || []).filter((one: any) => one.command === command);
}

describe('the autosynced folder, in the menus', () => {
  it('is a command with a title', () => {
    const declared = manifest.contributes.commands.map((one: any) => one.command);
    AWAY_COMMANDS.forEach(command => expect(declared).toContain(command));
  });

  it('is offered in the file explorer and the Remote Explorer', () => {
    expect(entries('explorer/context', 'sftp.autosyncOpenWindow')).toHaveLength(1);
    expect(entries('view/item/context', 'sftp.autosyncOpenWindow')).toHaveLength(1);
    expect(entries('explorer/context', 'sftp.autosyncReveal.mac')).toHaveLength(1);
  });

  it('only while the folder synced is not this window’s own', () => {
    AWAY_COMMANDS.forEach(command => {
      ['commandPalette', 'explorer/context', 'view/item/context'].forEach(menu => {
        entries(menu, command).forEach((one: any) =>
          expect(one.when).toMatch(/autosyncAwayPaths|autosyncElsewhere|-autosyncaway/)
        );
      });
    });
  });

  // At the top, with the editor's own ways of revealing a folder, rather than
  // down among the transfer commands.
  it('sits at the top of the menu, beside the other reveals', () => {
    ['explorer/context', 'view/item/context'].forEach(menu =>
      AWAY_COMMANDS.forEach(command =>
        entries(menu, command).forEach((one: any) =>
          expect(String(one.group)).toMatch(/^navigation/)
        )
      )
    );
  });
});
