import { COMMAND_REVEAL_IN_FINDER_LINUX } from '../constants';
import { checkFileCommand } from './abstract/createCommand';
import { revealLocal, uriFromExplorerContextOrEditorContext } from './shared';

/**
 * One command per platform, because a menu entry shows its command's title and
 * a title cannot vary - which is how the editor spells its own.
 */
export default checkFileCommand({
  id: COMMAND_REVEAL_IN_FINDER_LINUX,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  handleFile: revealLocal,
});
