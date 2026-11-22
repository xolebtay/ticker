"use strict";
// Receipt scanning: photo -> cleaned image -> Tesseract text -> draft receipt lines.
// The parser is plain functions so it can be tested outside the browser (Node).

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

// ── Image clean-up (crop to the paper, then black-and-white or grey) ─────────
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not open this photo")); };
    img.src = url;
  });
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0; for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wb = 0, sb = 0, best = 128, bestV = -1;
  for (let t = 0; t < 256; t++) {
    wb += hist[t]; if (!wb || wb === total) continue;
    sb += t * hist[t];
    const mb = sb / wb, mf = (sumAll - sb) / (total - wb), v = wb * (total - wb) * (mb - mf) ** 2;
    if (v > bestV) { bestV = v; best = t; }
  }
  return best;
}

function longestRun(fracs, thr) {
  let best = [0, fracs.length], bestLen = 0, start = 0, len = 0;
  for (let i = 0; i <= fracs.length; i++) {
    if (i < fracs.length && fracs[i] >= thr) { if (!len) start = i; len++; }
    else { if (len > bestLen) { bestLen = len; best = [start, start + len]; } len = 0; }
  }
  return bestLen ? best : [0, fracs.length];
}

// Returns two canvases: [black-and-white, contrast-stretched grey]
function prepareImages(img) {
  const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h), paper = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  const t = otsu(gray);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    paper[i] = mx > t && mx - mn < 30 ? 1 : 0;
  }
  const colF = [];
  for (let x = 0; x < w; x++) { let n = 0, k = 0; for (let y = 0; y < h; y += 4) { n += paper[y * w + x]; k++; } colF.push(n / k); }
  let [x0, x1] = longestRun(colF, 0.35);
  const rowF = [];
  for (let y = 0; y < h; y++) { let n = 0, k = 0; for (let x = x0; x < x1; x += 4) { n += paper[y * w + x]; k++; } rowF.push(n / k); }
  let [y0, y1] = longestRun(rowF, 0.3);
  // Crop looks wrong (too small) -> use the whole photo
  if ((x1 - x0) * (y1 - y0) < w * h * 0.08) { x0 = 0; x1 = w; y0 = 0; y1 = h; }

  const cw = x1 - x0, ch = y1 - y0, up = cw < 1200 ? 1200 / cw : 1;
  const W = Math.round(cw * up), H = Math.round(ch * up);
  const g2 = document.createElement("canvas"); g2.width = W; g2.height = H;
  const gctx = g2.getContext("2d", { willReadFrequently: true });
  gctx.imageSmoothingQuality = "high";
  gctx.drawImage(c, x0, y0, cw, ch, 0, 0, W, H);
  const d = gctx.getImageData(0, 0, W, H), dp = d.data;
  const g = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = (dp[i * 4] * 299 + dp[i * 4 + 1] * 587 + dp[i * 4 + 2] * 114) / 1000;

  // Grey variant: stretch contrast (2% cut-off each side)
  const hist = new Array(256).fill(0); for (const v of g) hist[v]++;
  let lo = 0, hi = 255, acc = 0, cut = W * H * 0.02;
  while (lo < 255 && (acc += hist[lo]) < cut) lo++;
  acc = 0; while (hi > 0 && (acc += hist[hi]) < cut) hi--;
  const greyData = gctx.createImageData(W, H), bwData = gctx.createImageData(W, H);
  // Black-and-white variant: darker than the local average -> black (integral image box mean)
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y++) { let row = 0; for (let x = 1; x <= W; x++) { row += g[(y - 1) * W + x - 1]; integ[y * (W + 1) + x] = integ[(y - 1) * (W + 1) + x] + row; } }
  const R = Math.max(8, Math.floor(W / 40));
  for (let y = 0; y < H; y++) {
    const ya = Math.max(0, y - R), yb = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const xa = Math.max(0, x - R), xb = Math.min(W, x + R + 1);
      const sum = integ[yb * (W + 1) + xb] - integ[ya * (W + 1) + xb] - integ[yb * (W + 1) + xa] + integ[ya * (W + 1) + xa];
      const mean = sum / ((yb - ya) * (xb - xa)), i = y * W + x;
      const bw = g[i] < mean - 12 ? 0 : 255;
      const gv = hi > lo ? Math.max(0, Math.min(255, (g[i] - lo) * 255 / (hi - lo))) : g[i];
      bwData.data.set([bw, bw, bw, 255], i * 4);
      greyData.data.set([gv, gv, gv, 255], i * 4);
    }
  }
  const out = [bwData, greyData].map(data => {
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    cv.getContext("2d").putImageData(data, 0, 0); return cv;
  });
  return out;
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("Could not load the text reader. Scanning needs internet the first time."));
    document.head.appendChild(s);
  });
}

