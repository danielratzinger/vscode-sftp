import { COMMAND_STOP_CONTINUOUS_SYNC } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { stopSyncing } from '../modules/worktreeSync';
import { whichConnection } from './commandContinuousSync';

export default checkCommand({
  id: COMMAND_STOP_CONTINUOUS_SYNC,

  async handleCommand(...args: any[]) {
    const service = await whichConnection(...args);
    if (service) {
      await stopSyncing(service);
    }
  },
});
