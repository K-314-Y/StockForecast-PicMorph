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
  let historicalStatus=200;
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
      if(url.origin!==origin || ![api,api+'/compare',api+'/historical'].includes(pathname)) {
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
      if(method==='POST' && pathname===api+'/historical' && input.expected_revision===record.revision) {
        check(JSON.stringify(input)===JSON.stringify({character_id,active_revision:2,equipment_revision:3,
          expected_revision:record.revision}),'Unexpected historical parameters');
        if(historicalStatus!==200)return route.fulfill({status:historicalStatus,json:{error:historicalStatus===409 ?
          '設定を再読込してください' : 'ローカルの2024年株価データを読み込めません。'}});
        return route.fulfill({json:{scope:'ACCESSORY_RULES_HISTORICAL_LOCAL_12',read_only:true,holdout_evaluated:false,
          market:{source_origin:'LOCAL_JPX_REPORT_CACHE_2024',source:'合成の出典',adjusted:false,code:'40050',
            period_start:'2024-01-04',history_end:'2024-02-08',period_end:'2024-02-26',eligible_windows:694,warning:'分割・配当の影響があります。'},
          baseline:{...baseline,brier:.75,signals:undefined},candidate:{...candidate,brier:.8,signals:undefined},
          difference:{different_signals:2,profit_coins:-25},provenance:{applied_rules:record.policies}}});
      }
      return route.fulfill({status:409,json:{error:'設定を再読込してください'}});
    });
    const fixture=await context.newPage();
    const errors=[];
    fixture.on('pageerror',error=>errors.push(error.message));
    await fixture.goto(origin+'/accessory-analysis.html');
    const save=fixture.getByRole('button',{name:'分析設定を保存する'});
    const compare=fixture.getByRole('button',{name:'保存済み設定で比較する'});
    const history=fixture.getByRole('button',{name:'過去の株価（2024年）で比較する'});
    const focus=fixture.getByRole('combobox',{name:'分析の焦点'});
    const strength=fixture.getByRole('combobox',{name:'強度'});
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    check(calls.length===1 && calls[0].method==='GET','Page load must only read metadata');
    check(await save.isDisabled(),'Save should be disabled before edits');
    check(await history.isDisabled(),'History requires an applied saved policy');
    await focus.selectOption({label:'直近の勢い'});
    await strength.selectOption('3');
    check(await compare.isDisabled(),'Unsaved changes must not be compared');
    check(await history.isDisabled(),'Unsaved policies must not run historical analysis');
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
    check(!calls.some(call=>call.path===api+'/historical'),'History must wait for an explicit click');
    await history.click();
    const historicalResult=fixture.getByRole('region',{name:'過去12営業日の比較結果'});
    await historicalResult.getByText(/合成の出典（未調整）.*40050.*2024-01-04.*2024-02-08.*2024-02-26/).waitFor();
    await historicalResult.getByText(/候補期間は694件で互いに重なります.*独立した検証用データ.*分割・配当/).waitFor();
    await historicalResult.getByText(/異なる日次シグナルは12日中2日/).waitFor();
    for(const [brier,profit,drawdown] of [[.75,45,1.5],[.8,20,2.25]]) {
      const card=historicalResult.getByRole('article').filter({hasText:new RegExp('Brierスコア\\s+'+brier)});
      await card.getByText('仮想損益 '+profit+'コイン',{exact:true}).waitFor();
      await card.getByText('最大下落率 '+drawdown+'%',{exact:true}).waitFor();
    }
    check(await fixture.getByRole('heading',{name:'架空12日間の比較結果'}).isVisible(),'Historical result must stay separate');
    check(await fixture.evaluate(()=>document.documentElement.scrollWidth===innerWidth),'320px viewport should not overflow');
    historicalStatus=503;
    await history.click();
    await fixture.getByText('ローカルの2024年株価データを読み込めません。',{exact:true}).waitFor();
    check(!await historicalResult.isVisible(),'Unavailability must not show a substitute outcome');
    historicalStatus=409;
    await history.click();
    await fixture.getByText('設定を再読込してください',{exact:true}).waitFor();
    check(await history.isDisabled() && await compare.isDisabled(),'Conflict must require reload');
    check(!await fixture.getByRole('heading',{name:'架空12日間の比較結果'}).isVisible(),'Conflict must clear old outcome');
    empty=true;
    record={schema:1,revision:0,policies:[]};
    await fixture.reload();
    await fixture.getByText('カタログに登録された装飾品はありません。').waitFor();
    check(await compare.isDisabled(),'Empty fixture without a character must not allow comparison');
    check(await history.isDisabled(),'Empty fixture must not allow historical analysis');
    check(unexpected.length===0 && errors.length===0,'Unexpected browser activity: '+JSON.stringify({unexpected,errors}));
    return {viewport:320,requests:calls.map(({method,path})=>method+' '+path),images:0};
  } finally {
    await context.close();
  }
}
