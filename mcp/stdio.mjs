/** Local stdio entrance to the SAME allowlisted Creature Lab MCP tool registry. */
/* No additional HTTP listener, tunnel, token, or independent feature implementation. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
process.env.CREATURE_LAB_STDIO = "1";
const { makeMcpServer } = await import("./server.mjs");
const mcp = makeMcpServer();
await mcp.connect(new StdioServerTransport());
