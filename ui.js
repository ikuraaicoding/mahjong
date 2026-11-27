/* 麻雀精算: 画面の部品（対局画面 app.js と、参加画面 online.js で共通）
 * 方針: 画面は DOM と textContent だけで組み立てる（innerHTML は使わない）。
 *       通信で受け取った名前などをそのまま渡しても、HTMLとして解釈されることはない。
 * logic.js / sync.js が先に必要。
 */
(function () {
'use strict';
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'line', 'polyline', 'circle', 'text', 'path', 'rect', 'g']);
const PC = ['var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)'];
const HEX = ['#e5585f', '#4f8fe8', '#e8a13a', '#c46bb6'];   // app.css の --p1〜--p4 と同じ色
const ROW_H = 58, ROW_GAP = 6;                               // app.css の .b-row / .board と合わせる
const $ = id => document.getElementById(id);

/* ---------- DOM ヘルパー ----------
   h('button.key.fn#id', { onclick, style: {'--pc': ...}, 'aria-label': ... }, 子, [子...], 'テキスト') */
function h(sel, props) {
  const parts = String(sel).split(/(?=[.#])/);
  let tag = 'div', i = 0;
  if (parts[0] && parts[0][0] !== '.' && parts[0][0] !== '#') { tag = parts[0]; i = 1; }
  const e = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (; i < parts.length; i++) {
    const p = parts[i];
    if (p[0] === '.') e.classList.add(p.slice(1)); else if (p[0] === '#') e.id = p.slice(1);
  }
  if (props) Object.keys(props).forEach(k => {
    const v = props[k];
    if (v == null || v === false) return;
    if (k === 'text') e.textContent = String(v);
    else if (k === 'class') String(v).split(/\s+/).forEach(c => { if (c) e.classList.add(c); });
    else if (k === 'style') Object.keys(v).forEach(s => e.style.setProperty(s, v[s]));
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  });
  for (let j = 2; j < arguments.length; j++) add(e, arguments[j]);
  return e;
}
function add(e, c) {
  if (c == null || c === false) return e;
  if (Array.isArray(c)) c.forEach(x => add(e, x));
  else e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  return e;
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
const cls = v => (round1(v) > 0 ? 'pos' : (round1(v) < 0 ? 'neg' : ''));
const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function buzz() { if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* 対応していない端末 */ } } }

/* ---------- トースト・お知らせ帯 ---------- */
let toastT = null;
function toast(msg, ms) {
  const el = $('toast'); if (!el) return;
  el.textContent = msg; el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms || 2800);
}
function banner(msg, action) {
  const b = $('banner'); if (!b) return;
  clear(b); b.appendChild(h('span', null, msg));
  if (action) b.appendChild(h('button', { type: 'button', onclick: action.fn }, action.label));
  b.classList.add('on'); b.dataset.msg = msg;
}
function hideBanner() { const b = $('banner'); if (b) { b.classList.remove('on'); b.dataset.msg = ''; } }
function bannerMsg() { const b = $('banner'); return b && b.classList.contains('on') ? (b.dataset.msg || '') : ''; }

/* ---------- 下から出るシート ---------- */
let sheetK = null, sheetOnClose = null;
function openSheet(kind, nodes, onClose) {
  const prev = sheetOnClose; sheetOnClose = null;
  if (prev) { try { prev(); } catch (e) { /* 続ける */ } }
  sheetK = kind;
  const s = $('sheet'); clear(s);
  s.appendChild(h('div.grip'));
  add(s, nodes);
  sheetOnClose = onClose || null;
  $('backdrop').classList.add('open'); document.body.classList.add('sheet-open');
  s.scrollTop = 0;
}
// 開いているシートの中身だけを描き直す（閉じたときの処理はそのまま）
function refillSheet(nodes) {
  const s = $('sheet'), top = s.scrollTop;
  clear(s); s.appendChild(h('div.grip')); add(s, nodes); s.scrollTop = top;
}
function closeSheet() {
  const f = sheetOnClose; sheetOnClose = null; sheetK = null;
  $('backdrop').classList.remove('open'); document.body.classList.remove('sheet-open');
  if (f) { try { f(); } catch (e) { /* 続ける */ } }
}
function sheetKind() { return sheetK; }
$('backdrop').addEventListener('click', e => { if (e.target === $('backdrop')) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetK) closeSheet(); });

