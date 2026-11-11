/* 麻雀精算 みんなで同期（ホストが卓の記録を持ち、参加者の画面に映す）
 * 方針
 *  - 受け取ったデータは型・範囲を検査し、画面には textContent / DOM だけで出す（innerHTML・eval・外部fetchは使わない）
 *  - 同期するのは名前・ルール・各試合の持ち点だけ。順位とポイントは、受け取った側が計算し直す
 *  - 隠す情報は無い（卓の記録は全員が見られる）。ホストが記録の正しさを決める
 */
(function () {
'use strict';
const R = window.NomiRoom;
const $ = id => document.getElementById(id);
const KEY_MAIN = 'mahjong_v3', KEY_HOST = 'mj_online_host', KEY_NAME = 'mj_online_name', KEY_SEAT = 'mj_online_seat';
const LEGACY_KEYS = ['mahjong_pNames', 'mahjong_archives', 'mahjong_app2_scores'];
const HEX = ['#e0555d', '#4f8fe8', '#e8a13a', '#c46bb6'];
const PC = ['var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)'];
const ROW_H = 58, ROW_GAP = 6;
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------- DOM ヘルパー ---------- */
function h(tag, props, kids) {
  const e = document.createElement(tag);
  fill(e, props, kids);
  return e;
}
function sv(tag, props, kids) {
  const e = document.createElementNS(SVG_NS, tag);
  fill(e, props, kids);
  return e;
}
function fill(e, props, kids) {
  if (props) Object.keys(props).forEach(k => {
    const v = props[k];
    if (k === 'class') e.setAttribute('class', v);
    else if (k === 'text') e.textContent = v;
    else if (k === 'on') Object.keys(v).forEach(ev => e.addEventListener(ev, v[ev]));
    else if (k === 'style') Object.keys(v).forEach(s => e.style.setProperty(s, v[s]));
    else e.setAttribute(k, v);
  });
  (kids || []).forEach(c => { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
const cls = v => (round1(v) > 0 ? 'pos' : (round1(v) < 0 ? 'neg' : ''));

let toastTimer = null;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2800);
}
let bannerTimer = null;
function banner(msg, ms) {
  const b = $('banner'); b.textContent = msg; b.classList.add('on');
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(hideBanner, ms);
}
function hideBanner() { $('banner').classList.remove('on'); }

function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); window.scrollTo(0, 0); }

let sheetKind = null;
function openSheet(kind, nodes) {
  sheetKind = kind;
  const s = $('sheet'); clear(s);
  s.appendChild(h('div', { class: 'grip' }));
  nodes.forEach(n => s.appendChild(n));
  $('backdrop').classList.add('open');
}
function closeSheet() { sheetKind = null; $('backdrop').classList.remove('open'); }
$('backdrop').addEventListener('click', e => { if (e.target === $('backdrop')) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 次の方法を試す */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ---------- 画面を消さない ---------- */
let wake = null;
async function keepAwake() { try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { /* 使えなくても動く */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && role) keepAwake(); });

/* ---------- QR 表示・読み取り ---------- */
function drawQR(text, canvas, cssSize) {
  const qr = window.qrcode(0, 'L'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), quiet = 4, dpr = window.devicePixelRatio || 1;
  const px = Math.max(2, Math.floor(cssSize * dpr / (n + quiet * 2))), size = px * (n + quiet * 2);
  canvas.width = size; canvas.height = size; canvas.style.width = (size / dpr) + 'px'; canvas.style.height = (size / dpr) + 'px';
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
}
let scanner = null;
function stopScan() { if (scanner) { scanner.stop(); scanner = null; } }
// カメラはQRを読むあいだだけ使い、読めたら（やめたら）必ず止める。映像はどこにも送らない
function startScan(videoEl, onText, onError) {
  let stream = null, stopped = false, timer = null;
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  function stop() { stopped = true; clearTimeout(timer); if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } videoEl.srcObject = null; }
  function tick() {
    if (stopped) return;
    if (videoEl.readyState >= 2 && videoEl.videoWidth) {
      const w = videoEl.videoWidth, hh = videoEl.videoHeight, sc = Math.min(1, 900 / Math.max(w, hh));
      canvas.width = Math.round(w * sc); canvas.height = Math.round(hh * sc);
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data && code.data.indexOf('MJ1~') === 0) { stop(); onText(code.data); return; }
    }
    timer = setTimeout(tick, 120);
  }
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      videoEl.srcObject = stream; videoEl.setAttribute('playsinline', 'true'); await videoEl.play(); tick();
    } catch (e) { stop(); onError(e); }
  })();
  return { stop };
}
function camMsg(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'カメラの許可が必要です。ブラウザの設定で許可するか、参加コードを貼り付けてください。';
  if (n === 'NotFoundError') return 'カメラが見つかりません。参加コードを貼り付けてください。';
  return 'カメラを開けませんでした';
}

/* =====================================================================
   状態
===================================================================== */
let role = null;                       // null | 'host' | 'guest'
let room = null, guest = null, myId = -1;
let model = newModel(MJ_PRESETS[0]);
let synced = false;                    // 参加者: ホストの卓を受け取ったか
let roster = [];                       // [{id,name,ed}]
let myName = '';
let qrText = '';                       // 参加者: 再接続に使う
let epoch = 0, snapN = 0, lastSnap = { e: null, n: -1 };
let userLocked = false;
let rejoining = false;
let mySeat = null;
let importedModel = null;
let input = { vals: ['', '', '', ''], active: 0, editingId: null, op: null };
let sending = false, sendTimer = null;
const editors = new Set();
const nm = i => displayName(model.names[i], i);

