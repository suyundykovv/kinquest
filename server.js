// Kinquest MVP: Express + Socket.IO. Комнаты в памяти, роли, проверка ответов на сервере, журнал попыток.
// Правило: решение никогда не уходит в браузер — каждый игрок получает только view своей роли.
// Сообщения браузер ↔ сервер: create_room, join_room, role_view, submit, lock_update.
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
const { ACTIVITIES, SKILLS } = require('./activities');

const PORT = Number(process.env.PORT || 3000);
const LOCK_TYPES = ['detective', 'cipher', 'blueprint'];
const ROLE_LABEL = { scout: 'Разведчик', keeper: 'Хранитель' };
const ROLE_GEN = { scout: 'Разведчика', keeper: 'Хранителя' };
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

// ---------------------------------------------------------------- утилиты
function newCode() {
  for (let i = 0; i < 1000; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  throw new Error('нет свободных кодов');
}
// Часы вынесены в объект, чтобы скрипт симуляции мог вести виртуальное время.
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
  // «Ответ быстрее 5 секунд» считаем от последнего собственного действия игрока.
  if (part && action !== 'part_solved') part.lastAnswer = now();
}

function levelFor(room, player, type) {
  const r = room.ratings[player.key].after[SKILL_OF_LOCK[type]];
  return store.ratingToLevel(r);
}

// ---------------------------------------------------------------- построение экспедиции
async function buildExpedition(room) {
  const story = await Promise.race([room.storyPromise, new Promise((res) => setTimeout(() => res(null), 12000))]) || ai.templateStory(room.prefs.interest);
  room.story = story;
  const scout = room.players.find((p) => p.role === 'scout');
  const keeper = room.players.find((p) => p.role === 'keeper');
  room.locks = LOCK_TYPES.map((type, i) => {
    const opts = { levelScout: levelFor(room, scout, type), levelKeeper: levelFor(room, keeper, type), cast: story.cast };
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
      why: type === 'detective' ? P.detectiveWhyOptions(seed) : null,
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
  };
  if (lock.type === 'detective') {
    const v = P.detectiveViews(puz)[role];
    return { ...base, ...v, excluded: lock.excluded[role], why: role === 'scout' ? lock.why : null };
  }
  if (lock.type === 'cipher') {
    const v = P.cipherViews(puz, lock.round)[role];
    return { ...base, ...v, roundSolved: lock.roundKeys[role] };
  }
  const v = P.blueprintViews(puz)[role];
  if (role === 'scout') return { ...base, ...v, grid: lock.grid, highlight: part.highlight };
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
  if (room.phase === 'chest') v.chest = room.chest;
  return v;
}

function broadcast(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('role_view', roleView(room, p));
}
function lockUpdate(room, payload) {
  const lock = room.locks[room.lockIdx];
  io.to('room:' + room.code).emit('lock_update', { lockIdx: room.lockIdx, keys: keysView(lock), opened: lock.opened, ...payload });
}

// ---------------------------------------------------------------- игровая логика
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
  lockUpdate(room, { event: { kind: 'open', message: 'Дверь открыта!' } });
  const idx = room.lockIdx;
  setTimeout(() => {
    if (room.lockIdx !== idx || room.phase !== 'lock') return;
    if (idx + 1 < room.locks.length) startLock(room, idx + 1);
    else finish(room);
    broadcast(room);
  }, ADVANCE_MS);
}

function handleDetective(room, player, lock, msg) {
  const puz = lock.puzzle;
  const role = player.role;
  if (msg.action === 'exclude') {
    const i = Number(msg.i);
    if (!(i >= 0 && i < puz.lineup.length)) return;
    const list = lock.excluded[role];
    const at = list.indexOf(i);
    if (at >= 0) { list.splice(at, 1); log(room, player, lock, 'unexclude', { i }); }
    else { list.push(i); log(room, player, lock, 'exclude', { i, correct: i !== puz.solution.thief }); }
    lock.part[role].lastProgress = now();
    return;
  }
  if (msg.action === 'accuse') {
    if (lock.keys[role]) return;
    const i = Number(msg.i);
    if (!(i >= 0 && i < puz.lineup.length)) return;
    if (role === 'scout' && lock.why) {
      const opt = ['all_clues', 'looks', 'guess'].includes(msg.why) ? msg.why : null;
      if (opt) log(room, player, lock, 'why', { correct: opt === 'all_clues', choice: opt });
    }
    const correct = i === puz.solution.thief;
    log(room, player, lock, 'accuse', { i, correct });
    lock.part[role].lastAnswer = now();
    if (!correct) return wrong(room, player, lock, `${puz.lineup[i].name} не подходит под все улики. Поговорите ещё!`);
    lock.keys[role] = true;
    const deltas = partSolved(room, player, lock);
    lockUpdate(room, { event: { role, kind: 'key', message: `Ключ ${ROLE_GEN[role]} горит!` }, ratingDelta: { role, deltas } });
    maybeOpen(room, lock);
  }
}

