/* 麻雀精算: 卓に参加する（参加者の画面）
 * ホストが対局画面で「共有」した卓を、このスマホに映す。
 * 方針
 *  - 受け取ったデータは sync.js で型・範囲を検査し、画面は ui.js（DOM と textContent だけ）で出す
 *  - 同期するのは名前・ルール・各試合の持ち点だけ。順位とポイントは、このスマホで計算し直す
 *  - 入力を許可されたら、ホストに「記録のお願い」を送れる（記録を決めるのはホスト）
 *  - ホストが対局を終えたら、その結果を自分の履歴にもワンタップで保存できる
 */
(function () {
'use strict';
const U = window.MJUI, R = window.NomiRoom;
const { h, clear, PC, toast } = U;
const $ = id => document.getElementById(id);
const KEY_MAIN = 'mahjong_v3', KEY_NAME = 'mj_online_name', KEY_SEAT = 'mj_online_seat', KEY_GUEST = 'mj_guest_room', KEY_AUTO = 'mj_guest_autosave', KEY_SEG = 'mj_guest_seg', KEY_LAST = 'mj_guest_last';
const LEGACY_KEYS = ['mahjong_pNames', 'mahjong_archives', 'mahjong_app2_scores'];
const CODE_RE = /MJ1~[A-Za-z0-9_-]{22}~[A-Za-z0-9_-]{20,120}/;
const GUEST_RESUME_MS = 6 * 3600 * 1000;   // 開き直したとき、これより最近まで参加していたら、同じ卓につなぎ直す
const REJOIN_WAIT = 30 * 60 * 1000;        // 参加中にホストが止まったとき、アプリを開き直すのを待つ長さ
const RESUME_WAIT = 3 * 60 * 1000;         // この画面を開き直したとき、さっきの卓を待つ長さ
const LAST_KEEP_MS = 3 * 24 * 3600 * 1000;  // 最後に受け取った卓の記録を、この端末に残しておく長さ

/* ---------- 状態 ---------- */
let guest = null, joinSeq = 0, myId = -1, inTable = false, synced = false, rejoining = false;
let code = '', pendingCode = '', identity = null;
let model = newModel(MJ_PRESETS[0]), roster = [], lastSnap = { e: null, n: -1 };
let netState = { up: 0, total: 2 }, lastModel = null, touchT = null;
let offline = false;   // ホストとつながっていないが、最後に受け取った記録を見ている
let myName = '', mySeat = null;
let input = { vals: ['', '', '', ''], active: 0, editingId: null, op: null }, sending = false, sendTimer = null;
const finSeen = new Set();
const nm = i => displayName(model.names[i], i);
const names4 = () => [0, 1, 2, 3].map(nm);
const todayTitle = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()} の対局`; };

try { myName = cleanName(localStorage.getItem(KEY_NAME) || ''); } catch (e) { /* 保存できなくても動く */ }
try { const s = parseInt(localStorage.getItem(KEY_SEAT), 10); if (s >= 0 && s <= 3) mySeat = s; } catch (e) { /* 同上 */ }
$('name').value = myName; $('name-ready').value = myName;

function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); window.scrollTo(0, 0); }
function menuErr(msg) { $('menu-err').textContent = msg || ''; }
function amEditor() { const me = roster.find(p => p.id === myId); return !!(inTable && me && me.ed); }
// 自分の席: 選んだ席。選んでいなければ、自分の名前と同じメンバー（1人だけのとき）
function seatIdx() {
  if (mySeat !== null) return mySeat;
  const k = nameKey(myName);
  if (!k) return null;
  const hits = [0, 1, 2, 3].filter(i => nameKey(model.names[i]) === k);
  return hits.length === 1 ? hits[0] : null;
}
function ruleName(r) {
  const p = MJ_PRESETS.find(x => x.id !== 'custom' && x.start === r.start && x.ret === r.ret && x.uma.every((u, i) => u === r.uma[i]));
  return p ? p.name : `${r.start}点持ち・${r.ret}点返し`;
}
function saveName() {
  const v = !$('ready-card').hidden ? $('name-ready').value : $('name').value;
  myName = cleanName(v);
  $('name').value = myName; $('name-ready').value = myName;
  try { localStorage.setItem(KEY_NAME, myName); } catch (e) { /* 保存できなくても動く */ }
}

/* =====================================================================
   表示
===================================================================== */
const board = U.Board($('board'));
function renderAll(animate) { renderHeader(); renderBoard(animate); renderEntry(); renderPanes(); }
function renderHeader() {
  $('t-title').textContent = model.title || 'ホストの卓';
  const n = model.games.length;
  $('t-sub').textContent = !synced ? 'ホストの卓を受信中…' : `${n ? n + '試合を記録' : 'これから第1試合'} ・ ${ruleName(model.rule)}`;
  const down = offline || netState.up === 0 || rejoining;
  $('t-people').className = 'share-btn ' + (down ? 'warn' : 'on');
  $('t-people-label').textContent = offline ? 'オフライン' : rejoining ? 'つなぎ直し中' : (netState.up === 0 ? '再接続中' : (roster.length ? `参加中 ${roster.length}人` : '参加中'));
  $('viewer-note').hidden = amEditor() || !synced || offline;
  $('b-quit').textContent = offline ? 'この画面を閉じる' : '退出する';
}
function renderBoard(animate) {
  const last = model.games[model.games.length - 1];
  board.render({ names: names4(), totals: sessionTotals(model), last: last ? last.pts : null, me: seatIdx(), empty: !model.games.length, animate });
}
function settlementEntries(m) { const t = sessionTotals(m); return [0, 1, 2, 3].map(i => ({ name: displayName(m.names[i], i), pt: t[i] })); }
async function copySettle(m) {
  if (!m.games.length) { toast('コピーできる結果がありません'); return; }
  toast((await U.copyText(buildSettlementText(m.title || '対局中', settlementEntries(m)))) ? '精算の内容をコピーしました' : 'コピーできませんでした');
}
function renderPanes() {
  const names = names4();
  clear($('pane-chart')).appendChild(U.chart(cumulativeSeries(model), names));
  const ps = clear($('pane-settle'));
  if (!model.games.length) ps.appendChild(h('div.empty', null, '試合が記録されると、ここに受け渡しの案が出ます'));
  else {
    const entries = settlementEntries(model), n = calcTransfers(entries).length;
    ps.appendChild(h('div.pane-head', null, h('span', null, n ? `${n}回の受け渡しで精算できます` : ''), h('button.pill', { type: 'button', onclick: () => copySettle(model) }, 'コピー')));
    ps.appendChild(U.settle(entries));
  }
  $('log-count').textContent = model.games.length ? String(model.games.length) : '';
  clear($('pane-log')).appendChild(U.gameLog(model.games, names, openGameSheet));
}
function openGameSheet(id) {
  const idx = model.games.findIndex(g => g.id === id); if (idx < 0) return;
  U.openSheet('game', [h('h3', null, `第${idx + 1}試合`), U.gameTable(model.games[idx], names4()),
    h('p.hint', null, '修正や削除は、ホストのスマホでできます。'),
    h('div.sheet-actions', null, h('button.btn.primary', { type: 'button', onclick: U.closeSheet }, 'とじる'))]);
}

/* =====================================================================
   入力（ホストに入力を許可されたとき）
===================================================================== */
function resetInput() { input = { vals: ['', '', '', ''], active: 0, editingId: null, op: null }; sending = false; clearTimeout(sendTimer); }
function renderEntry() {
  const can = amEditor();
  $('input-panel').hidden = !can;
  if (!can) return;
  const d = draftGame(input.vals, model.rule), n = model.games.length + 1;
  $('input-title').textContent = `第${n}試合`;
  U.entryRows($('entry-rows'), input, d, names4(), i => { input.active = i; renderEntry(); });
  U.draftMsg($('draft-msg'), d, input.vals, false);
  const btn = $('record-btn');
  btn.disabled = !d.complete || sending;
  btn.textContent = sending ? '送信中…' : `第${n}試合を記録する`;
}
U.keypad($('keypad'), k => { if (U.entryKey(input, k, model.rule)) input.op = null; renderEntry(); });
$('record-btn').addEventListener('click', () => {
  if (!amEditor() || sending || !guest) return;
  const d = draftGame(input.vals, model.rule);
  if (!d.complete) return;
  if (!input.op) input.op = newId();   // 同じ op の再送は、ホストで二重に記録されない
  sending = true; renderEntry();
  guest.send({ t: 'rec', op: input.op, s: d.scores }, true);
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => { sending = false; renderEntry(); toast('届いたか分かりません。もう一度押してね（二重には記録されません）'); }, 7000);
});

/* =====================================================================
   席決め（ホストが始めると、この画面にも出る。自分の番の牌をめくれる）
===================================================================== */
const seatUI = U.SeatUI({
  host: false,
  names: names4,
  canPick: v => { const t = v.owner.filter(p => p >= 0).length, s = seatIdx(); return s === null || s === t || amEditor(); },
  pick: k => { if (guest && seatUI.view) guest.send({ t: 'seatpick', id: seatUI.view.id, k }, true); },
  setMode: () => {},
  actions: (v, r) => [
    h('button.btn.primary', { type: 'button', onclick: U.closeSheet }, 'とじる'),
    r && model.games.length === 0 && !r.order.every((p, k) => p === k) ? h('p.hint.center', null, 'ホストがこの席順に並べ替えると、全員の画面に反映されます。') : null
  ]
});
function onSeat(v) {
  if (!v) return;
  const cur = seatUI.view, same = !!cur && cur.id === v.id;
  if (v.st === 'end') {
    if (same) { seatUI.reset(); if (U.sheetKind() === 'seat') { U.closeSheet(); toast('ホストが席決めをやめました'); } }
    return;
  }
  if (v.st === 'applied') {
    // 自分の席の印も、並べ替えにあわせて動かす（見ていた席決めのときだけ。重ねて動かさない）
    if (same) {
      if (mySeat !== null) { mySeat = v.perm.indexOf(mySeat); try { localStorage.setItem(KEY_SEAT, String(mySeat)); } catch (e) { /* 保存できなくても動く */ } }
      if (U.sheetKind() === 'seat') U.closeSheet();
      seatUI.reset(); renderBoard(false);
      toast('席順どおりに、メンバーが並べ替えられました');
    }
    return;
  }
  seatUI.show(v);
}
$('b-seat').addEventListener('click', () => { if (seatUI.view) seatUI.open(); else toast('ホストが席決めを始めると、ここに出ます'); });

/* ---------- 自分の席・参加者 ---------- */
function setSeat(i) {
  mySeat = i;
  try { if (i === null) localStorage.removeItem(KEY_SEAT); else localStorage.setItem(KEY_SEAT, String(i)); } catch (e) { /* 保存できなくても動く */ }
  renderBoard(false); U.closeSheet();
}
$('b-myseat').addEventListener('click', () => {
  const cur = seatIdx();
  U.openSheet('myseat', [h('h3', null, '自分の席'),
    h('p.sheet-text', null, 'このスマホの画面だけ、自分の行に印を付けます。' + (mySeat === null && cur !== null ? '\n（いまは名前が同じなので、自動で印を付けています）' : '')),
    h('div.seat-pick', null, [0, 1, 2, 3].map(i => h('button', { type: 'button', class: cur === i ? 'on' : null, style: { '--pc': PC[i] }, onclick: () => setSeat(i) }, nm(i)))),
    h('div.sheet-actions', null, h('button.btn', { type: 'button', onclick: () => setSeat(null) }, mySeat === null ? 'とじる' : '印をはずす'))]);
});
function peopleNodes() {
  return [
    h('div.sheet-head', null, h('h3', null, '参加者'),
      h('span.status-pill', { class: netState.up ? null : 'warn' }, h('i'), netState.up ? `中継 ${netState.up}/${netState.total}` : '再接続中…')),
    h('div.people', null, roster.map(p => h('div.prow', null, h('span.pn', null, p.name,
      h('small', null, p.id === 0 ? 'ホスト' : (p.id === myId ? (p.ed ? 'あなた（入力できる）' : 'あなた') : (p.ed ? '入力できる' : '見るだけ'))))))),
    roster.length ? null : h('p.hint', null, '参加者の一覧を受信中です'),
    h('div.sheet-actions', null, h('button.btn.primary', { type: 'button', onclick: U.closeSheet }, 'とじる'))
  ];
}
$('t-people').addEventListener('click', () => U.openSheet('people', peopleNodes()));

/* =====================================================================
   自分の履歴に保存（麻雀精算アプリの「履歴」に入る）
===================================================================== */
function autoSave() { try { return localStorage.getItem(KEY_AUTO) === '1'; } catch (e) { return false; } }
function setAutoSave(on) { try { if (on) localStorage.setItem(KEY_AUTO, '1'); else localStorage.removeItem(KEY_AUTO); } catch (e) { /* 覚えられなくても動く */ } }
function saveToHistory(m, title) {
  let raw;
  try { raw = localStorage.getItem(KEY_MAIN); } catch (e) { return { ok: false, why: 'この端末に保存できませんでした' }; }
  if (raw === null && LEGACY_KEYS.some(k => localStorage.getItem(k) !== null)) return { ok: false, why: '先に「麻雀精算」アプリを一度開いてください' };
  const session = modelToSession(m, title, Date.now());
  if (!session || !session.games.length) return { ok: false, why: '保存できる試合がありません' };
  const r = mergeIntoMainStorage(raw, session);
  if (!r.ok) return r;
  if (!r.added) return { ok: true, added: false };
  try { localStorage.setItem(KEY_MAIN, r.json); } catch (e) { return { ok: false, why: 'この端末に保存できませんでした' }; }
  return { ok: true, added: true };
}
const savedMsg = r => (!r.ok ? r.why : (r.added ? '自分の履歴に保存しました（麻雀精算の「履歴」に入ります）' : '同じ内容の対局が、すでに履歴にあります'));
async function saveWithTitle(m) {
  if (!m || !m.games.length) { toast('まだ試合がありません'); return; }
  const t = await U.ask({ title: '自分の履歴に保存', body: 'この卓の記録を、このスマホの麻雀精算の「履歴」に入れます。', input: { value: m.title || todayTitle(), label: '対局の名前', max: 40 }, ok: '保存する' });
  if (t === null) return;
  toast(savedMsg(saveToHistory(m, t.trim() || todayTitle())), 3600);
}
$('b-save').addEventListener('click', () => saveWithTitle(model));
$('b-last-save').addEventListener('click', () => saveWithTitle(lastModel));
$('b-last-view').addEventListener('click', () => viewLast());
$('b-last-forget').addEventListener('click', () => { forgetLast(); renderMenu(); });

// ホストが対局を終えた: 結果を出して、自分の履歴にも保存できるようにする
function onFin(f) {
  if (!f || finSeen.has(f.id)) return;
  finSeen.add(f.id);
  lastModel = f.model;
  const m = f.model, saved = autoSave() ? saveToHistory(m, m.title || todayTitle()) : null;
  const names = [0, 1, 2, 3].map(i => displayName(m.names[i], i)), totals = sessionTotals(m);
  const chk = h('input', { type: 'checkbox' }); chk.checked = autoSave();
  chk.addEventListener('change', () => setAutoSave(chk.checked));
  const done = saved && saved.ok;
  U.openSheet('fin', [
    h('h3', null, '対局が終わりました'),
    h('p.sheet-text', null, `「${m.title || '無題の対局'}」 ・ ${m.games.length}試合`),
    U.standings(names, totals),
    h('div.sheet-sec', null, '精算'),
    U.settle(settlementEntries(m)),
    saved ? h('p.draft-msg', { class: saved.ok ? 'ok' : 'warn' }, savedMsg(saved)) : null,
    h('label.check', null, h('span', null, 'これからは自動で自分の履歴に保存する'), chk),
    h('div.sheet-actions', null,
      done ? null : h('button.btn.primary', { type: 'button', onclick: () => { const r = saveToHistory(m, m.title || todayTitle()); toast(savedMsg(r), 3600); if (r.ok) U.closeSheet(); } }, '自分の履歴に保存'),
      h('button.btn', { type: 'button', onclick: () => copySettle(m) }, '精算をコピー'),
      h('button.link', { type: 'button', onclick: U.closeSheet }, done ? 'とじる' : '保存しない'))
  ]);
}

/* =====================================================================
   つなぐ・つなぎ直す・抜ける
===================================================================== */
function onMsg(o) {
  if (!o || typeof o.t !== 'string') return;
  if (U.bannerMsg().indexOf('ホストの応答') === 0) U.hideBanner();
  if (o.t === 'snap') {
    const p = parseSnap(o);
    if (!p || !acceptSnap(lastSnap, p.e, p.n)) return;
    lastSnap = { e: p.e, n: p.n };
    const before = sessionTotals(model).join(','), was = synced;
    model = p.model; synced = true;
    if (model.games.length) { lastModel = model; cacheSnap(o); }
    renderAll(was && before !== sessionTotals(model).join(','));
  } else if (o.t === 'seat') {
    onSeat(parseSeat(o));
  } else if (o.t === 'roster') {
    const r = cleanRoster(o.players); if (!r) return;
    roster = r; renderHeader(); renderEntry();
    if (U.sheetKind() === 'people') U.refillSheet(peopleNodes());
  } else if (o.t === 'fin') {
    const f = parseFin(o);
    if (f) cacheSnap(o.snap);
    onFin(f);
  } else if (o.t === 'ok') {
    if (typeof o.op === 'string' && o.op === input.op) { resetInput(); renderEntry(); toast('記録しました'); }
  } else if (o.t === 'no') {
    if (typeof o.op === 'string' && o.op === input.op) {
      const why = { noperm: '入力の許可がありません', sum: '合計が合いませんでした', full: '試合数の上限です', rate: '少し待ってから、もう一度押してね' }[o.why] || '記録できませんでした';
      input.op = null; sending = false; clearTimeout(sendTimer); renderEntry(); toast(why);
    }
  }
}

async function joinWith(text, opts) {
  opts = opts || {};
  const m = CODE_RE.exec(String(text || ''));
  if (!m) { show('s-menu'); menuErr('参加コードが読み取れませんでした。ホストのQRかリンクか、確かめてください。'); return; }
  stopScan(); menuErr('');
  if (!opts.quiet) saveName();
  if (m[0] !== code) { identity = null; resetTable(); }   // ほかの卓
  code = m[0]; pendingCode = '';
  if (!opts.quiet) { show('s-connect'); $('cn-text').textContent = opts.resume ? 'さっきの卓につなぎ直しています…' : 'ホストにつないでいます…'; }
  const seq = ++joinSeq;
  let g = null;
  try {
    g = await R.join(code, {
      name: myName,
      onNet: s => { if (guest === g) { netState = s; renderHeader(); if (U.sheetKind() === 'people') U.refillSheet(peopleNodes()); } },
      onWelcome: id => { if (guest === g) onWelcome(id); },
      onMsg: o => { if (guest === g) onMsg(o); },
      onStall: ms => { if (guest === g) onStall(ms); },
      onEnd: why => { if (guest === g) onEnd(why); }
    }, identity, { wait: opts.wait || 45000 });
  } catch (e) {
    if (seq !== joinSeq) return;
    guest = null; rejoining = false; U.hideBanner();
    code = ''; identity = null; forgetGuest();
    show('s-menu'); renderMenu(); menuErr(e.message);
    return;
  }
  if (seq !== joinSeq) { try { g.close(); } catch (e) { /* 閉じられなくても続ける */ } return; }   // 途中でやめた
  guest = g; identity = g.identity;
  persistGuest();
}
function resetTable() {
  model = newModel(MJ_PRESETS[0]); synced = false; lastSnap = { e: null, n: -1 }; roster = []; myId = -1;
  resetInput(); seatUI.reset();
}
function onWelcome(id) {
  myId = id; rejoining = false; offline = false; U.hideBanner();
  if (!inTable) { inTable = true; show('s-table'); }
  renderAll(false);
  guest.send({ t: 'req' }, true);
  U.wake(true);
  clearInterval(touchT); touchT = setInterval(touchGuest, 60000);
  persistGuest();
}
function onStall(ms) {
  if (!inTable || rejoining) return;
  U.banner('ホストの応答がありません（ホストのスマホが止まっているかも）');
  if (ms > 12000) rejoin();
}
// ホストが戻ってくるのを待ちながら、同じ鍵でつなぎ直す（受付を締めたあとでも戻れる）
function rejoin() {
  if (rejoining || !code) return;
  rejoining = true; renderHeader();
  U.banner('ホストを待っています…（ホストが麻雀精算を開き直すと、自動でつながります）', { label: 'やめる', fn: () => leave(false) });
  const old = guest; guest = null;
  try { if (old) old.close(); } catch (e) { /* 閉じられなくても続ける */ }
  joinWith(code, { quiet: true, wait: REJOIN_WAIT });
}
function onEnd(why) {
  guest = null;
  if (why === 'kicked') endTable('ホストに外されました');
  else if (model.games.length) goOffline(why === 'closed' ? 'ホストが共有をやめました' : 'ホストにつながりません', why !== 'closed');
  else if (why === 'closed') endTable('ホストが共有をやめました');
  else endTable(inTable ? 'ホストにつながりませんでした' : 'ホストが見つかりませんでした。QRやリンクがいまのものか、ホストのスマホで麻雀精算が開いているか確かめてください。');
}
// ホストとつながらなくても、最後に受け取った記録はそのまま見られるようにする（入力・席決めはできない）
function goOffline(msg, canRetry) {
  stopScan(); U.wake(false); clearInterval(touchT);
  if (U.sheetKind() === 'seat' || U.sheetKind() === 'people') U.closeSheet();
  guest = null; inTable = false; rejoining = false; offline = true;
  roster = []; myId = -1; resetInput(); seatUI.reset();
  if (!canRetry) { code = ''; identity = null; forgetGuest(); }
  synced = true; show('s-table'); renderAll(false);
  U.banner(msg + '。最後に受け取った記録を表示しています', canRetry ? { label: 'つなぎ直す', fn: retry } : null);
}
function retry() {
  if (!code || guest) return;
  offline = false; rejoining = true; renderHeader();
  U.banner('ホストを待っています…（ホストが麻雀精算を開き直すと、自動でつながります）', { label: 'やめる', fn: () => leave(false) });
  joinWith(code, { quiet: true, wait: REJOIN_WAIT });
}
// 入口の「さっきの卓」から、記録だけを見る
function viewLast() {
  if (!lastModel || !lastModel.games.length) return;
  model = lastModel; offline = true; synced = true; roster = []; myId = -1;
  show('s-table'); renderAll(false);
  U.banner('さっきの卓の記録です（ホストとはつながっていません）');
}
function endTable(msg) {
  stopScan(); U.closeSheet(); U.hideBanner(); U.wake(false); clearInterval(touchT);
  if ((inTable || offline) && model.games.length) lastModel = model;
  guest = null; inTable = false; rejoining = false; offline = false; code = ''; identity = null;
  resetTable(); forgetGuest();
  renderMenu(); show('s-menu'); menuErr(msg);
  if (msg) toast(msg, 4000);
}
async function leave(confirmFirst) {
  if (confirmFirst && inTable && !offline && !await U.ask({ title: '退出する', body: 'この卓の画面を閉じます。\n（あとで同じQRから入り直せます）', ok: '退出する' })) return;
  joinSeq++;
  const g = guest; guest = null;
  try { if (g) g.close(); } catch (e) { /* 閉じられなくても続ける */ }
  endTable('');
}
$('b-quit').addEventListener('click', () => leave(true));
$('cn-cancel').addEventListener('click', () => leave(false));

/* ---------- 開き直しても、同じ卓につなぎ直せるように ---------- */
async function persistGuest() {
  if (!code || !identity) return;
  try { const key = await R.exportPair(identity); localStorage.setItem(KEY_GUEST, JSON.stringify({ v: 1, code, key, at: Date.now() })); } catch (e) { /* 残せなくても参加は続ける */ }
}
function touchGuest() {
  try { const s = JSON.parse(localStorage.getItem(KEY_GUEST)); if (s && s.code === code) { s.at = Date.now(); localStorage.setItem(KEY_GUEST, JSON.stringify(s)); } } catch (e) { /* 同上 */ }
}
function forgetGuest() { try { localStorage.removeItem(KEY_GUEST); } catch (e) { /* 同上 */ } }
// 最後に受け取った卓（試合があるもの）を端末に残す。中身が変わったときだけ書く
let cacheKey = '';
function cacheSnap(o) {
  const k = JSON.stringify([o.names, o.title, o.rule, o.g, o.rules]);
  if (k === cacheKey) return;
  cacheKey = k;
  try { localStorage.setItem(KEY_LAST, JSON.stringify({ v: 1, code, snap: o, at: Date.now() })); } catch (e) { /* 残せなくても見るのは続けられる */ }
}
function cachedTable() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY_LAST)); } catch (e) { s = null; }
  if (!s || s.v !== 1 || !(Date.now() - s.at < LAST_KEEP_MS)) return null;
  const p = parseSnap(s.snap);   // 端末に残したものも、受け取ったときと同じ検査を通す
  return p && p.model.games.length ? { code: typeof s.code === 'string' ? s.code : '', model: p.model, e: p.e, n: p.n } : null;
}
function forgetLast() { try { localStorage.removeItem(KEY_LAST); } catch (e) { /* 同上 */ } lastModel = null; cacheKey = ''; }
async function savedGuest(want) {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY_GUEST)); } catch (e) { s = null; }
  if (!s || s.v !== 1 || typeof s.code !== 'string' || !CODE_RE.test(s.code) || !(Date.now() - s.at < GUEST_RESUME_MS)) return null;
  if (want && s.code !== want) return null;
  const id = await R.importPair(s.key);
  return id ? { code: s.code.match(CODE_RE)[0], identity: id } : null;
}

/* =====================================================================
   入口（QR・リンク）
===================================================================== */
function renderMenu() {
  $('ready-card').hidden = !pendingCode;
  $('join-area').hidden = !!pendingCode;
  const lm = lastModel && lastModel.games.length ? lastModel : null;
  $('last-card').hidden = !lm;
  if (lm) $('last-text').textContent = `${lm.title || 'ホストの卓'} ・ ${lm.games.length}試合（${[0, 1, 2, 3].map(i => displayName(lm.names[i], i)).join('・')}）`;
}
$('b-go').addEventListener('click', () => joinWith(pendingCode));
$('b-forget').addEventListener('click', () => { pendingCode = ''; renderMenu(); });
$('b-paste').addEventListener('click', () => {
  const t = $('paste').value.trim();
  if (!t) { menuErr('参加リンクを貼り付けてください'); return; }
  joinWith(t);
});

// カメラはQRを読むあいだだけ使い、読めたら（やめたら）必ず止める。映像はどこにも送らない
let scanner = null;
function stopScan() { if (scanner) { scanner.stop(); scanner = null; } }
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
      const c = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (c && c.data && CODE_RE.test(c.data)) { stop(); onText(c.data); return; }
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
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'カメラの許可が必要です。ブラウザの設定で許可するか、スマホのカメラアプリでQRを読み取ってください。';
  if (n === 'NotFoundError') return 'カメラが見つかりません。送られてきたリンクで参加してください。';
  return 'カメラを開けませんでした';
}
$('b-scan').addEventListener('click', () => {
  saveName(); menuErr('');
  show('s-scan'); $('sc-msg').textContent = 'ホストの画面のQRを、枠に写してください';
  stopScan();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('sc-msg').textContent = camMsg(null); return; }
  scanner = startScan($('sc-video'), t => joinWith(t), e => { $('sc-msg').textContent = camMsg(e); });
});
$('sc-back').addEventListener('click', () => { stopScan(); show('s-menu'); });
['name', 'name-ready'].forEach(id => $(id).addEventListener('change', saveName));

/* =====================================================================
   起動: リンク（#MJ1~…）で開いたら、その卓へ。開き直しなら、前の卓へつなぎ直す
===================================================================== */
U.Tabs($('seg'), KEY_SEG);
document.addEventListener('gesturestart', e => e.preventDefault());
window.addEventListener('pagehide', () => { stopScan(); if (inTable) touchGuest(); });
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !inTable) U.banner('アプリを新しくしました', { label: '読み込み直す', fn: () => location.reload() });
  });
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* 登録できなくても動く */ }); });
}

(async function boot() {
  let fromLink = '';
  try { fromLink = (CODE_RE.exec(decodeURIComponent(location.hash || '')) || [''])[0]; } catch (e) { fromLink = ''; }
  if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 消せなくても動く */ } }
  renderAll(false);
  const cache = cachedTable();
  if (cache) lastModel = cache.model;
  const saved = await savedGuest(fromLink || null);
  if (saved) {
    // 開き直した（または同じ卓のリンクをもう一度開いた）→ 同じ人として、つなぎ直す
    code = saved.code; identity = saved.identity;
    if (cache && cache.code === saved.code) {
      // 最後に受け取った記録をすぐ見せながら、裏でつなぎ直す
      model = cache.model; synced = true; lastSnap = { e: cache.e, n: cache.n }; inTable = true; rejoining = true;
      show('s-table'); renderAll(false);
      U.banner('つなぎ直しています…（最後に受け取った記録を表示しています）', { label: 'やめる', fn: () => leave(false) });
      joinWith(code, { quiet: true, wait: RESUME_WAIT });
    } else joinWith(code, { wait: RESUME_WAIT, resume: true });
    return;
  }
  if (fromLink) {
    pendingCode = fromLink;
    if (myName) { joinWith(fromLink); return; }   // 名前を知っていれば、すぐ参加
  }
  renderMenu();
})();
})();