try { myName = cleanName(localStorage.getItem(KEY_NAME) || ''); } catch (e) { /* 保存できなくても動く */ }
try { const s = parseInt(localStorage.getItem(KEY_SEAT), 10); if (s >= 0 && s <= 3) mySeat = s; } catch (e) { /* 同上 */ }
$('name').value = myName;

function amEditor() {
  if (role === 'host') return true;
  const me = roster.find(p => p.id === myId);
  return !!(role === 'guest' && me && me.ed);
}

/* =====================================================================
   保存（ホストの卓は、この端末に残しておく）
===================================================================== */
function saveHost() {
  if (role !== 'host') return;
  try {
    localStorage.setItem(KEY_HOST, JSON.stringify({ v: 1, names: model.names, title: model.title, rule: model.rule, g: model.games.map(g => g.scores) }));
  } catch (e) { /* 保存できなくても同期は続ける */ }
}
function loadHost() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY_HOST));
    if (!d || d.v !== 1) return null;
    const p = parseSnap({ t: 'snap', e: 0, n: 0, names: d.names, title: d.title, rule: d.rule, g: d.g });
    return p ? p.model : null;
  } catch (e) { return null; }
}
function readMain() {
  try { const d = JSON.parse(localStorage.getItem(KEY_MAIN)); return d && d.v === 3 ? d : null; } catch (e) { return null; }
}

/* =====================================================================
   順位ボード（数字が先に動き、そのあと行がゆっくり入れ替わる）
===================================================================== */
let shownTotals = [0, 0, 0, 0], shownOrder = [0, 1, 2, 3], boardTimers = [];
const orderOf = totals => [0, 1, 2, 3].sort((a, b) => totals[b] - totals[a] || a - b);

function buildBoard() {
  const b = $('board'); clear(b);
  for (let i = 0; i < 4; i++) {
    b.appendChild(h('div', { class: 'b-row', id: 'brow-' + i, style: { '--pc': PC[i] } }, [
      h('div', { class: 'b-rank', id: 'brank-' + i, text: String(i + 1) }),
      h('div', { class: 'b-name' }, [h('span', { class: 'b-name-text', id: 'bname-' + i }), h('span', { class: 'b-move', id: 'bmove-' + i })]),
      h('div', { class: 'b-val' }, [h('div', { class: 'b-total', id: 'btotal-' + i, text: '0.0' }), h('div', { class: 'b-delta', id: 'bdelta-' + i })])
    ]));
  }
}
function placeRows(order, withTransition) {
  order.forEach((p, pos) => {
    const el = $('brow-' + p);
    if (!withTransition) el.style.transition = 'none';
    el.style.transform = 'translateY(' + (pos * (ROW_H + ROW_GAP)) + 'px)';
    el.classList.toggle('lead', pos === 0);
    if (!withTransition) { void el.offsetHeight; el.style.transition = ''; }
  });
}
function renderBoard(animate) {
  boardTimers.forEach(clearTimeout); boardTimers = [];
  const totals = sessionTotals(model), order = orderOf(totals);
  const last = model.games[model.games.length - 1];
  for (let i = 0; i < 4; i++) {
    $('bname-' + i).textContent = nm(i);
    $('brow-' + i).classList.toggle('me', mySeat === i);
    const d = $('bdelta-' + i);
    if (last) { d.textContent = '前の試合 ' + fmtPt1(last.pts[i]); d.className = 'b-delta ' + cls(last.pts[i]); } else { d.textContent = ''; d.className = 'b-delta'; }
  }
  const setTotals = vals => { for (let i = 0; i < 4; i++) { const el = $('btotal-' + i); el.textContent = fmtPt1(vals[i]); el.className = 'b-total ' + cls(vals[i]); } };
  const setRanks = t => { for (let i = 0; i < 4; i++) $('brank-' + i).textContent = rankOf(t, i); };
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!animate || reduce) {
    setTotals(totals); setRanks(totals); placeRows(order, false);
    for (let i = 0; i < 4; i++) $('bmove-' + i).className = 'b-move';
    shownTotals = totals; shownOrder = order;
    return;
  }
  const from = shownTotals.slice(), prevOrder = shownOrder.slice(), STEPS = 30;
  for (let k = 1; k <= STEPS; k++) {
    const t = k / STEPS, e = 1 - Math.pow(1 - t, 3);
    boardTimers.push(setTimeout(() => setTotals(from.map((f, i) => f + (totals[i] - f) * e)), k * 40));
  }
  boardTimers.push(setTimeout(() => { setTotals(totals); shownTotals = totals; }, STEPS * 40 + 20));
  boardTimers.push(setTimeout(() => {
    for (let i = 0; i < 4; i++) {
      const before = prevOrder.indexOf(i), after = order.indexOf(i), mv = $('bmove-' + i);
      if (after < before) { mv.textContent = '▲'; mv.className = 'b-move up'; }
      else if (after > before) { mv.textContent = '▼'; mv.className = 'b-move down'; }
      else mv.className = 'b-move';
      $('brow-' + i).style.zIndex = after < before ? 2 : 1;
    }
    setRanks(totals); placeRows(order, true);
    shownOrder = order;
  }, STEPS * 40 + 450));
}

