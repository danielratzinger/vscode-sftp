import { COMMAND_REMOTEEXPLORER_EDITINLOCAL } from '../constants';
import { editInLocal } from '../fileHandlers';
import { uriFromExplorerContextOrEditorContext } from './shared';
import { checkFileCommand } from './abstract/createCommand';

export default checkFileCommand({
  id: COMMAND_REMOTEEXPLORER_EDITINLOCAL,
  getFileTarget: uriFromExplorerContextOrEditorContext,

  async handleFile(ctx) {
    await editInLocal(ctx, { ignore: null });
  },
});
