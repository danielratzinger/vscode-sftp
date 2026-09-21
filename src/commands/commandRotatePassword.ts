import { COMMAND_ROTATE_PASSWORD } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { rotateOneAccount } from '../modules/passwordRotate';

/**
 * The other half of keeping a record per project.
 *
 * Six sites on one hosting account hold six copies of one password, so a
 * rotation that updates one of them leaves five connections that will start
 * failing at a time nobody is watching.
 */
export default checkCommand({
  id: COMMAND_ROTATE_PASSWORD,

  async handleCommand() {
    await rotateOneAccount();
  },
});