/* =====================================================================
   グラフ・精算・試合ログ
===================================================================== */
function chartNode(series, names) {
  const n = series[0].length - 1;
  if (n < 1) return h('div', { class: 'empty', text: '試合を記録すると、ここに推移グラフが出ます' });
  const W = 360, H = 190, L = 34, Rm = 62, T = 12, B = 24;
  let min = 0, max = 0;
  series.forEach(s => s.forEach(v => { if (v < min) min = v; if (v > max) max = v; }));
  if (max - min < 20) { max += 10; min -= 10; }
  const step = [5, 10, 20, 25, 50, 100, 200, 500].find(s => (max - min) / s <= 5) || 1000;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const X = i => L + (W - L - Rm) * (i / n), Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'ポイント推移グラフ' });
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = Y(v).toFixed(1);
    svg.appendChild(sv('line', { x1: L, x2: W - Rm, y1: y, y2: y, class: v === 0 ? 'zero' : 'grid' }));
    svg.appendChild(sv('text', { x: L - 6, y: (Y(v) + 3).toFixed(1), class: 'ytick', 'text-anchor': 'end' }, [String(v)]));
  }
  const xs = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i <= n; i += xs) svg.appendChild(sv('text', { x: X(i).toFixed(1), y: H - 8, class: 'xtick', 'text-anchor': 'middle' }, [String(i)]));
  series.forEach((s, p) => svg.appendChild(sv('polyline', {
    points: s.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' '), fill: 'none', stroke: HEX[p],
    'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
  })));
  series.forEach((s, p) => svg.appendChild(sv('circle', { cx: X(n).toFixed(1), cy: Y(s[n]).toFixed(1), r: 3.4, fill: HEX[p] })));
  const labels = series.map((s, p) => ({ p, y: Y(s[n]) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) if (labels[k].y < labels[k - 1].y + 12) labels[k].y = labels[k - 1].y + 12;
  labels.forEach(l => svg.appendChild(sv('text', { x: W - Rm + 9, y: (l.y + 3.5).toFixed(1), class: 'lbl', style: { fill: HEX[l.p] } }, [Array.from(names[l.p]).slice(0, 5).join('')])));
  return svg;
}

function settlementEntries() {
  const t = sessionTotals(model);
  return [0, 1, 2, 3].map(i => ({ name: nm(i), pt: t[i] }));
}
function settleNode() {
  const box = h('div');
  if (!model.games.length) { box.appendChild(h('div', { class: 'empty', text: '試合を記録すると、ここに受け渡しの案が出ます' })); return box; }
  const transfers = calcTransfers(settlementEntries());
  if (!transfers.length) { box.appendChild(h('div', { class: 'empty', text: '全員が 0pt なので、受け渡しはありません' })); return box; }
  box.appendChild(h('div', { class: 'tr-sum', text: transfers.length + '回の受け渡しで精算できます' }));
  transfers.forEach(t => box.appendChild(h('div', { class: 'tr-item' }, [
    h('span', { class: 'tr-who' }, [h('span', { class: 'tr-from', text: t.from }), h('i', { class: 'tr-arrow', text: '➡' }), h('span', { class: 'tr-to', text: t.to })]),
    h('span', { class: 'tr-amt', text: t.pt.toFixed(1) + ' pt' })
  ])));
  return box;
}

function renderLog() {
  const games = model.games, box = $('log'); clear(box);
  $('log-count').textContent = games.length ? games.length + '試合' : '';
  $('log-hint').style.display = games.length ? 'block' : 'none';
  if (!games.length) { box.appendChild(h('div', { class: 'empty', text: 'まだ試合がありません' })); return; }
  for (let idx = games.length - 1; idx >= 0; idx--) {
    const g = games[idx];
    const cells = h('span', { class: 'log-cells' });
    for (let i = 0; i < 4; i++) {
      cells.appendChild(h('div', { class: 'lc' + (g.ranks[i] === 1 ? ' top' : '') }, [h('span', { text: nm(i) }), h('b', { class: cls(g.pts[i]), text: fmtPt1(g.pts[i]) })]));
    }
    box.appendChild(h('button', { class: 'log-item', 'data-id': g.id, type: 'button' }, [h('span', { class: 'log-n', text: String(idx + 1) }), cells]));
  }
}
$('log').addEventListener('click', e => {
  const b = e.target.closest('.log-item'); if (b) openGameSheet(b.getAttribute('data-id'));
});

function renderChartPanel() {
  const c = $('chart'); clear(c); c.appendChild(chartNode(cumulativeSeries(model), [0, 1, 2, 3].map(nm)));
  const s = $('settle'); clear(s); s.appendChild(settleNode());
}

/* =====================================================================
   入力（ホスト／入力を許可された参加者）
===================================================================== */
function resetInput() { input = { vals: ['', '', '', ''], active: 0, editingId: null, op: null }; sending = false; clearTimeout(sendTimer); }
function activeRule() {
  if (input.editingId) { const g = model.games.find(x => x.id === input.editingId); if (g && g.rule) return g.rule; }
  return model.rule;
}

function renderEntry() {
  const can = amEditor();
  $('input-panel').style.display = can ? '' : 'none';
  $('viewer-note').style.display = can ? 'none' : '';
  if (!can) return;
  const d = draftGame(input.vals, activeRule());
  const editing = !!input.editingId;
  const n = editing ? model.games.findIndex(g => g.id === input.editingId) + 1 : model.games.length + 1;
  $('input-title').textContent = editing ? '第' + n + '試合を修正中' : '第' + n + '試合';
  $('cancel-edit').style.display = editing ? 'block' : 'none';

  const rows = $('entry-rows'); clear(rows);
  for (let i = 0; i < 4; i++) {
    const raw = input.vals[i];
    const isAuto = d.autoIndex === i && raw === '';
    let text = '';
    if (raw !== '') text = raw === '-' ? '-' : fmtScore(parseInt(raw, 10));
    else if (isAuto) text = fmtScore(d.scores[i]);
    const res = d.complete ? d.result.players[i] : null;
    const score = h('span', { class: 'e-score' + (text === '' ? ' ph' : '') + (isAuto ? ' auto' : ''), text: text === '' ? '持ち点' : text });
    if (isAuto) score.appendChild(h('em', { text: '自動' }));
    const resNode = h('span', { class: 'e-res' });
    if (res) { resNode.appendChild(h('b', { class: cls(res.pt), text: fmtPt1(res.pt) })); resNode.appendChild(h('i', { text: res.rank + '位' })); }
    rows.appendChild(h('button', { type: 'button', class: 'e-row' + (i === input.active ? ' active' : ''), 'data-i': String(i), style: { '--pc': PC[i] } }, [h('span', { class: 'e-name', text: nm(i) }), score, resNode]));
  }
  const msg = $('draft-msg'), typed = input.vals.some(v => v !== '');
  if (d.complete) { msg.className = 'draft-msg ok'; msg.textContent = editing ? 'この内容で更新できます' : 'この内容で記録できます'; }
  else if (!typed) { msg.className = 'draft-msg'; msg.textContent = '終局時の持ち点を入れてね'; }
  else { msg.className = 'draft-msg ' + (d.diff !== undefined ? 'warn' : ''); msg.textContent = d.message; }
  const btn = $('record-btn');
  btn.disabled = !d.complete || sending;
  btn.textContent = sending ? '送信中…' : (editing ? '試合を更新する' : '第' + n + '試合を記録する');
}
$('entry-rows').addEventListener('click', e => {
  const b = e.target.closest('.e-row'); if (!b) return;
  input.active = parseInt(b.getAttribute('data-i'), 10); renderEntry();
});

(function buildKeypad() {
  const keys = [['7', '7'], ['8', '8'], ['9', '9'], ['BS', '⌫', 'fn'], ['4', '4'], ['5', '5'], ['6', '6'], ['C', 'C', 'fn'], ['1', '1'], ['2', '2'], ['3', '3'], ['NEG', '±', 'fn'], ['0', '0'], ['00', '00'], ['NEXT', '次へ ▶', 'next']];
  const kp = $('keypad');
  keys.forEach(k => kp.appendChild(h('button', { type: 'button', class: 'key' + (k[2] ? ' ' + k[2] : ''), 'data-k': k[0], text: k[1] })));
  kp.addEventListener('click', e => { const b = e.target.closest('.key'); if (b) pressKey(b.getAttribute('data-k')); });
})();

function advance() {
  const d = draftGame(input.vals, activeRule());
  for (let k = 1; k <= 4; k++) { const j = (input.active + k) % 4; if (input.vals[j] === '' && d.autoIndex !== j) { input.active = j; return; } }
  for (let k = 1; k <= 4; k++) { const j = (input.active + k) % 4; if (d.autoIndex !== j) { input.active = j; return; } }
}
function pressKey(k) {
  const i = input.active; let s = input.vals[i];
  const digits = s.replace('-', '').length;
  if (/^\d$/.test(k)) { if (s === '0') s = k; else if (s === '-0') s = '-' + k; else if (digits < 7) s += k; }
  else if (k === '00') { if (s !== '' && s !== '-' && !/^-?0$/.test(s) && digits <= 5) s += '00'; }
  else if (k === 'BS') s = s.slice(0, -1);
  else if (k === 'C') s = '';
  else if (k === 'NEG') s = s.startsWith('-') ? s.slice(1) : '-' + s;
  else if (k === 'NEXT') { advance(); renderEntry(); return; }
  input.vals[i] = s; input.op = null; renderEntry();
}

$('record-btn').addEventListener('click', recordGame);
$('cancel-edit').addEventListener('click', () => { resetInput(); renderEntry(); });

function recordGame() {
  if (!amEditor() || sending) return;
  const d = draftGame(input.vals, activeRule());
  if (!d.complete) return;
  if (role === 'host') {
    if (input.editingId) {
      if (!modelUpdateGame(model, input.editingId, d.scores)) { toast('更新できませんでした'); return; }
      toast('試合を更新しました');
    } else {
      if (!modelAddGame(model, d.scores)) { toast(model.games.length >= SYNC_MAX_GAMES ? '試合数の上限です（' + SYNC_MAX_GAMES + '試合）' : '記録できませんでした'); return; }
      toast('第' + model.games.length + '試合を記録しました');
    }
    resetInput(); afterChange(true);
    return;
  }
  // 入力を許可された参加者: ホストに記録をお願いする（同じ op の再送は二重に記録されない）
  if (!guest) return;
  if (!input.op) input.op = newId();
  sending = true; renderEntry();
  guest.send({ t: 'rec', op: input.op, s: d.scores }, true);
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => { sending = false; renderEntry(); toast('届いたか分かりません。もう一度押してね（二重には記録されません）'); }, 7000);
}

