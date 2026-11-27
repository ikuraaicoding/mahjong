/* 麻雀精算: 対局画面（この端末の記録）と、みんなに共有（ホスト）
 * - データはこの端末の localStorage（mahjong_v3）に保存する
 * - 「共有」を押すと、いまの対局をそのまま参加者の画面に映す。記録はふだんどおりこの端末に残るので、
 *   共有のための別の画面を開いたり、終わってから保存し直したりする必要はない
 * - 画面は ui.js の部品（DOM と textContent だけ）で組み立てる
 */
(function () {
'use strict';
const U = window.MJUI;
const { h, add, clear, cls, PC, toast } = U;
const $ = id => document.getElementById(id);

const KEY_MAIN = 'mahjong_v3', KEY_INPUT = 'mahjong_v3_input', KEY_SEG = 'mj_play_seg', KEY_SEAT_HAKU = 'mj_seat_haku';
const KEY_SHARE = 'mj_share', KEY_NAME = 'mj_online_name', KEY_OLD_HOST = 'mj_online_host';
const SHARE_RESUME_MS = 30 * 60 * 1000;   // 開き直したとき、これより最近まで共有していたら、同じQRのまま自動で再開する

let state = { current: newSession(), archives: [], rule: cloneRule(MJ_PRESETS[0]), carry: [] };
let input = { vals: ['', '', '', ''], active: 0, editingId: null };
let ui = { screen: 'play', detailId: null };
let saveWarned = false;
let lastRaw = null;   // 最後に読み書きした保存データ（ほかのタブが履歴を足したら、戻ってきたときに読み直す）

const nm = i => displayName(state.current.names[i], i);
const names4 = () => [0, 1, 2, 3].map(nm);
function cloneRule(r) { return { start: r.start, ret: r.ret, uma: r.uma.slice() }; }
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
function fmtDate(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const sessionDate = s => (s.endedAt ? fmtDate(s.endedAt) : (s.dateText || ''));
const todayTitle = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()} の対局`; };
function randInt(n) {
  try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; } catch (e) { return Math.floor(Math.random() * n); }
}
function icon(d) {
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, h('path', { d }));
}
function card(title, action, body) {
  return h('div.card', null, h('div.card-head', null, h('h2', null, title), action || null), body);
}

/* =========================================
   保存・読み込み（旧バージョンのデータも引き継ぐ）
========================================= */
function save() {
  let ok = true;
  try {
    localStorage.setItem(KEY_MAIN, JSON.stringify({ v: 3, current: state.current, archives: state.archives, rule: state.rule, carry: state.carry }));
    localStorage.setItem(KEY_INPUT, JSON.stringify(input));
    lastRaw = localStorage.getItem(KEY_MAIN);
  } catch (e) {
    ok = false;
    if (!saveWarned) { saveWarned = true; toast('⚠️ この端末に保存できませんでした。書き出しでバックアップしてください', 5000); }
  }
  shareChanged();   // 共有中なら、参加者の画面にも送る
  return ok;
}
function saveInput() { try { localStorage.setItem(KEY_INPUT, JSON.stringify(input)); } catch (e) { /* 保存できなくても動作は続ける */ } }

function migrateLegacy() {
  const names = readJSON('mahjong_pNames');
  const scores = readJSON('mahjong_app2_scores');
  const archs = readJSON('mahjong_archives');
  const start = numOr(localStorage.getItem('mahjong_app1_start'), 25000);
  const ret = numOr(localStorage.getItem('mahjong_app1_return'), 30000);
  const uma = readJSON('mahjong_app1_uma');
  const umaN = (Array.isArray(uma) && uma.length === 4) ? uma.map(u => numOr(u, 0)) : MJ_PRESETS[0].uma.slice();
  const rule = sanitizeRule({ start, ret, uma: umaN }) || cloneRule(MJ_PRESETS[0]);
  // 旧版の uma は「オカ込み」で入れていた (50/10/-10/-30)。合計が0でなければ標準に戻す
  const okRule = toTenths(rule.uma.reduce((a, b) => a + b, 0)) === 0 ? rule : cloneRule(MJ_PRESETS[0]);
  const nameArr = (Array.isArray(names) && names.length === 4) ? names.map(n => (typeof n === 'string' ? n : '')) : ['', '', '', ''];
  const cur = newSession(nameArr);
  if (isValidScores(scores)) cur.games = gamesFromScoreArrays(scores);
  const arc = Array.isArray(archs) ? archs.map(sessionFromLegacy).filter(Boolean) : [];
  return { current: cur, archives: arc, rule: okRule };
}

function load() {
  try {
    const raw = readJSON(KEY_MAIN);
    if (raw && raw.v === 3) {
      state.current = sanitizeSession(raw.current) || newSession();
      state.archives = (Array.isArray(raw.archives) ? raw.archives : []).map(sanitizeSession).filter(Boolean);
      state.rule = sanitizeRule(raw.rule) || cloneRule(MJ_PRESETS[0]);
      state.carry = sanitizeCarry(raw.carry);
    } else if (localStorage.getItem('mahjong_pNames') !== null || localStorage.getItem('mahjong_archives') !== null || localStorage.getItem('mahjong_app2_scores') !== null) {
      const m = migrateLegacy();
      state.current = m.current; state.archives = m.archives; state.rule = m.rule;
      save();
    }
    const inp = readJSON(KEY_INPUT);
    if (inp && Array.isArray(inp.vals) && inp.vals.length === 4 && inp.vals.every(v => typeof v === 'string' && /^-?\d{0,7}$/.test(v))) {
      input.vals = inp.vals;
      input.active = (inp.active >= 0 && inp.active <= 3) ? inp.active : 0;
      input.editingId = (inp.editingId && state.current.games.some(g => g.id === inp.editingId)) ? inp.editingId : null;
    }
  } catch (e) { console.log('Load failed:', e); }
  try { lastRaw = localStorage.getItem(KEY_MAIN); } catch (e) { lastRaw = null; }
}

// 前のバージョンでは「みんなで同期」の画面でホストが別に記録していた。その卓を、この端末の対局に引き取る
function migrateOnlineHost() {
  let d;
  try { d = localStorage.getItem(KEY_OLD_HOST); } catch (e) { return; }
  if (d === null) return;
  const done = msg => { try { localStorage.removeItem(KEY_OLD_HOST); } catch (e) { /* 次に開いたときにもう一度 */ } if (msg) toast(msg, 5000); };
  try { d = JSON.parse(d); } catch (e) { d = null; }
  const p = d && d.v === 1 ? parseSnap({ t: 'snap', e: 0, n: 0, names: d.names, title: d.title, rule: d.rule, g: d.g }) : null;
  const s = p && p.model.games.length ? modelToSession(p.model, p.model.title, Date.now()) : null;
  if (!s) { done(''); return; }
  const cur = state.current;
  const sameNames = cur.names.every((n, i) => nameKey(displayName(n, i)) === nameKey(displayName(s.names[i], i)));
  const prefix = cur.games.length <= s.games.length && cur.games.every((g, i) => g.pts.every((v, k) => toTenths(v) === toTenths(s.games[i].pts[k])));
  if (cur.games.length === 0 || (sameNames && prefix)) {
    // いまの対局が空か、その続きだった → いまの対局にする
    if (cur.games.length === s.games.length) { done(''); return; }
    cur.names = s.names.slice(); cur.games = s.games;
    resetInput();
    if (save()) done(`前のバージョンの「みんなで同期」で記録した ${s.games.length} 試合を、いまの対局に引き継ぎました`);
    return;
  }
  if (state.archives.concat([cur]).some(a => sessionKey(a) === sessionKey(s))) { done(''); return; }
  s.title = s.title || 'みんなで同期の対局';
  state.archives.unshift(s);
  if (save()) done(`前のバージョンの「みんなで同期」で記録した対局（${s.games.length}試合）を、履歴に移しました`);
}

/* =========================================
   画面切り替え
========================================= */
function showScreen(name) {
  ui.screen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  const tab = name === 'detail' ? 'history' : name;
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.id === 'tab-' + tab;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  if (name === 'play') renderPlay(false);
  if (name === 'history') renderHistory();
  if (name === 'detail') renderDetail();
  if (name === 'stats') renderStats();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function renderAll() { renderPlay(false); refreshKnownNames(); }

function refreshKnownNames() {
  const set = new Set();
  state.archives.concat([state.current]).forEach(s => s.names.forEach(n => { if (n.trim() !== '') set.add(n.trim()); }));
  state.carry.forEach(c => set.add(c.name));
  const dl = clear($('known-names'));
  set.forEach(n => dl.appendChild(h('option', { value: n })));
}

/* =========================================
   対局画面
========================================= */
const board = U.Board($('board'));
const totalsOf = s => sessionTotals(s);

function activeRule() {
  if (input.editingId) { const g = state.current.games.find(x => x.id === input.editingId); if (g && g.rule) return g.rule; }
  return state.rule;
}
function matchPreset(rule) {
  const p = MJ_PRESETS.find(x => x.id !== 'custom' && x.start === rule.start && x.ret === rule.ret && x.uma.every((u, i) => u === rule.uma[i]));
  return p ? p.id : 'custom';
}

function renderPlay(animate) {
  renderSub();
  renderBoard(animate);
  renderEntry();
  renderPanes();
}
function renderSub() {
  const n = state.current.games.length;
  const preset = MJ_PRESETS.find(p => p.id === matchPreset(state.rule));
  $('play-sub').textContent = `${n ? n + '試合を記録' : 'これから第1試合'} ・ ${preset ? preset.name : 'カスタムルール'}`;
}
function renderBoard(animate) {
  const s = state.current, last = s.games[s.games.length - 1];
  board.render({ names: names4(), totals: totalsOf(s), last: last ? last.pts : null, me: null, empty: !s.games.length, animate });
}

/* ---- 入力 ---- */
function renderEntry() {
  const d = draftGame(input.vals, activeRule());
  const editing = !!input.editingId;
  const n = editing ? state.current.games.findIndex(g => g.id === input.editingId) + 1 : state.current.games.length + 1;
  $('input-title').textContent = editing ? `第${n}試合を修正中` : `第${n}試合`;
  $('cancel-edit').hidden = !editing;
  U.entryRows($('entry-rows'), input, d, names4(), selectRow);
  U.draftMsg($('draft-msg'), d, input.vals, editing);
  const btn = $('record-btn');
  btn.disabled = !d.complete;
  btn.textContent = editing ? 'この内容で更新する' : `第${n}試合を記録する`;
}
U.keypad($('keypad'), pressKey);
function selectRow(i) { input.active = i; saveInput(); renderEntry(); }
function pressKey(k) { U.entryKey(input, k, activeRule()); saveInput(); renderEntry(); }
function resetInput() { input = { vals: ['', '', '', ''], active: 0, editingId: null }; }

function recordGame() {
  const rule = activeRule();
  const d = draftGame(input.vals, rule);
  if (!d.complete) return;
  const pts = d.result.players.map(p => p.pt), ranks = d.result.players.map(p => p.rank);
  if (input.editingId) {
    const g = state.current.games.find(x => x.id === input.editingId);
    if (g) { g.scores = d.scores.slice(); g.pts = pts; g.ranks = ranks; }
    toast('試合を更新しました');
  } else {
    state.current.games.push({ id: newId(), at: Date.now(), scores: d.scores.slice(), pts, ranks, rule: cloneRule(rule) });
    toast(`第${state.current.games.length}試合を記録しました`);
  }
  resetInput(); save(); refreshKnownNames();
  renderSub(); renderBoard(true); renderEntry(); renderPanes();
}
function cancelEdit() { resetInput(); saveInput(); renderEntry(); }

// パソコンのキーボードでも入力できる（数字・Backspace・Delete・-・↑↓・Enter）
document.addEventListener('keydown', e => {
  if (ui.screen !== 'play' || U.sheetKind() || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  if (e.key === 'Enter') {
    if (e.target.closest && e.target.closest('button')) return;
    e.preventDefault();
    if (!$('record-btn').disabled) recordGame(); else pressKey('NEXT');
    return;
  }
  if (e.key === 'ArrowUp') { e.preventDefault(); selectRow((input.active + 3) % 4); return; }
  const k = U.keyFromEvent(e);
  if (k) { e.preventDefault(); pressKey(k); }
});

/* ---- 推移・精算・試合 ---- */
function settlementEntries(s) {
  const t = sessionTotals(s);
  return [0, 1, 2, 3].map(i => ({ name: displayName(s.names[i], i), pt: t[i] }));
}
async function copySettlement(s, fallback) {
  if (!s || !s.games.length) { toast('コピーできる結果がありません'); return; }
  const ok = await U.copyText(buildSettlementText(s.title || fallback, settlementEntries(s)));
  toast(ok ? '精算の内容をコピーしました' : 'コピーできませんでした');
}
function settlePane(s, fallback) {
  if (!s.games.length) return h('div.empty', null, '試合を記録すると、ここに受け渡しの案が出ます');
  const entries = settlementEntries(s), n = calcTransfers(entries).length;
  return h('div', null,
    h('div.pane-head', null, h('span', null, n ? `${n}回の受け渡しで精算できます` : ''), h('button.pill', { type: 'button', onclick: () => copySettlement(s, fallback) }, 'コピー')),
    U.settle(entries));
}
function renderPanes() {
  const s = state.current, names = names4();
  clear($('pane-chart')).appendChild(U.chart(cumulativeSeries(s), names));
  clear($('pane-settle')).appendChild(settlePane(s, '対局中'));
  $('log-count').textContent = s.games.length ? String(s.games.length) : '';
  const pl = clear($('pane-log'));
  pl.appendChild(U.gameLog(s.games, names, openGameSheet));
  if (s.games.length) pl.appendChild(h('p.hint', null, '試合をタップすると、修正や削除ができます。'));
}

function openGameSheet(id) {
  const idx = state.current.games.findIndex(g => g.id === id); if (idx < 0) return;
  U.openSheet('game', [
    h('h3', null, `第${idx + 1}試合`),
    U.gameTable(state.current.games[idx], names4()),
    h('div.sheet-actions', null,
      h('button.btn.primary', { type: 'button', onclick: () => startEdit(id) }, 'この試合を修正する'),
      h('button.btn.danger', { type: 'button', onclick: () => deleteGame(id) }, 'この試合を削除する'),
      h('button.link', { type: 'button', onclick: U.closeSheet }, '閉じる'))
  ]);
}
function startEdit(id) {
  const g = state.current.games.find(x => x.id === id); if (!g) return;
  U.closeSheet();
  if (!g.scores) { toast('この試合は持ち点が残っていないので、削除して入れ直してね'); return; }
  input = { vals: g.scores.map(String), active: 0, editingId: id };
  saveInput(); renderEntry();
  $('input-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function deleteGame(id) {
  const idx = state.current.games.findIndex(g => g.id === id); if (idx < 0) return;
  if (!await U.ask({ title: `第${idx + 1}試合を削除`, body: 'この試合の記録を消します。元に戻せません。', ok: '削除する', danger: true })) return;
  const k = state.current.games.findIndex(g => g.id === id); if (k < 0) return;
  state.current.games.splice(k, 1);
  if (input.editingId === id) resetInput();
  save(); renderPlay(true);
  toast('試合を削除しました');
}

/* ---- 対局の終了・破棄 ---- */
async function finishSession() {
  const s = state.current;
  if (!s.games.length) { toast('まだ試合が記録されていません'); return; }
  const title = await U.ask({
    title: '対局を終了して保存',
    input: { value: s.title || todayTitle(), label: '対局の名前', max: 40 },
    below: h('div', null, h('div.sheet-sec', null, '最終結果'), U.standings(names4(), totalsOf(s)),
      h('p.hint', null, sharing() ? '共有中なので、参加している人の画面にも最終結果が出ます。' : '保存すると「履歴」に入り、成績にも反映されます。')),
    ok: '保存して終了'
  });
  if (title === null || state.current !== s) return;
  const t = title.trim() || todayTitle();
  s.title = t; s.endedAt = Date.now();
  state.archives.unshift(s);
  shareFinished(s);   // 参加者に「対局が終わりました」を送る（共有中だけ）
  state.current = newSession(s.names.slice());
  resetInput(); save(); renderPlay(false); refreshKnownNames();
  toast(`「${t}」を履歴に保存しました`);
}
async function discardSession() {
  const n = state.current.games.length;
  if (!n) { toast('破棄する試合がありません'); return; }
  if (!await U.ask({ title: 'この対局を破棄', body: `いまの対局（${n}試合）を消します。履歴には保存されません。`, ok: '破棄する', danger: true })) return;
  state.current.games = []; resetInput(); save(); renderPlay(false);
  toast('対局を破棄しました');
}

/* ---- メンバー ---- */
function memberInput(i) {
  const inp = h('input.txt', { type: 'text', maxlength: 12, list: 'known-names', placeholder: 'P' + (i + 1), autocomplete: 'off', 'aria-label': `P${i + 1}の名前` });
  inp.value = state.current.names[i];
  inp.addEventListener('input', () => setName(i, inp.value));
  return h('label.mem', { style: { '--pc': PC[i] } }, inp);
}
function openMembers() {
  U.openSheet('members', [
    h('h3', null, 'メンバー'),
    h('div.mem-list', null, [0, 1, 2, 3].map(memberInput)),
    h('p.hint', null, '同じ名前の人は、これまでの対局も合わせて累計されます。過去に使った名前は候補に出ます。'),
    h('div.sheet-actions', null, h('button.btn.primary', { type: 'button', onclick: U.closeSheet }, 'とじる'))
  ]);
}
function setName(i, v) {
  state.current.names[i] = v; save();
  renderBoard(false); renderEntry(); renderPanes(); refreshKnownNames();
}

/* =========================================
   席決め: 伏せた牌を1人ずつめくる（決まりごとは logic.js の seat〜）
   この端末が牌の中身を持つ。共有中は、参加者の画面でも同じ牌がめくれる（参加者は自分の番の牌をめくれる）
========================================= */
let seatG = null;
function seatHakuPref() { try { return localStorage.getItem(KEY_SEAT_HAKU) !== '0'; } catch (e) { return true; } }
const seatUI = U.SeatUI({
  host: true,
  names: names4,
  canPick: () => true,
  pick: k => seatPickHost(k),
  setMode: haku => { try { localStorage.setItem(KEY_SEAT_HAKU, haku ? '1' : '0'); } catch (e) { /* 覚えられなくても動く */ } seatStart(); },
  actions: (v, r) => {
    if (!r) return [h('button.link', { type: 'button', onclick: seatCancel }, 'やめる')];
    const can = state.current.games.length === 0, apply = can && !r.order.every((p, k) => p === k);
    return [
      apply ? h('button.btn.primary', { type: 'button', onclick: seatApply }, 'この席順でメンバーを並べる') : h('button.btn.primary', { type: 'button', onclick: seatClose }, 'とじる'),
      h('button.btn', { type: 'button', onclick: seatStart }, 'もう一度'),
      apply ? h('button.link', { type: 'button', onclick: seatClose }, '並べ替えずにとじる') : null,
      can ? null : h('p.hint.center', null, '試合を記録したあとはメンバーの並びを変えられないので、結果の表示だけです。')
    ];
  }
});
function openSeat() { if (seatG && !seatDone(seatG) && seatUI.view && seatUI.view.id === seatG.id) seatUI.open(); else seatStart(); }
function seatStart() { seatG = seatNew(randInt, seatHakuPref()); seatSync(); }
function seatSync() {
  const msg = seatToMsg(seatG);
  if (share.room) share.room.bcast(msg, true);
  const v = parseSeat(msg);
  if (v && v.st === 'play') seatUI.show(v);
}
function seatPickHost(k) {
  const g = seatG;
  if (!g || !seatPick(g, k)) return;
  seatSync();
  // 白なしで3人めくったら、最後の1枚は残りの人のもの
  const auto = seatAutoTile(g);
  if (auto >= 0) setTimeout(() => { if (seatG === g && seatPick(g, auto)) seatSync(); }, 650);
}
function seatCancel() {
  if (seatG && !seatDone(seatG)) { seatG.st = 'end'; if (share.room) share.room.bcast(seatToMsg(seatG), true); }
  seatG = null; seatUI.reset(); U.closeSheet();
}
function seatClose() { seatG = null; seatUI.reset(); U.closeSheet(); }
// メンバーの並び（P1〜P4）を東・南・西・北の順に入れ替える。試合を記録する前だけ
function seatApply() {
  if (!seatG || !seatDone(seatG) || state.current.games.length) return;
  const r = seatResult(seatG.tiles, seatG.owner); if (!r) return;
  const order = r.order;
  state.current.names = order.map(p => state.current.names[p]);
  input.vals = order.map(p => input.vals[p]); input.active = 0; input.editingId = null;
  seatG.st = 'applied'; seatG.perm = order;
  if (share.room) share.room.bcast(seatToMsg(seatG), true);
  seatG = null; seatUI.reset(); U.closeSheet();
  save(); renderPlay(false); refreshKnownNames();
  toast(`起家は ${nm(0)} さんです`);
}

/* =========================================
   履歴
========================================= */
function renderHistory() {
  const list = clear($('hist-list'));
  $('hist-count').textContent = state.archives.length ? `${state.archives.length} 件` : '';
  if (!state.archives.length) {
    list.appendChild(h('div.card', null, h('div.empty', null, 'まだ保存された対局がありません。', h('br'), '対局画面の「対局を終了して保存」で、ここに並びます。')));
    return;
  }
  state.archives.forEach(s => {
    const totals = sessionTotals(s);
    list.appendChild(h('button.hist-item', { type: 'button', onclick: () => openDetail(s.id) },
      h('div.h-top', null, h('span.h-title', null, s.title || '無題の対局'), h('span.h-date', null, sessionDate(s))),
      h('div.h-meta', null, `${s.games.length} 試合`),
      h('div.h-totals', null, [0, 1, 2, 3].map(i => h('div.h-tot', { style: { '--pc': PC[i] } },
        h('i', null, displayName(s.names[i], i)), h('b', { class: cls(totals[i]) }, fmtPt1(totals[i])))))));
  });
}
function openDetail(id) { ui.detailId = id; showScreen('detail'); }

function renderDetail() {
  const s = state.archives.find(a => a.id === ui.detailId);
  if (!s) { showScreen('history'); return; }
  const names = [0, 1, 2, 3].map(i => displayName(s.names[i], i)), totals = sessionTotals(s);
  const sum = sessionSummary(s);
  const table = h('div.tbl-wrap', null, h('table.tbl', null,
    h('thead', null, h('tr', null, h('th', null, '#'), names.map((n, i) => h('th', { style: { '--pc': PC[i] } }, h('span.dot'), n)))),
    h('tbody', null, s.games.map((g, idx) => h('tr', null, h('td.g', null, String(idx + 1)),
      [0, 1, 2, 3].map(i => h('td', null, h('b', { class: cls(g.pts[i]) }, fmtPt1(g.pts[i])), h('small', null, g.ranks[i] + '位'), g.scores ? h('small', null, fmtScore(g.scores[i])) : null))))),
    h('tfoot', null, h('tr', null, h('td.g', null, '計'), totals.map(t => h('td', { class: cls(t) }, fmtPt1(t)))))));
  add(clear($('detail')), [
    h('h1.page-title.detail-title', null, s.title || '無題の対局'),
    h('p.detail-meta', null, `${sessionDate(s)} ・ ${s.games.length} 試合`),
    card('最終結果', null, h('div.sum-grid', null, sum.map((p, i) => h('div.sum-card', { style: { '--pc': PC[i] } },
      h('div.n', null, p.name), h('div.t', { class: cls(p.total) }, fmtPt1(p.total)),
      h('div.s', null, `平均 ${p.games ? p.avgRank.toFixed(2) : '-'}位 ・ ${p.rankCounts.join('-')}`))))),
    card('ポイントの精算', h('button.pill', { type: 'button', onclick: () => copySettlement(s, '無題の対局') }, 'コピー'), U.settle(settlementEntries(s))),
    card('ポイント推移', null, U.chart(cumulativeSeries(s), names)),
    card('試合ごとの結果', null, table),
    h('div.stack', null,
      h('button.btn.primary', { type: 'button', onclick: () => resumeSession(s.id) }, 'この対局を再開する'),
      h('div.btn-row', null,
        h('button.btn.sm', { type: 'button', onclick: () => renameSession(s.id) }, '名前を変える'),
        h('button.btn.sm.danger', { type: 'button', onclick: () => deleteSession(s.id) }, '削除')))
  ]);
}
async function renameSession(id) {
  const s = state.archives.find(a => a.id === id); if (!s) return;
  const t = await U.ask({ title: '名前を変える', input: { value: s.title, label: '対局の名前', max: 40 }, ok: '変える' });
  if (t === null) return;
  s.title = t.trim() || s.title; save(); renderDetail();
}
async function deleteSession(id) {
  const s = state.archives.find(a => a.id === id); if (!s) return;
  if (!await U.ask({ title: '対局を削除', body: `「${s.title || '無題の対局'}」を削除します。元に戻せません。`, ok: '削除する', danger: true })) return;
  state.archives = state.archives.filter(a => a.id !== id);
  save(); showScreen('history'); toast('削除しました');
}
async function resumeSession(id) {
  const s = state.archives.find(a => a.id === id); if (!s) return;
  const n = state.current.games.length;
  const body = n ? `いま対局中の${n}試合は、履歴に自動で保存してから切り替えます。` : `「${s.title || '無題の対局'}」の続きを記録できるようにします。`;
  if (!await U.ask({ title: 'この対局を再開', body, ok: '再開する' })) return;
  const cur = state.current;
  if (cur.games.length) {
    cur.title = `${todayTitle()}（自動保存）`; cur.endedAt = Date.now();
    state.archives.unshift(cur);
  }
  state.archives = state.archives.filter(a => a.id !== id);
  s.endedAt = null;
  state.current = s;
  resetInput(); save(); refreshKnownNames(); showScreen('play');
  toast('対局を再開しました');
}

/* =========================================
   成績（名前ごとの累計）
========================================= */
const DIST = ['#f3dc9f', '#b89a4e', '#5b6270', '#b04f48'];
function renderStats() {
  const sessions = state.archives.concat($('stats-cur').checked ? [state.current] : []);
  const stats = calcStats(sessions, $('stats-carry').checked ? state.carry : []);
  const list = clear($('stats-list'));
  if (!stats.length) { list.appendChild(h('div.card', null, h('div.empty', null, '試合を記録すると、ここに名前ごとの累計が出ます'))); return; }
  stats.forEach((s, idx) => {
    const has = s.games > 0;
    const carryLine = (s.carryPt !== 0 || s.carryGames > 0) ? `繰越 ${fmtPt1(s.carryPt)}${s.carryGames ? `（${s.carryGames}試合）` : ''} を含む` : '';
    const detail = has ? `最高 ${fmtPt1(s.best)} ／ 最低 ${fmtPt1(s.worst)} ／ ${s.sessionCount} 回の対局` : 'このアプリで記録した試合はまだありません';
    list.appendChild(h('div.st-card', { class: idx === 0 ? 'first' : null },
      h('div.st-head', null, h('div.st-no', null, String(idx + 1)), h('div.st-name', null, s.name), h('div.st-total', { class: cls(s.total) }, fmtPt1(s.total))),
      h('div.st-meta', null,
        h('div', null, String(s.games), h('small', null, '試合')),
        h('div', null, has ? s.avgRank.toFixed(2) : '-', h('small', null, '平均順位')),
        h('div', null, has ? Math.round(s.topRate * 100) + '%' : '-', h('small', null, 'トップ率')),
        h('div', null, has ? Math.round(s.lastRate * 100) + '%' : '-', h('small', null, 'ラス率'))),
      has ? h('div.dist', { role: 'img', 'aria-label': '順位の分布' }, s.rankCounts.map((c, k) => h('i', { style: { width: (c / s.games * 100).toFixed(1) + '%', background: DIST[k] } }))) : null,
      has ? h('div.dist-legend', null, s.rankCounts.map((c, k) => h('div', null, h('i', { style: { background: DIST[k] } }), `${k + 1}位 `, h('b', null, String(c))))) : null,
      h('div.st-foot', null, detail, carryLine ? [h('br'), carryLine] : null)));
  });
}

/* =========================================
   設定
========================================= */
function ruleFromUI() {
  return {
    start: numOr($('rule-start').value, 25000),
    ret: numOr($('rule-return').value, 30000),
    uma: [1, 2, 3, 4].map(n => numOr($(`rule-uma-${n}`).value, 0))
  };
}
function renderSettings() {
  const ml = clear($('set-members'));
  [0, 1, 2, 3].forEach(i => ml.appendChild(memberInput(i)));
  const sel = clear($('rule-preset'));
  MJ_PRESETS.forEach(p => sel.appendChild(h('option', { value: p.id }, p.name)));
  $('rule-start').value = state.rule.start; $('rule-return').value = state.rule.ret;
  state.rule.uma.forEach((u, i) => { $(`rule-uma-${i + 1}`).value = u; });
  updateRuleLabels();
  renderCarry();
}
function updateRuleLabels() {
  const rule = ruleFromUI();
  $('rule-preset').value = matchPreset(rule);
  const oka = (rule.ret - rule.start) * 4 / 1000;
  const umaSum = round1(rule.uma.reduce((a, b) => a + b, 0));
  $('oka-note').textContent = (oka === 0 ? 'オカ: なし' : `オカ: ${fmtPt(oka)}pt を1位に加算（返し点 − 持ち点）`) + (toTenths(umaSum) !== 0 ? ` ／ ⚠ ウマの合計が ${fmtPt(umaSum)} です（0 にしてください）` : '');
}
function applyPreset(id) {
  const p = MJ_PRESETS.find(x => x.id === id);
  if (!p || p.id === 'custom') return;
  state.rule = cloneRule(p); save();
  $('rule-start').value = p.start; $('rule-return').value = p.ret;
  p.uma.forEach((u, i) => { $(`rule-uma-${i + 1}`).value = u; });
  updateRuleLabels(); renderSub();
}
function onRuleInput() { state.rule = ruleFromUI(); save(); updateRuleLabels(); renderSub(); }

/* ---- 繰越ポイント（過去の累計） ---- */
let carryText = '';
function renderCarry() {
  const box = clear($('carry-list')), list = state.carry;
  if (!list.length) { box.appendChild(h('div.empty', null, 'まだ登録がありません')); return; }
  const total = round1(list.reduce((a, c) => a + c.pt, 0)), ok = toTenths(total) === 0;
  box.appendChild(h('div.carry-rows', null, list.map(c => h('button.carry-row', { type: 'button', onclick: () => openCarryEdit(c.id) },
    h('span.c-name', null, c.name), h('span.c-games', null, c.games ? c.games + '試合' : ''), h('b', { class: cls(c.pt) }, fmtPt1(c.pt))))));
  box.appendChild(h('div.carry-sum', { class: ok ? 'ok' : 'warn' }, `合計 ${fmtPt1(total)} ${ok ? '✓' : '（0になっていません）'}`));
}
function openCarryPaste() {
  const ta = h('textarea.area', { id: 'carry-text', rows: 8, placeholder: 'タロウ +120.5\nジロウ -45\nサブロー -75.5', 'aria-label': '繰越ポイントのメモ' });
  ta.value = carryText;
  U.openSheet('carry', [
    h('h3', null, 'メモから取り込む'),
    h('p.sheet-text', null, '1行に「名前 ポイント」の形で貼り付けてください。\n例: タロウ +120 ／ ジロウ：-45pt ／ サブロー 30.5'),
    ta,
    h('div.sheet-actions', null,
      h('button.btn.primary', { type: 'button', onclick: () => { carryText = ta.value; previewCarry(); } }, '内容を確認する'),
      h('button.link', { type: 'button', onclick: () => { carryText = ta.value; U.closeSheet(); } }, '閉じる'))
  ]);
}
function previewCarry() {
  const r = parseCarryText(carryText);
  if (!r.entries.length) { toast('読み取れる行がありませんでした'); return; }
  const total = round1(r.entries.reduce((a, e) => a + e.pt, 0));
  const exist = new Set(state.carry.map(c => nameKey(c.name)));
  U.openSheet('carry', [
    h('h3', null, '取り込む内容の確認'),
    h('div.tbl-wrap', null, h('table.tbl', null,
      h('thead', null, h('tr', null, h('th.l', null, '名前'), h('th', null, '累計pt'))),
      h('tbody', null, r.entries.map(e => h('tr', null, h('td.l', null, e.name, exist.has(nameKey(e.name)) ? h('small', null, '上書き') : null), h('td', null, h('b', { class: cls(e.pt) }, fmtPt1(e.pt)))))))),
    h('p.draft-msg', { class: toTenths(total) === 0 ? 'ok' : 'warn' }, toTenths(total) === 0 ? '合計は 0 です ✓' : `合計が ${fmtPt1(total)} です（0 になっていません）。メモの内容を確認してね`),
    r.errors.length ? h('p.hint', null, '読み取れなかった行（取り込まれません）:', r.errors.map(x => [h('br'), `${x.line}行目: ${x.text}`])) : null,
    r.skipped.length ? h('p.hint', null, '合計の行は無視しました: ' + r.skipped.join(' / ')) : null,
    h('div.sheet-actions', null,
      h('button.btn.primary', { type: 'button', onclick: applyCarryText }, 'この内容で取り込む'),
      h('button.btn', { type: 'button', onclick: openCarryPaste }, 'メモを直す'))
  ]);
}
function applyCarryText() {
  const r = parseCarryText(carryText);
  r.entries.forEach(e => {
    const old = state.carry.find(c => nameKey(c.name) === nameKey(e.name));
    state.carry = upsertCarry(state.carry, e.name, e.pt, old ? old.games : 0);
  });
  carryText = '';
  save(); refreshKnownNames(); renderCarry(); U.closeSheet();
  toast(`${r.entries.length} 人ぶんを取り込みました`);
}
function openCarryEdit(id) {
  const c = id ? state.carry.find(x => x.id === id) : null;
  const name = h('input.txt', { type: 'text', maxlength: 20, list: 'known-names', autocomplete: 'off' });
  const pt = h('input.numin', { type: 'number', step: '0.1' });
  const games = h('input.numin', { type: 'number', min: '0', step: '1', inputmode: 'numeric' });
  name.value = c ? c.name : ''; pt.value = c ? String(c.pt) : ''; games.value = c && c.games ? String(c.games) : '';
  const saveIt = () => {
    const nv = name.value.trim(), pv = parseFloat(pt.value), gv = parseInt(games.value, 10);
    if (nv === '') { toast('名前を入れてね'); return; }
    if (!Number.isFinite(pv)) { toast('累計ptを入れてね'); return; }
    const base = c ? state.carry.filter(x => x.id !== c.id) : state.carry;
    state.carry = upsertCarry(base, nv, round1(pv), Number.isFinite(gv) && gv > 0 ? gv : 0);
    save(); refreshKnownNames(); renderCarry(); U.closeSheet();
    toast('保存しました');
  };
  U.openSheet('carry', [
    h('h3', null, c ? '繰越ポイントを編集' : '繰越ポイントを追加'),
    h('div.stack', null,
      h('label.field', null, h('span', null, '名前'), name),
      h('div.grid2', null, h('label.field', null, h('span', null, '累計pt'), pt), h('label.field', null, h('span', null, '試合数（任意）'), games))),
    h('div.sheet-actions', null,
      h('button.btn.primary', { type: 'button', onclick: saveIt }, '保存'),
      c ? h('button.btn.danger', { type: 'button', onclick: () => deleteCarry(c.id) }, '削除') : null,
      h('button.link', { type: 'button', onclick: U.closeSheet }, '閉じる'))
  ]);
}
async function deleteCarry(id) {
  const c = state.carry.find(x => x.id === id); if (!c) return;
  if (!await U.ask({ title: '繰越ポイントを削除', body: `「${c.name}」の繰越ポイントを削除します。`, ok: '削除する', danger: true })) return;
  state.carry = state.carry.filter(x => x.id !== id);
  save(); renderCarry();
}

/* =========================================
   バックアップ
========================================= */
function exportData() {
  const all = state.archives.slice();
  if (state.current.games.length) all.push(Object.assign({}, state.current, { title: state.current.title || '対局中データ' }));
  if (!all.length && !state.carry.length) { toast('書き出すデータがありません'); return; }
  const blob = new Blob([JSON.stringify({ app: 'mahjong-settle', version: 3, exportedAt: Date.now(), archives: all, carry: state.carry }, null, 2)], { type: 'application/json' });
  const d = new Date(), a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mahjong_backup_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('書き出しました');
}
function importData(ev) {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    let fresh, newCarry, incoming;
    try {
      const data = JSON.parse(reader.result);
      if (data.app !== 'mahjong-settle' || !Array.isArray(data.archives)) throw new Error('このアプリのバックアップファイルではありません');
      incoming = data.archives.map(a => (data.version >= 3 ? sanitizeSession(a) : sessionFromLegacy(a)));
      if (incoming.some(s => s === null)) throw new Error('ファイルの中身が正しくありません');
      const known = new Set(state.archives.concat([state.current]).map(sessionKey));
      fresh = incoming.filter(s => { const k = sessionKey(s); if (known.has(k)) return false; known.add(k); return s.games.length > 0; });
      // 繰越ポイントは、まだ登録のない名前だけ追加する（すでにある名前は上書きしない）
      const knownCarry = new Set(state.carry.map(c => nameKey(c.name)));
      newCarry = sanitizeCarry(data.version >= 3 ? data.carry : []).filter(c => !knownCarry.has(nameKey(c.name)));
    } catch (e) { toast('読み込めませんでした: ' + e.message, 4500); return; }
    if (!fresh.length && !newCarry.length) { toast('新しいデータはありませんでした（すべて登録済み）'); return; }
    const what = `対局 ${fresh.length} 件${newCarry.length ? `と、繰越ポイント ${newCarry.length} 人ぶん` : ''}`;
    if (!await U.ask({ title: 'バックアップの読み込み', body: `${what}を追加します。\n（登録済みの対局 ${incoming.length - fresh.length} 件は除きます）`, ok: '追加する' })) return;
    fresh.forEach(s => { if (!s.endedAt && !s.dateText) s.endedAt = Date.now(); state.archives.push(s); });
    state.archives.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    state.carry = sanitizeCarry(state.carry.concat(newCarry));
    save(); refreshKnownNames();
    if (ui.screen === 'history') renderHistory();
    if (ui.screen === 'settings') renderCarry();
    toast(`${what}を読み込みました`);
  };
  reader.readAsText(file);
}

/* =========================================
   みんなに共有（ホスト）
   いまの対局（state.current）を、そのまま参加者の画面に映す。記録を変えたら save() のたびに送る。
   部屋の鍵は端末に残しておき、ページを開き直しても同じQRのまま再開する（参加者は自動でつなぎ直す）。
========================================= */
const share = {
  room: null, starting: false, epoch: 0, n: 0, lastKey: '', editors: new Set(), locked: false,
  roster: [], net: { up: 0, total: 2 }, tick: null, beat: null, debounce: null, saved: null, fin: null, ruleWarned: false, bigWarned: false
};
const sharing = () => !!share.room;
function hostName() { try { return cleanName(localStorage.getItem(KEY_NAME) || '') || 'ホスト'; } catch (e) { return 'ホスト'; } }
function joinUrl() { return new URL('online.html', location.href).href.split('#')[0] + '#' + share.room.qr; }

async function startShare(saved) {
  if (share.room || share.starting) return;
  if (!window.NomiRoom || !window.crypto || !crypto.subtle || !window.WebSocket) { toast('この端末（ブラウザ）では共有を使えません'); return; }
  if (!validRule(state.rule)) { toast('ルールの設定（ウマの合計など）を直してから共有してください', 4000); return; }
  share.starting = true; renderShareBtn(); renderShareSheet();
  let room;
  try {
    room = await NomiRoom.host({ onNet: shareNet, onJoin: shareJoin, onLeave: shareLeave, onMsg: shareMsg }, saved ? saved.room : null);
  } catch (e) {
    share.starting = false; renderShareBtn(); renderShareSheet();
    toast('共有を始められませんでした: ' + e.message, 4500);
    return;
  }
  share.starting = false;
  share.room = room; share.epoch = randInt(2147483647); share.n = 0; share.lastKey = ''; share.fin = null;
  share.editors = new Set(saved && room.resumed && Array.isArray(saved.editors) ? saved.editors.filter(x => typeof x === 'string') : []);
  share.locked = !!(saved && room.resumed && saved.locked); room.setLocked(share.locked);
  share.roster = buildRoster();
  clearInterval(share.tick); share.tick = setInterval(shareTick, 6000);
  clearInterval(share.beat); share.beat = setInterval(touchShare, 30000);
  persistShare(); U.wake(true);
  renderShareBtn(); renderShareSheet();
  broadcastSnap(true, true);
}

async function stopShare() {
  if (!share.room) return;
  if (!await U.ask({ title: '共有をやめる', body: '参加している人の画面は、つながらなくなります。\n（この卓の記録は、このスマホに残ります）', ok: '共有をやめる', danger: true })) { openShare(); return; }
  const room = share.room;
  if (!room) return;
  share.room = null; share.roster = []; share.fin = null; share.saved = null; share.bigWarned = false;
  clearInterval(share.tick); clearInterval(share.beat); clearTimeout(share.debounce);
  try { room.close(); } catch (e) { /* もう閉じている */ }
  try { localStorage.removeItem(KEY_SHARE); } catch (e) { /* 消せなくても、時間がたてば再開しない */ }
  U.wake(false); U.hideBanner(); renderShareBtn();
  toast('共有をやめました');
}

// 部屋の鍵などを端末に残す（参加者の出入りで変わる）。touchShare は「まだ共有中」の時刻だけ更新する
async function persistShare() {
  const room = share.room; if (!room) return;
  try {
    const r = await room.persist();
    if (share.room !== room) return;
    share.saved = r; touchShare();
  } catch (e) { /* 残せなくても共有は続ける */ }
}
function touchShare() {
  if (!share.room || !share.saved) return;
  try { localStorage.setItem(KEY_SHARE, JSON.stringify({ v: 1, at: Date.now(), room: share.saved, editors: Array.from(share.editors), locked: share.locked })); } catch (e) { /* 同上 */ }
}
function resumeShare() {
  const s = readJSON(KEY_SHARE);
  if (!s) return;
  const age = Date.now() - (Number(s.at) || 0);
  if (s.v !== 1 || !s.room || !(age >= -60000 && age < SHARE_RESUME_MS)) { try { localStorage.removeItem(KEY_SHARE); } catch (e) { /* 次回 */ } return; }
  startShare(s).then(() => {
    if (share.room) toast(share.room.resumed ? '共有を再開しました（参加している人は自動でつながります）' : '共有を始め直しました（QRが変わりました）', 4000);
  });
}

function snapNow() { return sessionToSnap(state.current, state.rule, share.epoch, 0); }
function snapOk(snap) {
  if (state.current.games.length <= SYNC_MAX_GAMES && snapEnvelopeSize(snap) <= SYNC_MAX_ENV) {
    if (share.bigWarned) { share.bigWarned = false; U.hideBanner(); }
    return true;
  }
  if (!share.bigWarned) { share.bigWarned = true; U.banner('試合が多すぎて、参加者の画面を更新できません（対局を終了して、新しい対局にしてください）'); }
  return false;
}
// 卓の記録を全員に送る。force でなければ、変わったときだけ
function broadcastSnap(reliable, force) {
  const room = share.room; if (!room) return;
  if (!validRule(state.rule)) {
    if (!share.ruleWarned) { share.ruleWarned = true; toast('ルールの設定が正しくないので、参加者の画面を更新できません', 4000); }
    return;
  }
  share.ruleWarned = false;
  const snap = snapNow(), key = JSON.stringify(snap);
  if (!force && key === share.lastKey) return;
  if (!snapOk(snap)) return;
  share.lastKey = key;
  snap.n = ++share.n;
  room.bcast(snap, !!reliable);
}
function sendSnapTo(id) {
  const room = share.room; if (!room || !validRule(state.rule)) return;
  const snap = snapNow();
  if (!snapOk(snap)) return;
  snap.n = ++share.n;
  room.sendTo(id, snap, true);
}
function shareChanged() {
  if (!share.room) return;
  clearTimeout(share.debounce);
  share.debounce = setTimeout(() => broadcastSnap(true, false), 150);
}
// 対局を終えたとき: 終わった卓の記録を送る（参加者は、自分の履歴にも保存できる）
function shareFinished(s) {
  const room = share.room; if (!room || !validRule(state.rule)) return;
  const snap = sessionToSnap(s, state.rule, share.epoch, ++share.n);
  if (snapEnvelopeSize(snap) > SYNC_MAX_ENV) return;
  const msg = finMsg(newId(), snap);
  room.bcast(msg, true);
  // 一時的に切れていた人にも届くよう、しばらく送り直す（そのとき参加していた人だけ）
  share.fin = { msg, ids: Array.from(room.peers.keys()), until: Date.now() + 20000 };
}
function shareTick() {
  const room = share.room; if (!room) return;
  broadcastSnap(false, true);
  room.bcast({ t: 'roster', players: share.roster }, false);
  if (seatG && seatG.st === 'play') room.bcast(seatToMsg(seatG), false);
  if (share.fin) {
    if (Date.now() > share.fin.until) share.fin = null;
    else share.fin.ids.forEach(id => { if (room.peers.has(id)) room.sendTo(id, share.fin.msg, false); });
  }
}

function buildRoster() {
  const list = [{ id: 0, name: hostName(), ed: true }];
  if (share.room) share.room.peers.forEach(p => list.push({ id: p.id, name: p.name, ed: share.editors.has(p.gid) }));
  return list;
}
function pushRoster() {
  share.roster = buildRoster();
  if (share.room) share.room.bcast({ t: 'roster', players: share.roster }, true);
  renderShareBtn(); renderShareSheet();
}
function shareNet(s) {
  share.net = s; renderShareBtn();
  const pill = $('share-status');
  if (pill) { pill.className = 'status-pill' + (s.up ? '' : ' warn'); pill.lastChild.textContent = s.up ? `中継 ${s.up}/${s.total}` : '再接続中…'; }
}
function shareJoin(p) {
  pushRoster();
  setTimeout(() => sendSnapTo(p.id), 400);
  toast(p.returning ? `${p.name} さんがつなぎ直しました` : `${p.name} さんが参加しました`);
  persistShare();
}
function shareLeave(p, why) {
  pushRoster();
  if (why !== 'kicked') toast(`${p.name} さんが抜けました`);
}

// 参加者から届いたもの: 卓のリクエスト・席決めの牌・（入力を許可した人の）試合の記録
function shareMsg(id, o) {
  const room = share.room;
  if (!room || !o || typeof o.t !== 'string') return;
  if (o.t === 'req') { sendSnapTo(id); if (seatG && seatG.st === 'play') room.sendTo(id, seatToMsg(seatG), true); return; }
  if (o.t === 'seatpick') { if (seatG && o.id === seatG.id && Number.isInteger(o.k) && seatAutoTile(seatG) < 0) seatPickHost(o.k); return; }
  if (o.t !== 'rec') return;
  const p = room.peers.get(id); if (!p) return;
  const no = why => room.sendTo(id, { t: 'no', op: typeof o.op === 'string' ? o.op.slice(0, 40) : '', why }, true);
  if (!share.editors.has(p.gid)) { no('noperm'); return; }
  p.ops = p.ops || new Set();
  if (typeof o.op === 'string' && p.ops.has(o.op)) { room.sendTo(id, { t: 'ok', op: o.op }, true); return; }   // 再送された記録は、二重にしない
  const rule = state.rule;
  const v = validateRec(o, state.current.games.length, rule);
  if (!v.ok) { no(v.why); return; }
  const now = Date.now();
  if (now - (p.lastRec || 0) < 600) { no('rate'); return; }                              // 連打対策
  p.lastRec = now;
  state.current.games.push({ id: newId(), at: now, scores: v.scores, pts: v.result.players.map(x => x.pt), ranks: v.result.players.map(x => x.rank), rule: cloneRule(rule) });
  p.ops.add(o.op); if (p.ops.size > 60) p.ops.delete(p.ops.values().next().value);
  room.sendTo(id, { t: 'ok', op: o.op }, true);
  save(); refreshKnownNames();
  renderSub(); renderBoard(true); renderEntry(); renderPanes();
  toast(`${p.name} さんが第${state.current.games.length}試合を記録しました`);
}

/* ---- 共有ボタン・シート ---- */
function renderShareBtn() {
  const b = $('share-btn'), lbl = $('share-label');
  if (!share.room) {
    b.className = 'share-btn'; lbl.textContent = share.starting ? '準備中…' : '共有';
    b.setAttribute('aria-label', 'みんなに共有');
    return;
  }
  const guests = share.room.peers.size, down = share.net.up === 0;
  b.className = 'share-btn ' + (down ? 'warn' : 'on');
  lbl.textContent = down ? '再接続中' : (guests ? `共有中 ${guests}人` : '共有中');
  b.setAttribute('aria-label', '共有中。参加者とQRを見る');
}
function openShare() { U.openSheet('share', shareNodes()); }
function renderShareSheet() { if (U.sheetKind() === 'share') U.refillSheet(shareNodes()); }
function sharePoint(d, title, text) { return h('div.share-pt', null, icon(d), h('div', null, h('b', null, title), text)); }
const ICON_PHONE = 'M8 2.5h8a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2zM11 18.5h2';
const ICON_CHECK = 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0zM8.5 12.3l2.4 2.4 4.6-4.9';
const ICON_QR = 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h2.5M20 14v2.5';

function shareNodes() {
  if (!share.room) {
    return [
      h('h3', null, 'みんなに共有'),
      h('div.share-intro', null,
        sharePoint(ICON_PHONE, '全員のスマホに、この卓が映る', '順位・グラフ・精算が、記録したそばから参加者の画面に出ます。'),
        sharePoint(ICON_CHECK, '保存の手間なし', '記録はいつもどおり、このスマホの対局に残ります。終わったら「対局を終了して保存」だけ。'),
        sharePoint(ICON_QR, '参加はQRを読むだけ', 'アプリを入れていない人も、カメラで読み取れば参加できます。通信は暗号化されます。')),
      h('div.sheet-actions', null,
        h('button.btn.primary', { type: 'button', disabled: share.starting, onclick: () => startShare(null) }, share.starting ? '準備中…' : '共有を始める'),
        h('a.btn', { href: 'online.html' }, 'ほかの人の卓に参加する'),
        h('button.link', { type: 'button', onclick: U.closeSheet }, '閉じる'))
    ];
  }
  const room = share.room, url = joinUrl(), down = share.net.up === 0;
  const nodes = [h('div.sheet-head', null, h('h3', null, 'みんなに共有'),
    h('span.status-pill', { id: 'share-status', class: down ? 'warn' : null }, h('i'), down ? '再接続中…' : `中継 ${share.net.up}/${share.net.total}`))];
  if (!share.locked) {
    const cv = h('canvas', { role: 'img', 'aria-label': '参加用のQRコード' });
    try { U.drawQR(url, cv, Math.min(window.innerWidth - 120, 232)); } catch (e) { /* QRが描けなくてもリンクは送れる */ }
    nodes.push(h('div.qr-wrap', null, cv, h('p.qr-cap', null, '参加する人は、スマホの', h('b', null, 'カメラでこのQRを読み取る'), 'だけ。', h('br'), 'リンクをLINEなどで送っても参加できます。')));
    nodes.push(h('div.btn-row', null,
      h('button.btn.sm.gold-line', { type: 'button', onclick: async () => { const r = await U.shareLink({ title: '麻雀精算', text: '麻雀の卓に参加してね', url }); if (r === 'copied') toast('参加リンクをコピーしました'); else if (r === 'fail') toast('送れませんでした'); } }, 'リンクを送る'),
      h('button.btn.sm', { type: 'button', onclick: async () => toast((await U.copyText(url)) ? '参加リンクをコピーしました' : 'コピーできませんでした') }, 'コピー')));
  } else {
    nodes.push(h('p.note', null, '受付を締めています。新しい人は入れません（通信が切れただけの人は、自動で戻れます）。'));
  }
  nodes.push(h('div.sheet-sec', null, `参加者（${share.roster.length}人）`));
  nodes.push(h('div.people', null, share.roster.map(p => h('div.prow', null,
    h('span.pn', null, p.id === 0 ? 'あなた' : p.name, h('small', null, p.id === 0 ? 'ホスト（点数を記録する人）' : (p.ed ? '点数を入力できる' : '見るだけ'))),
    p.id === 0 ? null : h('span.pb', null,
      h('button.pbtn', { type: 'button', class: p.ed ? 'on' : null, onclick: () => toggleEditor(p.id) }, p.ed ? '入力: 許可中' : '入力を許可'),
      h('button.pbtn.kick', { type: 'button', onclick: () => kickPeer(p.id) }, '外す'))))));
  if (share.roster.length < 2) nodes.push(h('p.hint', null, 'まだ誰も参加していません。'));
  nodes.push(h('div.lock-row', null,
    h('div', null, h('b', null, share.locked ? '受付を締めています' : '全員そろったら受付を締める'), share.locked ? '新しい人は入れません' : 'QRを知っている人が、あとから入れなくなります'),
    h('button.pbtn', { type: 'button', class: share.locked ? 'on' : null, onclick: toggleLock }, share.locked ? '再開する' : '締める')));
  nodes.push(h('div.sheet-actions', null,
    h('button.btn.primary', { type: 'button', onclick: U.closeSheet }, 'とじる'),
    h('button.link.danger', { type: 'button', onclick: stopShare }, '共有をやめる')));
  return nodes;
}
function toggleEditor(id) {
  const peer = share.room && share.room.peers.get(id); if (!peer) return;
  if (share.editors.has(peer.gid)) share.editors.delete(peer.gid); else share.editors.add(peer.gid);
  pushRoster(); touchShare();
}
async function kickPeer(id) {
  const peer = share.room && share.room.peers.get(id); if (!peer) return;
  const ok = await U.ask({ title: `${peer.name} さんを外す`, body: 'この人の画面は、つながらなくなります（同じ画面からは入り直せません）。', ok: '外す', danger: true });
  if (ok && share.room && share.room.peers.get(id) === peer) { share.editors.delete(peer.gid); share.room.kick(id); persistShare(); }
  openShare();
}
function toggleLock() {
  if (!share.room) return;
  share.locked = !share.locked; share.room.setLocked(share.locked);
  renderShareSheet(); touchShare();
}

/* =========================================
   ボタン（data-act）と起動
========================================= */
const ACT = {
  go: a => showScreen(a),
  openShare, openSeat, openMembers,
  record: recordGame, cancelEdit, finish: finishSession, discard: discardSession,
  carryPaste: openCarryPaste, carryAdd: () => openCarryEdit(null),
  export: exportData, import: () => $('import-file').click()
};
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const f = ACT[t.dataset.act];
  if (f) { e.preventDefault(); f(t.dataset.arg, t); }
});
$('stats-cur').addEventListener('change', renderStats);
$('stats-carry').addEventListener('change', renderStats);
$('rule-preset').addEventListener('change', e => applyPreset(e.target.value));
['rule-start', 'rule-return', 'rule-uma-1', 'rule-uma-2', 'rule-uma-3', 'rule-uma-4'].forEach(id => $(id).addEventListener('input', onRuleInput));
$('import-file').addEventListener('change', importData);

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) U.banner('アプリを新しくしました', { label: '読み込み直す', fn: () => location.reload() });
  });
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(e => console.log('SW failed:', e)); });
}

// ほかのタブ（参加画面など）で履歴が増えていたら、戻ってきたときに読み直す（古い状態で上書きしないため）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { touchShare(); return; }
  let raw = null;
  try { raw = localStorage.getItem(KEY_MAIN); } catch (e) { return; }
  if (raw === lastRaw) return;
  load(); renderAll(); showScreen(ui.screen === 'detail' ? 'history' : ui.screen);
  shareChanged();
});
window.addEventListener('pageshow', e => { if (e.persisted) document.dispatchEvent(new Event('visibilitychange')); });
window.addEventListener('pagehide', touchShare);

load();
migrateOnlineHost();
U.Tabs($('seg'), KEY_SEG);
renderAll();
renderShareBtn();
resumeShare();
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 失敗しても問題なし */ }
})();
