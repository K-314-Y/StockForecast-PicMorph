import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {verifyPluginTools} from '../../scripts/plugin-tool-contract.mjs';

const entry=fileURLToPath(new URL('../companion-stdio.mjs',import.meta.url));
for(const readOnly of [false,true]) {
  test(`companion stdio lists exactly ${readOnly ? 6 : 13} tools`,async()=>{
    const transport=new StdioClientTransport({
      command:process.execPath,args:readOnly ? [entry,'--read-only'] : [entry],stderr:'pipe',
    });
    const client=new Client({name:'companion-stdio-test',version:'1.0.0'});
    try {
      await client.connect(transport);
      verifyPluginTools((await client.listTools()).tools,{readOnly});
    } finally {
      await client.close();
    }
  });
}

test('companion stdio fails closed for unknown or duplicate flags',async()=>{
  for(const args of [['--readonly'],['--read-only','--read-only'],['--read-only','--port=80']]) {
    await assert.rejects(promisify(execFile)(process.execPath,[entry,...args]),error=>{
      assert.equal(error.code,1);
      assert.equal(error.stdout,'');
      assert.match(error.stderr,/Usage:.*\[--read-only\]/);
      return true;
    });
  }
});
