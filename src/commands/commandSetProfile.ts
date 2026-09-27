import * as vscode from 'vscode';
import { COMMAND_SET_PROFILE } from '../constants';
import { showInformationMessage } from '../host';
import app from '../app';
import logger from '../logger';
import { getAllFileService } from '../modules/serviceManager';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_SET_PROFILE,

  async handleCommand(definedProfile) {
    // One entry per name, with the connections it belongs to beside it. Two
    // contexts may name their profiles differently - `dev1` and `dev2` - and
    // then which is which is the whole question. Two that share a name are one
    // choice, not the same choice twice.
    const whoHasIt = new Map<string, string[]>();
    getAllFileService().forEach(service => {
      service.getAvailableProfiles().forEach(profile => {
        const held = whoHasIt.get(profile) || [];
        held.push(service.name || service.baseDir);
        whoHasIt.set(profile, held);
      });
    });

    const named = Array.from(whoHasIt.keys()).length > 1;
    const profiles: Array<vscode.QuickPickItem & { value: string | null }> = [
      { value: null, label: 'UNSET' },
      ...Array.from(whoHasIt.entries()).map(([profile, services]) => ({
        value: profile,
        label: app.state.profile === profile ? `${profile} (active)` : profile,
        description: named ? services.join(', ') : undefined,
      })),
    ];

    if (profiles.length <= 1) {
      showInformationMessage('No Available Profile.');
      return;
    }

    if (definedProfile !== undefined) {
      const index = profiles.findIndex(a => a.value === definedProfile);
      if (index !== -1) {
        settle(definedProfile);
      } else {
        settle(null);
        logger.warn(`try to set a unknown profile "${definedProfile}"`);
      }
      return;
    }

    const item = await vscode.window.showQuickPick(profiles, { placeHolder: 'select a profile' });
    if (item === undefined) return;
    settle(item.value);
  },
});

/**
 * Takes the choice, and tells the parts of the extension that were told once and
 * not since.
 *
 * `uploadOnSave` needs nothing: it is read on every save, so it follows the
 * profile by itself. A watcher is *installed*, and the Remote Explorer holds a
 * tree built from a host and a remote path that the new profile may have changed
 * - both would otherwise go on as they were until the next time `sftp.json` was
 * saved. Switching to the profile that deploys to production is precisely when
 * neither should.
 */
function settle(profile: string | null): void {
  app.state.profile = profile;

  getAllFileService().forEach(service => service.refreshWatcher());
  app.remoteExplorer.refresh();
}
