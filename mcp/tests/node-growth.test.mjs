import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGrowthStore, GrowthError} from '../../game_runtime/growth.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {request as httpRequest} from 'node:http';

function base() {
  return {schema:1,revision:0,slots:Object.fromEntries(
    ['mine','owl','turtle'].map(k=>[k,{achievements:[],gear:'none'}])
  )};
}
async function fixture(t, legacy) {
  const {rm} = await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'creature-growth-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const node=join(dir,'node','growth.json');
  const old=join(dir,'legacy-growth.json');
  if(legacy)await writeFile(old,JSON.stringify(legacy),{mode:0o600});
  return {store:createGrowthStore({file:node,legacyFile:old}), node,old,dir};
}
const solo={mine:100,owl:0,turtle:0};
const split={mine:40,owl:30,turtle:20};
const fail=async (promise,status) =>
  assert.rejects(promise,e=>e instanceof GrowthError && e.status===status);

test('Node XP exactly matches Python schema/awards and survives new instance', async t => {
  const {store,node,old}=await fixture(t);
  let state=await store.public();
  assert.equal(state.revision,0);
  assert.deepEqual(state.slots.map(x=>x.xp),[0,0,0]);
  assert.equal(state.challenges.length,3);
  await assert.rejects(stat(node),{code:'ENOENT'}); // GET does not write
  const first=await store.complete(solo,0);
  assert.deepEqual(first.earned_xp,{mine:30});
  assert.equal(first.growth.slots[0].level,2);
  assert.equal(first.growth.revision,1);
  const retry=await store.complete(solo,1);
  assert.deepEqual(retry.earned_xp,{mine:0});
  assert.equal(retry.growth.revision,1);
  const second=await store.complete(split,1);
  assert.deepEqual(second.earned_xp,{mine:10,owl:30,turtle:30});
  assert.equal(second.growth.revision,2);
  assert.deepEqual(second.growth.slots.map(x=>x.xp),[40,30,30]);
  assert.deepEqual(second.growth.slots.map(x=>x.level),[3,2,2]);
  await assert.rejects(stat(old),{code:'ENOENT'});
  const restart=createGrowthStore({file:node,legacyFile:old});
  assert.deepEqual(await restart.public(),second.growth);
});

test('One-time legacy read is compatible but original file is never overwritten', async t => {
  const legacy=base(); legacy.revision=6;
  legacy.slots.mine.achievements=['first_practice','full_allocation'];
  legacy.slots.mine.gear='focus_lens';
  const {store,node,old}=await fixture(t,legacy);
  const original=await readFile(old);
  const digest=createHash('sha256').update(original).digest('hex');
  const snapshot=await store.public();
  assert.equal(snapshot.revision,6);
  assert.equal(snapshot.slots[0].xp,30);
  assert.deepEqual(Object.keys(snapshot).sort(),['challenges','revision','slots']);
  assert.deepEqual(Object.keys(snapshot.slots[0]).sort(),['achievements','level','slot','xp']);
  await assert.rejects(stat(node),{code:'ENOENT'});
  assert.deepEqual(await readFile(old),original);
  const result=await store.complete(split,6);
  assert.deepEqual(result.earned_xp,{mine:10,owl:30,turtle:30});
  assert.equal(result.growth.revision,7);
  const imported=JSON.parse(await readFile(node,'utf8'));
  assert.equal(imported.revision,7);
  assert.equal(imported.slots.mine.gear,'focus_lens');
  assert.equal(createHash('sha256').update(await readFile(old)).digest('hex'),digest);
});

test('Current schema-1 gear is immutable metadata and GET never rewrites it', async t => {
  const {store,node}=await fixture(t);
  const saved=base();saved.revision=9;
  saved.slots.mine.achievements=['first_practice','full_allocation'];
  saved.slots.mine.gear='spark_charm';
  const original=JSON.stringify(saved,null,3)+'\n';
  await mkdir(join(node,'..'),{recursive:true});
  await writeFile(node,original);
  const before=await stat(node);
  assert.equal(store.equip,undefined);
  for(let i=0;i<2;i++) {
    const value=await store.public();
    assert.equal(value.revision,9);
    assert.equal(value.slots[0].xp,30);
    assert.equal(value.slots[0].gear,undefined);
    assert.equal(value.slots[0].gear_options,undefined);
    assert.equal(await readFile(node,'utf8'),original);
    assert.equal((await stat(node)).mtimeMs,before.mtimeMs);
  }
  await store.complete(split,9);
  assert.equal(JSON.parse(await readFile(node,'utf8')).slots.mine.gear,'spark_charm');
});

