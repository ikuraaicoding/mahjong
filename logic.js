'use strict';
/* =========================================
   純粋な計算ロジック（画面に依存しない）
   index.html と テスト の両方から読み込む
========================================= */

const MJ_PRESETS = [
  { id: 'std1030', name: '10-30 (オカあり)', start: 25000, ret: 30000, uma: [30, 10, -10, -30] },
  { id: 'std510',  name: '5-10 (オカあり)',  start: 25000, ret: 30000, uma: [10, 5, -5, -10] },
  { id: 'std1020', name: '10-20 (オカあり)', start: 25000, ret: 30000, uma: [20, 10, -10, -20] },
  { id: 'flat510', name: '5-10 (オカなし)',  start: 25000, ret: 25000, uma: [10, 5, -5, -10] },
  { id: 'custom',  name: 'カスタム' }
];

/* ---------- 数値・表示ヘルパー ---------- */
function round1(x) { return Math.round(x * 10) / 10; }
function toTenths(x) { return Math.round(x * 10); }

// 空欄・数値でない場合だけ既定値にする（0 は 0 のまま）
function numOr(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

// +12.5 / -3 / 0
function fmtPt(x) {
  const r = round1(x);
  return (r > 0 ? '+' : '') + String(r);
}

// 小数1桁そろえ: +12.5 / -3.0 / 0.0
function fmtPt1(x) {
  const r = round1(x);
  const t = Math.abs(r).toFixed(1);
  return r > 0 ? '+' + t : (r < 0 ? '-' + t : '0.0');
}

// 41,300 / -1,200
function fmtScore(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// 画面の onclick に埋め込む値なので、読み込んだデータの id は英数字・_・- だけを許可する
function safeId(v) {
  const s = String(v == null ? '' : v);
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : newId();
}

function displayName(n, i) {
  const t = String(n == null ? '' : n).trim();
  return t !== '' ? t : `P${i + 1}`;
}

// 同じ人とみなすための名前の正規化（全角半角・大小文字・空白の違いを無視）
function nameKey(n) {
  return String(n == null ? '' : n).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
}

/* ---------- 順位点つき精算 ----------
   scores: 4人の持ち点（整数） / rule: { start, ret, uma[4] }
   オカは (返し点-持ち点)×4 を1位に加算。同点は順位点を平均して分け合う。
   0.1pt 未満の端数は合計が必ず 0 になるよう 1位 に寄せる。 */
function calcRankPoints(scores, rule) {
  const { start, ret, uma } = rule;
  if (!Array.isArray(scores) || scores.length !== 4 || scores.some(s => !Number.isFinite(s))) {
    return { ok: false, error: '点数が正しく入力されていません' };
  }
  const total = scores.reduce((a, b) => a + b, 0);
  if (total !== start * 4) {
    return { ok: false, error: `合計点が ${start * 4} 点になりません（現在 ${total} 点）` };
  }
  if (!Array.isArray(uma) || uma.length !== 4 || toTenths(uma.reduce((a, b) => a + b, 0)) !== 0) {
    return { ok: false, error: 'ウマの合計が 0 になりません' };
  }

  const oka = (ret - start) * 4 / 1000;
  const bonus = uma.map((u, i) => (i === 0 ? u + oka : u));
  const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a] || a - b);
  const rank = [0, 0, 0, 0];
  const avg = [0, 0, 0, 0];

  let pos = 0;
  while (pos < 4) {
    let end = pos + 1;
    while (end < 4 && scores[order[end]] === scores[order[pos]]) end++;
    let sum = 0;
    for (let k = pos; k < end; k++) sum += bonus[k];
    const a = sum / (end - pos);
    for (let k = pos; k < end; k++) { rank[order[k]] = pos + 1; avg[order[k]] = a; }
    pos = end;
  }

  const tenths = [0, 1, 2, 3].map(i => Math.round((scores[i] - ret) / 100 + avg[i] * 10));
  const residual = -tenths.reduce((a, b) => a + b, 0);
  tenths[order[0]] += residual;

  return {
    ok: true,
    players: scores.map((s, i) => ({ index: i, score: s, rank: rank[i], pt: tenths[i] / 10 }))
  };
}

