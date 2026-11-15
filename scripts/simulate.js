// Records a demo week for the weekly report: 6 expeditions of a bot family through the real server
// (generators, answer checking, attempt log, ratings — all real), time is virtual.
// Result: seed-sessions.json. Data is marked simulated: true and shown with a "demo" badge.
// Before the pitch, replace with real sessions (see README).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-sim-'));
process.env.KQ_ADVANCE_MS = '5';
delete process.env.GEMINI_API_KEY; // the demo story is templated to avoid spending calls

const P = require('../puzzles');
const { server, rooms, clock } = require('../server');
const { playExpedition } = require('./bot');
const store = require('../store');

// Child profile by day: patterns strong, spatial weak but growing toward the end of the week.
const DAYS = [
  { logic: 0.55, patterns: 0.75, spatial: 0.25, rotations: 1, guessy: 0.35, rating: 2 },
  { logic: 0.6, patterns: 0.8, spatial: 0.3, rotations: 1, guessy: 0.3, rating: 2 },
  { logic: 0.65, patterns: 0.85, spatial: 0.35, rotations: 1, guessy: 0.25, rating: 3 },
  { logic: 0.7, patterns: 0.9, spatial: 0.45, rotations: 2, guessy: 0.2, rating: 2 },
  { logic: 0.7, patterns: 0.9, spatial: 0.5, rotations: 2, guessy: 0.2, rating: 3 },
  { logic: 0.97, patterns: 0.95, spatial: 0.6, rotations: 3, guessy: 0.15, rating: 3 },
];
const INTERESTS = ['ocean', 'ocean', 'space', 'ocean', 'dinosaurs', 'ocean'];
const START = Date.UTC(2026, 10, 9, 16, 0); // November 9, 2026, 7:00 PM Moscow time

server.listen(0, async () => {
  const url = `http://localhost:${server.address().port}`;
  const rnd = P.rng(20261115);
  let familyId = '';
  const ids = [];
  for (let d = 0; d < DAYS.length; d++) {
    clock.now = () => START + d * 86400000 + Math.floor(rnd() * 3600e3);
    const out = await playExpedition({ url, rooms, clock, rnd, profile: DAYS[d], opts: { parentName: 'Mom', childName: 'Max', ageBand: '8-10', interest: INTERESTS[d], familyId, familyName: 'Demo Family' } });
    familyId = out.familyId;
    ids.push(out.sessionId);
    console.log(`day ${d + 1}: ${out.sessionId}`);
  }
  const sessions = store.familySessions(familyId).map((s, i) => ({ ...s, id: `demo-${i + 1}`, familyId: 'demo', simulated: true }));
  fs.writeFileSync(path.join(__dirname, '..', 'seed-sessions.json'), JSON.stringify(sessions, null, 1));
  console.log(`seed-sessions.json: ${sessions.length} sessions, ${sessions.reduce((a, s) => a + s.attempts.length, 0)} attempts`);
  server.close();
  process.exit(0);
});
