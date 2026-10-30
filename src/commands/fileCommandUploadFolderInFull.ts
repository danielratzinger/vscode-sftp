import { COMMAND_UPLOAD_FOLDER_IN_FULL } from '../constants';
import { uploadFolder } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

/**
 * `Upload Folder` as it was before it read `.gitignore` and `.git-ftp-ignore`:
 * everything in the folder but what the connection's own `ignore` leaves out.
 */
export default checkFileCommand({
  id: COMMAND_UPLOAD_FOLDER_IN_FULL,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  async handleFile(ctx) {
    await uploadFolder(ctx, { projectIgnore: false });
  },
});
