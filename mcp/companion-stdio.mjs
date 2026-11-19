/** Stdio entrypoint for the same private companion tools.
 * Local MCP clients and Secure MCP Tunnel may launch this directly.
 * No HTTP listener, no access to the old 8765 game MCP, and no credentials.
 */
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {makeCompanionChatGptMcp} from './companion-chatgpt.mjs';
const args=process.argv.slice(2);
const readOnly=args.length===1 && args[0]==='--read-only';
if(args.length===0 || readOnly) {
  const server=makeCompanionChatGptMcp({readOnly});
  await server.connect(new StdioServerTransport());
} else {
  process.stderr.write('Usage: node mcp/companion-stdio.mjs [--read-only]\n');
  process.exitCode=1;
}