test('Concurrent reward claims cannot both write same growth revision', async t => {
  const {store,node}=await fixture(t);
  const outcomes=await Promise.allSettled([
    store.complete(solo,0),
    store.complete(solo,0),
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  assert.equal(outcomes.find(x=>x.status==='rejected').reason.status,409);
  assert.equal((await store.public()).slots[0].xp,30);
  assert.equal(JSON.parse(await readFile(node,'utf8')).revision,1);
});

test('Bad legacy or current records fail closed and are not silently reset', async t => {
  const legacy=base();legacy.slots.mine.gear='spark_charm';
  const {store,node,old}=await fixture(t,legacy);
  await fail(store.public(),503);
  await fail(store.complete(solo,0),503);
  await assert.rejects(stat(node),{code:'ENOENT'});
  const good=base();good.slots.mine.achievements=['first_practice','first_practice'];
  await writeFile(old,JSON.stringify(good));
  await fail(store.public(),503);
  await writeFile(old,JSON.stringify(base()));
  assert.equal((await store.public()).revision,0);
});

function model(fast,slow,risk) {
  return {fast_window:fast,slow_window:slow,risk_fraction:risk,
    plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
    plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
}
async function withServer(t,store,fn) {
  const snapshot=async () => {
    const growth=await store.public();
    return {
      state:{revision:44,model:model(3,9,.35)},
      lineup:{revision:2,slots:[
        {slot:'owl',model:model(5,12,.5)},
        {slot:'turtle',model:model(8,20,.25)}]},
      growth,
      source_revision:44,lineup_revision:2,growth_revision:growth.revision
    };
  };
  const server=createGameServer({store,loadSnapshot:snapshot});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const url='http://127.0.0.1:'+server.address().port;
  const call=async (path,body)=>{
    const res=await fetch(url+path,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:res.status,value:await res.json()};
  };
  await fn({url,call});
}

test('Real Node HTTP: ticket required, one-time award, retired equip route cannot mutate',async t=>{
  const {store,node,old}=await fixture(t);
  await withServer(t,store,async({url,call})=>{
    assert.equal((await (await fetch(url+'/api/growth')).json()).revision,0);
    const forged=await call('/api/training/complete',{ticket:'a'.repeat(48),expected_growth_revision:0});
    assert.equal(forged.status,409);
    const run=await call('/api/practice',{allocations:solo});
    assert.equal(run.status,200);
    assert.match(run.value.training_ticket,/^[0-9a-f]{48}$/);
    assert.equal(run.value.growth_revision,0);
    assert.equal(run.value.final_coins,10111.68);
    const claimed=await call('/api/training/complete',{
      ticket:run.value.training_ticket,expected_growth_revision:0
    });
    assert.equal(claimed.status,200);
    assert.deepEqual(claimed.value.earned_xp,{mine:30});
    assert.equal(claimed.value.growth.revision,1);
    const reused=await call('/api/training/complete',{
      ticket:run.value.training_ticket,expected_growth_revision:1
    });
    assert.equal(reused.status,409);
    const equipped=await call('/api/growth/equip',{
      slot:'mine',gear_id:'focus_lens',expected_growth_revision:1
    });
    assert.equal(equipped.status,404);
    const run2=await call('/api/practice',{allocations:solo});
    assert.equal(run2.status,200);
    assert.equal(run2.value.growth_revision,1);
    assert.equal(run2.value.characters.mine.plugin_strengths.trend,100);
    assert.equal(run2.value.characters.owl.plugin_strengths.trend,100);
    // No XP from a second run unless user explicitly requests, then zero.
    assert.equal((await (await fetch(url+'/api/growth')).json()).slots[0].xp,30);
    const double=await call('/api/training/complete',{
      ticket:run2.value.training_ticket,expected_growth_revision:1
    });
    assert.equal(double.status,200);
    assert.deepEqual(double.value.earned_xp,{mine:0});
    assert.equal(double.value.growth.revision,1);
  });
  assert.equal(JSON.parse(await readFile(node,'utf8')).revision,1);
  await assert.rejects(stat(old),{code:'ENOENT'});
});

test('Two concurrent HTTP attempts with same ticket award XP once',async t=>{
  const {store}=await fixture(t);
  await withServer(t,store,async({call})=>{
    const run=await call('/api/practice',{allocations:solo});
    const ticket=run.value.training_ticket;
    const results=await Promise.all([
      call('/api/training/complete',{ticket,expected_growth_revision:0}),
      call('/api/training/complete',{ticket,expected_growth_revision:0}),
    ]);
    assert.equal(results.filter(x=>x.status===200).length,1);
    assert.equal(results.filter(x=>x.status===409).length,1);
    assert.equal((await store.public()).slots[0].xp,30);
  });
});
