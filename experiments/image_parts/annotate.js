'use strict';
(() => {
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_SIDE = 4096;
  const MAX_PIXELS = 4_000_000;
  const UNDO_BUDGET = 32 * 1024 * 1024;
  const MAX_UNDO = 12;
  const names = { hair: '髪', face: '顔', outfit: '服' };
  const colors = { hair: '#ff4560', face: '#377bff', outfit: '#16a475' };
  const $ = (id) => document.getElementById(id);
  const canvas = $('editor');
  const ctx = canvas.getContext('2d');
  const scratch = document.createElement('canvas');
  const tint = scratch.getContext('2d');
  const masks = {};
  let source = null;
  let basename = 'drawing';
  let history = [];
  let historyBytes = 0;
  let stroke = null;
  let busy = false;
  let loadVersion = 0;
  let frame = 0;

  const dimensionsOK = (w, h) => w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;
  function status(message) { $('status').textContent = message; }
  function controls() {
    $('source').disabled = !$('rights').checked || busy;
    $('tools').disabled = !source || !$('rights').checked || busy;
    $('undo').disabled = !history.length;
  }
  function safeBasename(name) {
    return name.replace(/\.png$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'drawing';
  }
  function render() {
    frame = 0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!source) return;
    const selected = $('part').value;
    if ($('preview').checked) {
      ctx.drawImage(masks[selected], 0, 0);
      return;
    }
    ctx.drawImage(source, 0, 0);
    for (const part of Object.keys(names)) {
      if (!$('all').checked && part !== selected) continue;
      tint.clearRect(0, 0, scratch.width, scratch.height);
      tint.globalCompositeOperation = 'source-over';
      tint.drawImage(masks[part], 0, 0);
      tint.globalCompositeOperation = 'source-in';
      tint.fillStyle = colors[part];
      tint.fillRect(0, 0, scratch.width, scratch.height);
      tint.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.45;
      ctx.drawImage(scratch, 0, 0);
    }
    ctx.globalAlpha = 1;
  }
  function scheduleRender() { if (!frame) frame = requestAnimationFrame(render); }
  function remember(part) {
    const bytes = canvas.width * canvas.height * 4;
    while (history.length && (historyBytes + bytes > UNDO_BUDGET || history.length >= MAX_UNDO)) {
      historyBytes -= history.shift().data.data.byteLength;
    }
    const data = masks[part].getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    history.push({ part, data });
    historyBytes += data.data.byteLength;
    controls();
  }
  function finishStroke(event) {
    if (!stroke || (event && event.pointerId !== stroke.id)) return;
    const id = stroke.id;
    stroke = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height };
  }
  // Integer scanline disks avoid antialiasing: masks contain only alpha 0 or 255.
  function disk(x, y) {
    const { part, radius, erase } = stroke;
    const target = masks[part].getContext('2d');
    target.fillStyle = '#ffffff';
    const first = Math.max(0, Math.ceil(y - radius - 0.5));
    const last = Math.min(canvas.height - 1, Math.floor(y + radius - 0.5));
    for (let py = first; py <= last; py++) {
      const dy = py + 0.5 - y;
      const dx = Math.sqrt(Math.max(0, radius * radius - dy * dy));
      const left = Math.max(0, Math.ceil(x - dx - 0.5));
      const right = Math.min(canvas.width - 1, Math.floor(x + dx - 0.5));
      if (right < left) continue;
      if (erase) target.clearRect(left, py, right - left + 1, 1);
      else target.fillRect(left, py, right - left + 1, 1);
    }
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (!source || busy || !$('rights').checked || stroke || event.button !== 0) return;
    const p = point(event);
    const value = Number($('radius').value);
    const radius = Math.max(2, Math.min(70, Number.isFinite(value) ? value : 12));
    $('radius').value = String(radius);
    remember($('part').value);
    stroke = { id: event.pointerId, part: $('part').value, radius, erase: $('erase').checked, previous: p };
    canvas.setPointerCapture(event.pointerId);
    disk(p.x, p.y);
    scheduleRender();
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!stroke || event.pointerId !== stroke.id) return;
    const raw = point(event);
    // Bound off-canvas pointer capture coordinates to keep interpolation finite.
    const p = { x: Math.max(-70, Math.min(canvas.width + 70, raw.x)),
      y: Math.max(-70, Math.min(canvas.height + 70, raw.y)) };
    const previous = stroke.previous;
    const distance = Math.hypot(p.x - previous.x, p.y - previous.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, stroke.radius / 2)));
    for (let i = 1; i <= steps; i++) {
      disk(previous.x + (p.x - previous.x) * i / steps, previous.y + (p.y - previous.y) * i / steps);
    }
    stroke.previous = p;
    scheduleRender();
    event.preventDefault();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, finishStroke);
  window.addEventListener('blur', () => finishStroke());
  for (const id of ['part', 'all', 'preview', 'erase', 'radius']) {
    $(id).addEventListener('change', () => { finishStroke(); scheduleRender(); });
  }
  $('undo').addEventListener('click', () => {
    finishStroke();
    const entry = history.pop();
    if (!entry) return;
    historyBytes -= entry.data.data.byteLength;
    masks[entry.part].getContext('2d').putImageData(entry.data, 0, 0);
    $('part').value = entry.part;
    controls();
    scheduleRender();
  });
  $('clear').addEventListener('click', () => {
    finishStroke();
    const part = $('part').value;
    if (!window.confirm(`${names[part]}のマスクを全て消しますか？`)) return;
    remember(part);
    masks[part].getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    scheduleRender();
  });
  $('rights').addEventListener('change', () => {
    finishStroke();
    loadVersion++;
    controls();
    if (!$('rights').checked) status('権利確認が解除されました。画像選択・編集・保存は停止中です。');
  });

  async function validatePNG(file) {
    if (!/\.png$/i.test(file.name) || file.size > MAX_BYTES || file.size < 33) throw new Error('8 MiB以下のPNGを選んでください。');
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => bytes[index] === value)) throw new Error('PNG形式ではありません。');
    const view = new DataView(buffer);
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 || !dimensionsOK(view.getUint32(16), view.getUint32(20))) {
      throw new Error('PNGの各辺4096px・総画素4,000,000以下を確認してください。');
    }
    let offset = 8;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = view.getUint32(offset + 4);
      if (offset + 12 + length > bytes.length) throw new Error('PNGが壊れています。');
      if (type === 0x6163544c) throw new Error('アニメーションPNGは使えません。');
      offset += 12 + length;
      if (type === 0x49454e44) { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!ended) throw new Error('PNGの終端が不正です。');
    return new Blob([buffer], { type: 'image/png' });
  }
  $('source').addEventListener('change', async () => {
    const file = $('source').files[0];
    if (!file || !$('rights').checked || busy) return;
    finishStroke();
    if (history.length && !window.confirm('未保存の塗り分けがあります。別の画像を開くと現在のマスクは全て破棄されます。続けますか？')) {
      $('source').value = '';
      status('画像の変更をキャンセルしました。現在の塗り分けを保持しています。');
      return;
    }
    const version = ++loadVersion;
    busy = true;
    controls();
    let url;
    try {
      const blob = await validatePNG(file);
      url = URL.createObjectURL(blob);
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!dimensionsOK(image.naturalWidth, image.naturalHeight)) throw new Error('読み込み後の画像寸法が上限を超えています。');
      if (version !== loadVersion || !$('rights').checked) return;
      source = image;
      basename = safeBasename(file.name);
      history = [];
      historyBytes = 0;
      canvas.width = scratch.width = image.naturalWidth;
      canvas.height = scratch.height = image.naturalHeight;
      for (const part of Object.keys(names)) {
        if (masks[part]) masks[part].width = masks[part].height = 1;
        const mask = document.createElement('canvas');
        mask.width = canvas.width;
        mask.height = canvas.height;
        masks[part] = mask;
      }
      status(`${canvas.width} × ${canvas.height}px。部位を選んで手で塗ってください。`);
      scheduleRender();
    } catch (error) {
      status(error instanceof Error ? error.message : '画像を読み込めませんでした。');
    } finally {
      if (url) URL.revokeObjectURL(url);
      $('source').value = '';
      busy = false;
      controls();
    }
  });
  for (const button of document.querySelectorAll('[data-save]')) {
    button.addEventListener('click', () => {
      if (!source || busy || !$('rights').checked) return;
      finishStroke();
      const part = button.dataset.save;
      // Show the selected mask before the user approves the download.
      $('part').value = part;
      $('preview').checked = true;
      render();
      if (!window.confirm(`${names[part]}の正解マスクを保存します。\n正解マスクにも元画像に準じた権利が及びます。許可されたローカル利用・再配布条件を守りますか？\n既存ファイルを置換しない新しい保存先を選んでください。`)) return;
      busy = true;
      controls();
      masks[part].toBlob((blob) => {
        try {
          if (!blob) throw new Error('PNGの生成に失敗しました。');
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          // Unique suffix reduces collision; browser owns destination/overwrite UI.
          link.download = `${basename}_${part}_${Date.now()}_${crypto.randomUUID()}.png`;
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          status(`${names[part]}のPNGダウンロードを開始しました。保存先はブラウザで確認してください。`);
        } catch (error) { status(error.message); }
        finally { busy = false; controls(); }
      }, 'image/png');
    });
  }
  controls();
  document.documentElement.dataset.editorReady = 'true';
})();
