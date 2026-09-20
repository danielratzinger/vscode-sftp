import { COMMAND_AUTOSYNC_REVEAL_FINDER_WINDOWS } from '../constants';
import { revealAutosyncWith } from './autosyncReveal';

export default revealAutosyncWith(
  COMMAND_AUTOSYNC_REVEAL_FINDER_WINDOWS,
  'revealFileInOS'
);
