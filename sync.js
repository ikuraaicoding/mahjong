'use strict';
/* =========================================
   オンライン同期の純粋ロジック（画面・通信に依存しない）
   app.js（ホスト）・online.js（参加者）・テストから読み込む。logic.js が先に必要。

   同期するのは「卓の記録」だけ（名前・ルール・各試合の持ち点）。
   順位やポイントは、受け取った側が持ち点から計算し直す（ホストの数字をうのみにしない）。
   持ち点が残っていない古い試合だけは、ptをそのまま送る（合計0・範囲は検査する）。
========================================= */

const SYNC_MAX_GAMES = 80;      // 1つの卓の試合数の上限（通信の1メッセージに収めるため）
const SYNC_MAX_ENV = 5600;      // 暗号文(base64)の長さの目安。room.js の受信上限は 6000 文字
const SYNC_MAX_SCORE = 9999999;
const SYNC_MAX_PT = 100000;
const SYNC_MAX_RULES = 8;       // 途中でルールを変えた試合のための、追加のルールの数
const SYNC_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 12);
}
function cleanTitle(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 40);
}
function cloneRuleSync(r) { return { start: r.start, ret: r.ret, uma: r.uma.slice() }; }
function sameRule(a, b) {
  return !!a && !!b && a.start === b.start && a.ret === b.ret && a.uma.length === b.uma.length && a.uma.every((u, i) => u === b.uma[i]);
}

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
function validPts(p) {
  return Array.isArray(p) && p.length === 4 && p.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SYNC_MAX_PT) &&
    toTenths(p.reduce((a, b) => a + b, 0)) === 0;
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

/* ---------- 卓（参加者の画面が持つモデル） ----------
   model = { names[4], title, rule, games: [{ id, scores[4]|null, pts[4], ranks[4], rule|null }] } */
function newModel(rule, names) {
  return { names: (names || ['', '', '', '']).slice(0, 4).map(cleanName), title: '', rule: cloneRuleSync(rule), games: [] };
}

/* ---------- 通信メッセージ（卓の記録） ----------
   snap = { t:'snap', e, n, names[4], title, rule, g: [...], rules?: [...] }
   g の1件:  [持ち点×4]                  → rule で計算（ふつうはこれだけ）
            { s:[持ち点×4], u:k }         → rules[k] で計算（途中でルールを変えた試合）
            { p:[pt×4], s?:[持ち点×4] }   → 持ち点が残っていない・ルールが分からない試合は、ptをそのまま */
function sessionToSnap(session, rule, epoch, n) {
  const rules = [], g = [];
  session.games.forEach(x => {
    const sc = validScores(x.scores) ? x.scores.slice() : null;
    const r = validRule(x.rule);
    if (sc && r) {
      const built = buildGame(sc, r);
      if (built && built.pts.every((p, i) => toTenths(p) === toTenths(x.pts[i]))) {
        if (sameRule(r, rule)) { g.push(sc); return; }
        let k = rules.findIndex(y => sameRule(y, r));
        if (k < 0 && rules.length < SYNC_MAX_RULES) { rules.push(cloneRuleSync(r)); k = rules.length - 1; }
        if (k >= 0) { g.push({ s: sc, u: k }); return; }
      }
    }
    const o = { p: x.pts.map(round1) };
    if (sc) o.s = sc;
    g.push(o);
  });
  const snap = { t: 'snap', e: epoch, n, names: session.names.map(cleanName), title: cleanTitle(session.title), rule: cloneRuleSync(rule), g };
  if (rules.length) snap.rules = rules;
  return snap;
}

function snapEnvelopeSize(msg) {
  return Math.ceil(JSON.stringify(msg).length * 4 / 3) + 80;
}