// 確認・入力のシート（confirm / prompt の代わり）。OK → true / 入力した文字、やめる → false / null
// o = { title, body: 文字 | ノード, input: { value, label, max, placeholder }, below: 入力欄の下に出すノード, ok, cancel, danger }
function ask(o) {
  return new Promise(resolve => {
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    const inp = o.input ? h('input.txt', { type: 'text', maxlength: o.input.max || 40, placeholder: o.input.placeholder || '', enterkeyhint: 'done', autocomplete: 'off', 'aria-label': o.input.label || o.title }) : null;
    if (inp) inp.value = o.input.value || '';
    const ok = () => { fin(inp ? inp.value : true); closeSheet(); };
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    openSheet('ask', [
      h('h3', null, o.title),
      o.body ? (typeof o.body === 'string' ? h('p.sheet-text', null, o.body) : o.body) : null,
      inp ? (o.input.label ? h('label.field', null, h('span', null, o.input.label), inp) : inp) : null,
      o.below || null,
      h('div.sheet-actions', null,
        h('button.btn' + (o.danger ? '.danger' : '.primary'), { type: 'button', onclick: ok }, o.ok || 'OK'),
        o.cancel === false ? null : h('button.link', { type: 'button', onclick: () => closeSheet() }, o.cancel || 'やめる'))
    ], () => fin(inp ? null : false));
  });
}

/* ---------- コピー・リンクを送る ---------- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 次の方法を試す */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.setProperty('position', 'fixed'); ta.style.setProperty('top', '0'); ta.style.setProperty('opacity', '0');
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok;
  } catch (e) { return false; }
}
// スマホの「共有」メニューで送る（ないときはコピー）。'shared' | 'copied' | 'cancel' | 'fail'
async function shareLink(o) {
  if (navigator.share) {
    try { await navigator.share(o); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  return (await copyText(o.url)) ? 'copied' : 'fail';
}

/* ---------- QR ---------- */
function drawQR(text, canvas, cssSize) {
  const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), quiet = 3, dpr = window.devicePixelRatio || 1;
  const px = Math.max(2, Math.floor(cssSize * dpr / (n + quiet * 2))), size = px * (n + quiet * 2);
  canvas.width = size; canvas.height = size;
  canvas.style.setProperty('width', (size / dpr) + 'px'); canvas.style.setProperty('height', (size / dpr) + 'px');
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); ctx.fillStyle = '#111';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
}

