import { COMMAND_STOP_WORKTREE_SYNC } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { stopSyncing } from '../modules/worktreeSync';
import { whichConnection } from './commandSyncWorktree';

export default checkCommand({
  id: COMMAND_STOP_WORKTREE_SYNC,

  async handleCommand(hint: any) {
    const service = await whichConnection(hint);
    if (service) {
      await stopSyncing(service);
    }
  },
});
