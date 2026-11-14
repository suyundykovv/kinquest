// Записывает демо-неделю для недельного отчёта: 6 экспедиций бот-семьи через настоящий сервер
// (генераторы, проверка ответов, журнал попыток, рейтинги — всё боевое), время — виртуальное.
// Результат: seed-sessions.json. Данные помечены simulated: true и показываются с плашкой «демо».
// Перед питчем замените их на реальные сессии тестовой семьи: npm run record-real (см. README).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-sim-'));
process.env.KQ_ADVANCE_MS = '5';
delete process.env.ANTHROPIC_API_KEY; // сюжет в демо — шаблонный, чтобы не тратить вызовы
delete process.env.ANTHROPIC_AUTH_TOKEN;

const P = require('../puzzles');
const { server, rooms, clock } = require('../server');
const { playExpedition } = require('./bot');
const store = require('../store');

// Профиль ребёнка по дням: закономерности сильные, пространство слабое, но растёт к концу недели.
const DAYS = [
  { logic: 0.55, patterns: 0.75, spatial: 0.25, rotations: 1, guessy: 0.35, why: 0.5, rating: 2 },
  { logic: 0.6, patterns: 0.8, spatial: 0.3, rotations: 1, guessy: 0.3, why: 0.6, rating: 2 },
  { logic: 0.65, patterns: 0.85, spatial: 0.35, rotations: 1, guessy: 0.25, why: 0.6, rating: 3 },
  { logic: 0.7, patterns: 0.9, spatial: 0.45, rotations: 2, guessy: 0.2, why: 0.7, rating: 2 },
  { logic: 0.7, patterns: 0.9, spatial: 0.5, rotations: 2, guessy: 0.2, why: 0.75, rating: 3 },
  { logic: 0.75, patterns: 0.95, spatial: 0.6, rotations: 3, guessy: 0.15, why: 0.8, rating: 3 },
];
const INTERESTS = ['ocean', 'ocean', 'space', 'ocean', 'dinosaurs', 'ocean'];
const START = Date.UTC(2026, 10, 9, 16, 0); // 9 ноября 2026, 19:00 по Москве

server.listen(0, async () => {
  const url = `http://localhost:${server.address().port}`;
  const rnd = P.rng(20261115);
  let familyId = '';
  const ids = [];
  for (let d = 0; d < DAYS.length; d++) {
    clock.now = () => START + d * 86400000 + Math.floor(rnd() * 3600e3);
    const out = await playExpedition({ url, rooms, clock, rnd, profile: DAYS[d], opts: { parentName: 'Мама', childName: 'Макс', ageBand: '8-10', interest: INTERESTS[d], familyId, familyName: 'Демо-семья' } });
    familyId = out.familyId;
    ids.push(out.sessionId);
    console.log(`день ${d + 1}: ${out.sessionId}`);
  }
  const sessions = store.familySessions(familyId).map((s, i) => ({ ...s, id: `demo-${i + 1}`, familyId: 'demo', simulated: true }));
  fs.writeFileSync(path.join(__dirname, '..', 'seed-sessions.json'), JSON.stringify(sessions, null, 1));
  console.log(`seed-sessions.json: ${sessions.length} сессий, ${sessions.reduce((a, s) => a + s.attempts.length, 0)} попыток`);
  server.close();
  process.exit(0);
});
