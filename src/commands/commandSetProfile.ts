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
        app.state.profile = definedProfile;
      } else {
        app.state.profile = null;
        logger.warn(`try to set a unknown profile "${definedProfile}"`);
      }
      return;
    }

    const item = await vscode.window.showQuickPick(profiles, { placeHolder: 'select a profile' });
    if (item === undefined) return;
    app.state.profile = item.value;
  },
});