function handleCipher(room, player, lock, msg) {
  const role = player.role;
  const rd = lock.puzzle.rounds[lock.round];
  if (lock.roundKeys[role]) return;
  let correct;
  if (role === 'keeper' && msg.action === 'branch') {
    if (!['then', 'else'].includes(msg.branch)) return;
    correct = msg.branch === rd.solution.branch;
    log(room, player, lock, 'branch', { correct, choice: msg.branch });
  } else if (role === 'scout' && msg.action === 'press') {
    const b = Number(msg.button);
    if (!(b >= 0 && b < rd.panel.length)) return;
    correct = b === rd.solution.button;
    log(room, player, lock, 'press', { correct, button: b });
  } else return;
  lock.part[role].lastAnswer = now();
  if (!correct) return wrong(room, player, lock, role === 'keeper' ? 'Это правило сейчас не работает. Уточните у Разведчика!' : 'Знак не тот — дверь дрогнула, но не открылась.');
  lock.roundKeys[role] = true;
  const deltas = partSolved(room, player, lock, { round: lock.round });
  lockUpdate(room, { event: { role, kind: 'round', message: `${ROLE_LABEL[role]}: верно!` }, ratingDelta: { role, deltas } });
  if (lock.roundKeys.scout && lock.roundKeys.keeper) {
    if (lock.round + 1 < lock.puzzle.rounds.length) {
      lock.round++;
      lock.roundKeys = { scout: false, keeper: false };
      lock.part = { scout: partState(), keeper: partState() };
      lockUpdate(room, { event: { kind: 'next_round', message: `Раунд ${lock.round + 1} из ${lock.puzzle.rounds.length}` } });
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
    // Ошибочное изменение: испортили верную башню или ушли дальше от цели.
    const good = Math.abs(h - puz.target[z][x]) < Math.abs(h - d - puz.target[z][x]);
    log(room, player, lock, 'edit', { z, x, delta: d, correct: good, brokeRight: wasRight });
    lock.part[role].lastProgress = now();
    if (lock.part[role].highlight && lock.part[role].highlight.z === z && lock.part[role].highlight.x === x && h === puz.target[z][x]) lock.part[role].highlight = null;
    return;
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
    if (!correct) return wrong(room, player, lock, 'Деталь пока не совпадает с чертежом. Спроси Хранителя ещё раз!');
    lock.keys.scout = true;
    const deltas = partSolved(room, player, lock);
    lockUpdate(room, { event: { role, kind: 'key', message: 'Деталь собрана точно по чертежу!' }, ratingDelta: { role, deltas } });
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
    if (!correct) return wrong(room, player, lock, got.size < want.size ? 'Отмечены не все отличия.' : 'Среди отмеченных есть лишние башни.');
    lock.keys.keeper = true;
    const deltas = partSolved(room, player, lock);
    lockUpdate(room, { event: { role, kind: 'key', message: 'Хранитель нашёл все отличия!' }, ratingDelta: { role, deltas } });
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
  else if (lock.type === 'cipher') h = H.cipherHint(lock.puzzle, lock.round, role, part.hints);
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
    locks: room.locks.map((l) => ({ type: l.type, levels: l.puzzle.levels, opened: l.opened, errors: l.totals.errors, hints: l.totals.hints, ms: (l.openedAt || now()) - (l.startedAt || now()) })),
    attempts: room.attempts,
    ratings: room.ratings,
    parentRating: null,
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
  room.chest = {
    sessionId, card: room.story.conversation_card,
    durationSec: Math.round(durationMs / 1000), recordSec: record ? Math.round(record / 1000) : null,
    newRecord: record == null || durationMs < record,
    streak, mapPiece: room.story.region,
    levels: room.players.map((p) => ({ nickname: p.nickname, role: p.role, skills: Object.fromEntries(Object.entries(room.ratings[p.key].after).filter(([k]) => k !== 'communication').map(([k, v]) => [SKILLS[k], { level: store.ratingToLevel(v), levelBefore: store.ratingToLevel(room.ratings[p.key].before[k]), delta: v - room.ratings[p.key].before[k] }])) })),
  };
}

// ---------------------------------------------------------------- сокеты
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
      const parentName = clean(data.parentName) || 'Мама';
      const interest = INTERESTS.includes(data.interest) ? data.interest : 'animals';
      const ageBand = AGE_BANDS.includes(data.ageBand) ? data.ageBand : '8-10';
      const code = newCode();
      const room = {
        code, mode, familyId: fam.id, createdAt: now(), phase: 'lobby', players: [], attempts: [], ratings: {},
        prefs: { interest, ageBand }, seed: Math.floor(Math.random() * 2 ** 31), lockIdx: -1, locks: [],
      };
      room.joinUrl = `${publicBase(socket)}/game.html?room=${code}`;
      room.qrSvg = await QRCode.toString(room.joinUrl, { type: 'svg', margin: 1, color: { dark: '#2b2140', light: '#0000' } });
      const host = addPlayer(room, fam, parentName, 'adult', null, 'keeper');
      room.hostId = host.id;
      attach(socket, room, host);
      if (mode === 'single') {
        const child = addPlayer(room, fam, clean(data.childName) || 'Макс', 'child', ageBand, 'scout');
        attach(socket, room, child);
      }
      store.saveFamily(fam);
      // Сюжет готовим заранее, пока второй игрок заходит в комнату.
      room.storyPromise = ai.generateStory({ ageBand, interest, suspects: P.ANIMALS.length });
      rooms.set(code, room);
      ack({ ok: true, code, playerId: host.id, familyId: fam.id, joinUrl: room.joinUrl, playerIds: room.players.map((p) => p.id) });
      broadcast(room);
    } catch (e) {
      console.error(e);
      ack({ ok: false, error: 'Не удалось создать комнату' });
    }
  });

  socket.on('join_room', (data = {}, ack = () => {}) => {
    const room = rooms.get(String(data.code || '').trim());
    if (!room) return ack({ ok: false, error: 'Комната не найдена. Проверьте код.' });
    // Переподключение по сохранённому playerId (обновили страницу, сменили сеть).
    const ids = Array.isArray(data.playerIds) ? data.playerIds : data.playerId ? [data.playerId] : [];
    const known = room.players.filter((p) => ids.includes(p.id));
    if (known.length) {
      known.forEach((p) => attach(socket, room, p));
      ack({ ok: true, code: room.code, playerIds: known.map((p) => p.id), familyId: room.familyId });
      return broadcast(room);
    }
    if (room.players.length >= 2) return ack({ ok: false, error: 'В комнате уже два игрока. В MVP играют Разведчик и Хранитель.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: 'Экспедиция уже началась.' });
    const name = clean(data.name);
    if (!name) return ack({ ok: false, error: 'Введите имя' });
    if (room.players.some((p) => p.key === name.toLowerCase())) return ack({ ok: false, error: 'Такое имя уже есть в комнате' });
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
    if (!room) return ack({ ok: false, error: 'Нет комнаты' });
    const mine = room.players.filter((p) => socket.data.players && socket.data.players.has(p.id));
    const player = mine.find((p) => p.role === msg.asRole) || mine[0];
    if (!player) return ack({ ok: false });

    if (msg.kind === 'start') {
      if (player.id !== room.hostId || room.phase !== 'lobby') return ack({ ok: false });
      if (room.players.length < 2) return ack({ ok: false, error: 'Ждём второго игрока' });
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
    if (room.phase !== 'lock') return ack({ ok: false });
    const lock = room.locks[room.lockIdx];
    if (lock.opened) return ack({ ok: false });
    if (msg.kind === 'hint') handleHint(room, player, lock);
    else if (lock.type === 'detective') handleDetective(room, player, lock, msg);
    else if (lock.type === 'cipher') handleCipher(room, player, lock, msg);
    else handleBlueprint(room, player, lock, msg);
    broadcast(room);
    ack({ ok: true });
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

// Комнаты старше 6 часов удаляем из памяти.
setInterval(() => {
  for (const [code, r] of rooms) if (now() - r.createdAt > 6 * 3600e3) rooms.delete(code);
}, 600e3).unref();

// ---------------------------------------------------------------- отчёты
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
  if (!s) return res.status(404).json({ error: 'Сессия не найдена' });
  const key = `s:${s.id}:${s.parentRating || 0}`;
  const out = await reportFor([s], key);
  res.json({ kind: 'session', session: { id: s.id, familyId: s.familyId, title: s.story.title, region: s.story.region, startedAt: s.startedAt, players: s.players }, ...out });
});

app.get('/api/report/week', async (req, res) => {
  const familyId = String(req.query.family || '');
  const all = store.familySessions(familyId);
  if (!all.length) return res.status(404).json({ error: 'Пока нет сыгранных экспедиций' });
  const lastTs = all[all.length - 1].startedAt;
  const week = all.filter((s) => s.startedAt > lastTs - 7 * 86400000);
  const fam = familyId === 'demo' ? { name: 'Демо-семья' } : store.getFamily(familyId) || {};
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
  server.listen(PORT, () => console.log(`Kinquest: http://localhost:${PORT}  (Claude: ${ai.hasKey() ? ai.MODEL : 'нет ключа — шаблонные тексты'})`));
}

module.exports = { app, server, io, rooms, clock };
