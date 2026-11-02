/** Stdio entrypoint for the same three restricted companion tools.
 * Local MCP clients and Secure MCP Tunnel may launch this directly.
 * No HTTP listener, no access to the old 8765 game MCP, and no credentials.
 */
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {makeCompanionChatGptMcp} from './companion-chatgpt.mjs';
const server=makeCompanionChatGptMcp();
await server.connect(new StdioServerTransport());
