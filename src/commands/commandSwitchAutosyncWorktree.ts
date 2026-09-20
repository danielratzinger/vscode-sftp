import { COMMAND_SWITCH_AUTOSYNC_WORKTREE } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { chooseWorktree } from '../modules/worktreeSync';
import { whichConnection } from './commandAutosyncWorktree';

/**
 * The same picker as `Autosync Worktree`, under the name that fits once
 * something is already running.
 *
 * Two commands rather than one whose title changes, because a menu entry shows
 * its command's title and a title is fixed. So the pair swap places: a
 * connection that is not syncing offers `Autosync Worktree`, one that is
 * offers `Switch Autosync Worktree` beside `Stop`.
 */
export default checkCommand({
  id: COMMAND_SWITCH_AUTOSYNC_WORKTREE,

  async handleCommand(...args: any[]) {
    const service = await whichConnection(...args);
    if (service) {
      await chooseWorktree(service);
    }
  },
});
