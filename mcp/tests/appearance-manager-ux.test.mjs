import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../../game_runtime/',import.meta.url);
const html = await readFile(new URL('demo.html',root),'utf8');
const controller = await readFile(new URL('generated-avatar.mjs',root),'utf8');
const home = await readFile(new URL('quick-home.mjs',root),'utf8');

test('appearance manager clearly distinguishes currently displayed visual and reversible source choice',()=>{
  for(const id of [
    'generatedAvatarOptions','avatarCurrentName','avatarCurrentDescription','avatarOwnChoice',
    'avatarDemoChoice','generatedAvatarSelect','avatarSelectionHint','useGeneratedAvatar',
    'resetGeneratedAvatar','generatedAvatarStatus','avatarEditNotice',
  ]){
    const matches=html.match(new RegExp('id="'+id+'"','g'));
    assert.equal(matches?.length,1,'unique accessible UI id: '+id);
  }
  assert.match(html,/外見を切り替える（試作）/);
  assert.match(html,/今ゲームに表示中/);
  assert.match(html,/自分の外見/);
  assert.match(html,/登録したキャラ/);
  assert.match(html,/保存データを元に戻す操作ではありません/);
  assert.match(html,/このキャラに切り替える/);
  assert.match(html,/選ぶだけでは変更されません/);
  assert.match(html,/href="#scene"/);
  assert.match(html,/id="avatarEditNotice"[^>]*hidden/);
  assert.doesNotMatch(html,/>元の外見に戻す</);
  assert.match(html,/id="quickArtwork"[^>]*>外見を選ぶ・作る/);
});

test('mobile UX shows two choices in one column and retains accessible control sizes',()=>{
  assert.match(html,/\.avatar-choice-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html,/@media\(max-width:560px\)\{\.avatar-choice-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/);
  assert.match(html,/\.avatar-choice select\{width:100%;min-width:0;min-height:46px\}/);
  assert.match(html,/\.avatar-choice button\{width:100%;white-space:normal/);
  assert.match(html,/\.avatar-choice\[data-current="true"\]/);
  assert.match(html,/\.avatar-current\{display:grid/);
  assert.match(html,/\.avatar-show-preview\{display:inline-flex;align-items:center;min-height:44px/);
});

test('display mode and edit warning change with saved active ID without rewriting artwork',()=>{
  assert.match(controller,/const showingDemo=Boolean\(record\?\.active_demo_id && !sprite\.hidden\)/);
  assert.match(controller,/currentName\.textContent=!record/);
  assert.match(controller,/ownCard\.dataset\.current=String\(Boolean\(record && !showingDemo\)\)/);
  assert.match(controller,/demoCard\.dataset\.current=String\(showingDemo\)/);
  assert.match(controller,/editNotice\.hidden=!showingDemo/);
  assert.match(controller,/pendingDemo/);
  assert.match(controller,/selectionHint\.textContent=/);
  assert.match(controller,/reset\.textContent=record\?\.active_demo_id===null/);
  assert.match(controller,/expected_revision:record\.revision/);
  assert.match(controller,/function display\(id,parts\)/);
  assert.doesNotMatch(controller,/\/api\/artwork|\/api\/companion|\/api\/look/);
  assert.match(home,/element\('lookControls'\)\.open=false/);
  assert.match(home,/element\('artworkControls'\)\.open=false/);
  assert.match(html,/id="lookControls"(?![^>]*\bopen\b)/);
  assert.match(html,/id="artworkControls"(?![^>]*\bopen\b)/);
});
