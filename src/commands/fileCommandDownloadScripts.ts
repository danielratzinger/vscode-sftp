import { COMMAND_DOWNLOAD_SCRIPTS } from '../constants';
import { downloadScripts } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_DOWNLOAD_SCRIPTS,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  handleFile: downloadScripts,
});
