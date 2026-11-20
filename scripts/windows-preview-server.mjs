/** Windows viewing copy of Linux-developed Creature Lab. Loopback only. */
import {createGameServer} from '../game_runtime/server.mjs';
const server=createGameServer();
server.listen(8891,'127.0.0.1',()=>{
  process.stdout.write('Creature Lab Windows preview: http://127.0.0.1:8891/game\n');
});
