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
  let batchStatus=200;
  let adjustedStatus=200;
  let fixedRecord;
  let registrationConflict=false;
  const previewToken='1795477200000.'+'a'.repeat(64);
  const registrationPaths=[api+'/registration/preview',api+'/registration',api+'/registrations'];
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
      if(url.origin!==origin || ![api,api+'/compare',api+'/historical',api+'/batch-history',api+'/adjusted-split',...registrationPaths].includes(pathname)) {
        unexpected.push(method+' '+url);
        return route.abort();
      }
      const input=method==='POST'?req.postDataJSON():null;
      calls.push({method,path:pathname,input});
      if(method==='GET' && pathname===api) {
        return route.fulfill({json:{...record,kinds:empty?[]:[{kind_id:kind,part_count:1}],
          equipped:{character_id:empty?null:character_id,active_revision:2,equipment_revision:3,visible_kinds:empty?[]:[kind]},stale_kinds:[]}});
      }
      if(method==='GET' && pathname===registrationPaths[2])return route.fulfill({json:{registrations:fixedRecord?[fixedRecord]:[]}});
      if(method==='POST' && registrationPaths.slice(0,2).includes(pathname)) {
        const context={character_id,active_revision:2,equipment_revision:3,expected_revision:record.revision};
        if(pathname===registrationPaths[1]) {
          check(JSON.stringify(input)===JSON.stringify({...context,preview_token:previewToken}),'Unexpected registration write fields');
          if(registrationConflict)return route.fulfill({status:409,json:{error:'固定する設定を再読込してください。'}});
          fixedRecord={id:'a'.repeat(64),created_at:'2026-11-23T15:01:00.000Z',earliest_possible_day:'2026-11-25',
            registered_jst_day:'2026-11-24',status:'pending_no_verified_data',timestamp_basis:'local_system_clock'};
          return route.fulfill({status:201,json:{registration:fixedRecord}});
        }
        check(JSON.stringify(input)===JSON.stringify(context),'Preview may receive only revisions and character');
        const model={fast_window:4,slow_window:10,risk_fraction:.35,plugin_weights:baseline.parameters.plugin_weights,
          plugin_strengths:{trend:100,momentum:100,reversion:100,volatility:100}};
        return route.fulfill({json:{preview_token:previewToken,valid_for_seconds:300,review:{context,
          applied_rules:record.policies,source_revisions:{source_revision:5,companion_revision:6,lineup_revision:1,growth_revision:0},
          earliest_possible_day:'2026-11-25',base_model:model,baseline:model,candidate:model,
          protocol:{evaluation_sessions_per_code:12,lookback_sessions:24,
            codes:['40050','46890','47550','50200','72010','84100','85930','86040','94320','95010'],
            initial_virtual_coins_per_model_and_code:10000,trade_fee_bps:10}}}});
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
      if(method==='POST' && pathname===api+'/batch-history' && input.expected_revision===record.revision) {
        check(JSON.stringify(input)===JSON.stringify({character_id,active_revision:2,equipment_revision:3,
          expected_revision:record.revision}),'Unexpected historical batch parameters');
        if(batchStatus===0)return route.abort();
        if(batchStatus===409)return route.fulfill({status:409,json:{error:'一括比較の設定を再読込してください'}});
        const metrics={brier:{baseline_mean:.71,candidate_mean:.7,wins:1,ties:1,losses:1},
          profit_coins:{baseline_mean:0,candidate_mean:-6.25,wins:1,ties:1,losses:1},
          max_drawdown_pct:{baseline_mean:0,candidate_mean:2,wins:0,ties:1,losses:2}};
        return route.fulfill({json:{scope:'ACCESSORY_RULES_HISTORICAL_LOCAL_NONOVERLAP_V1',read_only:true,holdout_evaluated:false,
          weighting:'equal_per_window',coverage:{codes:2,selected_windows:3,eligible_windows:694,
            period_start:'2024-01-04',period_end:'2024-03-19'},
          market:{source_origin:'LOCAL_JPX_REPORT_CACHE_2024',source:'合成の出典',adjusted:false,warning:'分割・配当の影響があります。'},
          notice:'銘柄間では同じ市場を共有します。再現する12日間も含めた急変の除外で、選択に偏りがあり得ます。',
          signal_comparisons:36,different_signals:2,metrics,
          downside:{baseline:{max_drawdown_pct:0,worst_profit_coins:0},candidate:{max_drawdown_pct:3.5,worst_profit_coins:-34}},
          by_code:[{code:'40050',windows:2,metrics},{code:'46890',windows:1,metrics}],provenance:{applied_rules:record.policies}}});
      }
      if(method==='POST' && pathname===api+'/adjusted-split' && input.expected_revision===record.revision) {
        check(JSON.stringify(input)===JSON.stringify({character_id,active_revision:2,equipment_revision:3,
          expected_revision:record.revision}),'Adjusted chronology only accepts the review context');
        if(adjustedStatus!==200)return route.fulfill({status:adjustedStatus,json:{error:adjustedStatus===409 ?
          '調整済み比較の設定を再読込してください' : 'ローカルの調整済み研究データを確認できませんでした。'}});
        const metrics={brier:{baseline_mean:.71,candidate_mean:.7,delta:-.01,wins:1,ties:0,losses:0},
          profit_coins:{baseline_mean:0,candidate_mean:-6.25,delta:-6.25,wins:0,ties:0,losses:1},
          max_drawdown_pct:{baseline_mean:0,candidate_mean:2,delta:2,wins:0,ties:0,losses:1}};
        const phase={sessions_per_code:242,calendar_start:'2024-08-05',calendar_end:'2025-07-31',periods:60,
          window_start:'2024-08-05',window_end:'2025-06-24',metrics,different_signals:2,signal_comparisons:720,
          downside:{baseline:{max_drawdown_pct:0,worst_profit_coins:0},candidate:{max_drawdown_pct:3.5,worst_profit_coins:-34}},
          by_code:[{code:'40050',windows:6,metrics}]};
        return route.fulfill({json:{scope:'ACCESSORY_RULES_ADJUSTED_CHRONOLOGY_RESEARCH_V1',read_only:true,research_only:true,
          holdout_evaluated:false,rights_verified:false,point_in_time_verified:false,corporate_actions_verified:false,
          weighting:'equal_per_window',split_date:'2025-08-01',market:{source_origin:'LOCAL_PRIVATE_JQUANTS_ADJUSTED_RESEARCH',
            adjusted:true,manifests_verified:true,codes:10,sessions_per_code:485,missing_sessions:['2024-08-01','2024-08-02']},
          phases:{early:phase,later:{...phase,sessions_per_code:243,calendar_start:'2025-08-01',calendar_end:'2026-07-31',
            window_start:'2025-08-01',window_end:'2026-06-23'}},
          direction_by_metric:{brier:{early:'better',later:'worse'},profit_coins:{early:'worse',later:'tie'},
            max_drawdown_pct:{early:'worse',later:'worse'}},
          notice:'権利・ライセンス、当時の入手可能性、企業行動の処理は未確認です。前半も後半も遡及比較です。',
          provenance:{applied_rules:record.policies}}});
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
    const batch=fixture.getByRole('button',{name:'重ならない複数期間でまとめて比較する'});
    const adjusted=fixture.getByRole('button',{name:'調整済み株価で前半・後半を比較（研究用）'});
    const reviewRegistration=fixture.getByRole('button',{name:'固定する内容を確認する'});
    const confirmRegistration=fixture.getByRole('button',{name:'この設定を固定する'});
    const listRegistrations=fixture.getByRole('button',{name:'固定記録の一覧を表示する'});
    const focus=fixture.getByRole('combobox',{name:'分析の焦点'});
    const strength=fixture.getByRole('combobox',{name:'強度'});
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    check(calls.length===1 && calls[0].method==='GET','Page load must only read metadata');
    check(await save.isDisabled(),'Save should be disabled before edits');
    check(await history.isDisabled(),'History requires an applied saved policy');
    check(await batch.isDisabled(),'Batch requires an applied saved policy');
    check(await adjusted.isDisabled(),'Adjusted chronology requires an applied saved policy');
    check(await reviewRegistration.isDisabled(),'Registration requires an applied saved policy');
    await focus.selectOption({label:'直近の勢い'});
    await strength.selectOption('3');
    check(await compare.isDisabled(),'Unsaved changes must not be compared');
    check(await history.isDisabled(),'Unsaved policies must not run historical analysis');
    check(await batch.isDisabled(),'Unsaved policies must not run a batch');
    check(await adjusted.isDisabled(),'Unsaved policies must not run adjusted chronology');
    check(await reviewRegistration.isDisabled(),'Unsaved policies must not be registered');
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
    check(!calls.some(call=>call.path===api+'/batch-history'),'Historical batch must wait for its own click');
    await batch.click();
    const batchResult=fixture.getByRole('region',{name:'重ならない複数期間の比較結果'});
    await batchResult.getByText(/2銘柄・3期間（重なる候補は694件）/).waitFor();
    await batchResult.getByText(/同じ市場を共有.*12日間.*偏り/).waitFor();
    await batchResult.getByText(/36日のうち2日/).waitFor();
    await batchResult.getByText(/候補が良い 0 ／ 同じ 1 ／ 悪い 2/).waitFor();
    await batchResult.getByText(/最も大きな下落率.*3.5%.*-34コイン/).waitFor();
    await batchResult.getByText('銘柄ごとの平均と対象期間数',{exact:true}).click();
    await batchResult.getByText(/^40050（2期間、基準 → 候補）/).waitFor();
    check(await historicalResult.isVisible(),'Single-window result must stay separate');
    check(await fixture.evaluate(()=>document.documentElement.scrollWidth===innerWidth),'320px viewport should not overflow');
    await strength.selectOption('2');
    check(!await batchResult.isVisible() && await batch.isDisabled(),'Editing settings must clear batch result');
    await strength.selectOption('3');
    await batch.click();
    await batchResult.waitFor();
    await fixture.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
    check(!await batchResult.isVisible() && await batch.isDisabled(),'Leaving for another active character must invalidate the batch');
    await fixture.getByRole('button',{name:'設定を再読込する'}).click();
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    batchStatus=0;
    await batch.click();
    await fixture.getByText('接続に失敗しました。設定を再読込してください。',{exact:true}).waitFor();
    check(!await batchResult.isVisible(),'A failed batch must not display substitute metrics');
    batchStatus=409;
    await batch.click();
    await fixture.getByText('一括比較の設定を再読込してください',{exact:true}).waitFor();
    check(await batch.isDisabled(),'A stale batch must require reload');
    await fixture.getByRole('button',{name:'設定を再読込する'}).click();
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    historicalStatus=503;
    await history.click();
    await fixture.getByText('ローカルの2024年株価データを読み込めません。',{exact:true}).waitFor();
    check(!await historicalResult.isVisible(),'Unavailability must not show a substitute outcome');
    historicalStatus=409;
    await history.click();
    await fixture.getByText('設定を再読込してください',{exact:true}).waitFor();
    check(await history.isDisabled() && await compare.isDisabled(),'Conflict must require reload');
    check(!await fixture.getByRole('heading',{name:'架空12日間の比較結果'}).isVisible(),'Conflict must clear old outcome');
    check(!calls.some(call=>call.path===api+'/adjusted-split'),'Adjusted comparison must wait for its own click');
    await fixture.getByRole('button',{name:'設定を再読込する'}).click();
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    await adjusted.click();
    const chronology=fixture.getByRole('region',{name:'調整済み株価の前半・後半の結果'});
    await chronology.getByRole('heading',{name:'前半（遡及比較）'}).waitFor();
    await chronology.getByRole('heading',{name:'後半（遡及比較）'}).waitFor();
    await chronology.getByText(/2024-08-01、2024-08-02.*2025-08-01/).waitFor();
    await chronology.getByText(/当時の入手可能性、企業行動の処理は未確認.*価格変動による選別はしません/).waitFor();
    await chronology.getByText(/Brierスコア.*前半 候補が良い ／ 後半 候補が悪い/).waitFor();
    await chronology.getByText(/後半の銘柄ごとの平均/).click();
    await chronology.locator('details[open]').getByText(/^40050（6期間、基準 → 候補）/).waitFor();
    check(await fixture.evaluate(()=>document.documentElement.scrollWidth===innerWidth),'Adjusted result must fit 320px');
    const beforeUnavailable=calls.length;
    adjustedStatus=503;
    await adjusted.click();
    await fixture.getByText('ローカルの調整済み研究データを確認できませんでした。',{exact:true}).waitFor();
    check(!await chronology.isVisible() && calls.length===beforeUnavailable+1,'An unavailable adjusted archive must not fall back');
    adjustedStatus=409;
    await adjusted.click();
    await fixture.getByText('調整済み比較の設定を再読込してください',{exact:true}).waitFor();
    check(await adjusted.isDisabled(),'Stale adjusted results require reload');
    check(!calls.some(call=>registrationPaths.includes(call.path)),'Registrations must wait for an explicit action');
    await fixture.getByRole('button',{name:'設定を再読込する'}).click();
    await fixture.getByText('設定を読み込みました。',{exact:true}).waitFor();
    await listRegistrations.click();
    await fixture.getByText('固定記録はまだありません。',{exact:true}).waitFor();
    await reviewRegistration.click();
    const previewRegion=fixture.getByRole('region',{name:'固定する内容のプレビュー'});
    await previewRegion.getByText(/今回の最短日は2026-11-25/).waitFor();
    await previewRegion.getByText(/対象10銘柄.*94320/).waitFor();
    await previewRegion.getByText(/指標はBrierスコア.*売買手数料は0.1%/).waitFor();
    await previewRegion.getByText(/権利.*評価待ち（データ未取得・未検証）/).waitFor();
    check(!calls.some(call=>call.path===registrationPaths[1]),'Preview must not register');
    fixture.once('dialog',dialog=>dialog.dismiss());
    await confirmRegistration.click();
    check(!calls.some(call=>call.path===registrationPaths[1]),'Cancelled confirmation must not register');
    await strength.selectOption('2');
    check(!await previewRegion.isVisible() && await reviewRegistration.isDisabled(),'Edits must clear registration preview');
    await strength.selectOption('3');
    await reviewRegistration.click();
    await previewRegion.waitFor();
    check(await fixture.evaluate(()=>document.documentElement.scrollWidth===innerWidth),'Registration preview must fit 320px');
    fixture.once('dialog',dialog=>dialog.accept());
    await confirmRegistration.click();
    await fixture.getByText(/設定を固定しました。評価待ち/).waitFor();
    check(!await previewRegion.isVisible() && calls.at(-1).path===registrationPaths[1],'Save must consume preview without auto-list');
    await listRegistrations.click();
    await fixture.getByRole('region',{name:'固定記録',exact:true}).getByText(/最短日 2026-11-25 ／ 評価待ち/).waitFor();
    registrationConflict=true;
    await reviewRegistration.click();
    await previewRegion.waitFor();
    fixture.once('dialog',dialog=>dialog.accept());
    await confirmRegistration.click();
    await fixture.getByText('固定する設定を再読込してください。',{exact:true}).waitFor();
    check(!await previewRegion.isVisible() && await reviewRegistration.isDisabled(),'Stale registration requires reload');
    empty=true;
    record={schema:1,revision:0,policies:[]};
    await fixture.reload();
    await fixture.getByText('カタログに登録された装飾品はありません。').waitFor();
    check(await compare.isDisabled(),'Empty fixture without a character must not allow comparison');
    check(await history.isDisabled(),'Empty fixture must not allow historical analysis');
    check(await batch.isDisabled(),'Empty fixture must not allow a batch');
    check(await adjusted.isDisabled(),'Empty fixture must not allow adjusted chronology');
    check(unexpected.length===0 && errors.length===0,'Unexpected browser activity: '+JSON.stringify({unexpected,errors}));
    return {viewport:320,requests:calls.map(({method,path})=>method+' '+path),images:0};
  } finally {
    await context.close();
  }
}
