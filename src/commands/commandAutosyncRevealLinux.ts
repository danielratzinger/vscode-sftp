import { COMMAND_AUTOSYNC_REVEAL_FINDER_LINUX } from '../constants';
import { revealAutosyncWith } from './autosyncReveal';

export default revealAutosyncWith(
  COMMAND_AUTOSYNC_REVEAL_FINDER_LINUX,
  'revealFileInOS'
);
