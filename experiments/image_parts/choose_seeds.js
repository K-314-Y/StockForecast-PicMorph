 'use strict';
(() => {
  const MAX_BYTES = 8 * 1024 * 1024, MAX_SIDE = 4096, MAX_PIXELS = 4_000_000;
  const $ = id => document.getElementById(id);
  const canvas = $('image'), overlay = $('overlay');
  const names = {hair: '髪', face: '顔', outfit: '服'};
  const colors = {hair: '#ff4560', face: '#377bff', outfit: '#16a475'};
  const dimensionsOK = (w, h) => w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;
  let data = null, busy = false, version = 0;
  function controls() {
    $('source').disabled = !$('rights').checked || busy;
    $('tools').disabled = !data || !$('rights').checked || busy;
    $('save').disabled = !data || !$('rights').checked || busy ||
      !Object.values(data.points).some(Boolean);
  }
  function render() {
    overlay.replaceChildren();
    if (!data) return;
    const lines = [];
    for (const [part, point] of Object.entries(data.points)) {
      lines.push(`${names[part]}: ${point ? `X=${point.x}, Y=${point.y}` : '未選択'}`);
      if (!point) continue;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.left = `${(point.x + 0.5) / data.width * 100}%`;
      dot.style.top = `${(point.y + 0.5) / data.height * 100}%`;
      dot.style.color = colors[part];
      dot.textContent = `● ${names[part]}`;
      overlay.append(dot);
    }
    $('coordinates').textContent = lines.join(' / ');
    controls();
  }
  $('rights').addEventListener('change', () => { version++; controls(); });
  $('clear').addEventListener('click', () => {
    if (!data || !$('rights').checked || busy) return;
    data.points[$('part').value] = null; render();
  });
  canvas.addEventListener('pointerdown', event => {
    if (!data || busy || !$('rights').checked || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(data.width - 1, Math.floor((event.clientX - rect.left) * data.width / rect.width)));
    const y = Math.max(0, Math.min(data.height - 1, Math.floor((event.clientY - rect.top) * data.height / rect.height)));
    data.points[$('part').value] = {x, y}; render(); event.preventDefault();
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
    return { buffer, blob: new Blob([buffer], { type: 'image/png' }), width: view.getUint32(16), height: view.getUint32(20) };
  }
  $('source').addEventListener('change', async () => {
    const file = $('source').files[0];
    if (!file || busy || !$('rights').checked) return;
    if (data && !window.confirm('現在の点を破棄して別の元画像を開きますか？')) { $('source').value = ''; return; }
    const ticket = ++version;
    busy = true; controls();
    let url;
    try {
      const png = await validatePNG(file);
      const hash = await crypto.subtle.digest('SHA-256', png.buffer);
      url = URL.createObjectURL(png.blob);
      const image = new Image(); image.src = url; await image.decode();
      if (image.naturalWidth !== png.width || image.naturalHeight !== png.height) throw new Error('画像寸法が一致しません。');
      if (ticket !== version || !$('rights').checked) return;
      data = {schema_version: 1, source: file.name, width: png.width, height: png.height,
        sha256: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join(''),
        points: {hair: null, face: null, outfit: null}};
      canvas.width = data.width; canvas.height = data.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      $('status').textContent = `${data.width} × ${data.height}px。元画像だけを見て点を選択してください。`;
      render();
    } catch (_) { $('status').textContent = 'PNGを読み込めません。形式・上限・SHA-256対応を確認してください。'; }
    finally { if (url) URL.revokeObjectURL(url); busy = false; $('source').value = ''; controls(); }
  });
  $('save').addEventListener('click', () => {
    if (!data || busy || !$('rights').checked || !Object.values(data.points).some(Boolean)) return;
    if (!window.confirm('正解マスクを見る前に元画像だけから点を選びましたか？自己申告であり正直さを証明できません。点のJSONのみ保存します。新しい保存先を選んでください。')) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url;
    link.download = `seeds_${Date.now()}_${crypto.randomUUID()}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $('status').textContent = 'JSONのダウンロードを開始しました。';
  });
  controls();
})();