// Full scan: reads the photo several ways and combines the lines whose maths checks out.
// onStatus(text) shows progress.
async function scanReceipt(file, ctx, onStatus) {
  onStatus("Opening photo...");
  const img = await loadImage(file);
  onStatus("Cleaning up the photo...");
  await new Promise(r => setTimeout(r, 30));
  const [bw, grey] = prepareImages(img);
  // Each reading mode tends to catch different lines on the same receipt
  const passes = [[bw, "3"], [grey, "6"], [grey, "4"], [bw, "6"]];
  onStatus("Loading the text reader (first time can take a while)...");
  const T = await loadTesseract();
  let pass = 0;
  const worker = await T.createWorker("eng", 1, {
    logger: m => { if (m.status === "recognizing text") onStatus(`Reading text, pass ${pass} of ${passes.length}... ${Math.round(m.progress * 100)}%`); }
  });
  const results = [];
  const debug = { version: "scan-v2", image: { w: bw.width, h: bw.height }, texts: [],
    pictures: [bw.toDataURL("image/png"), grey.toDataURL("image/jpeg", 0.8)] };
  let merged = null;
  try {
    for (const [canvas, psm] of passes) {
      pass++;
      await worker.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(canvas);
      debug.texts.push({ pass, mode: (canvas === bw ? "bw" : "grey") + " psm" + psm, text: data.text });
      results.push(parseReceipt(data.text, ctx));
      merged = finalize(mergeAll(results), ctx);
      if (merged.balanced) break;   // lines add up to the printed total - done
    }
  } finally {
    await worker.terminate();
  }
  merged.debug = debug;
  return merged;
}

// Start from the cleanest reading, then add checked lines from the others
function mergeAll(results) {
  return [...results].sort((a, b) => b.score - a.score).reduce((m, r) => mergeResults(m, r), null);
}

// Last tidy-up once the shop is known: match names again, and for lines where only the amount was
// readable, look for an item bought at this shop before whose old price divides the amount evenly
// (e.g. 59.20 at Petron = 8 x Magnum Almond at 7.40). Such guesses stay marked "Please check".
function finalize(res, ctx) {
  const items = (ctx && ctx.items) || [];
  const used = new Set(res.lines.filter(l => l.known).map(l => l.item));
  res.lines = res.lines.map(l => {
    if (l.item === "Rounding Adj") return l;
    let out = { ...l };
    if (!out.known) {
      const k = matchItem(out.read || out.item, items, res.shop);
      if (k) out = { ...out, item: k.name, unit: k.unit, category: k.cat, known: true };
    }
    if (!out.verified && res.shop && (!out.known || Math.abs(out.qty - 1) < 1e-9)) {
      const fits = items.filter(it => it.places && it.places.has(res.shop) && it.last > 0 && !used.has(it.name) &&
        it.cat !== "Petrol").map(it => ({ it, n: out.total / it.last }))
        .filter(c => c.n >= 1 && c.n <= 60 && Math.abs(c.n - Math.round(c.n)) < 0.002);
      const sameName = out.known && fits.find(c => c.it.name === out.item);
      const pickC = sameName || (!out.known && fits.length === 1 ? fits[0] : null);
      if (pickC) {
        const n = Math.round(pickC.n);
        out = { ...out, item: pickC.it.name, unit: pickC.it.unit, category: pickC.it.cat, qty: n, price: pickC.it.last, known: true, guessed: true };
        used.add(pickC.it.name);
      }
    }
    return out;
  });
  return res;
}

