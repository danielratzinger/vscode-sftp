import { COMMAND_REMOVE_DELETED } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { removeWhatWasDeleted } from '../modules/worktreeSync';
import { whichConnection } from './commandAutosyncWorktree';

/**
 * Two commands, two questions, and confusing them is expensive.
 *
 * This one asks git what the project deleted and offers to take those off the
 * server. It cannot name a path the repository never tracked.
 *
 * `SFTP: Sync Local -> Remote` with `syncOption.delete` asks the server what
 * it holds and removes whatever is not on this machine. That is the complete
 * answer and the dangerous one: it includes every runtime directory, upload
 * folder and cache the site keeps and the repository ignores.
 */
export default checkCommand({
  id: COMMAND_REMOVE_DELETED,

  async handleCommand(...args: any[]) {
    const service = await whichConnection(...args);
    if (service) {
      await removeWhatWasDeleted(service);
    }
  },
});
