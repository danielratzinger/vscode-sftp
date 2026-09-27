import { COMMAND_DOWNLOAD_FILE_AS } from '../constants';
import { downloadFile } from '../fileHandlers';
import { checkCommand } from './abstract/createCommand';
import { askWhereToPut } from './downloadAs';

/**
 * A file from the server, put where you say rather than where it belongs.
 *
 * For the times the answer to "download this" is "yes, but not over the one I
 * have" - a copy to compare against, or a file wanted outside the project
 * altogether.
 */
export default checkCommand({
  id: COMMAND_DOWNLOAD_FILE_AS,

  async handleCommand(item, items) {
    const where = await askWhereToPut(item, items, 'file');
    if (!where) {
      return;
    }

    await downloadFile(where.from, { ignore: null, saveAs: where.to });
  },
});
