"use strict";

// ── Storage (IndexedDB, one record holding the whole dataset) ───────────────
const DB_NAME = "ticker", STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const app = document.getElementById("app");
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;

// Receipts round each line to 2 dp, so totals are built from rounded lines
function round2(x) { const s = x < 0 ? -1 : 1; return s * Math.round(Math.abs(x) * 100 + 1e-6) / 100; }
const lineTotal = e => round2(e.qty * e.unitPriceRM);
const shortPlace = p => p.replace(/\s*\(.*$/, "");
const num2 = v => v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unitPrice = p => Math.abs(p * 100 - Math.round(p * 100)) > 1e-6 ? p.toFixed(3) : p.toFixed(2);
const fmtDate = (d, o = { day: "2-digit", month: "short", year: "numeric" }) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-GB", o);
const fmtShort = d => fmtDate(d, { day: "2-digit", month: "short" });

const CAT_COLORS = { "Groceries": "#2E75B6", "Petrol": "#F4A300", "Food & Dining": "#1f8a3b",
  "Top-Up": "#8e44ad", "Others": "#7f8c8d" };
const catColor = c => CAT_COLORS[c] || "#95a5a6";

// ── State ───────────────────────────────────────────────────────────────────
let DATA = null, IX = null;
let currency = localStorage.getItem("ticker.currency") || "RM";
let catFilter = "all", query = "";

function setData(d) { DATA = d; IX = d ? buildIndex(d) : null; }

function buildIndex(d) {
  const rates = Object.fromEntries(d.trips.map(t => [t.date, t.rate]));
  const surcharge = Object.fromEntries(d.shops.map(s => [s.name, s.surcharge]));
  const trips = new Map(), items = new Map();
  for (const t of d.trips) trips.set(t.date, { date: t.date, rate: t.rate, total: 0, cats: {}, shops: new Map() });

  for (const e of d.entries) {
    const lt = lineTotal(e);
    let t = trips.get(e.date);
    if (!t) { t = { date: e.date, rate: null, total: 0, cats: {}, shops: new Map() }; trips.set(e.date, t); }
    t.total = round2(t.total + lt);
    t.cats[e.category] = round2((t.cats[e.category] || 0) + lt);
    if (!t.shops.has(e.place)) t.shops.set(e.place, { place: e.place, total: 0, lines: [] });
    const s = t.shops.get(e.place);
    s.total = round2(s.total + lt);
    s.lines.push(e);

    if (e.adjustment) continue;
    if (!items.has(e.item)) items.set(e.item, { name: e.item, unit: e.unit, cat: e.category, buys: new Map() });
    const it = items.get(e.item);
    it.unit = e.unit; it.cat = e.category;
    if (!it.buys.has(e.date)) it.buys.set(e.date, { date: e.date, prices: [], places: new Set() });
    const b = it.buys.get(e.date);
    b.prices.push(e.unitPriceRM);
    b.places.add(shortPlace(e.place));
  }

  // One price per trip per item (average when bought more than once that day, like the Excel sheet)
  for (const it of items.values()) {
    it.hist = [...it.buys.values()]
      .map(b => ({ date: b.date, price: b.prices.reduce((a, c) => a + c, 0) / b.prices.length, place: [...b.places].join(", ") }))
      .sort((a, b) => a.date.localeCompare(b.date));
    it.last = it.hist[it.hist.length - 1];
    it.prev = it.hist.length > 1 ? it.hist[it.hist.length - 2] : null;
    delete it.buys;
  }

  const tripList = [...trips.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { rates, surcharge, trips, items, tripList };
}

const toSGD = (rm, date) => IX.rates[date] ? rm / IX.rates[date] : null;
function money(rm, date) {
  if (currency === "RM") return "RM " + num2(rm);
  const s = toSGD(rm, date);
  return s == null ? "S$ ?" : "S$ " + num2(s);
}
function moneyUnit(rm, date) {
  if (currency === "RM") return "RM " + unitPrice(rm);
  const s = toSGD(rm, date);
  return s == null ? "S$ ?" : "S$ " + s.toFixed(s < 1 ? 3 : 2);
}

function diffBadge(cur, prev, label) {
  if (!prev) return '<span class="badge same">1 buy</span>';
  const d = cur.price - prev.price;
  const suffix = label ? ` vs ${fmtShort(prev.date)}` : "";
  if (Math.abs(d) < 0.005) return `<span class="badge same">= same${suffix}</span>`;
  return d > 0
    ? `<span class="badge up">&#9650; +${unitPrice(d)}${suffix}</span>`
    : `<span class="badge down">&#9660; ${unitPrice(d)}${suffix}</span>`;
}

function spark(hist) {
  if (hist.length < 2) return "";
  const v = hist.map(h => h.price);
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const W = 340, H = 90;
  const pts = v.map((p, i) => [10 + i * ((W - 20) / (v.length - 1)), H - 8 - (p - lo) / (hi - lo) * (H - 16)]);
  const path = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = pts.length - 1;
  const lastColor = v[last] > v[last - 1] ? "#c0262d" : v[last] < v[last - 1] ? "#1f8a3b" : "#2E75B6";
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${path} L${pts[last][0]} ${H} L10 ${H} Z" fill="#D6E4F0" opacity=".6"/>
    <path d="${path}" fill="none" stroke="#2E75B6" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    ${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="${i === last ? 5 : 3}" fill="${i === last ? lastColor : "#2E75B6"}"/>`).join("")}
  </svg>`;
}

// ── Screens ─────────────────────────────────────────────────────────────────
function emptyState() {
  return `<header><h1>Ticker</h1><div class="sub">JB price tracker</div></header>
    <div class="empty"><h2>No data yet</h2>
      Import your <b>ticker-data.json</b> file (or a Ticker backup) to load your trips.
      Your data stays on this device only.</div>
    <button class="btn primary" data-action="import">Import data file</button>`;
}

function screenPrices() {
  if (!IX) return emptyState();
  const lastTrip = IX.tripList[0];
  const cats = [...new Set([...IX.items.values()].map(i => i.cat))].sort();
  return `<header>
      <h1>Prices</h1>
      <div class="sub">Last trip ${fmtDate(lastTrip.date)}${lastTrip.rate ? ` - 1 SGD = ${lastTrip.rate} MYR` : ""}</div>
      <input class="search" id="search" type="search" placeholder="Search ${IX.items.size} items..." value="${esc(query)}" autocomplete="off">
    </header>
    ${backupBanner()}
    <div class="chips">
      ${["all", ...cats].map(c => `<span class="chip${c === catFilter ? " on" : ""}" data-cat="${esc(c)}">${c === "all" ? "All" : esc(c)}</span>`).join("")}
    </div>
    <div id="priceList">${priceList()}</div>
    <div class="note">Green = cheaper, red = dearer than the last time you bought that item. Discounts, rounding and service charges are left out.</div>`;
}

function priceList() {
  const q = query.trim().toLowerCase();
  const all = [...IX.items.values()];
  const petrol = all.filter(i => i.cat === "Petrol").sort((a, b) => b.hist.length - a.hist.length)[0];
  const showFeature = petrol && !q && (catFilter === "all" || catFilter === "Petrol");

  const list = all
    .filter(i => catFilter === "all" || i.cat === catFilter)
    .filter(i => !q || i.name.toLowerCase().includes(q) || i.hist.some(h => h.place.toLowerCase().includes(q)))
    .filter(i => !(showFeature && i === petrol))
    .sort((a, b) => b.last.date.localeCompare(a.last.date) || a.name.localeCompare(b.name));

  let html = "";
  if (showFeature) {
    const lo = petrol.hist.reduce((a, b) => b.price < a.price ? b : a);
    html += `<div class="section-title">Petrol</div>
      <a class="card feature" href="#/item/${enc(petrol.name)}">
        <div class="top">
          <div><div class="lbl">${esc(petrol.name)}</div>
            <div class="big">${moneyUnit(petrol.last.price, petrol.last.date)}<span class="unit">/${esc(petrol.unit)}</span></div>
            <div class="lbl">${esc(petrol.last.place)} - ${fmtShort(petrol.last.date)}</div></div>
          ${diffBadge(petrol.last, petrol.prev, true)}
        </div>
        ${spark(petrol.hist)}
        <div class="axis lbl"><span>${fmtShort(petrol.hist[0].date)}</span><span>low ${unitPrice(lo.price)} (${fmtShort(lo.date)})</span><span>${fmtShort(petrol.last.date)}</span></div>
      </a>`;
  }
  if (!list.length) return html + `<div class="empty">No items match "${esc(query)}"</div>`;

  let curDate = null, open = false;
  for (const it of list) {
    if (it.last.date !== curDate) {
      if (open) html += "</div>";
      curDate = it.last.date;
      html += `<div class="section-title">Last bought ${fmtDate(curDate)}</div><div class="card">`;
      open = true;
    }
    html += `<a class="row" href="#/item/${enc(it.name)}">
      <div class="main"><div class="name">${esc(it.name)}</div>
        <div class="meta">${esc(it.last.place)} - bought ${it.hist.length}x</div></div>
      <div class="right"><div class="price">${moneyUnit(it.last.price, it.last.date)}<span class="unit">/${esc(it.unit)}</span></div>
        ${diffBadge(it.last, it.prev)}</div></a>`;
  }
  return html + (open ? "</div>" : "");
}

function currencyToggle() {
  return `<div class="toggle">
    <button data-cur="RM" class="${currency === "RM" ? "on" : ""}">RM</button>
    <button data-cur="SGD" class="${currency === "SGD" ? "on" : ""}">S$</button></div>`;
}

function screenItem(name) {
  const it = IX && IX.items.get(name);
  if (!it) return notFound("#/prices", "Prices");
  const lo = it.hist.reduce((a, b) => b.price < a.price ? b : a);
  const hi = it.hist.reduce((a, b) => b.price > a.price ? b : a);
  const rows = it.hist.slice().reverse().map((h, k, arr) => {
    const prev = arr[k + 1];
    return `<a class="row" href="#/trip/${h.date}">
      <div class="main"><div class="name">${fmtDate(h.date)}</div><div class="meta">${esc(h.place)}</div></div>
      <div class="right"><div class="price">${moneyUnit(h.price, h.date)}</div>${prev ? diffBadge(h, prev) : ""}</div></a>`;
  }).join("");
  return `<header>
      <a class="back" href="#/prices">&lsaquo; Prices</a>
      <h1 class="small">${esc(it.name)}</h1>
      <div class="sub">${esc(it.cat)} - per ${esc(it.unit)} - bought on ${it.hist.length} trip${it.hist.length > 1 ? "s" : ""}</div>
    </header>
    ${currencyToggle()}
    <div class="stats">
      <div class="stat"><div class="lbl">Cheapest</div><div class="val">${moneyUnit(lo.price, lo.date)}</div><div class="where">${esc(lo.place)} - ${fmtShort(lo.date)}</div></div>
      <div class="stat"><div class="lbl">Dearest</div><div class="val">${moneyUnit(hi.price, hi.date)}</div><div class="where">${esc(hi.place)} - ${fmtShort(hi.date)}</div></div>
    </div>
    ${it.hist.length > 1 ? `<div class="card feature" style="margin-top:14px">${spark(it.hist)}</div>` : ""}
    <div class="section-title">History</div>
    <div class="card">${rows}</div>`;
}

function screenTrips() {
  if (!IX) return emptyState();
  const year = IX.tripList[0].date.slice(0, 4);
  const inYear = IX.tripList.filter(t => t.date.startsWith(year));
  const rm = round2(inYear.reduce((a, t) => a + t.total, 0));
  const sg = inYear.reduce((a, t) => a + (toSGD(t.total, t.date) || 0), 0);
  const rows = IX.tripList.map(t => `<a class="row" href="#/trip/${t.date}">
      <div class="main"><div class="name">${fmtDate(t.date)}</div>
        <div class="meta">${t.shops.size} shop${t.shops.size > 1 ? "s" : ""}${t.rate ? ` - 1 SGD = ${t.rate}` : " - no rate"}</div></div>
      <div class="right"><div class="price">RM ${num2(t.total)}</div>
        <div class="meta">${t.rate ? "S$ " + num2(t.total / t.rate) : ""}</div></div>
      <span class="chev">&rsaquo;</span></a>`).join("");
  return `<header><h1>Trips</h1><div class="sub">${IX.tripList.length} trips logged</div></header>
    <div class="stats">
      <div class="stat"><div class="lbl">Spent ${year}</div><div class="val">RM ${Math.round(rm).toLocaleString("en-GB")}</div><div class="where">S$ ${Math.round(sg).toLocaleString("en-GB")}</div></div>
      <div class="stat"><div class="lbl">Avg per trip</div><div class="val">RM ${Math.round(rm / inYear.length).toLocaleString("en-GB")}</div><div class="where">S$ ${Math.round(sg / inYear.length).toLocaleString("en-GB")} - ${inYear.length} trips</div></div>
    </div>
    <div class="section-title">All trips</div>
    <div class="card">${rows}</div>`;
}

function screenTrip(date) {
  const t = IX && IX.trips.get(date);
  if (!t) return notFound("#/trips", "Trips");
  const cats = Object.entries(t.cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const catSum = cats.reduce((a, [, v]) => a + v, 0) || 1;
  const shops = [...t.shops.values()].sort((a, b) => b.total - a.total);
  const shopRows = shops.map(s => {
    const items = s.lines.filter(l => !l.adjustment);
    const sc = IX.surcharge[s.place];
    const mainCat = items.length ? items[0].category : "";
    const meta = items.length === 1 && items[0].category === "Petrol"
      ? `${esc(items[0].item)} - ${items[0].qty} ${esc(items[0].unit)}`
      : `${esc(mainCat)} - ${items.length} item${items.length === 1 ? "" : "s"}`;
    return `<a class="row" href="#/shop/${t.date}/${enc(s.place)}">
      <div class="main"><div class="name wrap">${esc(s.place)}${sc && sc !== "None" ? `<span class="sc">${esc(sc)}</span>` : ""}</div>
        <div class="meta">${meta}</div></div>
      <div class="right price">${money(s.total, t.date)}</div><span class="chev">&rsaquo;</span></a>`;
  }).join("");
  return `<header>
      <a class="back" href="#/trips">&lsaquo; Trips</a>
      <h1 class="small">${fmtDate(t.date)}</h1>
      <div class="sub">RM ${num2(t.total)}${t.rate ? ` - S$ ${num2(t.total / t.rate)} - 1 SGD = ${t.rate}` : " - no exchange rate"}</div>
    </header>
    ${currencyToggle()}
    <div class="section-title">By category</div>
    <div class="card">
      <div class="bar">${cats.map(([c, v]) => `<div style="width:${(v / catSum * 100).toFixed(1)}%;background:${catColor(c)}"></div>`).join("")}</div>
      <div class="legend">${cats.map(([c, v]) => `<span><i class="dot" style="background:${catColor(c)}"></i>${esc(c)} ${money(v, t.date)}</span>`).join("")}</div>
    </div>
    <div class="section-title">Shops</div>
    <div class="card">${shopRows}</div>
    <div class="actions">
      <button class="btn ghost" data-action="rate" data-date="${t.date}">Change exchange rate</button>
      <button class="btn danger" data-action="delete-trip" data-date="${t.date}">Delete trip</button>
    </div>`;
}

function screenShop(date, place) {
  const t = IX && IX.trips.get(date);
  const s = t && t.shops.get(place);
  if (!s) return notFound("#/trips", "Trips");
  const sc = IX.surcharge[place];
  const rows = s.lines.map(l => {
    const lt = lineTotal(l);
    const body = `<div class="main"><div class="name wrap">${esc(l.item)}</div>
        <div class="meta">${l.qty} ${esc(l.unit)} x ${moneyUnit(l.unitPriceRM, date)}</div></div>
      <div class="right price">${money(lt, date)}</div>`;
    return l.adjustment
      ? `<div class="row adj">${body}</div>`
      : `<a class="row" href="#/item/${enc(l.item)}">${body}</a>`;
  }).join("");
  return `<header>
      <a class="back" href="#/trip/${date}">&lsaquo; ${fmtShort(date)}</a>
      <h1 class="small">${esc(place)}</h1>
      <div class="sub">${fmtDate(date)}${sc && sc !== "None" ? " - " + esc(sc) : ""}</div>
    </header>
    ${currencyToggle()}
    <div class="section-title">${s.lines.length} lines</div>
    <div class="card">${rows}
      <div class="row total"><div class="main"><div class="name">Total</div></div><div class="right price">${money(s.total, date)}</div></div>
    </div>
    <button class="btn ghost" data-action="edit-receipt" data-date="${date}" data-place="${esc(place)}">Edit receipt</button>
    <button class="btn danger" data-action="delete-receipt" data-date="${date}" data-place="${esc(place)}">Delete receipt</button>`;
}

// ── Add / edit receipt ──────────────────────────────────────────────────────
const DEFAULT_CATEGORIES = ["Food & Dining", "Groceries", "Petrol", "Top-Up", "Others"];
const DEFAULT_SURCHARGES = ["None", "SC 6% + SST 6%", "SST 6%", "SC 10%", "SC 3% + SST 6%", "SST 6% + SC 5%", "SC 10% + SST 6%"];
// Same rule as tools/export_data.py: these lines count in totals but not in price comparisons
const ADJ_RE = /^(Discount|Rounding Adj|SST|Service Charge|Service Tax|Takeaway Box)/;
const isAdj = name => ADJ_RE.test(String(name).trim());
const todayISO = () => new Date().toLocaleDateString("en-CA");
const parseNum = v => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? n : NaN; };

let draft = JSON.parse(localStorage.getItem("ticker.draft") || "null");
const saveDraft = () => localStorage.setItem("ticker.draft", JSON.stringify(draft));
const blankLine = (cat = "Groceries") => ({ item: "", qty: "1", unit: "each", price: "", category: cat });
function newDraft() {
  const last = IX && IX.tripList[0];
  return { date: todayISO(), rate: last && last.rate ? String(last.rate) : "", place: "", surcharge: "None",
    total: "", lines: [blankLine()], editing: null };
}
const draftHasContent = d => d && (d.place || d.lines.some(l => l.item || l.price));
const categories = () => (DATA && DATA.categories) || DEFAULT_CATEGORIES;
function surcharges() {
  const s = new Set([...((DATA && DATA.surcharges) || DEFAULT_SURCHARGES)]);
  if (draft && draft.surcharge) s.add(draft.surcharge);
  return [...s];
}

function screenAdd() {
  if (!draft) { draft = newDraft(); saveDraft(); }
  const d = draft;
  const opt = (list, cur) => list.map(v => `<option${v === cur ? " selected" : ""}>${esc(v)}</option>`).join("");
  const lines = d.lines.map((l, i) => `
    <div class="card line-card${l.flag ? " flag" : ""}" data-i="${i}">
      ${l.flag ? `<div class="lhint">Please check${l.read && l.read.toLowerCase() !== l.item.toLowerCase() ? ` - receipt says "${esc(l.read)}"` : ""}</div>` : ""}
      <div class="lrow">
        <input class="lname" data-k="item" list="dl-items" placeholder="Item name" value="${esc(l.item)}" autocomplete="off">
        <button class="del" data-del="${i}" aria-label="Remove line">&times;</button>
      </div>
      <div class="lgrid">
        <label>Qty<input data-k="qty" type="number" step="any" value="${esc(l.qty)}"></label>
        <label>Unit<input data-k="unit" list="dl-units" value="${esc(l.unit)}" autocomplete="off"></label>
        <label>RM each<input data-k="price" type="number" step="any" value="${esc(l.price)}" placeholder="0.00"></label>
        <div class="ltot" data-tot="${i}"></div>
      </div>
      <select data-k="category">${opt(categories(), l.category)}</select>
    </div>`).join("");
  const items = IX ? [...IX.items.keys()].sort() : [];
  const units = IX ? [...new Set(DATA.entries.map(e => e.unit))].sort() : ["each", "kg", "litre", "pack", "pc"];
  const shops = DATA ? DATA.shops.map(s => s.name).sort() : [];
  return `<header>
      ${d.editing ? `<a class="back" href="#/shop/${d.editing.date}/${enc(d.editing.place)}" data-action="cancel-edit">&lsaquo; Cancel</a>` : ""}
      <h1>${d.editing ? "Edit receipt" : "New receipt"}</h1>
      <div class="sub">${d.editing ? esc(d.editing.place) + " - " + fmtDate(d.editing.date) : "One receipt at a time - same date joins the same trip"}</div>
    </header>
    ${d.editing ? "" : `<button class="btn primary" data-action="scan">Scan receipt photo</button>
    <div class="note" style="padding-top:0">Lay the receipt flat, fill the frame, good light. You check every line before saving.</div>
    ${window.lastScanDebug ? `<button class="btn ghost" data-action="scan-debug">Save scan details</button>` : ""}`}
    <div class="section-title">Receipt</div>
    <div class="card">
      <label class="field"><span>Date</span><input data-f="date" type="date" value="${esc(d.date)}"></label>
      <label class="field"><span>1 SGD = (MYR)</span><input data-f="rate" type="number" step="any" value="${esc(d.rate)}" placeholder="e.g. 3.19"></label>
      <div class="field-note" id="rateNote"></div>
      <label class="field"><span>Shop</span><input data-f="place" list="dl-shops" value="${esc(d.place)}" placeholder="Shop name" autocomplete="off"></label>
      <label class="field"><span>Surcharge</span><select data-f="surcharge">${opt(surcharges(), d.surcharge)}<option value="__new">+ New...</option></select></label>
      <label class="field"><span>Receipt total (RM)</span><input data-f="total" type="number" step="any" value="${esc(d.total)}" placeholder="optional, for checking"></label>
    </div>
    <div class="section-title">Lines</div>
    <div id="lines">${lines}</div>
    <div class="quick">
      <button data-add="item">+ Item</button>
      <button data-add="Discount">+ Discount</button>
      <button data-add="Rounding Adj">+ Rounding</button>
      <button data-add="Service Charge">+ Charge</button>
    </div>
    <div class="check" id="check"></div>
    <button class="btn primary" data-action="save-receipt">${d.editing ? "Save changes" : "Save receipt"}</button>
    ${draftHasContent(d) || d.editing ? `<button class="btn ghost" data-action="clear-draft">${d.editing ? "Cancel edit" : "Clear form"}</button>` : ""}
    <div class="note">Discount lines: enter the price as a minus number (e.g. -2.96). Discount, rounding and charge lines count in the total but not in price comparisons.</div>
    <datalist id="dl-items">${items.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
    <datalist id="dl-units">${units.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
    <datalist id="dl-shops">${shops.map(n => `<option value="${esc(n)}">`).join("")}</datalist>`;
}

function updateDraftTotals() {
  if (!document.getElementById("check")) return;
  let sum = 0;
  draft.lines.forEach((l, i) => {
    const q = parseNum(l.qty), p = parseNum(l.price);
    const t = isFinite(q) && isFinite(p) ? round2(q * p) : null;
    if (t != null) sum = round2(sum + t);
    const el = document.querySelector(`[data-tot="${i}"]`);
    if (el) el.textContent = t == null ? "" : "RM " + num2(t);
  });
  const total = parseNum(draft.total), el = document.getElementById("check");
  if (!isFinite(total)) { el.className = "check"; el.textContent = `Lines add up to RM ${num2(sum)}`; }
  else if (Math.abs(total - sum) < 0.005) { el.className = "check ok"; el.textContent = `Lines add up to RM ${num2(sum)} - matches the receipt`; }
  else { el.className = "check bad"; el.textContent = `Lines add up to RM ${num2(sum)} - receipt says RM ${num2(total)} (off by ${num2(round2(total - sum))})`; }

  const note = document.getElementById("rateNote");
  if (note) {
    const existing = IX && IX.trips.get(draft.date);
    note.textContent = existing && (!draft.editing || draft.editing.date !== draft.date)
      ? `Adds to the ${fmtDate(draft.date)} trip (${existing.shops.size} shop${existing.shops.size > 1 ? "s" : ""} so far). The rate applies to the whole trip.`
      : existing ? "The rate applies to the whole trip." : "New trip.";
  }
}

function onDraftInput(t) {
  if (t.dataset.f) {
    const f = t.dataset.f;
    if (f === "surcharge" && t.value === "__new") {
      const v = (prompt("New surcharge, e.g. SC 10% + SST 8%") || "").trim();
      if (v) draft.surcharge = v;
      saveDraft(); route(); return;
    }
    draft[f] = t.value;
    if (f === "date" && IX && IX.rates[t.value]) {
      draft.rate = String(IX.rates[t.value]);
      document.querySelector('[data-f="rate"]').value = draft.rate;
    }
    if (f === "place" && IX && IX.surcharge[t.value] !== undefined) {
      draft.surcharge = IX.surcharge[t.value];
      document.querySelector('[data-f="surcharge"]').value = draft.surcharge;
    }
  } else if (t.dataset.k) {
    const i = +t.closest("[data-i]").dataset.i, k = t.dataset.k, line = draft.lines[i];
    line[k] = t.value;
    if (line.flag) { line.flag = false; t.closest("[data-i]").classList.remove("flag"); const h = t.closest("[data-i]").querySelector(".lhint"); if (h) h.remove(); }
    const known = k === "item" && IX && IX.items.get(t.value);
    if (known) {
      const card = t.closest("[data-i]");
      line.unit = known.unit; line.category = known.cat;
      card.querySelector('[data-k="unit"]').value = known.unit;
      card.querySelector('[data-k="category"]').value = known.cat;
      if (!line.price) { line.price = String(known.last.price); card.querySelector('[data-k="price"]').value = line.price; }
    }
  }
  saveDraft();
  updateDraftTotals();
}

function emptyData() {
  return { app: "Ticker", version: 1, trips: [], shops: [], categories: DEFAULT_CATEGORIES.slice(),
    surcharges: DEFAULT_SURCHARGES.slice(), trackerGroups: [], entries: [] };
}

async function commit() {
  const used = new Set(DATA.entries.map(e => e.date));
  DATA.trips = DATA.trips.filter(t => used.has(t.date)).sort((a, b) => a.date.localeCompare(b.date));
  DATA.entries.sort((a, b) => a.date.localeCompare(b.date));
  DATA.modifiedAt = new Date().toISOString();
  await dbSet("data", DATA);
  setData(DATA);
}

async function saveReceipt() {
  const d = draft;
  const rate = parseNum(d.rate), place = d.place.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return alert("Please choose a date.");
  if (!(rate > 0)) return alert("Please enter the exchange rate (1 SGD = ? MYR).");
  if (!place) return alert("Please enter the shop name.");
  const lines = [];
  for (const [n, l] of d.lines.entries()) {
    const item = l.item.trim(), q = parseNum(l.qty), p = parseNum(l.price);
    if (!item && !l.price) continue;
    if (!item) return alert(`Line ${n + 1}: please enter the item name.`);
    if (!isFinite(q) || q === 0) return alert(`Line ${n + 1} (${item}): please enter the quantity.`);
    if (!isFinite(p)) return alert(`Line ${n + 1} (${item}): please enter the price.`);
    lines.push({ date: d.date, place, category: l.category, item, unit: l.unit.trim() || "each",
      qty: q, unitPriceRM: p, adjustment: isAdj(item) });
  }
  if (!lines.length) return alert("Please add at least one line.");
  const sum = lines.reduce((a, e) => round2(a + lineTotal(e)), 0), total = parseNum(d.total);
  if (isFinite(total) && Math.abs(total - sum) >= 0.005 &&
      !confirm(`Lines add up to RM ${num2(sum)} but the receipt total is RM ${num2(total)}. Save anyway?`)) return;

  if (!DATA) DATA = emptyData();
  if (d.editing) DATA.entries = DATA.entries.filter(e => !(e.date === d.editing.date && e.place === d.editing.place));
  DATA.entries.push(...lines);

  const trip = DATA.trips.find(t => t.date === d.date);
  if (trip) trip.rate = rate; else DATA.trips.push({ date: d.date, rate });
  const shop = DATA.shops.find(s => s.name === place);
  if (shop) shop.surcharge = d.surcharge; else DATA.shops.push({ name: place, surcharge: d.surcharge });
  if (!DATA.surcharges.includes(d.surcharge)) DATA.surcharges.push(d.surcharge);

  await commit();
  draft = null; localStorage.removeItem("ticker.draft");
  location.hash = `#/shop/${d.date}/${enc(place)}`;
}

function startEdit(date, place) {
  const s = IX.trips.get(date).shops.get(place);
  if (draftHasContent(draft) && !draft.editing && !confirm("Discard the receipt you were adding?")) return;
  draft = { date, rate: String(IX.rates[date] || ""), place, surcharge: IX.surcharge[place] || "None",
    total: s.total.toFixed(2), editing: { date, place },
    lines: s.lines.map(l => ({ item: l.item, qty: String(l.qty), unit: l.unit, price: String(l.unitPriceRM), category: l.category })) };
  saveDraft();
  location.hash = "#/add";
}

async function deleteReceipt(date, place) {
  const s = IX.trips.get(date).shops.get(place);
  if (!confirm(`Delete ${place} on ${fmtDate(date)} (${s.lines.length} lines, RM ${num2(s.total)})?`)) return;
  DATA.entries = DATA.entries.filter(e => !(e.date === date && e.place === place));
  await commit();
  location.hash = IX.trips.has(date) ? `#/trip/${date}` : "#/trips";
}

async function changeRate(date) {
  const v = prompt(`Exchange rate for ${fmtDate(date)}: 1 SGD = ? MYR`, IX.rates[date] || "");
  if (v == null) return;
  const r = parseNum(v);
  if (!(r > 0)) return alert("Please enter a number like 3.19");
  const t = DATA.trips.find(t => t.date === date);
  if (t) t.rate = r; else DATA.trips.push({ date, rate: r });
  await commit();
  route();
}

async function deleteTrip(date) {
  const t = IX.trips.get(date);
  if (!confirm(`Delete the whole ${fmtDate(date)} trip (${t.shops.size} shops, RM ${num2(t.total)})? This cannot be undone unless you have a backup.`)) return;
  DATA.entries = DATA.entries.filter(e => e.date !== date);
  await commit();
  location.hash = "#/trips";
}

// ── Scan ────────────────────────────────────────────────────────────────────
function scanContext() {
  if (!IX) return { items: [], shops: [], shopCats: {} };
  const items = new Map(), cats = {};
  for (const e of DATA.entries) {
    if (e.adjustment) continue;
    if (!items.has(e.item)) items.set(e.item, { name: e.item, unit: e.unit, cat: e.category, places: new Set(), last: e.unitPriceRM });
    const it = items.get(e.item);
    it.places.add(e.place); it.unit = e.unit; it.cat = e.category; it.last = e.unitPriceRM;
    // Default category for unknown items at this shop - fuel is detected by name instead
    if (e.category !== "Petrol") (cats[e.place] = cats[e.place] || {})[e.category] = (cats[e.place][e.category] || 0) + 1;
  }
  const shopCats = {};
  for (const [p, c] of Object.entries(cats)) shopCats[p] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  return { items: [...items.values()], shops: DATA.shops, shopCats };
}

function scanOverlay(text) {
  let el = document.getElementById("scanOverlay");
  if (text == null) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div"); el.id = "scanOverlay"; el.className = "overlay";
    el.innerHTML = '<div class="overlay-box"><div class="spinner"></div><div class="overlay-text"></div></div>';
    document.body.appendChild(el);
  }
  el.querySelector(".overlay-text").textContent = text;
}

async function onScanFile(file) {
  if (!file) return;
  let res;
  try {
    res = await scanReceipt(file, scanContext(), scanOverlay);
  } catch (err) {
    scanOverlay(null);
    alert("Scanning failed: " + err.message);
    return;
  }
  scanOverlay(null);
  if (res && res.debug) {
    window.lastScanDebug = { ...res.debug, result: { shop: res.shop, date: res.date, total: res.total, sum: res.sum,
      lines: res.lines.map(l => [l.item, l.qty, l.price, l.total, l.verified]) } };
  }
  if (!res || !res.lines.length) {
    alert("No receipt lines could be read from this photo. Try a sharper photo, flat and well lit, or type the lines in.");
    return;
  }
  const hasLines = draft && draft.lines.some(l => l.item || l.price);
  const append = hasLines && !confirm("Replace the lines already in the form with the scanned lines?\n\nOK = replace, Cancel = add below");
  if (!draft) draft = newDraft();
  if (res.date) {
    draft.date = res.date;
    if (IX && IX.rates[res.date]) draft.rate = String(IX.rates[res.date]);
  }
  if (res.shop) { draft.place = res.shop; if (res.surcharge) draft.surcharge = res.surcharge; }
  if (res.total != null) draft.total = res.total.toFixed(2);
  const scanned = res.lines.map(l => ({ item: l.item, qty: String(l.qty), unit: l.unit, price: String(l.price),
    category: l.category, flag: !l.verified || !l.known, read: l.read }));
  draft.lines = append ? draft.lines.filter(l => l.item || l.price).concat(scanned) : scanned;
  saveDraft();
  route();
  const flagged = scanned.filter(l => l.flag).length;
  const msg = [`Read ${scanned.length} lines${res.shop ? " from " + res.shop : ""}${res.date ? " dated " + fmtDate(res.date) : ""}.`];
  if (flagged) msg.push(`${flagged} line${flagged > 1 ? "s are" : " is"} marked "Please check" (orange).`);
  if (!res.date) msg.push("Date not found - please set it.");
  if (!res.shop) msg.push("Shop not recognised - please enter it.");
  if (res.total == null) msg.push("Receipt total not found - type it in to check the lines.");
  else if (!res.balanced) msg.push("The lines do not add up to the receipt total yet - see the red bar.");
  alert(msg.join("\n\n"));
}

// ── Backup ──────────────────────────────────────────────────────────────────
const lastBackup = () => localStorage.getItem("ticker.lastBackup");
const needsBackup = () => DATA && DATA.modifiedAt && (!lastBackup() || lastBackup() < DATA.modifiedAt);
function backupBanner() {
  return needsBackup()
    ? `<a class="banner" data-action="backup">You have changes since your last backup. <b>Export backup</b></a>` : "";
}

async function exportBackup() {
  if (!DATA) return alert("No data to back up yet.");
  const name = `ticker-backup-${todayISO()}.json`;
  const blob = new Blob([JSON.stringify({ ...DATA, exportedAt: new Date().toISOString() })], { type: "application/json" });
  try {
    const file = new File([blob], name, { type: "application/json" });
    // Share sheet on iPhone/iPad (has "Save to Files"); plain download into Downloads on a Mac
    const touchDevice = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
    if (touchDevice && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Ticker backup" });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (err) {
    if (err.name !== "AbortError") alert("Backup failed: " + err.message);
    return;
  }
  localStorage.setItem("ticker.lastBackup", new Date().toISOString());
  route();
}

async function screenSettings() {
  let persisted = null;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* not supported */ }
  const info = DATA
    ? `${DATA.trips.length} trips, ${DATA.entries.length} lines, ${DATA.shops.length} shops`
    : "No data on this device";
  const when = DATA && DATA.importedAt ? `Imported ${new Date(DATA.importedAt).toLocaleString("en-GB")}` : "";
  const lb = lastBackup();
  return `<header><h1>Settings</h1></header>
    ${backupBanner()}
    <div class="section-title">Data on this device</div>
    <div class="card">
      <div class="row"><div class="main"><div class="name">${info}</div><div class="meta">${when}</div></div></div>
      <div class="row"><div class="main"><div class="name">Storage</div>
        <div class="meta">${persisted === true ? "Protected - Safari will not clear it automatically" : persisted === false ? "Not protected yet - add Ticker to Home Screen and export backups" : "Status unknown"}</div></div></div>
    </div>
    <div class="section-title">Backup</div>
    <div class="card">
      <a class="row" data-action="backup"><div class="main"><div class="name">Export backup</div>
        <div class="meta">${lb ? "Last backup " + new Date(lb).toLocaleString("en-GB") : "No backup yet"} - save to Files / iCloud</div></div><span class="chev">&rsaquo;</span></a>
      <a class="row" data-action="import"><div class="main"><div class="name">Import</div><div class="meta">Load ticker-data.json or a Ticker backup (replaces data on this device)</div></div><span class="chev">&rsaquo;</span></a>
    </div>
    <div class="note">Your data is stored only on this device. Export a backup after adding receipts. Ticker v0.4</div>`;
}

function notFound(href, label) {
  return `<header><a class="back" href="${href}">&lsaquo; ${label}</a><h1 class="small">Not found</h1></header>
    <div class="empty">This page does not exist (any more).</div>`;
}

// ── Router ──────────────────────────────────────────────────────────────────
async function route() {
  const [r = "prices", ...args] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const tab = { item: "prices", trip: "trips", shop: "trips" }[r] || r;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === tab));
  let html;
  switch (r) {
    case "item": html = screenItem(args.join("/")); break;
    case "trips": html = screenTrips(); break;
    case "trip": html = screenTrip(args[0]); break;
    case "shop": html = screenShop(args[0], args.slice(1).join("/")); break;
    case "add": html = screenAdd(); break;
    case "settings": html = await screenSettings(); break;
    default: html = screenPrices();
  }
  app.innerHTML = html;
  if (r === "add") updateDraftTotals();
  window.scrollTo(0, 0);
}

// ── Events ──────────────────────────────────────────────────────────────────
app.addEventListener("click", e => {
  const chip = e.target.closest("[data-cat]");
  if (chip) {
    catFilter = chip.dataset.cat;
    document.querySelectorAll(".chip").forEach(c => c.classList.toggle("on", c === chip));
    document.getElementById("priceList").innerHTML = priceList();
    return;
  }
  const cur = e.target.closest("[data-cur]");
  if (cur) {
    currency = cur.dataset.cur;
    localStorage.setItem("ticker.currency", currency);
    const y = window.scrollY;
    route().then(() => window.scrollTo(0, y));
    return;
  }
  const act = e.target.closest("[data-action]");
  if (!act) {
    const del = e.target.closest("[data-del]");
    if (del) {
      draft.lines.splice(+del.dataset.del, 1);
      if (!draft.lines.length) draft.lines.push(blankLine());
      saveDraft(); route();
      return;
    }
    const add = e.target.closest("[data-add]");
    if (add) {
      const kind = add.dataset.add;
      const lastCat = draft.lines.length ? draft.lines[draft.lines.length - 1].category : "Groceries";
      const line = blankLine(lastCat);
      if (kind !== "item") { line.item = kind; line.unit = "-"; }
      draft.lines.push(line);
      saveDraft(); route();
      const cards = document.querySelectorAll(".line-card");
      const last = cards[cards.length - 1];
      if (last) { last.scrollIntoView({ block: "center" }); last.querySelector(kind === "item" ? ".lname" : '[data-k="price"]').focus(); }
    }
    return;
  }
  const a = act.dataset.action, date = act.dataset.date, place = act.dataset.place;
  if (a === "import") { e.preventDefault(); document.getElementById("importInput").click(); }
  else if (a === "backup") { e.preventDefault(); exportBackup(); }
  else if (a === "save-receipt") saveReceipt();
  else if (a === "scan") document.getElementById("scanInput").click();
  else if (a === "scan-debug") {
    const blob = new Blob([JSON.stringify(window.lastScanDebug)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = "ticker-scan-details.json";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }
  else if (a === "clear-draft" || a === "cancel-edit") {
    if (a === "clear-draft" && !draft.editing && !confirm("Clear this receipt?")) return;
    const back = draft && draft.editing ? `#/shop/${draft.editing.date}/${enc(draft.editing.place)}` : null;
    draft = null; localStorage.removeItem("ticker.draft");
    if (back) { e.preventDefault(); location.hash = back; } else route();
  }
  else if (a === "edit-receipt") startEdit(date, place);
  else if (a === "delete-receipt") deleteReceipt(date, place);
  else if (a === "rate") changeRate(date);
  else if (a === "delete-trip") deleteTrip(date);
});

app.addEventListener("input", e => {
  if (e.target.id === "search") {
    query = e.target.value;
    document.getElementById("priceList").innerHTML = priceList();
  } else if (draft && (e.target.dataset.f || e.target.dataset.k) && e.target.tagName !== "SELECT") {
    onDraftInput(e.target);
  }
});

app.addEventListener("change", e => {
  if (draft && e.target.tagName === "SELECT" && (e.target.dataset.f || e.target.dataset.k)) onDraftInput(e.target);
});

document.getElementById("importInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); } catch (err) { alert("This file could not be read as JSON."); return; }
  if (!d || d.app !== "Ticker" || !Array.isArray(d.entries) || !Array.isArray(d.trips) || !Array.isArray(d.shops)) {
    alert("This is not a Ticker data file.");
    return;
  }
  if (DATA && !confirm(`Replace the data on this device (${DATA.trips.length} trips) with this file (${d.trips.length} trips)?`)) return;
  d.importedAt = new Date().toISOString();
  await dbSet("data", d);
  setData(d);
  // The imported file is itself a backup of what is now on the device
  localStorage.setItem("ticker.lastBackup", new Date().toISOString());
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (err) { /* optional */ }
  alert(`Imported ${d.trips.length} trips and ${d.entries.length} lines.`);
  location.hash = "#/prices";
  route();
});

window.addEventListener("hashchange", route);

document.getElementById("scanInput").addEventListener("change", e => {
  const file = e.target.files[0];
  e.target.value = "";
  onScanFile(file);
});

// ── Start ───────────────────────────────────────────────────────────────────
(async function start() {
  try { setData(await dbGet("data") || null); }
  catch (err) { console.error(err); setData(null); }
  route();
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if ("serviceWorker" in navigator && (location.protocol === "https:" || local)) {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW failed", err));
  }
})();