/* =====================================================================
   表示の更新
===================================================================== */
function renderHeader() {
  $('t-sub').textContent = role === 'host' ? '卓のホスト' : (synced ? '参加中（見る）' : 'ホストの卓を受信中…');
  if (role === 'guest' && synced && amEditor()) $('t-sub').textContent = '参加中（入力できます）';
  $('b-members').textContent = role === 'host' ? 'メンバー' : '自分の席';
  $('b-new').style.display = role === 'host' ? '' : 'none';
  $('b-save').textContent = role === 'host' ? 'この対局を履歴に保存' : 'この対局を自分の履歴に保存';
  $('b-quit').textContent = role === 'host' ? '部屋を閉じる' : '退出する';
  $('b-people').textContent = role === 'host' ? '参加者・QR' : '参加者';
}
function renderAll(animate) {
  renderHeader(); renderBoard(!!animate); renderEntry(); renderChartPanel(); renderLog();
}
let netState = { up: 0, total: 2 };
function renderChip() {
  const c = $('t-chip');
  c.textContent = (role === 'host' ? 'ホスト' : '参加中') + ' ・ 中継 ' + netState.up + '/' + netState.total;
  c.className = 'chip ' + (netState.up === 0 ? 'warn' : 'on');
}
function onNet(s) {
  netState = s; renderChip();
  if (s.up === 0) banner('中継サーバーにつながっていません…再接続中');
  else if ($('banner').textContent.indexOf('中継サーバー') === 0) hideBanner();
}

