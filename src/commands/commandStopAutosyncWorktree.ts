import { COMMAND_STOP_AUTOSYNC_WORKTREE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { stopSyncing } from '../modules/worktreeSync';
import { whichConnection } from './commandAutosyncWorktree';

export default checkCommand({
  id: COMMAND_STOP_AUTOSYNC_WORKTREE,

  async handleCommand(...args: any[]) {
    const service = await whichConnection(...args);
    if (service) {
      await stopSyncing(service);
    }
  },
});
