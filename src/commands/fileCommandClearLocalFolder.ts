import { COMMAND_CLEAR_LOCAL_FOLDER } from '../constants';
import { clearLocalFolder } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_CLEAR_LOCAL_FOLDER,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  handleFile: clearLocalFolder,
});
