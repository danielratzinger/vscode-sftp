import { COMMAND_REVEAL_IN_TERMINAL } from '../constants';
import { checkFileCommand } from './abstract/createCommand';
import { revealInTerminal, uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_REVEAL_IN_TERMINAL,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  handleFile: revealInTerminal,
});
