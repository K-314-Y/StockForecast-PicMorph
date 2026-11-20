import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../../',import.meta.url);
const source=async path=>readFile(new URL(path,root),'utf8');

test('Windows viewer serves the Linux-developed game on Windows loopback only',async()=>{
 const js=await source('scripts/windows-preview-server.mjs');
 assert.match(js,/import \{createGameServer\} from '\.\.\/game_runtime\/server\.mjs'/);
 assert.match(js,/server\.listen\(8891,'127\.0\.0\.1'/);
 assert.match(js,/previewCharacterStore/);
 assert.match(js,/activeCharacterStore:previewCharacterStore/);
 assert.match(js,/Windows viewer does not save active avatars/);
 assert.doesNotMatch(js,/0\.0\.0\.0|public_preview|localhost\.run|trycloudflare|:8890/);
});

test('Windows one-click launcher fetches private GitHub SSH main safely',async()=>{
 const cmd=await source('scripts/Open-Windows-Preview.cmd');
 const ps=await source('scripts/open-windows-preview.ps1');
 assert.match(cmd,/powershell\.exe -NoProfile -ExecutionPolicy Bypass -File/);
 assert.match(ps,/git@github\.com:K-314-Y\/StockForecast-PicMorph\.git/);
 assert.match(ps,/BatchMode=yes/);
 assert.match(ps,/StrictHostKeyChecking=yes/);
 assert.match(ps,/git -C \$repo status --porcelain/);
 assert.match(ps,/git -C \$repo fetch --quiet origin main/);
 assert.match(ps,/git -C \$repo merge --ff-only --quiet origin\/main/);
 assert.match(ps,/Unexpected repository remote/);
 assert.match(ps,/Port 8891 belongs to another program/);
 assert.match(ps,/windows-preview-server\.mjs/);
 assert.match(ps,/Stop-Process -Id \$listener\.OwningProcess/);
 assert.match(ps,/Get-CimInstance Win32_Process/);
 assert.match(ps,/127\.0\.0\.1:8891\/game/);
 assert.doesNotMatch(ps,/git\s+push|--force|git\s+reset\s+--hard|netsh\s+advfirewall|Tailscale\s+Funnel/);
});

test('Documentation makes Windows independent state and Linux-only development explicit',async()=>{
 const docs=await source('docs/WINDOWS_PREVIEW.md');
 assert.match(docs,/開発、修正、テスト、Gitのコミット・Pushは従来どおりLinux/);
 assert.match(docs,/WindowsはLinux本番ゲームの遠隔操作ではなく/);
 assert.match(docs,/ローカルの|local_state/);
 assert.match(docs,/8891/);
 assert.match(docs,/8890/);
 assert.match(docs,/公開トンネルは作らない/);
});
