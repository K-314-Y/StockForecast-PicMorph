/** Local demo shop UI. Uses only safe DOM APIs; no user-provided HTML. */
const $=id=>document.getElementById(id);
let state=null,busy=false;
async function request(url,data){
  const response=await fetch(url,data?{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)
  }:undefined);
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'ショップ通信に失敗しました');
  return result;
}
function status(message){$('shopStatus').textContent=message;}
function text(tag,value){
  const node=document.createElement(tag);node.textContent=value;return node;
}
function render(){
  if(!state)return;
  $('shopBalance').textContent=state.coins.toLocaleString('ja-JP')+' コイン';
  const container=$('shopCatalog');
  container.replaceChildren();
  for(const model of state.models){
    const card=document.createElement('article');
    card.className='shop-item';
    card.append(text('h3',model.name),text('p',model.description),
      text('p','作者: '+model.author+' / 価格: '+model.price+' コイン'),
      text('p',model.performance+' / 更新は次回の練習から自動反映'));
    const buttons=document.createElement('div');
    buttons.className='actions';
    const buy=document.createElement('button');
    buy.type='button';
    buy.textContent=model.owned?'解放済み':model.price+' コインで解放';
    buy.disabled=busy||model.owned||state.coins<model.price;
    buy.addEventListener('click',()=>act('buy',model));
    buttons.append(buy);
    const tryButton=document.createElement('button');
    tryButton.type='button';tryButton.className='primary';
    tryButton.textContent='このモデルで12日間練習';
    tryButton.disabled=busy||!model.owned;
    tryButton.addEventListener('click',()=>act('practice',model));
    buttons.append(tryButton);
    card.append(buttons);
    container.append(card);
  }
}
async function load(){
  state=await request('/api/model-shop');
  render();
}
async function act(kind,model){
  if(busy)return;
  busy=true;render();
  status(kind==='buy'?'コインで使用権を解放しています…':'固定された架空12日間で判断を計算しています…');
  try{
    if(kind==='buy'){
      state=await request('/api/model-shop/buy',{
        id:model.id,expected_revision:state.revision});
      status(model.name+'を解放しました。更新後も追加料金はありません。残高: '+state.coins+' コイン。');
    }else{
      const outcome=await request('/api/model-shop/practice',{id:model.id});
      status(model.name+'を使用した12日練習: 仮想損益 '+Number(outcome.profit_coins).toLocaleString('ja-JP')+
        ' コイン、最大下落率 '+outcome.max_drawdown_pct+'%。ショップ残高と実市場の記録は変わりません。');
    }
  }catch(error){
    status(error.message);
    try{await load();}catch{}
  }finally{busy=false;render();}
}
load().then(()=>status('試作モデル2体を表示。自分のモデルの利用は無料です。'))
  .catch(error=>status(error.message));