/* ---------- 画面を消さない（共有中・参加中） ---------- */
let wakeLock = null, wakeWant = false;
async function wake(on) {
  wakeWant = !!on;
  if (!on) { const w = wakeLock; wakeLock = null; if (w) { try { await w.release(); } catch (e) { /* もう外れている */ } } return; }
  try {
    if (navigator.wakeLock && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* 使えなくても動く */ }
}
document.addEventListener('visibilitychange', () => { if (wakeWant && document.visibilityState === 'visible') wake(true); });

/* =====================================================================
   順位ボード: 数字が先にカウントして変わり、ひと呼吸おいて行がゆっくり入れ替わる
===================================================================== */
function Board(el) {
  const rows = [], rank = [], name = [], me = [], move = [], total = [], delta = [];
  let shownTotals = [0, 0, 0, 0], shownOrder = [0, 1, 2, 3], timers = [];
  clear(el);
  for (let i = 0; i < 4; i++) {
    rank[i] = h('div.b-rank', null, String(i + 1));
    name[i] = h('span.b-name-text'); me[i] = h('span.b-me', { hidden: true }, 'あなた'); move[i] = h('span.b-move');
    total[i] = h('div.b-total', null, '0.0'); delta[i] = h('div.b-delta');
    rows[i] = h('div.b-row', { style: { '--pc': PC[i] } }, rank[i], h('div.b-name', null, name[i], me[i], move[i]), h('div.b-val', null, total[i], delta[i]));
    el.appendChild(rows[i]);
  }
  const orderOf = t => [0, 1, 2, 3].sort((a, b) => t[b] - t[a] || a - b);
  let empty = false;   // まだ試合がない: 順位もトップも出さない
  function place(order, anim) {
    order.forEach((p, pos) => {
      const r = rows[p];
      if (!anim) r.style.setProperty('transition', 'none');
      r.style.setProperty('transform', 'translateY(' + (pos * (ROW_H + ROW_GAP)) + 'px)');
      r.classList.toggle('lead', pos === 0 && !empty);
      if (!anim) { void r.offsetHeight; r.style.removeProperty('transition'); }
    });
  }
  function setTotals(v) { for (let i = 0; i < 4; i++) { total[i].textContent = fmtPt1(v[i]); total[i].className = 'b-total ' + cls(v[i]); } }
  function setRanks(t) { for (let i = 0; i < 4; i++) rank[i].textContent = empty ? '–' : String(rankOf(t, i)); }
  // o = { names[4], totals[4], last: 前の試合のpt[4] | null, me: 自分の席 | null, empty: 試合がまだない, animate }
  function render(o) {
    timers.forEach(clearTimeout); timers = [];
    empty = !!o.empty;
    const totals = o.totals.slice(), order = orderOf(totals);
    for (let i = 0; i < 4; i++) {
      name[i].textContent = o.names[i];
      rows[i].classList.toggle('me', o.me === i); me[i].hidden = o.me !== i;
      if (o.last) { delta[i].textContent = '前回 ' + fmtPt1(o.last[i]); delta[i].className = 'b-delta ' + cls(o.last[i]); }
      else { delta[i].textContent = ''; delta[i].className = 'b-delta'; }
    }
    if (!o.animate || reduced()) {
      setTotals(totals); setRanks(totals); place(order, false);
      move.forEach(m => { m.className = 'b-move'; });
      shownTotals = totals; shownOrder = order;
      return;
    }
    // 1) 数字がカウントして変わる
    const from = shownTotals.slice(), prevOrder = shownOrder.slice(), STEPS = 30;
    for (let k = 1; k <= STEPS; k++) {
      const t = k / STEPS, e = 1 - Math.pow(1 - t, 3);
      timers.push(setTimeout(() => setTotals(from.map((f, i) => f + (totals[i] - f) * e)), k * 40));
    }
    timers.push(setTimeout(() => { setTotals(totals); shownTotals = totals; }, STEPS * 40 + 20));
    // 2) ひと呼吸おいて、行がゆっくり入れ替わる
    timers.push(setTimeout(() => {
      for (let i = 0; i < 4; i++) {
        const before = prevOrder.indexOf(i), after = order.indexOf(i);
        if (after < before) { move[i].textContent = '▲'; move[i].className = 'b-move up'; }
        else if (after > before) { move[i].textContent = '▼'; move[i].className = 'b-move down'; }
        else move[i].className = 'b-move';
        rows[i].style.setProperty('z-index', after < before ? '2' : '1');
      }
      setRanks(totals); place(order, true);
      shownOrder = order;
    }, STEPS * 40 + 450));
  }
  return { render };
}

/* =====================================================================
   ポイント推移グラフ
===================================================================== */
function chart(series, names) {
  const n = series[0].length - 1;
  if (n < 1) return h('div.empty', null, '試合を記録すると、ここに推移グラフが出ます');
  const W = 360, H = 200, L = 34, Rm = 66, T = 12, B = 24;
  let min = 0, max = 0;
  series.forEach(s => s.forEach(v => { if (v < min) min = v; if (v > max) max = v; }));
  if (max - min < 20) { max += 10; min -= 10; }
  const step = [5, 10, 20, 25, 50, 100, 200, 500].find(s => (max - min) / s <= 5) || 1000;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const X = i => L + (W - L - Rm) * (i / n), Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const svg = h('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'ポイント推移グラフ' });
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = Y(v).toFixed(1);
    svg.appendChild(h('line', { x1: L, x2: W - Rm, y1: y, y2: y, class: v === 0 ? 'zero' : 'grid' }));
    svg.appendChild(h('text', { x: L - 6, y: (Y(v) + 3.5).toFixed(1), 'text-anchor': 'end' }, String(v)));
  }
  const xs = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i <= n; i += xs) svg.appendChild(h('text', { x: X(i).toFixed(1), y: H - 7, 'text-anchor': 'middle' }, String(i)));
  series.forEach((s, p) => svg.appendChild(h('polyline', {
    points: s.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' '), fill: 'none', stroke: HEX[p],
    'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
  })));
  series.forEach((s, p) => svg.appendChild(h('circle', { cx: X(n).toFixed(1), cy: Y(s[n]).toFixed(1), r: 3.6, fill: HEX[p] })));
  // 右端の名前: 重ならないように並べ、上下にはみ出さないようにする
  const labels = series.map((s, p) => ({ p, y: Y(s[n]) })).sort((a, b) => a.y - b.y);
  const GAP = 13, top = T + 4, bottom = H - B;
  labels.forEach((l, k) => { l.y = Math.max(l.y, k ? labels[k - 1].y + GAP : top); });
  for (let k = labels.length - 1; k >= 0; k--) labels[k].y = Math.min(labels[k].y, k < labels.length - 1 ? labels[k + 1].y - GAP : bottom);
  labels.forEach(l => svg.appendChild(h('text', { x: W - Rm + 9, y: (l.y + 4).toFixed(1), class: 'lbl', style: { fill: HEX[l.p] } }, Array.from(names[l.p]).slice(0, 5).join(''))));
  return svg;
}

