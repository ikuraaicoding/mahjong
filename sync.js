'use strict';
/* =========================================
   オンライン同期の純粋ロジック（画面・通信に依存しない）
   online.js と テスト の両方から読み込む。logic.js が先に必要。

   同期するのは「卓の記録」だけ（名前・ルール・各試合の持ち点）。
   順位やポイントは、受け取った側が持ち点から計算し直す（ホストの数字をうのみにしない）。
========================================= */

const SYNC_MAX_GAMES = 80;      // 1つの卓の試合数の上限（通信の1メッセージに収めるため）
const SYNC_MAX_ENV = 5600;      // 暗号文(base64)の長さの目安。room.js の受信上限は 6000 文字
const SYNC_MAX_SCORE = 9999999;

function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 12);
}
function cleanTitle(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 40);
}
function cloneRuleSync(r) { return { start: r.start, ret: r.ret, uma: r.uma.slice() }; }

// 通信で受け取るルールの検査（範囲も見る）
function validRule(r) {
  const x = sanitizeRule(r);
  if (!x) return null;
  if (!Number.isInteger(x.start) || !Number.isInteger(x.ret)) return null;
  if (x.start < 1000 || x.start > 200000 || x.ret < 1000 || x.ret > 200000) return null;
  if (x.uma.some(u => Math.abs(u) > 500)) return null;
  if (toTenths(x.uma.reduce((a, b) => a + b, 0)) !== 0) return null;
  return x;
}

function validScores(s) {
  return Array.isArray(s) && s.length === 4 && s.every(v => Number.isInteger(v) && Math.abs(v) <= SYNC_MAX_SCORE);
}

// 持ち点から1試合ぶんのデータを作る（合計が合わなければ null）
function buildGame(scores, rule, id) {
  if (!validScores(scores)) return null;
  const r = calcRankPoints(scores, rule);
  if (!r.ok) return null;
  return {
    id: id || newId(),
    scores: scores.slice(),
    pts: r.players.map(p => p.pt),
    ranks: r.players.map(p => p.rank),
    rule: cloneRuleSync(rule)
  };
}

/* ---------- 卓（モデル） ----------
   model = { names[4], title, rule, games: [{ id, scores[4], pts[4], ranks[4], rule }] } */
function newModel(rule, names) {
  return { names: (names || ['', '', '', '']).slice(0, 4).map(cleanName), title: '', rule: cloneRuleSync(rule), games: [] };
}

function modelAddGame(model, scores) {
  if (model.games.length >= SYNC_MAX_GAMES) return null;
  const g = buildGame(scores, model.rule);
  if (!g) return null;
  model.games.push(g);
  return g;
}

function modelUpdateGame(model, id, scores) {
  const g = model.games.find(x => x.id === id);
  if (!g) return null;
  const ng = buildGame(scores, g.rule || model.rule, id);
  if (!ng) return null;
  Object.assign(g, ng);
  return g;
}

/* ---------- 通信メッセージ ---------- */
function modelToSnap(model, epoch, n) {
  return { t: 'snap', e: epoch, n, names: model.names.slice(), title: model.title, rule: cloneRuleSync(model.rule), g: model.games.map(g => g.scores) };
}

function snapEnvelopeSize(snap) {
  return Math.ceil(JSON.stringify(snap).length * 4 / 3) + 80;
}

// 受け取った snap を検査して、卓のモデルに直す。おかしければ null
function parseSnap(o) {
  if (!o || typeof o !== 'object' || o.t !== 'snap') return null;
  if (!Number.isInteger(o.e) || !Number.isInteger(o.n) || o.n < 0) return null;
  if (!Array.isArray(o.names) || o.names.length !== 4) return null;
  if (!Array.isArray(o.g) || o.g.length > SYNC_MAX_GAMES) return null;
  const rule = validRule(o.rule);
  if (!rule) return null;
  const games = [];
  for (let i = 0; i < o.g.length; i++) {
    const g = buildGame(o.g[i], rule, 'g' + i);
    if (!g) return null;
    games.push(g);
  }
  return {
    e: o.e, n: o.n,
    model: { names: o.names.map(cleanName), title: cleanTitle(o.title), rule, games }
  };
}

// 新しい snap を採用してよいか（古い・重複したものは捨てる）
function acceptSnap(last, e, n) {
  return last.e !== e || n > last.n;
}

// 入力係(editor)から届いた「試合の記録」リクエストの検査
function validateRec(o, model) {
  if (!o || typeof o !== 'object' || o.t !== 'rec') return { ok: false, why: 'bad' };
  if (typeof o.op !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(o.op)) return { ok: false, why: 'bad' };
  if (!validScores(o.s)) return { ok: false, why: 'bad' };
  if (model.games.length >= SYNC_MAX_GAMES) return { ok: false, why: 'full' };
  const r = calcRankPoints(o.s, model.rule);
  if (!r.ok) return { ok: false, why: 'sum' };
  return { ok: true, scores: o.s.slice() };
}

function cleanRoster(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.slice(0, 8).filter(p => p && Number.isInteger(p.id)).map(p => ({
    id: p.id, name: cleanName(p.name) || '?', ed: p.ed === true
  }));
}

/* ---------- 履歴との行き来 ---------- */
function modelToSession(model, title, now) {
  return sanitizeSession({
    id: newId(), title: cleanTitle(title) || cleanTitle(model.title), startedAt: null, endedAt: now || Date.now(), dateText: '',
    names: model.names.slice(),
    games: model.games.map(g => ({ id: newId(), at: null, scores: g.scores, pts: g.pts, ranks: g.ranks, rule: model.rule }))
  });
}

