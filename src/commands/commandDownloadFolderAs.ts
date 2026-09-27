import { COMMAND_DOWNLOAD_FOLDER_AS } from '../constants';
import { downloadFolder } from '../fileHandlers';
import { checkCommand } from './abstract/createCommand';
import { askWhereToPut } from './downloadAs';

/**
 * A folder from the server, put where you say rather than where it belongs.
 *
 * Which files come is decided exactly as it always is - the connection's
 * `ignore` rules still apply, asked about the paths on the server - and only
 * where they land is different.
 */
export default checkCommand({
  id: COMMAND_DOWNLOAD_FOLDER_AS,

  async handleCommand(item, items) {
    const where = await askWhereToPut(item, items, 'folder');
    if (!where) {
      return;
    }

    await downloadFolder(where.from, { saveAs: where.to });
  },
});