/* ---------- 精算（誰が誰にいくら渡すか）。entries: [{ name, pt }] ---------- */
function settle(entries) {
  const transfers = calcTransfers(entries);
  if (!transfers.length) return h('div.empty', null, '全員が 0pt なので、受け渡しはありません');
  return h('div', null, transfers.map(t => h('div.tr-item', null,
    h('span.tr-who', null, h('span.tr-from', null, t.from), h('span.tr-arrow', { 'aria-label': 'から' }, '→'), h('span.tr-to', null, t.to)),
    h('span.tr-amt', null, t.pt.toFixed(1), h('small', null, 'pt')))));
}

/* ---------- 試合ログ（新しい順） ---------- */
function gameLog(games, names, onOpen) {
  if (!games.length) return h('div.empty', null, 'まだ試合がありません');
  const box = h('div.log');
  for (let idx = games.length - 1; idx >= 0; idx--) {
    const g = games[idx];
    box.appendChild(h('button.log-item', { type: 'button', onclick: () => onOpen(g.id) },
      h('span.log-n', null, String(idx + 1)),
      h('span.log-cells', null, [0, 1, 2, 3].map(i => h('span.lc', { class: g.ranks[i] === 1 ? 'top' : null },
        h('span', null, names[i]), h('b', { class: cls(g.pts[i]) }, fmtPt1(g.pts[i])))))));
  }
  return box;
}

// 1試合の詳細の表
function gameTable(g, names) {
  return h('div.tbl-wrap', null, h('table.tbl', null,
    h('thead', null, h('tr', null, h('th.l', null, '名前'), h('th', null, '持ち点'), h('th', null, 'pt'), h('th', null, '順位'))),
    h('tbody', null, [0, 1, 2, 3].map(i => h('tr', null,
      h('td.l', { style: { '--pc': PC[i] } }, h('span.dot'), names[i]),
      h('td', null, g.scores ? fmtScore(g.scores[i]) : '—'),
      h('td', null, h('b', { class: cls(g.pts[i]) }, fmtPt1(g.pts[i]))),
      h('td', null, g.ranks[i] + '位'))))));
}

// 最終結果（順位の順に並べる）
function standings(names, totals) {
  const order = [0, 1, 2, 3].sort((a, b) => totals[b] - totals[a] || a - b);
  return h('div.standings', null, order.map(p => {
    const r = rankOf(totals, p);
    return h('div.sd-row', { class: r === 1 ? 'top' : null, style: { '--pc': PC[p] } },
      h('span.sd-rk', null, String(r)), h('span.sd-nm', null, names[p]), h('b', { class: cls(totals[p]) }, fmtPt1(totals[p])));
  }));
}