/* =====================================================================
   ホスト
===================================================================== */
function buildRoster() {
  const list = [{ id: 0, name: myName || 'ホスト', ed: true }];
  if (room) room.peers.forEach(p => list.push({ id: p.id, name: p.name, ed: editors.has(p.gid) }));
  return list;
}
function pushRoster() {
  roster = buildRoster();
  if (room) room.bcast({ t: 'roster', players: roster }, true);
  if (sheetKind === 'people') renderPeopleSheet();
  renderEntry(); renderHeader();
}
function currentSnap() { return modelToSnap(model, epoch, ++snapN); }
function broadcastSnap(reliable) {
  if (role !== 'host' || !room) return;
  const snap = currentSnap();
  if (snapEnvelopeSize(snap) > SYNC_MAX_ENV) { banner('試合が多すぎて送れません。新しい対局を始めてください', 6000); return; }
  room.bcast(snap, !!reliable);
}
function sendSnapTo(id) {
  if (role !== 'host' || !room) return;
  const snap = currentSnap();
  if (snapEnvelopeSize(snap) > SYNC_MAX_ENV) return;
  room.sendTo(id, snap, true);
}
let bcastTimer = null, periodicT = null;
function scheduleBroadcast() { clearTimeout(bcastTimer); bcastTimer = setTimeout(() => broadcastSnap(true), 400); }
function afterChange(animate) { saveHost(); renderAll(animate); broadcastSnap(true); }

function hostMsg(id, o) {
  if (!o || typeof o.t !== 'string') return;
  if (o.t === 'req') { sendSnapTo(id); return; }
  if (o.t !== 'rec') return;
  const p = room.peers.get(id); if (!p) return;
  const no = why => room.sendTo(id, { t: 'no', op: typeof o.op === 'string' ? o.op.slice(0, 40) : '', why }, true);
  if (!editors.has(p.gid)) { no('noperm'); return; }
  p.ops = p.ops || new Set();
  if (typeof o.op === 'string' && p.ops.has(o.op)) { room.sendTo(id, { t: 'ok', op: o.op }, true); return; }   // 再送された記録は、二重にしない
  const v = validateRec(o, model);
  if (!v.ok) { no(v.why); return; }
  const now = Date.now();
  if (now - (p.lastRec || 0) < 600) { no('rate'); return; }                              // 連打対策
  p.lastRec = now;
  if (!modelAddGame(model, v.scores)) { no('full'); return; }
  p.ops.add(o.op); if (p.ops.size > 60) p.ops.delete(p.ops.values().next().value);
  room.sendTo(id, { t: 'ok', op: o.op }, true);
  toast(p.name + ' が第' + model.games.length + '試合を記録しました');
  afterChange(true);
}

async function hostCreate() {
  saveName();
  let m = null;
  if (importedModel) { m = importedModel; importedModel = null; }
  else {
    const saved = loadHost();
    if (saved && saved.games.length && confirm('前回の卓（' + saved.games.length + '試合）の続きから始めますか？\n「キャンセル」を押すと、新しい卓にします。')) m = saved;
  }
  if (!m) m = newModel(ruleFromSelect(), model.names);
  model = m; synced = true; role = 'host'; myId = 0; editors.clear(); userLocked = false; resetInput();
  epoch = Math.floor(Math.random() * 2147483647); snapN = 0;
  try {
    room = await R.host({
      onNet,
      onJoin: p => { pushRoster(); setTimeout(() => sendSnapTo(p.id), 400); toast(p.name + ' が参加しました'); },
      onLeave: (p, why) => { pushRoster(); if (why !== 'kicked') toast(p.name + ' が抜けました'); },   // 入力の許可は鍵ごとに覚えておく（つなぎ直しても残る）
      onMsg: hostMsg
    });
  } catch (e) { role = null; room = null; toast('部屋を作れませんでした: ' + e.message); return; }
  roster = buildRoster();
  keepAwake(); saveHost(); buildBoardOnce(); renderAll(false); renderChip(); show('s-table');
  clearInterval(periodicT);
  periodicT = setInterval(() => { if (role !== 'host' || !room) { clearInterval(periodicT); return; } broadcastSnap(false); room.bcast({ t: 'roster', players: roster }, false); }, 6000);
  openPeopleSheet();
}

