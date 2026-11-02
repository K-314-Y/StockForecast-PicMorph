import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createGameServer, pythonPredict} from '../../game_runtime/server.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const script=[
  "import json, tempfile",
  "from pathlib import Path",
  "import blueprints, training_lab",
  "from game_runtime.trained_bridge import resolve_version",
  "with tempfile.TemporaryDirectory(prefix='creature-e2e-') as tmp:",
  "    blueprints.STORE_FILE=Path(tmp)/'drafts.json'",
  "    training_lab.STORE_FILE=Path(tmp)/'versions.json'",
  "    draft=blueprints.create_draft({'action':'save','name':'テスト用花キャラ',",
  "      'concept':'','style':'','trait':'cautious','candidate_id':'trend'})['draft']",
  "    saved=training_lab.train_save({'draft_id':draft['id']})['version']",
  "    resolved=resolve_version(saved['id'])",
  "    print(json.dumps({'source_draft_id':draft['id'],'version':saved,'resolved':resolved},ensure_ascii=False))",
].join('\n');
const fixture=JSON.parse(execFileSync('python3',['-B','-c',script],
  {cwd:root,encoding:'utf8',timeout:10000}));
const model=()=>({fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{trend:100,momentum:0,reversion:0,volatility:0},
  plugin_strengths:{trend:100,momentum:100,reversion:100,volatility:100}});
const snapshot=()=>({
  state:{revision:4,model:model()},source_revision:4,
  lineup:{revision:2,slots:[{slot:'owl',model:model()},{slot:'turtle',model:model()}]},
  lineup_revision:2,
  growth:{revision:5,slots:['mine','owl','turtle'].map(slot=>({slot,gear:'none'}))},
  growth_revision:5,
});
const companion={revision:7,created:true,companion:{
  name:'自作の相棒',hair_color:'#123456',clothing_color:'#abcdef',
  approach:'momentum',risk_percent:80,
}};
test('temporary Python draft -> training -> Node forecasts: trained version takes precedence over authored companion',async()=>{
  let resolutions=0;
  const server=createGameServer({
    loadSnapshot:async()=>snapshot(),
    predict:pythonPredict,
    companionStore:{
      read:async()=>companion,
      save:async()=>{throw Error('Must not save companion');},
    },
    trainedVersion:async id=>{
      assert.equal(id,fixture.version.id);
      resolutions++;
      return fixture.resolved;
    },
    trainedVersions:async()=>({versions:[{id:fixture.version.id,
      source_draft_id:fixture.source_draft_id,source_name:'テスト用花キャラ',
      parameters_sha256:fixture.resolved.parameters_sha256}]}),
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    const allocations={mine:100,owl:0,turtle:0};
    const post=async body=>{
      const r=await fetch(base+'/api/practice',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(r.status,200,await r.clone().text());
      return r.json();
    };
    const authored=await post({allocations});
    assert.equal(authored.brain.kind,'authored_companion');
    assert.equal(authored.companion_name,'自作の相棒');
    assert.equal(authored.companion_applied,true);
    assert.equal(authored.characters.mine.risk_fraction,.8);
    assert.deepEqual(authored.characters.mine.plugin_weights,
      {trend:0,momentum:100,reversion:0,volatility:0});
    const trained=await post({allocations,trained_version_id:fixture.version.id});
    assert.equal(trained.mode,'PRACTICE_SYNTHETIC_ONLY');
    assert.equal(trained.brain.kind,'trained_practice_only');
    assert.equal(trained.brain.version_id,fixture.version.id);
    assert.equal(trained.brain.source_draft_id,fixture.source_draft_id);
    assert.equal(trained.brain.parameters_sha256,fixture.resolved.parameters_sha256);
    assert.equal(trained.brain.effective_sha256,trained.characters.mine.effective_sha256);
    assert.equal(trained.companion_applied,false);
    assert.equal(trained.companion_created,false);
    assert.equal(trained.companion_name,null);
    assert.equal(trained.approach,null);
    assert.equal(trained.characters.mine.risk_fraction,fixture.resolved.model.risk_fraction);
    assert.deepEqual(trained.characters.mine.plugin_weights,fixture.resolved.model.plugin_weights);
    assert.deepEqual(trained.characters.mine.plugin_strengths,fixture.resolved.model.plugin_strengths);
    assert.notDeepEqual(trained.characters.mine.plugin_weights,authored.characters.mine.plugin_weights);
    assert.equal(trained.decisions.length,12);
    assert.equal(trained.equity_path.length,13);
    assert.ok(resolutions>=2);
    const versions=await (await fetch(base+'/api/trained/versions')).json();
    assert.equal(versions.versions[0].source_name,'テスト用花キャラ');
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});