/* =====================================================================
   点数の入力（行・テンキー）
===================================================================== */
function entryRows(el, input, d, names, onSelect) {
  clear(el);
  for (let i = 0; i < 4; i++) {
    const raw = input.vals[i], isAuto = d.autoIndex === i && raw === '';
    let text = '';
    if (raw !== '') text = raw === '-' ? '-' : fmtScore(parseInt(raw, 10));
    else if (isAuto) text = fmtScore(d.scores[i]);
    const res = d.complete ? d.result.players[i] : null;
    el.appendChild(h('button.e-row', { type: 'button', class: i === input.active ? 'active' : null, style: { '--pc': PC[i] }, 'aria-pressed': i === input.active ? 'true' : 'false', onclick: () => onSelect(i) },
      h('span.e-name', null, names[i]),
      h('span.e-score', { class: (text === '' ? 'ph ' : '') + (isAuto ? 'auto' : '') }, text === '' ? '持ち点' : text, isAuto ? h('em', null, '自動') : null),
      h('span.e-res', null, res ? [h('b', { class: cls(res.pt) }, fmtPt1(res.pt)), h('i', null, res.rank + '位')] : null)));
  }
}
function draftMsg(el, d, vals, editing) {
  if (d.complete) { el.className = 'draft-msg ok'; el.textContent = editing ? 'この内容で更新できます' : 'この内容で記録できます'; }
  else if (!vals.some(v => v !== '')) { el.className = 'draft-msg'; el.textContent = '3人入れると、残りの1人は自動で計算されます'; }
  else { el.className = 'draft-msg' + (d.diff !== undefined ? ' warn' : ''); el.textContent = d.message; }
}
const KEYS = [['7'], ['8'], ['9'], ['BS', '⌫', 'fn', '1文字消す'], ['4'], ['5'], ['6'], ['C', 'C', 'fn', 'クリア'], ['1'], ['2'], ['3'], ['NEG', '±', 'fn', 'プラスとマイナスを切り替え'], ['0'], ['00'], ['NEXT', '次へ', 'next', '次の人へ']];
function keypad(el, onKey) {
  clear(el);
  KEYS.forEach(k => el.appendChild(h('button.key', { type: 'button', class: k[2] || null, 'aria-label': k[3] || null, onclick: () => onKey(k[0]) }, k[1] || k[0])));
}
function entryAdvance(input, rule) {
  const d = draftGame(input.vals, rule);
  for (let k = 1; k <= 4; k++) { const j = (input.active + k) % 4; if (input.vals[j] === '' && d.autoIndex !== j) { input.active = j; return; } }
  for (let k = 1; k <= 4; k++) { const j = (input.active + k) % 4; if (d.autoIndex !== j) { input.active = j; return; } }   // 空きがなければ、次の人へ
}
// キーを1つ押す。持ち点が変わったら true
function entryKey(input, k, rule) {
  const i = input.active; let s = input.vals[i];
  const digits = s.replace('-', '').length;
  if (/^\d$/.test(k)) { if (s === '0') s = k; else if (s === '-0') s = '-' + k; else if (digits < 7) s += k; }
  else if (k === '00') { if (s !== '' && s !== '-' && !/^-?0$/.test(s) && digits <= 5) s += '00'; }
  else if (k === 'BS') s = s.slice(0, -1);
  else if (k === 'C') s = '';
  else if (k === 'NEG') s = s.startsWith('-') ? s.slice(1) : '-' + s;
  else if (k === 'NEXT') { entryAdvance(input, rule); return false; }
  else return false;
  input.vals[i] = s;
  return true;
}
// パソコンのキーボードでも入力できるように（Enter・↑ は画面側で扱う）
function keyFromEvent(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (/^[0-9]$/.test(e.key)) return e.key;
  return { Backspace: 'BS', Delete: 'C', '-': 'NEG', ArrowDown: 'NEXT' }[e.key] || null;
}