/* =====================================================================
   参加者
===================================================================== */
function guestMsg(o) {
  if (!o || typeof o.t !== 'string') return;
  if ($('banner').textContent.indexOf('ホストの応答') === 0) hideBanner();
  if (o.t === 'snap') {
    const p = parseSnap(o);
    if (!p || !acceptSnap(lastSnap, p.e, p.n)) return;
    lastSnap = { e: p.e, n: p.n };
    const before = sessionTotals(model).join(','), wasSynced = synced;
    model = p.model; synced = true;
    const after = sessionTotals(model).join(',');
    renderAll(wasSynced && before !== after);
    if (rejoining) { rejoining = false; hideBanner(); }
  } else if (o.t === 'roster') {
    const r = cleanRoster(o.players); if (!r) return;
    roster = r; renderEntry(); renderHeader();
    if (sheetKind === 'people') renderPeopleSheet();
  } else if (o.t === 'ok') {
    if (typeof o.op === 'string' && o.op === input.op) { resetInput(); renderEntry(); toast('記録しました'); }
  } else if (o.t === 'no') {
    if (typeof o.op === 'string' && o.op === input.op) {
      const why = { noperm: '入力の許可がありません', sum: '合計が合いませんでした', full: '試合数の上限です', rate: '少し待ってから、もう一度押してね' }[o.why] || '記録できませんでした';
      input.op = null; sending = false; clearTimeout(sendTimer); renderEntry(); toast(why);
    }
  }
}

async function joinWith(text, identity) {
  stopScan();
  qrText = String(text || '').trim();
  $('menu-err').textContent = '';
  try {
    guest = await R.join(qrText, {
      name: myName,
      onNet,
      onWelcome: id => {
        const first = role !== 'guest';
        role = 'guest'; myId = id; keepAwake();
        if (first) { synced = false; model = newModel(MJ_PRESETS[0]); lastSnap = { e: null, n: -1 }; roster = []; resetInput(); buildBoardOnce(); }
        renderAll(false); renderChip(); show('s-table');
        guest.send({ t: 'req' }, true);
      },
      onMsg: guestMsg,
      onStall: ms => {
        banner('ホストの応答がありません（ホストのスマホが止まっているかも）');
        if (ms > 12000 && !rejoining && role === 'guest') rejoin();
      },
      onEnd: why => {
        const wasIn = role === 'guest';
        guest = null;
        if (why === 'timeout' && wasIn && rejoining) { endGuest('ホストにつながりませんでした'); return; }
        endGuest(why === 'kicked' ? 'ホストに外されました' : why === 'closed' ? 'ホストが部屋を閉じました' : 'ホストにつながりませんでした（QRを読み直してください）');
      }
    }, identity);
  } catch (e) {
    guest = null; show('s-menu'); $('menu-err').textContent = e.message;
  }
}
function rejoin() {
  if (rejoining || !qrText) return;
  rejoining = true; banner('つなぎ直しています…');
  const old = guest; guest = null;
  const identity = old ? old.identity : undefined;        // 同じ鍵で入り直す（受付を締めたあとでも、前に入っていた人は戻れる）
  try { if (old) old.close(); } catch (e) { /* 閉じられなくても続ける */ }
  joinWith(qrText, identity);
}
function endGuest(msg) {
  stopScan(); closeSheet();
  guest = null; role = null; rejoining = false; roster = []; synced = false; hideBanner();
  show('s-menu'); $('menu-err').textContent = msg || '';
  if (msg) toast(msg);
}

/* =====================================================================
   シート（参加者・QR／メンバー／試合の詳細）
===================================================================== */
function openPeopleSheet() { openSheet('people', []); renderPeopleSheet(); }
function renderPeopleSheet() {
  const s = $('sheet'); clear(s); s.appendChild(h('div', { class: 'grip' }));
  s.appendChild(h('h3', { text: role === 'host' ? '参加者・QR' : '参加者' }));
  if (role === 'host' && room) {
    if (!userLocked) {
      const cv = h('canvas');
      s.appendChild(h('div', { class: 'qr-box' }, [cv, h('textarea', { class: 'code-box', readonly: 'readonly', rows: '3', 'aria-label': '参加コード', text: room.qr }),
        h('button', { class: 'mini-btn', type: 'button', text: '参加コードをコピー', on: { click: async () => toast((await copyText(room.qr)) ? 'コピーしました' : 'コピーできませんでした') } })]));
      try { drawQR(room.qr, cv, Math.min(window.innerWidth - 80, 260)); } catch (e) { /* QRが描けなくてもコードは使える */ }
      s.appendChild(h('p', { class: 'hint', text: '全員が同じQRを読み取ります。全員そろったら「受付を締める」を押してください（QRを知っている人が、あとから入れなくなります）。' }));
    } else {
      s.appendChild(h('p', { class: 'hint', text: '受付を締めています。新しい人は入れません。（通信が一時的に切れただけの人は、自動で戻れます。ページを開き直した人は、「受付を再開」しないと入れません）' }));
    }
  }
  roster.forEach(p => {
    const left = h('span', { class: 'pn' }, [p.name, h('small', { text: p.id === 0 ? 'ホスト' : (p.id === myId && role === 'guest' ? 'あなた' : (p.ed ? '入力できる' : '見るだけ')) })]);
    const right = h('span', { class: 'pb' });
    if (role === 'host' && p.id !== 0) {
      right.appendChild(h('button', { type: 'button', class: 'pbtn' + (p.ed ? ' on' : ''), text: p.ed ? '入力: 許可中' : '入力を許可', on: { click: () => { const peer = room.peers.get(p.id); if (!peer) return; if (editors.has(peer.gid)) editors.delete(peer.gid); else editors.add(peer.gid); pushRoster(); } } }));
      right.appendChild(h('button', { type: 'button', class: 'pbtn kick', text: '外す', on: { click: () => { const peer = room.peers.get(p.id); if (peer) editors.delete(peer.gid); room.kick(p.id); } } }));
    }
    s.appendChild(h('div', { class: 'prow' }, [left, right]));
  });
  const acts = h('div', { class: 'sheet-actions' });
  if (role === 'host') acts.appendChild(h('button', { type: 'button', class: 'btn', text: userLocked ? '🔓 受付を再開する' : '🔒 受付を締める', on: { click: () => { userLocked = !userLocked; if (room) room.setLocked(userLocked); renderPeopleSheet(); } } }));
  acts.appendChild(h('button', { type: 'button', class: 'btn gold', text: 'とじる', on: { click: closeSheet } }));
  s.appendChild(acts);
  $('backdrop').classList.add('open'); sheetKind = 'people';
}

