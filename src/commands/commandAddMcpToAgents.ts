import { COMMAND_MCP_ADD_TO_AGENTS } from '../constants';
import { offerToAgents } from '../mcp';
import { checkCommand } from './abstract/createCommand';

/** Asks again what was asked once: which installed agents should have the tools. */
export default checkCommand({
  id: COMMAND_MCP_ADD_TO_AGENTS,

  async handleCommand() {
    await offerToAgents(true);
  },
});
