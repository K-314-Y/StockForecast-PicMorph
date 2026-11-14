/* Original offline prediction tool. No semantic model and no gold-mask input. */
"use strict";
(() => {
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_SIDE = 4096;
  const MAX_PIXELS = 4_000_000;
  const CPU_MAX_PIXELS = 2_000_000;
  const MAX_COVERAGE = 0.70;
  const CHUNK = 15_000;
  const MAX_MS = 15_000;
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  function dimensions(w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
        w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
      throw new Error("寸法制限（各辺4096・400万画素）を超えています。");
    }
    if (w * h > CPU_MAX_PIXELS) throw new Error("CPU保護のため200万画素以下にしてください。");
  }
  function validatePNG(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    if (bytes.length > MAX_BYTES) throw new Error("8 MiBを超えています。");
    const signature = [137,80,78,71,13,10,26,10];
    if (bytes.length < 45 || !signature.every((v, i) => bytes[i] === v)) throw new Error("PNG署名が不正です。");
    let offset = 8, width = 0, height = 0, dataSeen = false, ended = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw new Error("PNGチャンクが途中で切れています。");
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) throw new Error("PNGチャンク長が不正です。");
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new Error("APNGアニメーションは扱えません。");
      if (offset === 8 && type !== "IHDR") throw new Error("IHDRがありません。");
      if (type === "IHDR") {
        if (offset !== 8 || length !== 13) throw new Error("IHDRが不正です。");
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
        dimensions(width, height);
      }
      if (type === "IDAT") dataSeen = true;
      offset += length + 12;
      if (type === "IEND") {
        if (length !== 0 || offset !== bytes.length || !dataSeen) throw new Error("IENDが不正です。");
        ended = true; break;
      }
    }
    if (!ended) throw new Error("IENDがありません。");
    return { width, height };
  }
  function mapPoint(rect, clientX, clientY, width, height) {
    if (!rect.width || !rect.height || clientX < rect.left || clientY < rect.top ||
        clientX >= rect.left + rect.width || clientY >= rect.top + rect.height) return null;
    return { x: Math.floor((clientX - rect.left) * width / rect.width),
      y: Math.floor((clientY - rect.top) * height / rect.height) };
  }
  // A failed adaptive parent edge must remain retryable by another selected parent.
  async function grow(rgba, width, height, x, y, options = {}, alive = () => true, pause = frame) {
    dimensions(width, height);
    if (rgba.length !== width * height * 4) throw new Error("画素データ長が不正です。");
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new Error("開始点が画像外です。");
    const { method = "seeded", tolerance = 20, step = 18, drift = 90 } = options;
    if (!["seeded", "adaptive-seeded"].includes(method)) throw new Error("方式が不正です。");
    for (const v of [tolerance, step, drift]) if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error("色差は0〜255の整数です。");
    const total = width * height, seed = y * width + x, limit = Math.floor(total * MAX_COVERAGE);
    if (rgba[seed * 4 + 3] < 16) throw new Error("開始点が透明です（alpha < 16）。見える点を選んでください。");
    const visited = new Uint8Array(total), selected = new Uint8Array(total), queue = new Uint32Array(total);
    let head = 0, tail = 1, count = 1, touchedBoundary = false;
    queue[0] = seed; visited[seed] = 1; selected[seed] = 1;
    const start = performance.now();
    const check = () => {
      if (!alive()) throw new Error("処理を取り消しました。");
      if (performance.now() - start > MAX_MS) throw new Error("CPU保護の15秒制限で中止しました。小さい画像で再試行してください。");
    };
    const diff = (a, b) => Math.max(Math.abs(rgba[a*4]-rgba[b*4]), Math.abs(rgba[a*4+1]-rgba[b*4+1]), Math.abs(rgba[a*4+2]-rgba[b*4+2]));
    function neighbor(index, parent) {
      if (visited[index]) return;
      if (rgba[index*4+3] < 16 || diff(index, seed) > (method === "seeded" ? tolerance : drift)) { visited[index] = 1; return; }
      if (method === "adaptive-seeded" && diff(index, parent) > step) return;
      visited[index] = 1; selected[index] = 1;
      if (++count > limit) throw new Error("選択が全画素の70%を超えたため拒否しました。点・色差を変更してください。");
      queue[tail++] = index;
    }
    if (count > limit) throw new Error("選択が全画素の70%を超えたため拒否しました。");
    check();
    while (head < tail) {
      const pos = queue[head++], px = pos % width, py = Math.floor(pos / width);
      touchedBoundary ||= px === 0 || py === 0 || px === width-1 || py === height-1;
      if (px > 0) neighbor(pos-1, pos);
      if (px+1 < width) neighbor(pos+1, pos);
      if (py > 0) neighbor(pos-width, pos);
      if (py+1 < height) neighbor(pos+width, pos);
      if (head % CHUNK === 0) { await pause(); check(); }
    }
    check();
    if (!count) throw new Error("選択画素がありません。");
    return { selected, count, coverage: count / total, touchedBoundary };
  }
  function maskBytes(selected) {
    const output = new Uint8ClampedArray(selected.length * 4);
    for (let i = 0; i < selected.length; i++) if (selected[i]) output.set([255,255,255,255], i*4);
    return output;
  }
  // Node-only regression access; a classic script keeps file:// independent of module CORS.
  if (typeof module !== "undefined" && module.exports) module.exports = { grow, validatePNG, mapPoint, maskBytes };
  if (typeof document === "undefined") return;
  const el = id => document.getElementById(id);
  const rights = el("rights"), source = el("source"), canvas = el("preview"), save = el("export");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let pixels = null, result = null, token = 0, serial = 0;
  function status(message) { el("status").textContent = message; }
  function invalidate(message) {
    token++; result = null; save.disabled = true; el("cancel").disabled = true;
    if (pixels) ctx.putImageData(pixels, 0, 0);
    if (message) status(message);
  }
  function reset() {
    invalidate(); pixels = null; source.value = ""; canvas.width = canvas.height = 1;
    el("settings").disabled = el("seedControls").disabled = true;
    el("dimensions").textContent = "元画像未読込";
  }
  rights.addEventListener("change", () => {
    reset(); source.disabled = !rights.checked;
    status(rights.checked ? "元PNGを手動で選んでください。" : "権利確認が必要です。画像と予測を破棄しました。");
  });
  source.addEventListener("change", async () => {
    const file = source.files[0]; reset(); const current = token;
    if (!rights.checked || !file) return;
    let url;
    try {
      if (!/\.png$/i.test(file.name) || (file.type && file.type !== "image/png")) throw new Error("元画像はPNGのみです。");
      if (file.size > MAX_BYTES) throw new Error("8 MiBを超えています。");
      status("PNGを検査・復号しています…");
      const info = validatePNG(await file.arrayBuffer());
      if (current !== token || !rights.checked) return;
      url = URL.createObjectURL(file);
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("PNGを復号できません。")); image.src = url; });
      if (current !== token || !rights.checked) return;
      if (image.naturalWidth !== info.width || image.naturalHeight !== info.height) throw new Error("復号後の寸法が一致しません。");
      canvas.width = info.width; canvas.height = info.height;
      ctx.drawImage(image, 0, 0);
      pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      el("settings").disabled = el("seedControls").disabled = false;
      el("seedX").max = canvas.width-1; el("seedY").max = canvas.height-1;
      el("dimensions").textContent = `元画像：${canvas.width} × ${canvas.height} px（内部画素は原寸）`;
      status("画像の点をクリックして予測してください。正解マスクは使用しません。");
    } catch (error) { if (current === token) { reset(); status(error.message); } }
    finally { if (url) URL.revokeObjectURL(url); }
  });
  for (const id of ["part", "method", "tolerance", "step", "drift", "seedX", "seedY"]) {
    el(id).addEventListener("input", () => invalidate("条件が変わりました。開始点を指定し直してください。"));
  }
  el("cancel").addEventListener("click", () => invalidate("処理・予測を取り消しました。"));
  async function select(x, y) {
    invalidate();
    if (!rights.checked || !pixels) { status("権利確認と元PNGの読込が必要です。"); return; }
    const current = token, original = pixels;
    const options = { method: el("method").value, tolerance: Number(el("tolerance").value), step: Number(el("step").value), drift: Number(el("drift").value) };
    const part = el("part").value;
    el("cancel").disabled = false; status("CPUで予測中…（取り消し可能）");
    const alive = () => current === token && rights.checked;
    try {
      for (const id of ["tolerance", "step", "drift"]) if (!el(id).value.trim()) throw new Error("色差の数値を入力してください。");
      const grown = await grow(original.data, original.width, original.height, x, y, options, alive);
      const overlay = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
      for (let i = 0; i < grown.selected.length; i++) {
        if (grown.selected[i]) {
          overlay.data[i*4] = Math.round(original.data[i*4]*0.5 + 255*0.5);
          overlay.data[i*4+1] = Math.round(original.data[i*4+1]*0.5 + 64*0.5);
          overlay.data[i*4+2] = Math.round(original.data[i*4+2]*0.5 + 150*0.5);
          overlay.data[i*4+3] = Math.max(original.data[i*4+3], 160);
        }
        if (i && i % CHUNK === 0) { await frame(); if (!alive()) return; }
      }
      if (!alive()) return;
      ctx.putImageData(overlay, 0, 0);
      result = { ...grown, part, method: options.method, seedX: x, seedY: y, options };
      save.disabled = false; el("cancel").disabled = false;
      status(`推測：${part} / ${options.method}（AI意味解析ではありません）\n開始点 (${x}, ${y})：${grown.count}画素 / ${(grown.coverage*100).toFixed(2)}% ／ 画像端への到達：${grown.touchedBoundary ? "あり（漏出を確認）" : "なし"}`);
    } catch (error) { if (alive()) invalidate(`選択失敗：${error.message}`); }
  }
  canvas.addEventListener("click", event => {
    if (!pixels) return;
    const point = mapPoint(canvas.getBoundingClientRect(), event.clientX, event.clientY, pixels.width, pixels.height);
    if (point) { el("seedX").value = point.x; el("seedY").value = point.y; select(point.x, point.y); }
  });
  el("run").addEventListener("click", () => {
    if (!el("seedX").value.trim() || !el("seedY").value.trim()) { invalidate("元画素座標を入力してください。"); return; }
    select(Number(el("seedX").value), Number(el("seedY").value));
  });
  save.addEventListener("click", async () => {
    if (!rights.checked || !pixels || !result || !result.count) return;
    if (!window.confirm("予測（正解ではありません）の白色マスクPNGを保存しますか？派生画像の作成権利と保存先を確認してください。")) return;
    const current = token, chosen = result;
    save.disabled = true;
    try {
      const output = document.createElement("canvas"); output.width = pixels.width; output.height = pixels.height;
      output.getContext("2d").putImageData(new ImageData(maskBytes(chosen.selected), output.width, output.height), 0, 0);
      const blob = await new Promise(resolve => output.toBlob(resolve, "image/png"));
      if (current !== token || !rights.checked || result !== chosen) return;
      if (!blob) throw new Error("PNGの生成に失敗しました。");
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      const stamp = `${Date.now()}_${++serial}_${crypto.randomUUID()}`;
      const params = chosen.method === "seeded"
        ? `t${chosen.options.tolerance}` : `step${chosen.options.step}_drift${chosen.options.drift}`;
      link.download = `creature_prediction_${chosen.part}_${chosen.method}_x${chosen.seedX}_y${chosen.seedY}_${params}_${stamp}.png`;
      link.href = url; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status("予測マスクの保存をブラウザに依頼しました。正解として自己評価に使用しないでください。");
    } catch (error) { if (current === token) status(error.message); }
    finally { if (current === token && rights.checked && result) save.disabled = false; }
  });
})();