// 麻雀精算アプリの「いまの対局」を、オンラインの卓として読み込めるか
function modelFromSession(session, rule) {
  if (!session || !session.games.length) return { ok: false, why: 'まだ試合が記録されていません' };
  if (session.games.length > SYNC_MAX_GAMES) return { ok: false, why: `試合数が多すぎます（${SYNC_MAX_GAMES}試合まで）` };
  const model = newModel(rule, session.names);
  model.title = cleanTitle(session.title);
  for (let i = 0; i < session.games.length; i++) {
    const g = session.games[i];
    if (!g.scores) return { ok: false, why: '持ち点が残っていない試合があるので読み込めません' };
    if (g.rule && (g.rule.start !== rule.start || g.rule.ret !== rule.ret || g.rule.uma.some((u, k) => u !== rule.uma[k]))) {
      return { ok: false, why: '途中でルールが変わっているので読み込めません' };
    }
    const ng = buildGame(g.scores, rule, 'g' + i);
    if (!ng) return { ok: false, why: '合計が合わない試合があるので読み込めません' };
    model.games.push(ng);
  }
  return { ok: true, model };
}

// 麻雀精算アプリの保存データ(文字列)に、対局を1件追加する。同じ内容があれば追加しない
function mergeIntoMainStorage(raw, session) {
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch (e) { return { ok: false, why: 'いまの保存データを読めませんでした' }; }
    if (!data || data.v !== 3) return { ok: false, why: 'いまの保存データの形式が違います' };
  }
  const cur = data ? (sanitizeSession(data.current) || newSession()) : newSession();
  const arch = data ? (Array.isArray(data.archives) ? data.archives : []).map(sanitizeSession).filter(Boolean) : [];
  const rule = data ? (sanitizeRule(data.rule) || cloneRuleSync(MJ_PRESETS[0])) : cloneRuleSync(MJ_PRESETS[0]);
  const carry = data ? sanitizeCarry(data.carry) : [];
  const known = new Set(arch.concat([cur]).map(sessionKey));
  if (known.has(sessionKey(session))) return { ok: true, added: false, json: raw };
  arch.unshift(session);
  return { ok: true, added: true, json: JSON.stringify({ v: 3, current: cur, archives: arch, rule, carry }) };
}

/* ---------- 席決め（伏せた風牌を1人ずつめくる） ----------
   ホストだけが牌の中身を知っている。参加者に送るのは、めくられた牌だけ（伏せた牌は覗けない）。
   seat = { id, winds[4]: 牌ごとの風, owner[4]: 牌ごとにめくった人(-1 = まだ), st: 'play' | 'end' | 'applied', perm } */
const SEAT_WINDS = ['東', '南', '西', '北'];

function seatNew(randInt) {
  const w = SEAT_WINDS.slice();
  for (let i = w.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = w[i]; w[i] = w[j]; w[j] = t; }
  return { id: newId(), winds: w, owner: [-1, -1, -1, -1], st: 'play', perm: null };
}
function seatTurn(s) { return s.owner.filter(o => o >= 0).length; }
function seatDone(s) { return seatTurn(s) >= 4; }

// 牌 k を、いまの番の人がめくる。めくれたら true
function seatPick(s, k) {
  if (!s || s.st !== 'play' || !Number.isInteger(k) || k < 0 || k > 3 || s.owner[k] >= 0 || seatDone(s)) return false;
  s.owner[k] = seatTurn(s);
  return true;
}
// 東・南・西・北の順に、その風をひいた人（メンバーの番号）
function seatOrderOf(s) { return SEAT_WINDS.map(w => s.owner[s.winds.indexOf(w)]); }

// 参加者に送る形（伏せた牌の中身は '' にする）
function seatToMsg(s) {
  const m = { t: 'seat', id: s.id, w: s.winds.map((w, k) => (s.owner[k] >= 0 ? w : '')), o: s.owner.slice(), st: s.st };
  if (s.perm) m.perm = s.perm.slice();
  return m;
}

function validPerm(p) {
  return Array.isArray(p) && p.length === 4 && p.every(v => Number.isInteger(v) && v >= 0 && v <= 3) && new Set(p).size === 4;
}

// 受け取った席決めの状態を検査する。おかしければ null
function parseSeat(o) {
  if (!o || typeof o !== 'object' || o.t !== 'seat') return null;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(o.id)) return null;
  if (['play', 'end', 'applied'].indexOf(o.st) < 0) return null;
  if (!Array.isArray(o.w) || o.w.length !== 4 || !Array.isArray(o.o) || o.o.length !== 4) return null;
  const opened = [];
  for (let k = 0; k < 4; k++) {
    const w = o.w[k], p = o.o[k];
    if (!Number.isInteger(p) || p < -1 || p > 3) return null;
    if ((p >= 0) !== (w !== '')) return null;
    if (w !== '' && SEAT_WINDS.indexOf(w) < 0) return null;
    if (p >= 0) opened.push({ w, p });
  }
  if (new Set(opened.map(x => x.w)).size !== opened.length) return null;
  const ps = opened.map(x => x.p).sort();
  if (ps.some((p, i) => p !== i)) return null;              // めくった人は P1 から順番
  let perm = null;
  if (o.perm !== undefined) { if (o.st !== 'applied' || !validPerm(o.perm)) return null; perm = o.perm.slice(); }
  if (o.st === 'applied' && (!perm || opened.length !== 4)) return null;
  return { id: o.id, w: o.w.slice(), owner: o.o.slice(), st: o.st, perm };
}

// 参加者の画面用: 受け取った状態から、東・南・西・北の順の人（そろっていなければ null）
function seatOrderFromMsg(m) {
  if (m.owner.some(p => p < 0)) return null;
  return SEAT_WINDS.map(w => m.owner[m.w.indexOf(w)]);
}
