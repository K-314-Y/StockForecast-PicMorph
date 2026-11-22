/** Playwright smoke test. Supply the checked-out HTML and JS as strings. */
export default async function testAccessoryAnalysisPage(page,{html,script}) {
  const context=await page.context().browser().newContext({viewport:{width:320,height:840},serviceWorkers:'block'});
  const origin='https://accessory-analysis-fixture.invalid';
  const api='/api/accessory-analysis/v1';
  const calls=[];
  const unexpected=[];
  const kind='wearable.synthetic-pin';
  const character_id='cp_'+'a'.repeat(32);
  const signals=Array(12).fill('CASH');
  const baseline={parameters:{plugin_weights:{trend:40,momentum:20,reversion:25,volatility:15}},
    effective_sha256:'a'.repeat(64),profit_coins:45,return_pct:.45,max_drawdown_pct:1.5,signals};
  const candidate={...baseline,parameters:{plugin_weights:{trend:31,momentum:38,reversion:19,volatility:12}},
    effective_sha256:'b'.repeat(64),profit_coins:20,return_pct:.2,max_drawdown_pct:2.25};
  let record={schema:1,revision:0,policies:[]};
  let empty=false;
  function check(value,message) {
    if(!value)throw Error(message);
  }
  try {
    await context.route('**/*',async route=>{
      const req=route.request();
      const url=new URL(req.url());
      const {pathname}=url;
      const method=req.method();
      if(url.origin===origin && method==='GET') {
        if(pathname==='/accessory-analysis.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
        if(pathname==='/accessory-analysis-ui.mjs')return route.fulfill({contentType:'text/javascript; charset=utf-8',body:script});
        if(pathname==='/favicon.ico')return route.fulfill({status:204});
      }
      if(url.origin!==origin || ![api,api+'/compare'].includes(pathname)) {
        unexpected.push(method+' '+url);
        return route.abort();
      }
      const input=method==='POST'?req.postDataJSON():null;
      calls.push({method,path:pathname,input});
      if(method==='GET' && pathname===api) {
        return route.fulfill({json:{...record,kinds:empty?[]:[{kind_id:kind,part_count:1}],
          equipped:{character_id:empty?null:character_id,active_revision:2,equipment_revision:3,visible_kinds:empty?[]:[kind]},stale_kinds:[]}});
      }
      if(method==='POST' && pathname===api && input.expected_revision===record.revision) {
        record={...record,revision:record.revision+1,policies:input.policies};
        return route.fulfill({json:record});
      }
      if(method==='POST' && pathname===api+'/compare' && input.expected_revision===record.revision) {
        return route.fulfill({json:{baseline,candidate,weights_changed:true,effective_hash_changed:true,
          difference:{different_signals:0,profit_coins:-25},provenance:{applied_rules:record.policies}}});
      }
      return route.fulfill({status:409,json:{error:'設定を再読込してください'}});
    });
    const fixture=await context.newPage();
    const errors=[];
    fixture.on('pageerror',error=>errors.push(error.message));
    await fixture.goto(origin+'/accessory-analysis.html');
    const save=fixture.getByRole('button',{name:'分析設定を保存する'});
    const compare=fixture.getByRole('button',{name:'保存済み設定で比較する'});
    const focus=fixture.getByRole('combobox',{name:'分析の焦点'});
    const strength=fixture.getByRole('combobox',{name:'強度'});
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    check(calls.length===1 && calls[0].method==='GET','Page load must only read metadata');
    check(await save.isDisabled(),'Save should be disabled before edits');
    await focus.selectOption({label:'直近の勢い'});
    await strength.selectOption('3');
    check(await compare.isDisabled(),'Unsaved changes must not be compared');
    fixture.once('dialog',dialog=>dialog.dismiss());
    await save.click();
    check(calls.length===1,'Dismissing confirmation must not save');
    fixture.once('dialog',dialog=>dialog.accept());
    await save.click();
    await fixture.getByText('分析設定を保存しました。',{exact:true}).waitFor();
    check(calls.length===2 && calls[1].method==='POST' && calls[1].path===api,'Save must not start comparison');
    check(JSON.stringify(record.policies)===JSON.stringify([{kind_id:kind,focus:'momentum',intensity:3}]),'Expected form values were not saved');
    await fixture.reload();
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    check(await focus.inputValue()==='momentum' && await strength.inputValue()==='3','Reload failed to restore choices');
    await compare.click();
    await fixture.getByRole('heading',{name:'架空12日間の比較結果'}).waitFor();
    check(calls.at(-1).path===api+'/compare' && calls.at(-1).input.character_id===character_id,'Compare must use current character and revisions');
    const before=fixture.getByRole('article').filter({has:fixture.getByRole('heading',{name:'基準',exact:true})});
    const after=fixture.getByRole('article').filter({has:fixture.getByRole('heading',{name:'候補',exact:true})});
    for(const [card,profit,rate,decline] of [[before,45,0.45,1.5],[after,20,0.2,2.25]]) {
      await card.getByText('架空収支 '+profit+'コイン',{exact:true}).waitFor();
      await card.getByText('収益率 '+rate+'%',{exact:true}).waitFor();
      await card.getByText('最大下落率 '+decline+'%',{exact:true}).waitFor();
      await card.getByText(/^日次シグナル/).waitFor();
    }
    await fixture.getByText(/^異なる日次シグナルは12日中0日/).waitFor();
    check(await fixture.evaluate(()=>document.documentElement.scrollWidth===innerWidth),'320px viewport should not overflow');
    empty=true;
    record={schema:1,revision:0,policies:[]};
    await fixture.reload();
    await fixture.getByText('カタログに登録された装飾品はありません。').waitFor();
    check(await compare.isDisabled(),'Empty fixture without a character must not allow comparison');
    check(unexpected.length===0 && errors.length===0,'Unexpected browser activity: '+JSON.stringify({unexpected,errors}));
    return {viewport:320,requests:calls.map(({method,path})=>method+' '+path),images:0};
  } finally {
    await context.close();
  }
}
