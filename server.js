// Kinquest MVP: Express + Socket.IO. In-memory rooms, roles, server-side answer checks, attempt log.
// Rule: the solution never reaches the browser — each player only gets the view for their own role.
// Browser ↔ server messages: create_room, join_room, role_view, submit, lock_update.
'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const P = require('./puzzles');
const H = require('./hints');
const store = require('./store');
const ai = require('./ai');
const { buildMetrics, LOCK_SKILLS } = require('./report');
const { ACTIVITIES, SKILLS, MISSIONS } = require('./activities');
const { focusFor, FOCUS } = require('./focus');

const PORT = Number(process.env.PORT || 3000);
const LOCK_TYPES = ['detective', 'cipher', 'blueprint'];
const ROLE_LABEL = { scout: 'Scout', keeper: 'Keeper' };
const SKILL_OF_LOCK = { detective: 'logic', cipher: 'patterns', blueprint: 'spatial' };
const ADVANCE_MS = Number(process.env.KQ_ADVANCE_MS || 3200);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three')));
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------------------------------------------------------------- utils
function newCode() {
  for (let i = 0; i < 1000; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  throw new Error('no free room codes');
}
// The clock lives in an object so the simulation script can run on virtual time.
const clock = { now: () => Date.now() };
const now = () => clock.now();
const clean = (s, max = 24) => String(s || '').replace(/[<>{}]/g, '').trim().slice(0, max);
const AGE_BANDS = ['6-7', '8-10'];
const INTERESTS = Object.keys(ai.REGIONS);

function publicBase(socket) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const h = socket.handshake.headers;
  const proto = (h['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${h['x-forwarded-host'] || h.host}`;
}

function partState() {
  return { start: now(), lastAnswer: now(), lastProgress: now(), errors: 0, hints: 0, hintTexts: [], highlight: null, solved: false };
}

function log(room, player, lock, action, extra = {}) {
  const part = lock && lock.part[player.role];
  room.attempts.push({
    t: now(), lock: room.lockIdx, type: lock ? lock.type : null, round: lock && lock.type === 'cipher' ? lock.round : undefined,
    player: player.key, role: player.role, action,
    ms: part ? now() - part.lastAnswer : 0,
    hint: part ? part.hints : 0,
    ...extra,
  });
  // "Answered within 5 seconds" is measured from the player's own previous action.
  if (part && action !== 'part_solved') part.lastAnswer = now();
}

function levelFor(room, player, type) {
  const r = room.ratings[player.key].after[SKILL_OF_LOCK[type]];
  return store.ratingToLevel(r);
}

// ---------------------------------------------------------------- building the expedition
async function buildExpedition(room) {
  const story = await Promise.race([room.storyPromise, new Promise((res) => setTimeout(() => res(null), 12000))]) || ai.templateStory(room.prefs.interest);
  room.story = story;
  const scout = room.players.find((p) => p.role === 'scout');
  const keeper = room.players.find((p) => p.role === 'keeper');
  // Next-mission rules (focus.js): a mix-up seen in earlier sessions shapes one of today's locks.
  const focus = focusFor(store.familySessions(room.familyId), scout.key).next;
  room.locks = LOCK_TYPES.map((type, i) => {
    const opts = { levelScout: levelFor(room, scout, type), levelKeeper: levelFor(room, keeper, type), cast: story.cast };
    if (focus && focus.lock === type && focus.attr && focus.stage === 'scaffold') opts.focusAttr = focus.attr;
    const seed = (room.seed + i * 7919) >>> 0;
    const puzzle = type === 'detective' ? P.generateDetective(seed, opts) : type === 'cipher' ? P.generateCipher(seed, opts) : P.generateBlueprint(seed, opts);
    return {
      type, name: story.lock_names[i], puzzle, startedAt: null, openedAt: null, opened: false,
      keys: { scout: false, keeper: false },
      part: { scout: partState(), keeper: partState() },
      excluded: { scout: [], keeper: [] },
      round: 0, roundKeys: { scout: false, keeper: false },
      grid: type === 'blueprint' ? puzzle.start.map((r) => r.slice()) : null,
      rotations: 0, marks: [],
      predicted: false,
      viewQ: type === 'blueprint' ? { ...P.viewQuestion(puzzle.start, seed), answered: null } : null,
      focus: focus && focus.lock === type ? { id: focus.id, stage: focus.stage, reason: focus.reason || null } : null,
      coach: null,
      totals: { errors: 0, hints: 0 },
    };
  });
}

function startLock(room, idx) {
  room.lockIdx = idx;
  room.phase = 'lock';
  const lock = room.locks[idx];
  lock.startedAt = now();
  lock.part = { scout: partState(), keeper: partState() };
  if (lock.focus) {
    const kid = scoutName(room);
    const f = FOCUS[lock.focus.id];
    coach(room, lock, lock.focus.stage === 'scaffold'
      ? `Today’s focus is “${f.title}”. ${kid} gets ${f.tool}. Let ${kid} lead. ${f.parentTip}`
      : `Last time ${kid} practiced “${f.title}” with a helper. Today there’s none: see if ${kid} does it on their own.`);
  }
}

// ---------------------------------------------------------------- views
function lockView(room, lock, role) {
  const puz = lock.puzzle;
  const part = lock.part[role];
  const hintReadyAt = part.errors >= H.HINT_AFTER_ERRORS ? 0 : part.lastProgress + H.HINT_AFTER_MS;
  const base = {
    type: lock.type, name: lock.name, idx: room.lockIdx, total: room.locks.length,
    skill: SKILLS[SKILL_OF_LOCK[lock.type]],
    keys: keysView(lock), opened: lock.opened,
    hints: part.hintTexts, hintLevel: part.hints, hintReadyIn: hintReadyAt ? Math.max(0, hintReadyAt - now()) : 0, hintMax: 3,
    errors: part.errors, solved: lock.keys[role],
    focus: lock.focus ? { ...lock.focus, title: FOCUS[lock.focus.id].title, goal: FOCUS[lock.focus.id].goal, attr: FOCUS[lock.focus.id].attr || null } : null,
    coach: role === 'keeper' ? lock.coach : null,
  };
  if (lock.type === 'detective') {
    const v = P.detectiveViews(puz)[role];
    return { ...base, ...v, excluded: lock.excluded[role], checkTool: role === 'scout' && !!lock.focus && lock.focus.stage === 'scaffold' };
  }
  if (lock.type === 'cipher') {
    const v = P.cipherViews(puz, lock.round)[role];
    // The prediction step comes first; the panel opens once the row holder got it right.
    const needPredict = v.view === 'row' && v.predict && !lock.predicted;
    return { ...base, ...v, predict: needPredict ? v.predict : null, predicted: lock.predicted, panel: needPredict ? null : v.panel, roundSolved: lock.roundKeys[role] };
  }
  const v = P.blueprintViews(puz)[role];
  if (role === 'scout') return { ...base, ...v, grid: lock.grid, highlight: part.highlight, viewQ: lock.viewQ && lock.viewQ.answered == null ? { options: lock.viewQ.options } : null, viewQDone: lock.viewQ ? lock.viewQ.answered : null };
  return { ...base, ...v, marks: lock.marks };
}

function keysView(lock) {
  const n = lock.type === 'cipher' ? lock.puzzle.rounds.length : 0;
  const prog = (role) => (n ? `${lock.keys[role] ? n : lock.round + (lock.roundKeys[role] ? 1 : 0)}/${n}` : null);
  return {
    scout: { lit: lock.keys.scout, progress: prog('scout'), roundDone: lock.roundKeys.scout },
    keeper: { lit: lock.keys.keeper, progress: prog('keeper'), roundDone: lock.roundKeys.keeper },
  };
}

function roleView(room, player) {
  const v = {
    phase: room.phase, code: room.code, mode: room.mode, joinUrl: room.joinUrl,
    me: { playerId: player.id, role: player.role, roleLabel: ROLE_LABEL[player.role], nickname: player.nickname, kind: player.kind, isHost: player.id === room.hostId },
    players: room.players.map((p) => ({ nickname: p.nickname, role: p.role, roleLabel: ROLE_LABEL[p.role], kind: p.kind, connected: p.connected })),
    childName: (room.players.find((p) => p.role === 'scout') || {}).nickname || null,
    familyId: room.familyId,
  };
  if (room.phase === 'lobby') v.qrSvg = room.qrSvg;
  if (room.story) v.story = { title: room.story.title, intro: room.story.intro, region: room.story.region, lockNames: room.story.lock_names, source: room.story.source };
  if (room.phase === 'lock' && room.locks[room.lockIdx]) v.lock = lockView(room, room.locks[room.lockIdx], player.role);
  if (room.phase === 'lock' || room.phase === 'chest') v.locksDone = room.locks.map((l) => l.opened);
  if (room.phase === 'chest') { v.chest = room.chest; v.solo = soloView(room, player); }
  return v;
}

function broadcast(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('role_view', roleView(room, p));
}
function lockUpdate(room, payload) {
  const lock = room.locks[room.lockIdx];
  io.to('room:' + room.code).emit('lock_update', { lockIdx: room.lockIdx, keys: keysView(lock), opened: lock.opened, ...payload });
}

// ---------------------------------------------------------------- game logic
function partSolved(room, player, lock, extra = {}) {
  const part = lock.part[player.role];
  const type = lock.type;
  const level = lock.puzzle.levels[player.role];
  log(room, player, lock, 'part_solved', { errors: part.errors, hints: part.hints, ms: now() - part.start, level, rotations: type === 'blueprint' && player.role === 'scout' ? lock.rotations : undefined, ...extra });
  const deltas = [];
  for (const sk of LOCK_SKILLS[type]) {
    const before = room.ratings[player.key].after[sk];
    const after = store.updateRating(before, level, { errors: part.errors, hints: part.hints });
    room.ratings[player.key].after[sk] = after;
    deltas.push({ skill: SKILLS[sk], delta: after - before, level: store.ratingToLevel(after) });
  }
  lock.totals.errors += part.errors;
  lock.totals.hints += part.hints;
  return deltas;
}

function wrong(room, player, lock, message) {
  const part = lock.part[player.role];
  part.errors++;
  lockUpdate(room, { event: { role: player.role, kind: 'wrong', message } });
}

function maybeOpen(room, lock) {
  if (!(lock.keys.scout && lock.keys.keeper) || lock.opened) return;
  lock.opened = true;
  lock.openedAt = now();
  lockUpdate(room, { event: { kind: 'open', message: 'The door is open!' } });
  const idx = room.lockIdx;
  setTimeout(() => {
    if (room.lockIdx !== idx || room.phase !== 'lock') return;
    if (idx + 1 < room.locks.length) startLock(room, idx + 1);
    else finish(room);
    broadcast(room);
  }, ADVANCE_MS);
}

const scoutName = (room) => (room.players.find((p) => p.role === 'scout') || {}).nickname || 'Your Scout';

// A line for the grown-up's screen: how to help the kid reason, never the answer.
// It must not reveal the Scout's picture clues either: the two halves are shared by talking.
function coach(room, lock, text) {
  lock.coach = { text, t: now() };
}

// Every clue checked against one suspect, as short words for the log and the report.
function mixupOf(puz, i) {
  const checks = P.checkSuspect(puz, i);
  return {
    name: puz.lineup[i].name,
    fits: checks.filter((c) => c.holds).map((c) => c.short),
    breaks: checks.filter((c) => !c.holds).map((c) => c.short),
    breaksWho: [...new Set(checks.filter((c) => !c.holds).map((c) => c.who))],
    checks,
  };
}

function handleDetective(room, player, lock, msg) {
  const puz = lock.puzzle;
  const role = player.role;
  const kid = scoutName(room);
  if (msg.action === 'exclude') {
    const i = Number(msg.i);
    if (!(i >= 0 && i < puz.lineup.length)) return;
    const list = lock.excluded[role];
    const at = list.indexOf(i);
    if (at >= 0) { list.splice(at, 1); log(room, player, lock, 'unexclude', { i }); lock.part[role].lastProgress = now(); return; }
    // The Scout may tie a cross-out to one of their own picture clues. The server checks the link:
    // a clue that fits this suspect can't rule them out, so the cross-out is refused with the reason.
    let clue = null;
    if (role === 'scout' && msg.clue === 'keeper') clue = 'keeper';
    else if (role === 'scout' && Number.isInteger(msg.clue) && msg.clue >= 0 && msg.clue < puz.scoutClues.length) clue = msg.clue;
    if (typeof clue === 'number') {
      const e = P.explainClue(puz.lineup, i, puz.scoutClues[clue]);
      if (e.holds) {
        log(room, player, lock, 'exclude_link', { i, clue, valid: false, name: puz.lineup[i].name, short: e.short });
        coach(room, lock, `${kid} tried to cross out ${puz.lineup[i].name} with one of their clues, but that clue fits ${puz.lineup[i].name}. Ask: “Show me how that clue rules ${puz.lineup[i].name} out.”`);
        lockUpdate(room, { event: { role, kind: 'look_again', message: `Look again: ${e.text} So this clue can’t rule ${puz.lineup[i].name} out.` } });
        return { linkValid: false };
      }
    }
    list.push(i);
    log(room, player, lock, 'exclude', { i, correct: i !== puz.solution.thief, clue, linkValid: typeof clue === 'number' ? true : undefined });
    lock.part[role].lastProgress = now();
    return { linkValid: typeof clue === 'number' ? true : null };
  }
  // Check tool (focus "Two Clues", scaffold stage): the Scout says whether a suspect matches each of
  // their own clues before accusing. The server answers right or "look again" with the reason.
  if (msg.action === 'check_clue' && role === 'scout' && lock.focus && lock.focus.stage === 'scaffold') {
    const i = Number(msg.i), k = Number(msg.k);
    if (!(i >= 0 && i < puz.lineup.length && k >= 0 && k < puz.scoutClues.length) || typeof msg.answer !== 'boolean') return;
    const e = P.explainClue(puz.lineup, i, puz.scoutClues[k]);
    const correct = msg.answer === e.holds;
    log(room, player, lock, 'check_clue', { i, k, answer: msg.answer, correct });
    lock.part[role].lastProgress = now();
    return { correct, text: correct ? null : `Look again: ${e.text}` };
  }
  if (msg.action === 'accuse') {
    if (lock.keys[role]) return;
    const i = Number(msg.i);
    if (!(i >= 0 && i < puz.lineup.length)) return;
    const correct = i === puz.solution.thief;
    const m = correct ? null : mixupOf(puz, i);
    log(room, player, lock, 'accuse', { i, correct, checked: msg.checked === true || undefined, ...(m ? { name: m.name, fits: m.fits, breaks: m.breaks, breaksWho: m.breaksWho } : {}) });
    lock.part[role].lastAnswer = now();
    if (!correct) {
      const name = puz.lineup[i].name;
      const own = m.checks.find((c) => c.who === role && !c.holds);
      let text;
      if (own) text = `${own.text} Try someone else!`;
      else text = role === 'scout'
        ? `${name} fits your clues, but not one of the Keeper’s notes. Ask the Keeper to check ${name} with you.`
        : `${name} fits your notes, but not one of the Scout’s clues. Ask the Scout to check ${name} with you.`;
      if (role === 'scout') {
        const k = m.checks.filter((c) => c.who === 'keeper').findIndex((c) => !c.holds);
        coach(room, lock, k >= 0
          ? `${kid} picked ${name}, who breaks your note ${k + 1}. Ask: “Let’s check ${name} against my notes, one by one.”`
          : `${kid} picked ${name}, who breaks one of ${kid}’s own picture clues. Ask: “Which clue could prove your answer wrong?”`);
      }
      return wrong(room, player, lock, text);
    }
    lock.keys[role] = true;
    const deltas = partSolved(room, player, lock);
    lockUpdate(room, { event: { role, kind: 'key', message: `The ${ROLE_LABEL[role]}'s key is glowing!` }, ratingDelta: { role, deltas } });
    maybeOpen(room, lock);
  }
}

const swapWords = (t) => t.replace(/Scout|Keeper/g, (w) => (w === 'Scout' ? 'Keeper' : 'Scout'));

function handleCipher(room, player, lock, msg) {
  const role = player.role;
  const rd = lock.puzzle.rounds[lock.round];
  const presser = P.cipherPresser(rd);
  const ruler = presser === 'scout' ? 'keeper' : 'scout';
  const kid = scoutName(room);
  if (lock.roundKeys[role]) return;
  // Round 1: the row holder first predicts the next symbol and says which features change.
  if (msg.action === 'predict' && role === presser && rd.predict && !lock.predicted) {
    const k = Number(msg.choice);
    if (!(k >= 0 && k < rd.predict.options.length)) return;
    const correct = k === rd.solution.predict;
    const want = rd.predict.options[rd.solution.predict], got = rd.predict.options[k];
    const off = correct ? undefined : ['shape', 'color', 'dots'].filter((a) => want[a] !== got[a]);
    const said = Array.isArray(msg.changes) ? ['shape', 'color', 'dots'].filter((a) => msg.changes.includes(a)) : [];
    const changesCorrect = said.length === rd.solution.changes.length && said.every((a) => rd.solution.changes.includes(a));
    log(room, player, lock, 'predict', { correct, off, changes: said, changesCorrect, actual: rd.solution.changes });
    lock.part[role].lastProgress = now();
    const words = (xs) => xs.map((a) => (a === 'dots' ? 'the dots' : `the ${a}`)).join(' and ');
    const changesNote = changesCorrect ? `Yes: along this row, ${words(rd.solution.changes)} change${rd.solution.changes.length > 1 ? '' : 's'}.` : `Look closer: along this row, ${words(rd.solution.changes)} change${rd.solution.changes.length > 1 ? '' : 's'}.`;
    if (!correct) {
      const hint = off.length === 1 ? `Almost! Check the ${off[0] === 'dots' ? 'number of dots' : off[0]}.` : 'Not that one. Look at how the row repeats.';
      if (off.length === 1) coach(room, lock, `${kid}’s prediction was right except for the ${off[0] === 'dots' ? 'number of dots' : off[0]}. Ask: “Say the row out loud. What comes next?”`);
      lockUpdate(room, { event: { role, kind: 'look_again', message: hint } });
      return { correct: false, changesNote };
    }
    lock.predicted = true;
    coach(room, lock, `${kid} predicted what comes next in the row. Your rule may need it: ask “What did you predict comes next?”`);
    lockUpdate(room, { event: { role, kind: 'round', message: 'Prediction locked in! Now the rule decides what to press.' } });
    return { correct: true, changesNote };
  }
  let correct;
  if (role === ruler && msg.action === 'branch') {
    if (!['then', 'else'].includes(msg.branch)) return;
    correct = msg.branch === rd.solution.branch;
    log(room, player, lock, 'branch', { correct, choice: msg.branch, swapped: rd.swapped || undefined });
    if (!correct && rd.swapped) coach(room, lock, `${kid} holds the rule this round. Ask: “What does your rule need to know about the row? I’ll tell you.”`);
  } else if (role === presser && msg.action === 'press') {
    if (rd.predict && !lock.predicted) return;
    const b = Number(msg.button);
    if (!(b >= 0 && b < rd.panel.length)) return;
    correct = b === rd.solution.button;
    const want = rd.panel[rd.solution.button], got = rd.panel[b];
    const off = correct ? undefined : ['shape', 'color', 'dots'].filter((a) => want[a] !== got[a]);
    log(room, player, lock, 'press', { correct, button: b, off, swapped: rd.swapped || undefined });
    if (off && off.length === 1 && role === 'scout') coach(room, lock, `${kid} pressed a symbol with the wrong ${off[0] === 'dots' ? 'number of dots' : off[0]}, and everything else was right. Ask: “What ${off[0] === 'dots' ? 'number of dots' : off[0]} does the row need next?”`);
  } else return;
  lock.part[role].lastAnswer = now();
  if (!correct) {
    const other = ROLE_LABEL[role === 'scout' ? 'keeper' : 'scout'];
    return wrong(room, player, lock, role === ruler ? `That rule doesn’t apply this time. Check with the ${other}!` : 'Not that symbol. The door shook but stayed shut.');
  }
  lock.roundKeys[role] = true;
  const deltas = partSolved(room, player, lock, { round: lock.round, swapped: rd.swapped || undefined });
  lockUpdate(room, { event: { role, kind: 'round', message: `${ROLE_LABEL[role]}: correct!` }, ratingDelta: { role, deltas } });
  if (lock.roundKeys.scout && lock.roundKeys.keeper) {
    if (lock.round + 1 < lock.puzzle.rounds.length) {
      lock.round++;
      lock.roundKeys = { scout: false, keeper: false };
      lock.part = { scout: partState(), keeper: partState() };
      const next = lock.puzzle.rounds[lock.round];
      if (next.swapped) coach(room, lock, `Role swap! This round ${kid} holds the rule book and you see the symbols. Describe each symbol and let ${kid} decide which rule applies.`);
      lockUpdate(room, { event: { kind: 'next_round', message: next.swapped ? `Round ${lock.round + 1}: Role swap! The Scout holds the rule.` : `Round ${lock.round + 1} of ${lock.puzzle.rounds.length}` } });
    } else {
      lock.keys = { scout: true, keeper: true };
      maybeOpen(room, lock);
    }
  }
}

function handleBlueprint(room, player, lock, msg) {
  const puz = lock.puzzle;
  const role = player.role;
  if (lock.keys[role]) return;
  if (role === 'scout' && msg.action === 'edit') {
    const z = Number(msg.z), x = Number(msg.x), d = Number(msg.delta);
    if (!(z >= 0 && z < puz.d && x >= 0 && x < puz.w) || ![1, -1].includes(d)) return;
    const h = lock.grid[z][x] + d;
    if (h < 0 || h > 4) return;
    const wasRight = lock.grid[z][x] === puz.target[z][x];
    lock.grid[z][x] = h;
    // A wrong edit: broke a correct tower or moved further from the target.
    const good = Math.abs(h - puz.target[z][x]) < Math.abs(h - d - puz.target[z][x]);
    log(room, player, lock, 'edit', { z, x, delta: d, correct: good, brokeRight: wasRight });
    lock.part[role].lastProgress = now();
    if (lock.part[role].highlight && lock.part[role].highlight.z === z && lock.part[role].highlight.x === x && h === puz.target[z][x]) lock.part[role].highlight = null;
    return;
  }
  // Before turning the model: "How does it look from the right side?" One try, then turn to check.
  if (role === 'scout' && msg.action === 'predict_view' && lock.viewQ && lock.viewQ.answered == null) {
    const skip = msg.choice === 'skip';
    const k = Number(msg.choice);
    if (!skip && !(k >= 0 && k < lock.viewQ.options.length)) return;
    const correct = !skip && k === lock.viewQ.answer;
    lock.viewQ.answered = skip ? 'skipped' : correct;
    log(room, player, lock, 'predict_view', { correct: skip ? undefined : correct, skipped: skip || undefined, rotationsBefore: lock.rotations });
    if (!skip && !correct) coach(room, lock, `${scoutName(room)} guessed the right-side view of their model before turning it, and it didn’t match. Ask: “Turn it to the right side. What’s different from what you picked?”`);
    return { correct: skip ? null : correct };
  }
  if (role === 'scout' && msg.action === 'rotate') {
    lock.rotations++;
    log(room, player, lock, 'rotate', { n: lock.rotations });
    return;
  }
  if (role === 'scout' && msg.action === 'check') {
    const correct = lock.grid.every((row, z) => row.every((h, x) => h === puz.target[z][x]));
    log(room, player, lock, 'check', { correct, rotations: lock.rotations });
    lock.part[role].lastAnswer = now();
    if (!correct) {
      coach(room, lock, `${scoutName(room)}’s model isn’t right yet. Ask: “Turn the model around. What can you see from the back?”`);
      return wrong(room, player, lock, 'Your model doesn’t match the blueprint yet. Ask the Keeper again!');
    }
    lock.keys.scout = true;
    const deltas = partSolved(room, player, lock);
    lockUpdate(room, { event: { role, kind: 'key', message: 'The model matches the blueprint exactly!' }, ratingDelta: { role, deltas } });
    return maybeOpen(room, lock);
  }
  if (role === 'keeper' && msg.action === 'toggle_mark') {
    const z = Number(msg.z), x = Number(msg.x);
    if (!(z >= 0 && z < puz.d && x >= 0 && x < puz.w)) return;
    const k = lock.marks.findIndex((c) => c.z === z && c.x === x);
    if (k >= 0) lock.marks.splice(k, 1); else lock.marks.push({ z, x });
    lock.part[role].lastProgress = now();
    return;
  }
  if (role === 'keeper' && msg.action === 'mark') {
    const want = new Set(puz.solution.diffCells.map((c) => `${c.z},${c.x}`));
    const got = new Set(lock.marks.map((c) => `${c.z},${c.x}`));
    const correct = want.size === got.size && [...want].every((k) => got.has(k));
    log(room, player, lock, 'mark', { correct, marked: got.size });
    lock.part[role].lastAnswer = now();
    if (!correct) return wrong(room, player, lock, got.size < want.size ? 'Not every difference is marked yet.' : 'Some marked towers are actually correct.');
    lock.keys.keeper = true;
    const deltas = partSolved(room, player, lock);
    lockUpdate(room, { event: { role, kind: 'key', message: 'The Keeper found every difference!' }, ratingDelta: { role, deltas } });
    return maybeOpen(room, lock);
  }
}

function handleHint(room, player, lock) {
  const role = player.role;
  const part = lock.part[role];
  if (lock.keys[role] || part.hints >= 3) return;
  const ready = part.errors >= H.HINT_AFTER_ERRORS || now() - part.lastProgress >= H.HINT_AFTER_MS;
  if (!ready) return;
  part.hints++;
  let h;
  if (lock.type === 'detective') h = H.detectiveHint(lock.puzzle, role, part.hints, lock.puzzle.seed % 97);
  else if (lock.type === 'cipher') {
    const sw = lock.puzzle.rounds[lock.round].swapped;
    h = H.cipherHint(lock.puzzle, lock.round, sw ? (role === 'scout' ? 'keeper' : 'scout') : role, part.hints);
    if (sw) h = swapWords(h);
  }
  else h = H.blueprintHint(lock.puzzle, role, part.hints, lock.grid);
  const text = typeof h === 'string' ? h : h.text;
  if (h && h.highlight) part.highlight = h.highlight;
  part.hintTexts.push(text);
  part.lastProgress = now();
  log(room, player, lock, 'hint', { level: part.hints });
}

function finish(room) {
  room.phase = 'chest';
  room.endedAt = now();
  const fam = store.getFamily(room.familyId);
  const prev = store.familySessions(room.familyId);
  const sessionId = `${new Date(now()).toISOString().slice(0, 10)}-${room.code}-${store.newId(3)}`;
  const durationMs = room.endedAt - room.startedAt;
  const record = prev.length ? Math.min(...prev.map((s) => (s.endedAt || s.startedAt) - s.startedAt).filter((x) => x > 0)) : null;
  const session = {
    id: sessionId, familyId: room.familyId, code: room.code, mode: room.mode,
    startedAt: room.startedAt, endedAt: room.endedAt,
    story: { title: room.story.title, region: room.story.region, source: room.story.source },
    players: room.players.map((p) => ({ key: p.key, nickname: p.nickname, kind: p.kind, ageBand: p.ageBand, role: p.role })),
    locks: room.locks.map((l) => ({ type: l.type, levels: l.puzzle.levels, opened: l.opened, errors: l.totals.errors, hints: l.totals.hints, ms: (l.openedAt || now()) - (l.startedAt || now()), focus: l.focus || undefined })),
    attempts: room.attempts,
    ratings: room.ratings,
    parentRating: null,
    solo: null,
    offscreen: null,
  };
  store.saveSession(session);
  room.sessionId = sessionId;
  if (fam) {
    for (const p of room.players) if (fam.members[p.key]) fam.members[p.key].ratings = { ...room.ratings[p.key].after };
    store.saveFamily(fam);
  }
  const all = [...prev, session];
  const days = [...new Set(all.map((s) => new Date(s.startedAt).toISOString().slice(0, 10)))].sort();
  let streak = 1;
  for (let i = days.length - 1; i > 0; i--) { if ((new Date(days[i]) - new Date(days[i - 1])) / 86400000 === 1) streak++; else break; }
  const scout = room.players.find((p) => p.role === 'scout');
  const det = room.locks.find((l) => l.type === 'detective');
  room.solo = {
    puzzle: P.generateSoloDetective(room.seed + 104729, { level: det.puzzle.levels.scout, cast: room.story.cast }),
    robot: { puzzle: P.generateRobotCase(room.seed + 7, { level: det.puzzle.levels.scout, cast: room.story.cast }), state: 'locked', stepTries: 0, thiefTries: 0, lastWrong: null },
    state: 'offer', tries: 0, wrongs: [], helped: false, lastWrong: null, startedAt: null, endedAt: null, playerKey: scout.key,
  };
  // Tonight's off-screen mission follows the lock that took the most work today (or today's focus).
  const work = (l) => room.attempts.filter((a) => a.type === l.type && a.player === scout.key && (a.action === 'hint' || a.correct === false)).length;
  const focusLock = room.locks.find((l) => l.focus);
  const missionLock = focusLock || room.locks.slice().sort((a, b) => work(b) - work(a))[0];
  room.chest = {
    sessionId, card: room.story.conversation_card,
    mission: { type: missionLock.type, ...MISSIONS[missionLock.type], done: false },
    durationSec: Math.round(durationMs / 1000), recordSec: record ? Math.round(record / 1000) : null,
    newRecord: record == null || durationMs < record,
    streak, mapPiece: room.story.region,
    levels: room.players.map((p) => ({ nickname: p.nickname, role: p.role, skills: Object.fromEntries(Object.entries(room.ratings[p.key].after).filter(([k]) => k !== 'communication').map(([k, v]) => [SKILLS[k], { level: store.ratingToLevel(v), levelBefore: store.ratingToLevel(room.ratings[p.key].before[k]), delta: v - room.ratings[p.key].before[k] }])) })),
  };
}

// ---------------------------------------------------------------- the Scout's solo chest
// After the family expedition, the kid gets one small Detective on their own screen with every clue.
// Optional, no timer. The grown-up can mark that they helped: a home attempt, not a test.
function soloSummary(solo) {
  return {
    level: solo.puzzle.levels.scout, suspects: solo.puzzle.lineup.length, clues: solo.puzzle.scoutClues.length,
    state: solo.state, solved: solo.state === 'solved', tries: solo.tries, helped: solo.helped,
    wrongs: solo.wrongs, ms: solo.startedAt ? (solo.endedAt || now()) - solo.startedAt : null,
    robot: solo.robot.state === 'locked' ? null : { state: solo.robot.state, fixed: solo.robot.state === 'done', stepTries: solo.robot.stepTries, thiefTries: solo.robot.thiefTries },
  };
}

function saveSolo(room) {
  const s = store.getSession(room.sessionId);
  if (!s) return;
  s.solo = soloSummary(room.solo);
  store.saveSession(s);
}

function handleSolo(room, player, msg) {
  const solo = room.solo;
  if (!solo) return;
  if (msg.action === 'helped' && player.kind === 'adult') {
    solo.helped = msg.value === true;
    return saveSolo(room);
  }
  if (msg.action === 'skip' && solo.state === 'offer') { solo.state = 'skipped'; return saveSolo(room); }
  if (player.role !== 'scout' && room.mode !== 'single') return;
  if (msg.action === 'start' && solo.state === 'offer') { solo.state = 'playing'; solo.startedAt = now(); return saveSolo(room); }
  if (msg.action === 'accuse' && solo.state === 'playing') {
    const puz = solo.puzzle;
    const i = Number(msg.i);
    if (!(i >= 0 && i < puz.lineup.length)) return;
    solo.tries++;
    if (i === puz.solution.thief) {
      solo.state = 'solved';
      solo.endedAt = now();
      solo.lastWrong = null;
      solo.robot.state = 'offer'; // bonus: fix Robo's case
    } else {
      const m = mixupOf(puz, i);
      solo.wrongs.push({ name: m.name, fits: m.fits, breaks: m.breaks });
      solo.lastWrong = `${m.checks.find((c) => !c.holds).text} Try again!`;
    }
    return saveSolo(room);
  }
}

// "Fix the Robot": first find Robo's wrong step, then name the real thief.
function handleRobot(room, player, msg) {
  const rb = room.solo.robot;
  const puz = rb.puzzle;
  if (msg.action === 'robot_skip' && rb.state === 'offer') { rb.state = 'skipped'; return saveSolo(room); }
  if (msg.action === 'robot_start' && rb.state === 'offer') { rb.state = 'step'; return saveSolo(room); }
  if (msg.action === 'robot_step' && rb.state === 'step') {
    const k = Number(msg.k);
    if (!(k >= 0 && k < puz.steps.length)) return;
    rb.stepTries++;
    if (k === puz.solution.wrongStep) { rb.state = 'thief'; rb.lastWrong = null; }
    else rb.lastWrong = 'Robo got that step right: that animal really doesn’t match the clue. Look for a step where the animal DOES match.';
    return saveSolo(room);
  }
  if (msg.action === 'robot_thief' && rb.state === 'thief') {
    const i = Number(msg.i);
    if (!(i >= 0 && i < puz.lineup.length)) return;
    rb.thiefTries++;
    if (i === puz.solution.thief) { rb.state = 'done'; rb.lastWrong = null; }
    else rb.lastWrong = `${P.checkSuspect(puz, i).find((c) => !c.holds).text} Try again!`;
    return saveSolo(room);
  }
}

function soloView(room, player) {
  const solo = room.solo;
  if (!solo) return null;
  const base = { state: solo.state, tries: solo.tries, helped: solo.helped, level: solo.puzzle.levels.scout, childName: scoutName(room) };
  // Only the Scout's screen gets the puzzle; in one-device mode both roles share the screen.
  if (player.role === 'scout' || room.mode === 'single') {
    const v = P.detectiveViews(solo.puzzle).scout;
    const rb = solo.robot;
    const rv = P.detectiveViews(rb.puzzle).scout;
    const robot = rb.state === 'locked' ? null : { state: rb.state, steps: rb.puzzle.steps, accused: rb.puzzle.lineup[rb.puzzle.accused].name, lineup: rv.lineup, clues: rv.clues, lastWrong: rb.lastWrong };
    return { ...base, lineup: v.lineup, clues: v.clues, lastWrong: solo.lastWrong, robot };
  }
  return { ...base, robot: solo.robot.state === 'locked' ? null : { state: solo.robot.state } };
}

// ---------------------------------------------------------------- sockets
function attach(socket, room, player) {
  player.socketId = socket.id;
  player.connected = true;
  socket.join('room:' + room.code);
  socket.data.room = room.code;
  (socket.data.players ||= new Set()).add(player.id);
}

io.on('connection', (socket) => {
  socket.on('create_room', async (data = {}, ack = () => {}) => {
    try {
      const mode = data.mode === 'single' ? 'single' : 'multi';
      const fam = store.ensureFamily(clean(data.familyId, 32), clean(data.familyName, 40) || undefined);
      const parentName = clean(data.parentName) || 'Mom';
      const interest = INTERESTS.includes(data.interest) ? data.interest : 'animals';
      const ageBand = AGE_BANDS.includes(data.ageBand) ? data.ageBand : '8-10';
      const code = newCode();
      const room = {
        code, mode, familyId: fam.id, createdAt: now(), phase: 'lobby', players: [], attempts: [], ratings: {},
        prefs: { interest, ageBand }, seed: Math.floor(Math.random() * 2 ** 31), lockIdx: -1, locks: [],
      };
      room.joinUrl = `${publicBase(socket)}/game.html?room=${code}`;
      room.qrSvg = await QRCode.toString(room.joinUrl, { type: 'svg', margin: 1, color: { dark: '#222222', light: '#0000' } });
      const host = addPlayer(room, fam, parentName, 'adult', null, 'keeper');
      room.hostId = host.id;
      attach(socket, room, host);
      if (mode === 'single') {
        const child = addPlayer(room, fam, clean(data.childName) || 'Max', 'child', ageBand, 'scout');
        attach(socket, room, child);
      }
      store.saveFamily(fam);
      // Generate the story up front while the second player is joining.
      room.storyPromise = ai.generateStory({ ageBand, interest, suspects: P.ANIMALS.length });
      rooms.set(code, room);
      ack({ ok: true, code, playerId: host.id, familyId: fam.id, joinUrl: room.joinUrl, playerIds: room.players.map((p) => p.id) });
      broadcast(room);
    } catch (e) {
      console.error(e);
      ack({ ok: false, error: 'Couldn’t create a room. Please try again.' });
    }
  });

  socket.on('join_room', (data = {}, ack = () => {}) => {
    const room = rooms.get(String(data.code || '').trim());
    if (!room) return ack({ ok: false, error: 'Room not found. Check the 4-digit code and try again.' });
    // Reconnect by a saved playerId (page refresh, network switch).
    const ids = Array.isArray(data.playerIds) ? data.playerIds : data.playerId ? [data.playerId] : [];
    const known = room.players.filter((p) => ids.includes(p.id));
    if (known.length) {
      known.forEach((p) => attach(socket, room, p));
      ack({ ok: true, code: room.code, playerIds: known.map((p) => p.id), familyId: room.familyId });
      return broadcast(room);
    }
    if (room.players.length >= 2) return ack({ ok: false, error: 'This room already has two players: a Scout and a Keeper.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: 'This expedition has already started.' });
    const name = clean(data.name);
    if (!name) return ack({ ok: false, error: 'Enter your name to join.' });
    if (room.players.some((p) => p.key === name.toLowerCase())) return ack({ ok: false, error: 'That name is taken in this room. Try another one.' });
    const fam = store.getFamily(room.familyId);
    const ageBand = AGE_BANDS.includes(data.ageBand) ? data.ageBand : room.prefs.ageBand;
    const child = addPlayer(room, fam, name, 'child', ageBand, 'scout');
    store.saveFamily(fam);
    attach(socket, room, child);
    ack({ ok: true, code: room.code, playerIds: [child.id], familyId: room.familyId });
    broadcast(room);
  });

  socket.on('submit', async (msg = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return ack({ ok: false, error: 'Room not found' });
    const mine = room.players.filter((p) => socket.data.players && socket.data.players.has(p.id));
    const player = mine.find((p) => p.role === msg.asRole) || mine[0];
    if (!player) return ack({ ok: false });

    if (msg.kind === 'start') {
      if (player.id !== room.hostId || room.phase !== 'lobby') return ack({ ok: false });
      if (room.players.length < 2) return ack({ ok: false, error: 'Waiting for the second player' });
      room.phase = 'intro';
      room.loadingStory = true;
      broadcast(room);
      await buildExpedition(room);
      room.startedAt = now();
      broadcast(room);
      return ack({ ok: true });
    }
    if (msg.kind === 'begin' && room.phase === 'intro' && room.locks.length) {
      if (player.id !== room.hostId) return ack({ ok: false });
      startLock(room, 0);
      broadcast(room);
      return ack({ ok: true });
    }
    if (msg.kind === 'rating' && room.phase === 'chest' && player.kind === 'adult') {
      const v = Number(msg.value);
      if (![1, 2, 3].includes(v)) return ack({ ok: false });
      const s = store.getSession(room.sessionId);
      if (s) { s.parentRating = v; store.saveSession(s); }
      room.chest.parentRating = v;
      broadcast(room);
      return ack({ ok: true });
    }
    if (msg.kind === 'offscreen' && room.phase === 'chest' && player.kind === 'adult') {
      room.chest.mission.done = msg.value === true;
      const s = store.getSession(room.sessionId);
      if (s) { s.offscreen = room.chest.mission.done ? { type: room.chest.mission.type, title: room.chest.mission.title, t: now() } : null; store.saveSession(s); }
      broadcast(room);
      return ack({ ok: true });
    }
    if (msg.kind === 'solo' && room.phase === 'chest') {
      if (String(msg.action || '').startsWith('robot_')) { if (player.role === 'scout' || room.mode === 'single') handleRobot(room, player, msg); }
      else handleSolo(room, player, msg);
      broadcast(room);
      return ack({ ok: true });
    }
    if (room.phase !== 'lock') return ack({ ok: false });
    const lock = room.locks[room.lockIdx];
    if (lock.opened) return ack({ ok: false });
    let res;
    if (msg.kind === 'hint') handleHint(room, player, lock);
    else if (lock.type === 'detective') res = handleDetective(room, player, lock, msg);
    else if (lock.type === 'cipher') res = handleCipher(room, player, lock, msg);
    else res = handleBlueprint(room, player, lock, msg);
    broadcast(room);
    ack({ ok: true, ...(res || {}) });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    for (const p of room.players) if (p.socketId === socket.id) { p.connected = false; p.socketId = null; }
    broadcast(room);
  });
});

function addPlayer(room, fam, nickname, kind, ageBand, role) {
  const m = store.ensureMember(fam, nickname, kind, ageBand);
  const key = nickname.toLowerCase();
  const p = { id: store.newId(6), key, nickname: m.nickname, kind, ageBand, role, socketId: null, connected: false };
  room.players.push(p);
  room.ratings[key] = { before: { ...m.ratings }, after: { ...m.ratings } };
  return p;
}

// Drop rooms older than 6 hours from memory.
setInterval(() => {
  for (const [code, r] of rooms) if (now() - r.createdAt > 6 * 3600e3) rooms.delete(code);
}, 600e3).unref();

// ---------------------------------------------------------------- reports
const reportCache = new Map();
async function reportFor(sessions, cacheKey, nickKey) {
  const metrics = buildMetrics(sessions, nickKey);
  if (!metrics) return null;
  let text = reportCache.get(cacheKey);
  if (!text) {
    text = await ai.writeReport(metrics);
    reportCache.set(cacheKey, text);
  }
  const activities = text.activity_ids.map((id) => ACTIVITIES.find((a) => a.id === id)).filter(Boolean);
  return { metrics, text, activities, skills: SKILLS };
}

app.get('/api/report/session/:id', async (req, res) => {
  const s = store.getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const key = `s:${s.id}:${s.parentRating || 0}`;
  const out = await reportFor([s], key);
  res.json({ kind: 'session', session: { id: s.id, familyId: s.familyId, title: s.story.title, region: s.story.region, startedAt: s.startedAt, players: s.players }, ...out });
});

app.get('/api/report/week', async (req, res) => {
  const familyId = String(req.query.family || '');
  const all = store.familySessions(familyId);
  if (!all.length) return res.status(404).json({ error: 'No expeditions played yet' });
  const lastTs = all[all.length - 1].startedAt;
  const week = all.filter((s) => s.startedAt > lastTs - 7 * 86400000);
  const fam = familyId === 'demo' ? { name: 'Demo Family' } : store.getFamily(familyId) || {};
  const key = `w:${familyId}:${week.map((s) => s.id + (s.parentRating || 0)).join(',')}`;
  const out = await reportFor(week, key);
  res.json({ kind: 'week', family: { id: familyId, name: fam.name, demo: familyId === 'demo' }, sessionIds: week.map((s) => s.id), ...out });
});

app.get('/api/family/:id', (req, res) => {
  const fam = store.getFamily(req.params.id);
  if (!fam) return res.status(404).json({ error: 'not found' });
  const sessions = store.familySessions(fam.id);
  res.json({
    id: fam.id, name: fam.name,
    members: Object.values(fam.members).map((m) => ({ nickname: m.nickname, kind: m.kind, ageBand: m.ageBand, levels: Object.fromEntries(Object.entries(m.ratings).map(([k, v]) => [k, store.ratingToLevel(v)])) })),
    sessions: sessions.map((s) => ({ id: s.id, startedAt: s.startedAt, title: s.story.title })),
  });
});

app.get('/api/config', (req, res) => res.json({ ai: ai.hasKey(), model: ai.MODEL }));
app.get('/healthz', (req, res) => res.send('ok'));

if (require.main === module) {
  // Local secrets (GEMINI_API_KEY) live in .env, which is git-ignored. On Railway, set them as variables.
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
  server.listen(PORT, () => console.log(`Kinquest: http://localhost:${PORT}  (Gemini: ${ai.hasKey() ? ai.MODEL : 'no key, using template text'})`));
}

module.exports = { app, server, io, rooms, clock };
