import { COMMAND_AUTOSYNC_REVEAL_TERMINAL } from '../constants';
import { revealAutosyncWith } from './autosyncReveal';

/**
 * The machine's own terminal, not the editor's built-in one.
 *
 * `openInTerminal` is the editor's command for the external one and
 * `openInIntegratedTerminal` for the built-in, so `terminal.explorerKind` -
 * which decides what the editor offers in its own menus - does not redirect
 * this.
 */
export default revealAutosyncWith(COMMAND_AUTOSYNC_REVEAL_TERMINAL, 'openInTerminal');