// 受け取った snap を検査して、卓のモデルに直す。おかしければ null
function parseSnap(o) {
  if (!o || typeof o !== 'object' || o.t !== 'snap') return null;
  if (!Number.isInteger(o.e) || !Number.isInteger(o.n) || o.n < 0) return null;
  if (!Array.isArray(o.names) || o.names.length !== 4 || !o.names.every(x => typeof x === 'string')) return null;
  if (!Array.isArray(o.g) || o.g.length > SYNC_MAX_GAMES) return null;
  const rule = validRule(o.rule);
  if (!rule) return null;
  let rules = [];
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules) || o.rules.length > SYNC_MAX_RULES) return null;
    rules = o.rules.map(validRule);
    if (rules.some(r => !r)) return null;
  }
  const games = [];
  for (let i = 0; i < o.g.length; i++) {
    const x = o.g[i], id = 'g' + i;
    let g = null;
    if (Array.isArray(x)) g = buildGame(x, rule, id);
    else if (x && typeof x === 'object') {
      if (x.p !== undefined) {
        if (validPts(x.p) && (x.s === undefined || validScores(x.s))) {
          const pts = x.p.map(round1);
          g = { id, scores: x.s ? x.s.slice() : null, pts, ranks: gameRanks(pts), rule: null };
        }
      } else if (Number.isInteger(x.u) && x.u >= 0 && x.u < rules.length) {
        g = buildGame(x.s, rules[x.u], id);
      }
    }
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

// 対局の終わり（ホストが「対局を終了して保存」した）。終わった卓の記録をそのまま入れる
function finMsg(id, snap) { return { t: 'fin', id, snap }; }
function parseFin(o) {
  if (!o || typeof o !== 'object' || o.t !== 'fin') return null;
  if (typeof o.id !== 'string' || !SYNC_ID_RE.test(o.id)) return null;
  const p = parseSnap(o.snap);
  if (!p || !p.model.games.length) return null;
  return { id: o.id, model: p.model };
}

// 入力係(editor)から届いた「試合の記録」リクエストの検査。count = いまの試合数、rule = これから記録する試合のルール
function validateRec(o, count, rule) {
  if (!o || typeof o !== 'object' || o.t !== 'rec') return { ok: false, why: 'bad' };
  if (typeof o.op !== 'string' || !SYNC_ID_RE.test(o.op)) return { ok: false, why: 'bad' };
  if (!validScores(o.s)) return { ok: false, why: 'bad' };
  if (count >= SYNC_MAX_GAMES) return { ok: false, why: 'full' };
  const r = calcRankPoints(o.s, rule);
  if (!r.ok) return { ok: false, why: 'sum' };
  return { ok: true, scores: o.s.slice(), result: r };
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
    games: model.games.map(g => ({ id: newId(), at: null, scores: g.scores, pts: g.pts, ranks: g.ranks, rule: g.rule || null }))
  });
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

/* ---------- 席決め（オンライン同期）。決まりごとは logic.js の seat〜 ----------
   ホストだけが牌の中身を知っている。参加者に送るのは、表になった牌だけ（伏せた牌は覗けない）。 */
function seatToMsg(s) {
  const m = { t: 'seat', id: s.id, w: s.tiles.map((t, k) => (seatRevealed(s.owner, k) ? t : '')), o: s.owner.slice(), st: s.st };
  if (s.perm) m.perm = s.perm.slice();
  return m;
}

function validPerm(p) {
  return Array.isArray(p) && p.length === 4 && p.every(v => Number.isInteger(v) && v >= 0 && v <= 3) && new Set(p).size === 4;
}

// 受け取った席決めの状態を検査する。おかしければ null
function parseSeat(o) {
  if (!o || typeof o !== 'object' || o.t !== 'seat') return null;
  if (typeof o.id !== 'string' || !SYNC_ID_RE.test(o.id)) return null;
  if (['play', 'end', 'applied'].indexOf(o.st) < 0) return null;
  if (!Array.isArray(o.w) || !Array.isArray(o.o) || o.w.length !== o.o.length || (o.w.length !== 4 && o.w.length !== 5)) return null;
  const n = o.w.length, allowed = n === 5 ? SEAT_WINDS.concat([SEAT_HAKU]) : SEAT_WINDS;
  const owners = [];
  for (let k = 0; k < n; k++) {
    const p = o.o[k];
    if (!Number.isInteger(p) || p < -1 || p > 3) return null;
    if (p >= 0) owners.push(p);
  }
  owners.sort();
  if (owners.some((p, i) => p !== i)) return null;              // めくった人は P1 から順番
  const shown = [];
  for (let k = 0; k < n; k++) {
    const w = o.w[k];
    if ((w !== '') !== seatRevealed(o.o, k)) return null;
    if (w !== '') { if (allowed.indexOf(w) < 0) return null; shown.push(w); }
  }
  if (new Set(shown).size !== shown.length) return null;
  let perm = null;
  if (o.perm !== undefined) { if (o.st !== 'applied' || !validPerm(o.perm)) return null; perm = o.perm.slice(); }
  if (o.st === 'applied' && (!perm || owners.length !== 4)) return null;
  if (owners.length === 4 && !seatResult(o.w, o.o)) return null;
  return { id: o.id, haku: n === 5, w: o.w.slice(), owner: o.o.slice(), st: o.st, perm };
}