/* ---------- タブ（推移・精算・試合）。押したタブは覚えておく ---------- */
function Tabs(nav, key, onChange) {
  const btns = Array.from(nav.querySelectorAll('[data-seg]'));
  let cur = null;
  try { cur = localStorage.getItem(key); } catch (e) { /* 覚えられなくても動く */ }
  if (!btns.some(b => b.dataset.seg === cur)) cur = btns[0].dataset.seg;
  function set(name) {
    cur = name;
    btns.forEach(b => {
      const on = b.dataset.seg === name;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
      const p = $(b.getAttribute('aria-controls')); if (p) p.hidden = !on;
    });
    try { localStorage.setItem(key, name); } catch (e) { /* 同上 */ }
    if (onChange) onChange(name);
  }
  btns.forEach(b => b.addEventListener('click', () => set(b.dataset.seg)));
  set(cur);
  return { set, get: () => cur };
}

/* =====================================================================
   席決め: 伏せた牌を1人ずつめくる（決まりごとは logic.js の seat〜）
   ホストも参加者も、parseSeat の形（表になった牌だけ）を show() に渡して描く。
   o = { host, names(), canPick(v), pick(k), setMode(haku), actions(v, result) → ボタンの配列 }
===================================================================== */
const SEAT_RULE_HAKU = '東・南・西・北・白の5枚から1枚ずつ。白をひいた人のいる場所が卓の東になり、白の人は余った風をもらいます（白が余ったら、東の人のいる場所が卓の東）。';
const SEAT_RULE_PLAIN = '東・南・西・北の4枚から1枚ずつ。ひいた風がその人の席です。';
function SeatUI(o) {
  let view = null, shown = null;
  const turnOf = v => v.owner.filter(p => p >= 0).length;
  // いまタップしてめくれる番か（白なしの4人目は自動でめくれる）
  const openForPick = v => { const t = turnOf(v); return t < 4 && !(v.w.length === 4 && t >= 3); };
  const live = id => view && view.id === id && sheetK === 'seat';

  function open() {
    const v = view; if (!v) return;
    const n = v.w.length, tiles = h('div.sk-tiles.n' + n, { id: 'sk-tiles' });
    for (let k = 0; k < n; k++) {
      tiles.appendChild(h('button.sk-tile', { type: 'button', id: 'sk-tile-' + k, 'aria-label': (k + 1) + '枚目の牌', onclick: () => tap(k) },
        h('span.sk-in', null, h('span.sk-back'), h('span.sk-face')), h('span.sk-who')));
    }
    openSheet('seat', [
      h('h3', null, '席決め'),
      o.host ? h('div.sk-mode', { id: 'sk-mode', role: 'group', 'aria-label': 'ルール' },
        h('button', { type: 'button', class: v.haku ? 'on' : null, onclick: () => o.setMode(true) }, '白あり'),
        h('button', { type: 'button', class: v.haku ? null : 'on', onclick: () => o.setMode(false) }, '白なし')) : null,
      h('p.sk-rule', null, v.haku ? SEAT_RULE_HAKU : SEAT_RULE_PLAIN),
      h('div.sk-turn', { id: 'sk-turn' }), tiles, h('div', { id: 'sk-result' }), h('div.sheet-actions', { id: 'sk-actions' })
    ]);
    shown = null;
    update(false);
  }
  function tap(k) {
    const v = view;
    if (!v || v.owner[k] >= 0 || !openForPick(v) || !o.canPick(v)) return;
    o.pick(k);
  }
  function flip(k, label, pc) {
    const v = view, tile = $('sk-tile-' + k);
    if (!v || !tile || tile.classList.contains('open')) return;
    const w = v.w[k], face = tile.querySelector('.sk-face');
    face.textContent = w === SEAT_HAKU ? '' : w;
    face.classList.toggle('ton', w === '東'); face.classList.toggle('haku', w === SEAT_HAKU);
    const who = tile.querySelector('.sk-who');
    who.textContent = label;
    if (pc) who.style.setProperty('--pc', pc); else who.classList.add('left');
    tile.classList.add('open'); tile.setAttribute('aria-label', label + ': ' + w);
  }
  function update(animate) {
    const v = view; if (!v || sheetK !== 'seat') return;
    const names = o.names();
    for (let k = 0; k < v.w.length; k++) {
      const p = v.owner[k];
      if (p < 0) continue;
      const tile = $('sk-tile-' + k);
      if (tile && !tile.classList.contains('open')) { flip(k, names[p], PC[p]); if (animate) buzz(); }
    }
    const t = turnOf(v), turn = $('sk-turn'), mode = $('sk-mode');
    clear(turn);
    if (mode) mode.hidden = t > 0;
    $('sk-tiles').classList.toggle('wait', !openForPick(v) || !o.canPick(v));
    if (t >= 4) {
      turn.style.removeProperty('--pc');
      add(turn, ['席が決まりました', h('small', null, '東の人が起家（最初の親）です')]);
      if (shown !== v.id) {
        shown = v.id;
        const id = v.id, li = v.owner.indexOf(-1);
        // 余りの牌は、少し遅れて表にする
        if (li >= 0) { if (animate) setTimeout(() => { if (live(id)) flip(li, '余り', null); }, 650); else flip(li, '余り', null); }
        setTimeout(() => { if (live(id)) result(); }, !animate ? 0 : (li >= 0 ? 1300 : 700));
      }
    } else {
      turn.style.setProperty('--pc', PC[t]);
      add(turn, [h('b', null, names[t]), ' さんの番', h('small', null, o.canPick(v) ? '伏せてある牌を1枚えらんでください' : names[t] + ' さんがめくるのを待っています')]);
      actions();
    }
  }
  function result() {
    const v = view; if (!v || sheetK !== 'seat') return;
    const r = seatResult(v.w, v.owner); if (!r) return;
    const names = o.names();
    // 卓の図: 東が手前、右が南（下家）、向かいが西（対面）、左が北（上家）
    const table = h('div.sk-table');
    if (v.haku) table.appendChild(h('div.sk-center', null, h('div', null, '手前が卓の東', h('br'), '（', h('b', null, names[r.ref]), ' さんの', h('br'), 'いまの場所）')));
    r.order.forEach((p, k) => table.appendChild(h('div.sk-seat.sk-s' + k, { class: k === 0 ? 'oya' : null, style: { '--pc': PC[p], 'animation-delay': (k * 0.12) + 's' } },
      h('i', null, SEAT_WINDS[k]), h('span', null, names[p]), k === 0 ? h('small', null, '起家') : null)));
    const note = !v.haku ? null : (r.haku >= 0
      ? ['白をひいた ', h('b', null, names[r.haku]), ' さんがいま座っている場所が、卓の「東」です。' + names[r.haku] + ' さんは余った「' + r.left + '」の席に移ります。']
      : ['白が余ったので、東をひいた ', h('b', null, names[r.ref]), ' さんのいる場所が、卓の「東」です。']);
    const box = clear($('sk-result'));
    box.appendChild(h('div.sk-result', null, table, note ? h('p.sk-note', null, note) : null));
    actions();
  }
  function actions() {
    const a = $('sk-actions'); if (!a || !view || sheetK !== 'seat') return;
    clear(a); add(a, o.actions(view, seatResult(view.w, view.owner)));
  }
  // 'play' の状態を受け取って描く（変わっていなければ何もしない）
  function show(v) {
    const same = view && view.id === v.id;
    if (same && view.owner.every((p, k) => p === v.owner[k]) && view.w.every((w, k) => w === v.w[k])) return;
    view = v;
    if (!same) { shown = null; open(); }
    else if (sheetK === 'seat') update(true);
  }
  return { show, open, actions, reset() { view = null; shown = null; }, get view() { return view; } };
}

window.MJUI = {
  h, add, clear, cls, PC, HEX, buzz,
  toast, banner, hideBanner, bannerMsg,
  openSheet, refillSheet, closeSheet, sheetKind, ask,
  copyText, shareLink, drawQR, wake,
  Board, chart, settle, gameLog, gameTable, standings,
  entryRows, draftMsg, keypad, entryKey, keyFromEvent, Tabs, SeatUI
};
})();
