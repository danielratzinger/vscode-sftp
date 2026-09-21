import { COMMAND_MIGRATE_PASSWORDS } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { sweepPasswordsIntoAManager } from '../modules/passwordSweep';

/**
 * One command for the whole machine, rather than one connection at a time.
 *
 * Migration already happened per connection, lazily, and only where somebody
 * had written `passwordManager` into that connection by hand. This is the same
 * move made once for every password in every `sftp.json` behind a configured
 * connection.
 */
export default checkCommand({
  id: COMMAND_MIGRATE_PASSWORDS,

  async handleCommand() {
    await sweepPasswordsIntoAManager();
  },
});