// Combine two readings of the same receipt: keep a, fill gaps from b with arithmetic-checked lines
function mergeResults(a, b) {
  if (!a) return b;
  const out = { ...a, lines: a.lines.map(l => ({ ...l })) };
  if (!out.shop && b.shop) { out.shop = b.shop; out.surcharge = b.surcharge; }
  if (!out.date && b.date) out.date = b.date;
  if (out.total == null && b.total != null) out.total = b.total;
  const rIdx = out.lines.findIndex(l => l.item === "Rounding Adj");
  if (rIdx < 0) { const r = b.lines.find(l => l.item === "Rounding Adj"); if (r) out.lines.push({ ...r }); }
  const taken = new Set();
  const sumOf = ls => r2(ls.reduce((s, l) => s + l.total, 0));
  for (const L of b.lines) {
    if (!L.verified || L.item === "Rounding Adj") continue;
    const k = out.lines.findIndex((x, i) => !taken.has(i) && x.item !== "Rounding Adj" && close(x.total, L.total));
    if (k >= 0) {
      taken.add(k);
      if (!out.lines[k].verified) {   // same amount, but b read the details properly
        const keepName = out.lines[k].known && !L.known;
        out.lines[k] = keepName ? { ...L, item: out.lines[k].item, known: true } : { ...L };
      }
      continue;
    }
    if (out.total != null && sumOf(out.lines) + L.total > out.total + MONEY_TOL) {
      // A checked line beats unchecked guesses: drop unchecked lines until it fits
      const loose = out.lines.map((x, i) => ({ x, i })).filter(o => !o.x.verified && o.x.item !== "Rounding Adj" && !taken.has(o.i));
      let need = r2(sumOf(out.lines) + L.total - out.total);
      const drop = new Set();
      for (const o of loose.sort((p, q) => Math.abs(p.x.total - need) - Math.abs(q.x.total - need))) {
        if (need <= MONEY_TOL) break;
        drop.add(o.i); need = r2(need - o.x.total);
      }
      if (need > MONEY_TOL) continue;   // still would not fit - skip it
      const keep = out.lines.filter((_, i) => !drop.has(i));
      const remap = new Set();
      out.lines.forEach((x, i) => { if (taken.has(i) && !drop.has(i)) remap.add(keep.indexOf(x)); });
      out.lines = keep; taken.clear(); remap.forEach(i => taken.add(i));
    }
    const at = out.lines.findIndex(l => l.item === "Rounding Adj");
    if (at >= 0) out.lines.splice(at, 0, { ...L }); else out.lines.push({ ...L });
    taken.add(at >= 0 ? at : out.lines.length - 1);
  }
  out.sum = sumOf(out.lines);
  out.balanced = out.total != null && close(out.sum, out.total);
  out.score = out.lines.filter(l => l.verified).length * 2 + out.lines.length + (out.balanced ? 20 : 0);
  return out;
}