function openMembersSheet() {
  if (role === 'host') {
    const nodes = [h('h3', { text: 'メンバー' })];
    for (let i = 0; i < 4; i++) {
      nodes.push(h('input', { class: 'mem-input', type: 'text', maxlength: '12', placeholder: 'P' + (i + 1), value: model.names[i], 'aria-label': 'P' + (i + 1) + 'の名前', style: { '--pc': PC[i] },
        on: { input: e => { model.names[i] = cleanName(e.target.value); saveHost(); renderAll(false); scheduleBroadcast(); } } }));
    }
    nodes.push(h('p', { class: 'hint', text: '名前を変えると、全員の画面にも反映されます。' }));
    nodes.push(h('div', { class: 'sheet-actions' }, [h('button', { type: 'button', class: 'btn gold', text: 'とじる', on: { click: closeSheet } })]));
    openSheet('members', nodes);
  } else {
    const pick = h('div', { class: 'seat-pick' });
    for (let i = 0; i < 4; i++) pick.appendChild(h('button', { type: 'button', class: mySeat === i ? 'on' : '', text: nm(i), style: { '--pc': PC[i] }, on: { click: () => setSeat(i) } }));
    openSheet('members', [h('h3', { text: '自分の席' }), h('p', { class: 'hint', text: '自分の画面だけ、自分の行に印を付けます。' }), pick,
      h('div', { class: 'sheet-actions' }, [h('button', { type: 'button', class: 'btn', text: '印をはずす', on: { click: () => setSeat(null) } }), h('button', { type: 'button', class: 'btn gold', text: 'とじる', on: { click: closeSheet } })])]);
  }
}
function setSeat(i) {
  mySeat = i;
  try { if (i === null) localStorage.removeItem(KEY_SEAT); else localStorage.setItem(KEY_SEAT, String(i)); } catch (e) { /* 保存できなくても動く */ }
  renderBoard(false); closeSheet();
}