/* ---------- 入力中の持ち点から、記録前の見込みを出す ----------
   inputs: 文字列4つ（'' は未入力, '-' 単独も未入力扱い）
   空欄がちょうど1人なら、その人は「4人で持ち点×4」になるよう自動で埋める */
function parseScoreInput(s) {
  if (s === '' || s === '-' || s == null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function draftGame(inputs, rule) {
  const vals = inputs.map(parseScoreInput);
  const total = rule.start * 4;
  if (inputs.some(s => s === '-')) {
    return { complete: false, scores: vals, autoIndex: -1, filled: vals.filter(v => v !== null).length, message: '数字を入れてね（マイナスの点数のときは先に－を押しています）' };
  }
  const empty = [0, 1, 2, 3].filter(i => vals[i] === null);
  const scores = vals.slice();
  let autoIndex = -1;

  if (empty.length === 1) {
    autoIndex = empty[0];
    const others = [0, 1, 2, 3].filter(i => i !== autoIndex).reduce((a, i) => a + vals[i], 0);
    scores[autoIndex] = total - others;
  }
  if (empty.length > 1) {
    return { complete: false, scores, autoIndex, filled: 4 - empty.length, message: `あと ${empty.length - 1} 人ぶんの持ち点を入れてね` };
  }

  const sum = scores.reduce((a, b) => a + b, 0);
  if (sum !== total) {
    const diff = sum - total;
    return { complete: false, scores, autoIndex, filled: 4, diff, message: `合計が ${fmtScore(Math.abs(diff))} 点${diff > 0 ? '多い' : '足りない'}よ（4人で ${fmtScore(total)} 点になるように）` };
  }
  const result = calcRankPoints(scores, rule);
  if (!result.ok) return { complete: false, scores, autoIndex, filled: 4, message: result.error };
  return { complete: true, scores, autoIndex, filled: 4, result };
}

/* ---------- 受け渡しの組み合わせ ----------
   entries: [{ name, pt }] （0.1pt 単位の整数で計算するので誤差が出ない） */
function calcTransfers(entries) {
  const debtors = entries.filter(e => toTenths(e.pt) < 0)
    .map(e => ({ name: e.name, t: -toTenths(e.pt) })).sort((a, b) => b.t - a.t);
  const creditors = entries.filter(e => toTenths(e.pt) > 0)
    .map(e => ({ name: e.name, t: toTenths(e.pt) })).sort((a, b) => b.t - a.t);
  const transfers = [];
  let d = 0, c = 0;
  while (d < debtors.length && c < creditors.length) {
    const pay = Math.min(debtors[d].t, creditors[c].t);
    if (pay > 0) transfers.push({ from: debtors[d].name, to: creditors[c].name, pt: pay / 10 });
    debtors[d].t -= pay; creditors[c].t -= pay;
    if (debtors[d].t === 0) d++;
    if (creditors[c].t === 0) c++;
  }
  return transfers;
}

// 精算の文章（LINEなどに貼る用）。entries: [{ name, pt }]
function buildSettlementText(title, entries) {
  const lines = [`【${title || '対局'}】ポイントの精算`, ''];
  entries.forEach(e => lines.push(`${e.name}  ${fmtPt1(e.pt)}pt`));
  lines.push('');
  const transfers = calcTransfers(entries);
  if (!transfers.length) lines.push('受け渡しはありません');
  else transfers.forEach(t => lines.push(`${t.from} → ${t.to}  ${t.pt.toFixed(1)}pt`));
  return lines.join('\n');
}

/* =========================================
   対局（セッション）データ
   session = { id, title, startedAt, endedAt, dateText, names[4],
               games: [{ id, at, scores[4]|null, pts[4], ranks[4], rule|null }] }
========================================= */

// 1試合の中での順位（同点は同順位）
function rankOf(pts, i) {
  return 1 + pts.filter(p => toTenths(p) > toTenths(pts[i])).length;
}
function gameRanks(pts) { return pts.map((_, i) => rankOf(pts, i)); }

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function sanitizeRule(r) {
  if (!r || typeof r !== 'object') return null;
  if (!isNum(r.start) || !isNum(r.ret) || !Array.isArray(r.uma) || r.uma.length !== 4 || !r.uma.every(isNum)) return null;
  return { start: r.start, ret: r.ret, uma: r.uma.slice() };
}

function sanitizeGame(g) {
  if (!g || typeof g !== 'object') return null;
  if (!Array.isArray(g.pts) || g.pts.length !== 4 || !g.pts.every(isNum)) return null;
  if (toTenths(g.pts.reduce((a, b) => a + b, 0)) !== 0) return null;
  const scores = (Array.isArray(g.scores) && g.scores.length === 4 && g.scores.every(isNum)) ? g.scores.slice() : null;
  const pts = g.pts.map(round1);
  const ranks = (Array.isArray(g.ranks) && g.ranks.length === 4 && g.ranks.every(r => Number.isInteger(r) && r >= 1 && r <= 4)) ? g.ranks.slice() : gameRanks(pts);
  return { id: safeId(g.id), at: isNum(g.at) ? g.at : null, scores, pts, ranks, rule: sanitizeRule(g.rule) };
}

function sanitizeSession(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.names) || s.names.length !== 4 || !Array.isArray(s.games)) return null;
  const games = s.games.map(sanitizeGame);
  if (games.some(g => g === null)) return null;
  return {
    id: safeId(s.id),
    title: String(s.title || ''),
    startedAt: isNum(s.startedAt) ? s.startedAt : null,
    endedAt: isNum(s.endedAt) ? s.endedAt : null,
    dateText: s.dateText ? String(s.dateText) : '',
    names: s.names.map(n => String(n == null ? '' : n)),
    games
  };
}

