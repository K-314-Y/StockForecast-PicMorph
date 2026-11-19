/** Parse MCP Inspector CLI output after a real MCP transport connection. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {verifyPluginTools} from './plugin-tool-contract.mjs';
const [path,...args]=process.argv.slice(2);
const readOnly=args.length===1 && args[0]==='--read-only';
assert.ok(path && (args.length===0 || readOnly),'Expected an Inspector output path and optional --read-only');
const output=await readFile(path,'utf8');
const index=output.indexOf('{');
assert.ok(index>=0,'Inspector did not emit tool JSON');
const data=JSON.parse(output.slice(index));
verifyPluginTools(data.tools,{readOnly});
console.log(`PASS MCP Inspector: ${data.tools.length} ${readOnly ? 'read-only' : 'full private'} tools and annotations`);
