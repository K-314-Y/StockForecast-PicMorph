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
  // Binary masks only; never changes either input. Empty union has no defined IoU.
  function compareSelections(fixed, adaptive) {
    if (!(fixed instanceof Uint8Array) || !(adaptive instanceof Uint8Array) || fixed.length !== adaptive.length) {
      throw new Error("比較マスクの型または長さが不正です。");
    }
    let fixedCount = 0, adaptiveCount = 0, intersection = 0, union = 0, disagreementCount = 0;
    const disagreement = new Uint8Array(fixed.length);
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i] > 1 || adaptive[i] > 1) throw new Error("比較マスクは0または1です。");
      const a = fixed[i], b = adaptive[i];
      fixedCount += a; adaptiveCount += b;
      intersection += a && b ? 1 : 0; union += a || b ? 1 : 0;
      disagreement[i] = a !== b ? 1 : 0;
      disagreementCount += disagreement[i];
    }
    return { fixedCount, adaptiveCount, intersection, union, iou: union ? intersection / union : null, disagreementCount, disagreement };
  }
  function maskBytes(selected) {
    const output = new Uint8ClampedArray(selected.length * 4);
    for (let i = 0; i < selected.length; i++) if (selected[i]) output.set([255,255,255,255], i*4);
    return output;
  }
  // Node-only regression access; a classic script keeps file:// independent of module CORS.
  if (typeof module !== "undefined" && module.exports) module.exports = { grow, validatePNG, mapPoint, maskBytes, compareSelections };
  if (typeof document === "undefined") return;
  const el = id => document.getElementById(id);
  const rights = el("rights"), source = el("source"), canvas = el("preview"), save = el("export");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let pixels = null, result = null, comparison = null, token = 0, serial = 0;
  let compareMode = false;
  function status(message) { el("status").textContent = message; }
  function invalidate(message) {
    token++; result = null; comparison = null;
    el("comparison").hidden = true; el("comparisonStats").textContent = "";
    el("comparisonExport").value = ""; el("comparisonExport").disabled = true;
    for (const id of ["fixedPreview", "adaptivePreview", "differencePreview"]) el(id).width = el(id).height = 1; save.disabled = true; el("cancel").disabled = true;
    if (pixels) ctx.putImageData(pixels, 0, 0);
    if (message) status(message);
  }
  function reset() {
    compareMode = false;
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
    el(id).addEventListener("input", () => {
      compareMode = false;
      invalidate("条件が変わりました。開始点を指定し直してください。");
    });
  }
  el("cancel").addEventListener("click", () => {
    compareMode = false;
    invalidate("処理・予測を取り消しました。");
  });
  async function select(x, y) {
    compareMode = false;
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
  async function compare(x, y) {
    invalidate(); compareMode = true;
    if (!rights.checked || !pixels) { status("権利確認と元PNGの読込が必要です。"); return; }
    const current = token, original = pixels, part = el("part").value;
    const options = { tolerance: Number(el("tolerance").value), step: Number(el("step").value), drift: Number(el("drift").value) };
    const alive = () => current === token && rights.checked;
    const results = {}, lines = [`比較：${part} / 開始点 (${x}, ${y}) / fixed t=${options.tolerance}, adaptive step=${options.step}, drift=${options.drift}`];
    el("comparison").hidden = false; el("cancel").disabled = false;
    try {
      for (const id of ["tolerance", "step", "drift"]) if (!el(id).value.trim()) throw new Error("色差の数値を入力してください。");
      for (const method of ["seeded", "adaptive-seeded"]) {
        status(`比較中：${method}（各方式15秒まで・取り消し可能）`);
        await frame(); if (!alive()) return;
        try {
          const grown = await grow(original.data, original.width, original.height, x, y, { ...options, method }, alive);
          if (!alive()) return;
          results[method] = { ...grown, part, method, seedX: x, seedY: y, options: { ...options, method } };
          lines.push(`${method}：${grown.count}画素 / ${(grown.coverage * 100).toFixed(2)}%`);
          if (grown.touchedBoundary) lines.push(`警告 ${method}：画像端に到達。背景への漏出の可能性。`);
          if (grown.coverage >= 0.25) lines.push(`警告 ${method}：被覆率25%以上（目安であり失敗判定ではありません）。背景への漏出を確認。`);
        } catch (error) {
          if (!alive()) return;
          lines.push(`${method}：失敗 — ${error.message}`);
        }
        el("comparisonStats").textContent = lines.join("\n");
      }
      const fixed = results.seeded, adaptive = results["adaptive-seeded"];
      if (fixed && adaptive) {
        const metrics = compareSelections(fixed.selected, adaptive.selected);
        lines.push(`共通 ${metrics.intersection}画素 / 和集合 ${metrics.union}画素 / IoU ${metrics.iou === null ? "未定義（両方空）" : metrics.iou.toFixed(4)} / 不一致 ${metrics.disagreementCount}画素`);
        if (metrics.iou !== null && metrics.iou < 0.75) lines.push("警告：方式間の一致度が0.75未満。見逃し・背景への漏出を確認してください。");
      } else lines.push("一方または両方が失敗したため、IoU・不一致は算出しません。失敗を空マスクとして扱いません。成功側のみ単独色で表示し、差・重なりのペインは未算出です。");
      lines.push("方式間の一致度であり、正解との精度ではありません");
      for (const [id, mode] of [["fixedPreview", "fixed"], ["adaptivePreview", "adaptive"], ["differencePreview", "both"]]) {
        const pane = el(id); pane.width = original.width; pane.height = original.height;
        const overlay = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
        for (let i = 0; i < original.width * original.height; i++) {
          const a = fixed && fixed.selected[i], b = adaptive && adaptive.selected[i];
          // Missing results are not interpreted as empty masks or a measured difference.
          // A partial success remains visible in every pane, but is NOT
          // interpreted as disagreement when the other method failed.
          const color = a && b ? [160,80,208]
            : a ? [239,136,0] : b ? [0,190,210] : null;
          const show = mode === "both" ? a || b : mode === "fixed" ? a : b;
          const tint = color && show ? color : null;
          for (let c = 0; c < 3; c++) {
            const gray = (original.data[i*4] + original.data[i*4+1] + original.data[i*4+2]) / 3;
            overlay.data[i*4+c] = tint ? Math.round(original.data[i*4+c]*0.35 + tint[c]*0.65) : gray;
          }
          if (tint) overlay.data[i*4+3] = Math.max(original.data[i*4+3], 180);
          if (i && i % CHUNK === 0) { await frame(); if (!alive()) return; }
        }
        if (!alive()) return;
        pane.getContext("2d").putImageData(overlay, 0, 0);
      }
      if (!alive()) return;
      comparison = results;
      const choice = el("comparisonExport");
      for (const option of choice.options) if (option.value) option.disabled = !results[option.value];
      choice.disabled = !fixed && !adaptive;
      el("comparisonStats").textContent = lines.join("\n");
      status("比較完了。保存する場合は方式を明示的に選択してください。失敗・警告も確認してください。");
    } catch (error) { if (alive()) invalidate(`比較失敗：${error.message}`); }
  }
  // This choice changes only the export target; it must not cancel a comparison.
  el("comparisonExport").addEventListener("change", () => {
    result = comparison && comparison[el("comparisonExport").value] || null;
    save.disabled = !result;
  });
  el("compare").addEventListener("click", () => {
    if (!el("seedX").value.trim() || !el("seedY").value.trim()) { invalidate("元画素座標を入力してください。"); return; }
    return compare(Number(el("seedX").value), Number(el("seedY").value));
  });
  canvas.addEventListener("click", event => {
    if (!pixels) return;
    const point = mapPoint(canvas.getBoundingClientRect(), event.clientX, event.clientY, pixels.width, pixels.height);
    if (point) { el("seedX").value = point.x; el("seedY").value = point.y; (compareMode ? compare : select)(point.x, point.y); }
  });
  el("run").addEventListener("click", () => {
    if (!el("seedX").value.trim() || !el("seedY").value.trim()) { invalidate("元画素座標を入力してください。"); return; }
    return select(Number(el("seedX").value), Number(el("seedY").value));
  });
  save.addEventListener("click", async () => {
    if (!rights.checked || !pixels || !result || !result.count) return;
    if (comparison && comparison[el("comparisonExport").value] !== result) return;
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