// ── Text -> receipt ─────────────────────────────────────────────────────────
const MONEY_TOL = 0.011;
const r2 = x => Math.round(x * 100 + (x >= 0 ? 1e-6 : -1e-6)) / 100;
const close = (a, b) => Math.abs(a - b) <= MONEY_TOL;
const STOP_RE = /\b(su[bp]\s*-?\s*tota|tota[l1]|quantity\s*:|rounding|amount\s*due|cash|change|card|visa|master)/i;
const TOTAL_RE = /(net\s*total|grand\s*total|total\s*(rm|amount|due)?\s*:?|amount\s*due|jumlah)/i;
const NOT_TOTAL_RE = /(sub|sales|quantity|units|item|qty|saving|discount)/i;
const ROUND_RE = /round/i;
const STAR_RE = /[*x#%+«¥]\s*(\d{1,3}(?:\.\d+)?)(?![\d.])/i;

function normDigits(line) {
  return line
    .replace(/([*x#%+«¥]\s*\d)\s+(\d{3})\b/gi, "$1.$2")   // "x2 525" -> "x2.525"
    .replace(/(\d)\s*[_,]\s*(\d)/g, "$1.$2")
    .replace(/(\d)¢/g, "$14")
    .replace(/(\d)[Oo](?=\d|\b)/g, "$10");
}

function numbersIn(line) {
  const out = [];
  const re = /-?\d+\.\d+|\b\d+\b/g;
  let m;
  while ((m = re.exec(line))) {
    const s = m[0];
    if (!s.includes(".") && s.replace("-", "").length >= 4) continue;   // barcode / code
    out.push({ v: parseFloat(s), s, i: m.index, dec: s.includes(".") ? s.split(".")[1].length : 0 });
  }
  return out;
}

const letters = s => (s.match(/[a-z]/gi) || []).length;
function isNumberLine(line) {
  const l = line.replace(/\b\d+(\.\d+)?\s*[lL]\b/g, "0").replace(/^\W*[a-zA-Z]\W/, "");
  return letters(l) <= 3 && numbersIn(l).some(n => n.dec === 2 || n.dec === 3 || STAR_RE.test(l));
}

// Trailing unit price on a name line: "SAYUR @5.50" (OCR often reads @ as 8, e, €, 2, 0)
function splitNamePrice(line) {
  const m = line.match(/\s([@€£eE80-9]?)(\d+\.\d{2})((\s+\S{1,3})*)[^a-z0-9]*$/i);
  if (!m) return { name: line, prices: [] };
  const raw = m[2], prices = [parseFloat(raw)];
  if (m[1] && /\d/.test(m[1])) prices.push(parseFloat(m[1] + raw));
  if (raw.length > 4) prices.push(parseFloat(raw.slice(1)));   // "86.99" -> "6.99" when @ read as 8
  return { name: line.slice(0, m.index), prices };
}

function cleanName(s) {
  let t = s.replace(/[|\[\]{}©®“”"~_=]+/g, " ").replace(/\s+/g, " ").trim();
  let parts = t.split(" ");
  while (parts.length > 1 && parts[0].length === 1) parts.shift();          // leading noise like "3 " or "i "
  while (parts.length > 1 && parts[parts.length - 1].length === 1 && !/\d/.test(parts[parts.length - 1])) parts.pop();
  return parts.join(" ").replace(/^[^a-z0-9(]+|[^a-z0-9)%]+$/gi, "");
}

function validDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function parseDate(text) {
  const t = text.replace(/(\d)[Oo]/g, "$10").replace(/[Oo](\d)/g, "0$1");
  const m = t.match(/(?:^|[^\d])(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(20\d{2})(?!\d)/);
  if (m) { const r = validDate(m[3], +m[2], +m[1]); if (r) return r; }
  // Card slip style "Trans Date 261117" (YYMMDD)
  const s = t.match(/date\D{0,6}(\d{2})(\d{2})(\d{2})(?!\d)/i);
  if (s) return validDate("20" + s[1], +s[2], +s[3]);
  return null;
}

const tokens = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(t => t.length >= 2);
const tokMatch = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

function matchShop(lines, shops) {
  const head = tokens(lines.slice(0, 10).join(" "));
  let best = null, bestScore = 0;
  for (const s of shops) {
    const st = tokens(s.name.replace(/\b(sdn|bhd|s\/b|sb|enterprise)\b/gi, " ")).filter(t => t.length >= 3);
    if (!st.length) continue;
    const hit = st.filter(t => head.some(h => tokMatch(h, t))).length / st.length;
    if (hit > bestScore) { bestScore = hit; best = s; }
  }
  return bestScore >= 0.6 ? best : null;
}

function matchItem(name, items, place) {
  const ot = tokens(name);
  if (!ot.length) return null;
  let best = null, bestScore = 0;
  for (const it of items) {
    const kt = tokens(it.name);
    if (!kt.length) continue;
    const hitO = ot.filter(t => kt.some(k => tokMatch(t, k))).length;
    if (!hitO || !ot.some(t => t.length >= 3 && kt.some(k => tokMatch(t, k)))) continue;
    const hitK = kt.filter(k => ot.some(t => tokMatch(t, k))).length;
    let score = 0.7 * hitO / ot.length + 0.3 * hitK / kt.length;
    if (place && it.places && it.places.has(place)) score += 0.05;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 0.8 ? best : null;
}

const titleCase = s => s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());

// ctx: { items: [{name, unit, cat, places:Set}], shops: [{name, surcharge}], shopCats: {place: cat} }
function parseReceipt(text, ctx = { items: [], shops: [] }) {
  const lines = text.split(/\r?\n/).map(l => normDigits(l.trim())).filter(l => l && /[a-z0-9]/i.test(l));
  const shop = matchShop(lines, ctx.shops || []);
  const date = parseDate(text);

  // Item region: after the date line, up to the first total/subtotal line
  let start = 0;
  const di = lines.findIndex(l => /\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*20\d{2}/.test(l));
  if (di >= 0) start = di + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) if (STOP_RE.test(lines[i]) && letters(lines[i]) >= 4) { end = i; break; }

  // Totals and rounding (searched below the item region)
  let rounding = 0;
  const totalCands = [], subCands = [];
  for (let i = end; i < lines.length; i++) {
    const l = lines[i], nums = numbersIn(l).filter(n => n.dec === 2);
    const val = nums.length ? nums[nums.length - 1].v : null;
    if (ROUND_RE.test(l)) {
      if (val != null && Math.abs(val) <= 0.05) rounding = /-\s*\d|\(\s*\d/.test(l) ? -Math.abs(val) : val;
    } else if (/sub\s*-?\s*total|total\s*sales/i.test(l)) {
      if (val != null) subCands.push(val);
    } else if (TOTAL_RE.test(l) && !NOT_TOTAL_RE.test(l)) {
      if (val != null) totalCands.push(val);
    }
  }

  const found = [];
  let pending = null;       // { name, prices }
  const used = new Set();   // "line:index" of numbers already used as a line total
  const region = lines.slice(start, end);
  for (let i = 0; i < region.length; i++) {
    const line = region[i];
    if (isNumberLine(line)) {
      const nums = numbersIn(line).filter(n => !used.has(`${i}:${n.i}`));
      const star = line.match(STAR_RE);
      let qty = null, price = null, lt = null, verified = false;
      const last2 = [...nums].reverse().find(n => n.dec === 2);
      if (star) {
        qty = parseFloat(star[1]);
        if (last2 && last2.s !== star[1]) lt = last2.v;
        // total pushed onto the next line - only when that line is numbers, not the next item's name
        if (lt == null && i + 1 < region.length && letters(region[i + 1]) < 3) {
          const nx = numbersIn(region[i + 1]).filter(n => n.dec === 2).pop();
          if (nx) { lt = nx.v; used.add(`${i + 1}:${nx.i}`); }
        }
        const cands = pending ? pending.prices : [];
        let rebuilt = false;
        if (lt == null) {
          // total missing or misread (e.g. "3.4"): rebuild it from the @price when it fits
          const one = nums.find(n => n.dec === 1 && n.s !== star[1]);
          const p = cands.find(c => !one || Math.abs(r2(c * qty) - one.v) < 0.1);
          if (p != null && qty) { lt = r2(p * qty); rebuilt = true; }
        }
        const hit = lt != null && cands.find(p => close(r2(p * qty), lt));
        if (hit) { price = hit; verified = !rebuilt; }
        else if (lt != null && qty) price = Math.round(lt / qty * 100) / 100;
      } else {
        const vals = nums.map(n => n.v);
        // qty price total on one line ("8 7.40 59.20" / "44.128 4.200 185.34")
        outer: for (let a = 0; a < vals.length; a++) for (let b = a + 1; b < vals.length; b++) for (let c = b + 1; c < vals.length; c++) {
          if (close(r2(vals[a] * vals[b]), vals[c])) { qty = vals[a]; price = vals[b]; lt = vals[c]; verified = true; break outer; }
        }
        if (!verified && vals.length >= 2 && i + 1 < region.length) {
          // total moved to the end of the next line
          const nx = numbersIn(region[i + 1]).filter(n => n.dec === 2).pop();
          if (nx) for (let a = 0; a < vals.length && !verified; a++) for (let b = a + 1; b < vals.length; b++) {
            let q = vals[a];
            if (close(r2(q * vals[b]), nx.v)) {
              const s = String(q); if (s.includes(".") && s.split(".")[1].length > 3) q = parseFloat(s.slice(0, s.indexOf(".") + 4));
              if (!close(r2(q * vals[b]), nx.v)) q = vals[a];
              qty = q; price = vals[b]; lt = nx.v; verified = true; used.add(`${i + 1}:${nx.i}`); break;
            }
          }
        }
        if (!verified && last2) { lt = last2.v; qty = 1; price = lt; }
      }
      if (lt != null) {
        found.push({ name: pending ? pending.name : "", qty: qty || 1, price: price != null ? price : lt, total: lt, verified });
        pending = null;
      }
      continue;
    }
    // Text line. If the next line holds the numbers, this is a name line.
    const nextIsNum = i + 1 < region.length && isNumberLine(region[i + 1]);
    const cleaned = line.replace(/\bpump\s*\d+\b/i, "");
    const freeNums = numbersIn(cleaned).filter(n => n.dec === 2 && !used.has(`${i}:${n.i}`));
    if (!nextIsNum && freeNums.length && letters(cleaned) >= 3) {
      // Single-line item: "2 Laksa Johor 35.80"
      const last = freeNums[freeNums.length - 1];
      const lead = cleaned.match(/^\W*(\d{1,2})\s+[a-z]/i);
      const qty = lead ? parseInt(lead[1], 10) : 1;
      const sp = splitNamePrice(cleaned);
      const name = (sp.prices.length ? sp.name : cleaned.slice(0, last.i)).replace(/^\W*\d{1,2}\s+/, "");
      const cands = sp.prices.length > 1 ? sp.prices : null;   // "87.50" may really be "@7.50"
      found.push({ name, qty, price: r2(last.v / qty), total: last.v, verified: false, cands });
      pending = null;
    } else if (letters(cleaned) >= 3) {
      const usedHere = numbersIn(cleaned).filter(n => used.has(`${i}:${n.i}`));
      const base = usedHere.length ? cleaned.slice(0, usedHere[0].i) : cleaned;
      pending = splitNamePrice(base);
    }
  }

  let place = shop ? shop.name : null, surcharge = shop ? shop.surcharge : null;
  const named = found.filter(f => f.total !== 0 || f.name).map(f => {
    const rawName = cleanName(f.name) || "Item";
    return { f, rawName, known: matchItem(rawName, ctx.items || [], place) };
  });
  if (!place) {
    // Shop name unreadable: guess from where the recognised items were bought before
    const votes = {};
    for (const n of named) if (n.known && n.known.places) for (const p of n.known.places) votes[p] = (votes[p] || 0) + 1;
    const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      place = top[0];
      const s = (ctx.shops || []).find(s => s.name === place);
      surcharge = s ? s.surcharge : null;
    }
  }
  const lines2 = named.map(({ f, rawName, known }) => {
    if (f.cands && known && known.last) {
      const c = f.cands.reduce((a, b) => Math.abs(b - known.last) < Math.abs(a - known.last) ? b : a);
      f.price = c; f.total = r2(c * f.qty);
    }
    const petrol = /\b(blaze|ron\s*9\d|v-?power|diesel|petrol|primax)\b/i.test(rawName);
    const qtyR = Math.round(f.qty * 1000) / 1000;
    const unit = known ? known.unit : petrol ? "litre" : Number.isInteger(qtyR) ? "each" : "kg";
    const category = known ? known.cat : petrol ? "Petrol" : (place && ctx.shopCats && ctx.shopCats[place]) || "Groceries";
    return { item: known ? known.name : titleCase(rawName), read: rawName, qty: qtyR, unit, category,
      price: f.price, total: f.total, verified: f.verified, known: !!known };
  });
  const itemSum = r2(lines2.reduce((a, l) => a + l.total, 0));
  // Prefer the printed final total; fall back to subtotal + rounding. Ignore misreads far below the lines.
  const pick = list => {
    const ok = list.filter(v => v > 0 && v >= itemSum * 0.5);
    return ok.length ? ok.reduce((a, b) => Math.abs(b - itemSum) < Math.abs(a - itemSum) ? b : a) : null;
  };
  const target = pick(totalCands) ?? pick(subCands.map(s => r2(s + rounding)));
  // Rounding line not readable, but subtotal and total are: the difference is the rounding
  if (!rounding && target != null) {
    const sub = subCands.find(s => { const d = r2(target - s); return d !== 0 && Math.abs(d) <= 0.05; });
    if (sub != null) rounding = r2(target - sub);
  }
  if (rounding) lines2.push({ item: "Rounding Adj", read: "Rounding", qty: 1, unit: "-", category: lines2.length ? lines2[lines2.length - 1].category : "Groceries",
    price: rounding, total: rounding, verified: true, known: true });

  const sum = r2(lines2.reduce((a, l) => a + l.total, 0));
  const balanced = target != null && close(sum, target);
  const score = lines2.filter(l => l.verified).length * 2 + lines2.length + (balanced ? 20 : 0);
  return { shop: place, surcharge, date, total: target, sum, balanced, score, lines: lines2 };
}

if (typeof module !== "undefined") module.exports = { parseReceipt, mergeResults, mergeAll, finalize, matchItem, matchShop, parseDate };