function openGameSheet(id) {
  const idx = model.games.findIndex(g => g.id === id); if (idx < 0) return;
  const g = model.games[idx];
  const tb = h('tbody');
  for (let i = 0; i < 4; i++) tb.appendChild(h('tr', {}, [h('td', { style: { 'text-align': 'left', 'font-family': 'var(--serif)' }, text: nm(i) }), h('td', { text: fmtScore(g.scores[i]) }), h('td', {}, [h('b', { class: cls(g.pts[i]), text: fmtPt1(g.pts[i]) })]), h('td', { text: g.ranks[i] + '位' })]));
  const nodes = [h('h3', { text: '第' + (idx + 1) + '試合' }),
    h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, [h('th', { style: { 'text-align': 'left' }, text: '名前' }), h('th', { text: '持ち点' }), h('th', { text: 'pt' }), h('th', { text: '順位' })])]), tb])])];
  const acts = h('div', { class: 'sheet-actions' });
  if (role === 'host') {
    acts.appendChild(h('button', { type: 'button', class: 'btn gold', text: 'この試合を修正する', on: { click: () => startEdit(id) } }));
    acts.appendChild(h('button', { type: 'button', class: 'btn danger', text: 'この試合を削除する', on: { click: () => deleteGame(id) } }));
  }
  acts.appendChild(h('button', { type: 'button', class: 'link', text: '閉じる', on: { click: closeSheet } }));
  nodes.push(acts);
  openSheet('game', nodes);
}
function startEdit(id) {
  const g = model.games.find(x => x.id === id); if (!g) return;
  closeSheet();
  input = { vals: g.scores.map(String), active: 0, editingId: id, op: null };
  renderEntry();
  $('input-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function deleteGame(id) {
  const idx = model.games.findIndex(g => g.id === id); if (idx < 0) return;
  if (!confirm('第' + (idx + 1) + '試合を削除します。よろしいですか？')) return;
  model.games.splice(idx, 1);
  // 試合の id は番号ではなく固有なので、残りの試合はそのまま
  if (input.editingId === id) resetInput();
  closeSheet(); afterChange(true); toast('試合を削除しました');
}

/* =====================================================================
   履歴への保存・新しい対局・退出
===================================================================== */
function saveHistory() {
  if (!model.games.length) { toast('まだ試合がありません'); return; }
  const raw = localStorage.getItem(KEY_MAIN);
  if (raw === null && LEGACY_KEYS.some(k => localStorage.getItem(k) !== null)) { toast('先に「麻雀精算」アプリを一度開いてください'); return; }
  const d = new Date(), def = (d.getMonth() + 1) + '/' + d.getDate() + ' の対局';
  let title = prompt('履歴に残す名前', model.title || def);
  if (title === null) return;
  title = title.trim() || def;
  const session = modelToSession(model, title, Date.now());
  if (!session) { toast('保存できませんでした'); return; }
  const r = mergeIntoMainStorage(raw, session);
  if (!r.ok) { toast(r.why); return; }
  if (!r.added) { toast('同じ内容の対局が、すでに履歴にあります'); return; }
  try { localStorage.setItem(KEY_MAIN, r.json); } catch (e) { toast('この端末に保存できませんでした'); return; }
  if (role === 'host') { model.title = cleanTitle(title); saveHost(); scheduleBroadcast(); }
  toast('履歴に保存しました（麻雀精算アプリの「履歴」に入ります）');
}
function newTable() {
  if (role !== 'host') return;
  if (model.games.length && !confirm('いまの卓（' + model.games.length + '試合）を消して、新しい対局を始めます。\n履歴に保存していない記録は戻せません。よろしいですか？')) return;
  model = newModel(model.rule, model.names); resetInput(); afterChange(false); toast('新しい対局を始めました');
}
function quitAll() {
  if (role === 'host' && !confirm('部屋を閉じます。参加者の画面は、つながらなくなります。\n（この卓の記録は、この端末に残ります）')) return;
  stopScan(); closeSheet();
  if (role === 'host' && room) room.close(); else if (guest) guest.close();
  room = null; guest = null; role = null; roster = []; rejoining = false; synced = false; editors.clear(); hideBanner();
  show('s-menu');
}

/* =====================================================================
   メニュー
===================================================================== */
function saveName() { myName = cleanName($('name').value) || 'ゲスト'; $('name').value = myName; try { localStorage.setItem(KEY_NAME, myName); } catch (e) { /* 保存できなくても動く */ } }
let boardBuilt = false;
function buildBoardOnce() { if (!boardBuilt) { buildBoard(); boardBuilt = true; } }

function ruleOptions() {
  const main = readMain();
  const mainRule = main ? sanitizeRule(main.rule) : null;
  const opts = [];
  const ok = r => r && validRule(r);
  if (ok(mainRule) && !MJ_PRESETS.some(p => p.id !== 'custom' && p.start === mainRule.start && p.ret === mainRule.ret && p.uma.every((u, i) => u === mainRule.uma[i]))) {
    opts.push({ id: 'main', name: '麻雀精算アプリの設定（' + mainRule.start + '/' + mainRule.ret + '）', rule: mainRule });
  }
  MJ_PRESETS.filter(p => p.id !== 'custom').forEach(p => opts.push({ id: p.id, name: p.name, rule: { start: p.start, ret: p.ret, uma: p.uma.slice() } }));
  return opts;
}
let ruleOpts = [];
function buildRuleSelect() {
  ruleOpts = ruleOptions();
  const sel = $('host-rule'); clear(sel);
  ruleOpts.forEach(o => sel.appendChild(h('option', { value: o.id, text: o.name })));
  const main = readMain(), mr = main ? sanitizeRule(main.rule) : null;
  const match = mr && ruleOpts.find(o => o.rule.start === mr.start && o.rule.ret === mr.ret && o.rule.uma.every((u, i) => u === mr.uma[i]));
  if (match) sel.value = match.id;
}
function ruleFromSelect() {
  const o = ruleOpts.find(x => x.id === $('host-rule').value) || ruleOpts[0];
  return cloneRuleSync(o.rule);
}

$('b-host').addEventListener('click', hostCreate);
$('b-import').addEventListener('click', () => {
  const main = readMain();
  if (!main) { toast('引き継げる対局がありません'); return; }
  const cur = sanitizeSession(main.current), rule = sanitizeRule(main.rule) || cloneRuleSync(MJ_PRESETS[0]);
  const r = modelFromSession(cur, rule);
  if (!r.ok) { toast(r.why); return; }
  importedModel = r.model;
  $('host-note').textContent = '「いまの対局」（' + r.model.games.length + '試合）を引き継ぎます。「部屋をつくる」を押してください。';
  toast(r.model.games.length + '試合を引き継ぎます');
});
$('b-join').addEventListener('click', () => {
  saveName(); $('menu-err').textContent = '';
  show('s-scan'); $('sc-msg').textContent = 'ホストの画面のQRを、枠に写してください';
  stopScan();
  scanner = startScan($('sc-video'), joinWith, e => { $('sc-msg').textContent = camMsg(e); });
});
$('b-paste').addEventListener('click', () => { const t = $('paste').value.trim(); if (!t) { $('menu-err').textContent = '参加コードを貼り付けてください'; return; } saveName(); joinWith(t); });
$('sc-back').addEventListener('click', () => { stopScan(); show('s-menu'); });
$('b-members').addEventListener('click', openMembersSheet);
$('b-people').addEventListener('click', () => (role === 'host' ? openPeopleSheet() : (openSheet('people', []), renderPeopleSheet())));
$('t-chip').addEventListener('click', () => { if (role === 'host') openPeopleSheet(); });
$('b-save').addEventListener('click', saveHistory);
$('b-new').addEventListener('click', newTable);
$('b-quit').addEventListener('click', quitAll);
$('b-copy').addEventListener('click', async () => {
  if (!model.games.length) { toast('コピーできる結果がありません'); return; }
  toast((await copyText(buildSettlementText(model.title || '対局中', settlementEntries()))) ? '精算の内容をコピーしました' : 'コピーできませんでした');
});

document.addEventListener('gesturestart', e => e.preventDefault());
window.addEventListener('pagehide', stopScan);
if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* 登録できなくても動く */ }); });
buildRuleSelect();
buildBoardOnce();
renderAll(false);
})();