function newSession(names) {
  return { id: newId(), title: '', startedAt: Date.now(), endedAt: null, dateText: '', names: (names || ['', '', '', '']).slice(0, 4), games: [] };
}

/* ---------- 旧バージョン(v1/v2)のデータ変換 ---------- */
function isValidScores(scores) {
  return Array.isArray(scores) && scores.length === 4 &&
    scores.every(a => Array.isArray(a) && a.every(n => isNum(n))) &&
    scores.every(a => a.length === scores[0].length);
}

function isValidArchive(a) {
  return !!a && typeof a === 'object' && isValidScores(a.scores) &&
    Array.isArray(a.names) && a.names.length === 4;
}

function gamesFromScoreArrays(scores, rule) {
  const n = scores[0].length;
  const games = [];
  for (let g = 0; g < n; g++) {
    const pts = [0, 1, 2, 3].map(i => round1(scores[i][g]));
    games.push({ id: newId(), at: null, scores: null, pts, ranks: gameRanks(pts), rule: rule || null });
  }
  return games;
}

function sessionFromLegacy(a) {
  if (!isValidArchive(a)) return null;
  return sanitizeSession({
    id: newId(), title: a.title || '', dateText: a.date || '',
    names: a.names.map(String), games: gamesFromScoreArrays(a.scores)
  });
}

/* ---------- 集計・グラフ用 ---------- */
// 同じ内容の対局か（取り込み時の重複判定用）
function sessionKey(s) {
  return JSON.stringify([s.names.map(nameKey), s.games.map(g => g.pts)]);
}

function sessionTotals(s) {
  return [0, 1, 2, 3].map(i => round1(s.games.reduce((a, g) => a + g.pts[i], 0)));
}

// 各プレイヤーの累計ポイントの推移（0 から始まる）
function cumulativeSeries(s) {
  return [0, 1, 2, 3].map(i => {
    let acc = 0;
    return [0].concat(s.games.map(g => (acc = round1(acc + g.pts[i]))));
  });
}

// 1つの対局の、席ごとの成績
function sessionSummary(s) {
  return [0, 1, 2, 3].map(i => {
    const ranks = s.games.map(g => g.ranks[i]);
    const counts = [1, 2, 3, 4].map(r => ranks.filter(x => x === r).length);
    return {
      name: displayName(s.names[i], i),
      total: round1(s.games.reduce((a, g) => a + g.pts[i], 0)),
      games: s.games.length,
      avgRank: s.games.length ? ranks.reduce((a, b) => a + b, 0) / s.games.length : 0,
      rankCounts: counts
    };
  });
}

/* ---------- 繰越ポイント（過去の累計） ----------
   carry = [{ id, name, pt, games }]  名前ごとに1件（表記ゆれは同じ人） */
