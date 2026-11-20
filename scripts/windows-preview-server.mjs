/** Windows viewing copy of Linux-developed Creature Lab. Loopback only. */
import {createGameServer} from '../game_runtime/server.mjs';

// Linux's protected active-character store requires procfs/POSIX ownership.
// The Windows viewer deliberately uses an unsaved, default visual selection.
// This does not touch Linux state, and it cannot silently save a selected ID.
const previewCharacterStore={
  async read() {return {schema:1,revision:0,active_demo_id:null};},
  async save() {throw Object.assign(Error('Windows viewer does not save active avatars'),{status:403});},
};
const server=createGameServer({activeCharacterStore:previewCharacterStore});
server.listen(8891,'127.0.0.1',()=>{
  process.stdout.write('Creature Lab Windows preview: http://127.0.0.1:8891/game\n');
});