function sanitizeCarry(arr) {
  if (!Array.isArray(arr)) return [];
  const map = new Map();
  arr.forEach(c => {
    if (!c || typeof c !== 'object') return;
    const name = String(c.name == null ? '' : c.name).trim().slice(0, 20);
    if (name === '' || !isNum(c.pt)) return;
    const games = (Number.isInteger(c.games) && c.games >= 0 && c.games <= 100000) ? c.games : 0;
    map.set(nameKey(name), { id: safeId(c.id), name, pt: round1(c.pt), games });
  });
  return Array.from(map.values());
}

// 同じ名前があれば上書き、なければ追加（新しい配列を返す）
function upsertCarry(list, name, pt, games) {
  const key = nameKey(name);
  const rest = list.filter(c => nameKey(c.name) !== key);
  const old = list.find(c => nameKey(c.name) === key);
  return sanitizeCarry(rest.concat([{ id: old ? old.id : newId(), name, pt, games }]));
}

// メモ貼り付け用: 「名前 +120」「名前：-45pt」のような行を読み取る
function parseCarryText(text) {
  const entries = [], errors = [], skipped = [];
  const seen = new Map();
  String(text == null ? '' : text).split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.normalize('NFKC').replace(/[−–—]/g, '-').trim();
    if (line === '') return;
    const m = line.match(/^(.*?)[\s:：,、=]*([+-]?\d[\d,]*(?:\.\d+)?)\s*(?:pt|ポイント|P|点)?\s*$/i);
    const name = m ? m[1].replace(/^[・•●■□◆▶▷]+/, '').trim() : '';
    if (!m || name === '') { errors.push({ line: idx + 1, text: raw.trim() }); return; }
    if (/^(合計|総計|計|total|sum)$/i.test(name)) { skipped.push(raw.trim()); return; }
    const pt = round1(parseFloat(m[2].replace(/,/g, '')));
    if (!Number.isFinite(pt)) { errors.push({ line: idx + 1, text: raw.trim() }); return; }
    const key = nameKey(name);
    if (seen.has(key)) entries[seen.get(key)] = { name, pt };   // 同じ名前が複数あれば、あとの行を採用
    else { seen.set(key, entries.length); entries.push({ name, pt }); }
  });
  return { entries, errors, skipped };
}

// 名前ごと（表記ゆれは同じ人として）に、全対局をまたいで集計
// carry を渡すと、繰越ポイントを通算ptに足す（順位などの集計には含めない）
function calcStats(sessions, carry) {
  const map = new Map();
  const ensure = (key, name) => {
    if (!map.has(key)) map.set(key, { key, name, games: 0, total: 0, rankSum: 0, rankCounts: [0, 0, 0, 0], best: -Infinity, worst: Infinity, sessions: new Set(), carryPt: 0, carryGames: 0 });
    return map.get(key);
  };
  (carry || []).forEach(c => {
    const st = ensure(nameKey(c.name), c.name);
    st.carryPt = c.pt; st.carryGames = c.games; st.total = round1(st.total + c.pt);
  });
  sessions.forEach(s => {
    s.games.forEach(g => {
      for (let i = 0; i < 4; i++) {
        const key = nameKey(displayName(s.names[i], i));
        const st = ensure(key, displayName(s.names[i], i));
        st.games++; st.total = round1(st.total + g.pts[i]);
        st.rankSum += g.ranks[i]; st.rankCounts[g.ranks[i] - 1]++;
        st.best = Math.max(st.best, g.pts[i]); st.worst = Math.min(st.worst, g.pts[i]);
        st.sessions.add(s.id);
      }
    });
  });
  return Array.from(map.values())
    .map(st => ({
      key: st.key, name: st.name, games: st.games, total: st.total, rankCounts: st.rankCounts,
      avgRank: st.games ? st.rankSum / st.games : 0,
      topRate: st.games ? st.rankCounts[0] / st.games : 0,
      lastRate: st.games ? st.rankCounts[3] / st.games : 0,
      best: st.games ? st.best : null, worst: st.games ? st.worst : null, sessionCount: st.sessions.size,
      carryPt: st.carryPt, carryGames: st.carryGames
    }))
    .sort((a, b) => b.total - a.total || b.games - a.games);
}
