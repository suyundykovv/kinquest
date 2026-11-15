// End-to-end test: real server, two socket clients, full expedition → chest → report.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-'));
process.env.KQ_ADVANCE_MS = '20';
delete process.env.GEMINI_API_KEY; // the test never calls Gemini: it checks the template path

const { server, rooms, clock } = require('../server');
const { playExpedition, client, waitFor } = require('../scripts/bot');

let url;
test.before(() => new Promise((res) => server.listen(0, () => { url = `http://localhost:${server.address().port}`; res(); })));
test.after(() => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()); }));

test('full expedition on two devices and a report from real attempts', async () => {
  const leaks = [];
  const out = await playExpedition({ url, rooms, clock, profile: { logic: 0.5, patterns: 0.5, spatial: 0.4 }, opts: { childName: 'Test', familyName: 'Test Family' } });
  assert.ok(out.sessionId);

  // No view may contain the solution.
  for (const v of [...Object.values(out.hostViews), ...Object.values(out.kidViews)]) {
    const j = JSON.stringify(v);
    for (const bad of ['"solution"', '"thief"', '"target"', '"diffCells"']) if (j.includes(bad)) leaks.push(bad);
  }
  assert.deepStrictEqual(leaks, []);

  const rep = await (await fetch(`${url}/api/report/session/${out.sessionId}`)).json();
  assert.strictEqual(rep.kind, 'session');
  assert.strictEqual(rep.metrics.subject.nickname, 'Test');
  assert.strictEqual(rep.metrics.team.locks, 3);
  assert.ok(rep.metrics.skills.patterns.parts >= 3, 'three cipher rounds = three parts');
  assert.ok(rep.text.headline);
  assert.ok(rep.activities.length >= 1);

  const week = await (await fetch(`${url}/api/report/week?family=${out.familyId}`)).json();
  assert.strictEqual(week.kind, 'week');
  assert.strictEqual(week.sessionIds.length, 1);
  for (const k of ['wins', 'stuck', 'tip', 'next']) assert.ok(k in rep.metrics.blocks, 'report block ' + k);
  assert.ok(!JSON.stringify(rep.metrics).includes('guessPct'), 'no "guessing" metric');
});

test('a mix-up leads to the check tool, then the same lock without it', async () => {
  const fam = 'f' + Date.now();
  const profile = { logic: 0, keeper: 1, solo: 0 }; // first wrong picks are mix-ups
  const one = await playExpedition({ url, rooms, clock, profile, opts: { childName: 'Ana', familyName: 'Focus Family' } });
  const s1 = rooms.get(one.code);
  assert.ok(s1.attempts.some((a) => a.action === 'accuse' && !a.correct && a.fits && a.breaks));
  const two = await playExpedition({ url, rooms, clock, profile: { logic: 0.95, keeper: 1, solo: 0 }, opts: { childName: 'Ana', familyId: one.familyId } });
  const det2 = rooms.get(two.code).locks[0];
  assert.strictEqual(det2.focus.id, 'two_clues');
  assert.strictEqual(det2.focus.stage, 'scaffold');
  assert.ok(two.kidViews.scout && rooms.get(two.code).attempts.some((a) => a.action === 'check_clue'), 'the kid used the check tool');
  const three = await playExpedition({ url, rooms, clock, profile: { logic: 1, keeper: 1, solo: 0 }, opts: { childName: 'Ana', familyId: one.familyId } });
  assert.strictEqual(rooms.get(three.code).locks[0].focus.stage, 'independent');
  const rep = await (await fetch(`${url}/api/report/week?family=${one.familyId}`)).json();
  assert.strictEqual(rep.metrics.blocks.next.stage, 'done');
});

test('cipher: the Scout predicts first, then roles swap in the last round', async () => {
  const out = await playExpedition({ url, rooms, clock, profile: { patterns: 0.3 }, opts: { childName: 'Bo' } });
  const att = rooms.get(out.code).attempts;
  assert.ok(att.some((a) => a.action === 'predict' && a.correct), 'prediction logged');
  assert.ok(att.some((a) => a.action === 'part_solved' && a.swapped && a.role === 'scout'), 'the kid solved the rule side of the swap round');
  assert.ok(att.some((a) => a.action === 'press' && a.swapped && a.role === 'keeper'), 'the grown-up pressed in the swap round');
  const s = require('../store').getSession(out.sessionId);
  assert.ok(s.solo.robot === null || ['done', 'skipped', 'step', 'thief'].includes(s.solo.robot.state));
});

test('a Cipher near-miss leads to a "watch" focus on the Cipher lock', async () => {
  const profile = { logic: 1, keeper: 1, patterns: 0, solo: 0 };
  let one, att;
  for (let k = 0; k < 4; k++) { // keep playing until the bot makes a one-feature near-miss
    one = await playExpedition({ url, rooms, clock, profile, opts: { childName: 'Ivy', familyId: one && one.familyId } });
    att = rooms.get(one.code).attempts;
    if (att.some((a) => (a.action === 'press' || a.action === 'predict') && a.off && a.off.length === 1)) break;
  }
  const two = await playExpedition({ url, rooms, clock, profile: { logic: 1, keeper: 1, patterns: 1, solo: 0 }, opts: { childName: 'Ivy', familyId: one.familyId } });
  const ciph = rooms.get(two.code).locks[1];
  assert.ok(ciph.focus && ciph.focus.id.startsWith('watch_') && ciph.focus.stage === 'scaffold');
  assert.strictEqual(rooms.get(two.code).locks[0].focus, null, 'only one lock changes');
});

test('the solo chest is logged as a home try', async () => {
  const out = await playExpedition({ url, rooms, clock, profile: { logic: 0, solo: 1, helped: 1, robot: 1 }, opts: { childName: 'Lu' } });
  const s = require('../store').getSession(out.sessionId);
  assert.ok(s.solo.solved && s.solo.tries === 2 && s.solo.helped, 'solo summary saved');
  assert.ok(s.solo.wrongs[0].breaks.length, 'the wrong solo pick names the clue it breaks');
  const kidSolo = JSON.stringify(out.kidViews.scout.solo);
  assert.ok(!kidSolo.includes('"thief"') && !kidSolo.includes('"solution"'));
  assert.ok(!out.hostViews.keeper.solo.lineup, 'the grown-up gets no solo puzzle in two-device mode');
  assert.ok(s.solo.robot.fixed && s.solo.robot.stepTries === 2, 'robot case fixed after one wrong step');
  assert.ok(!kidSolo.includes('wrongStep'), 'the robot answer stays on the server');
});

test('roles get different parts of the puzzle', async () => {
  const host = client(url);
  const kid = client(url);
  const c = await host.emit('create_room', { parentName: 'Dad', interest: 'space' });
  await kid.emit('join_room', { code: c.code, name: 'Aya', ageBand: '6-7' });
  await host.emit('submit', { kind: 'start', asRole: 'keeper' });
  await waitFor(() => host.views.keeper.story);
  await host.emit('submit', { kind: 'begin', asRole: 'keeper' });
  await waitFor(() => kid.views.scout && kid.views.scout.phase === 'lock');
  await waitFor(() => host.views.keeper.phase === 'lock');
  const ks = host.views.keeper.lock, ss = kid.views.scout.lock;
  assert.strictEqual(ks.type, 'detective');
  assert.ok(typeof ks.clues[0] === 'string', 'Keeper sees text conditions');
  assert.ok(typeof ss.clues[0] === 'object' && ss.clues[0].icon, 'Scout sees picture clues');
  assert.ok(!ss.checkTool && !ks.checkTool, 'no check tool without a focus');

  // A cross-out tied to a clue that fits the suspect is refused, with the reason.
  const puz = rooms.get(c.code).locks[0].puzzle;
  const P = require('../puzzles');
  let refused = null;
  for (let i = 0; i < puz.lineup.length && !refused; i++) {
    const k = puz.scoutClues.findIndex((cl) => P.explainClue(puz.lineup, i, cl).holds);
    if (k >= 0) refused = { i, k };
  }
  const r1 = await kid.emit('submit', { action: 'exclude', i: refused.i, clue: refused.k, asRole: 'scout' });
  assert.strictEqual(r1.linkValid, false);
  await waitFor(() => host.views.keeper.lock.coach);
  assert.ok(!kid.views.scout.lock.excluded.includes(refused.i));
  assert.ok(!kid.views.scout.lock.coach, 'coaching lines go to the grown-up only');

  // A third player doesn't fit in the MVP, and a wrong code is rejected.
  const extra = client(url);
  assert.strictEqual((await extra.emit('join_room', { code: c.code, name: 'Guest' })).ok, false);
  assert.strictEqual((await extra.emit('join_room', { code: '0000', name: 'X' })).ok, false);

  // No hint is given too early.
  await kid.emit('submit', { kind: 'hint', asRole: 'scout' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(kid.views.scout.lock.hints.length, 0);
  // After two mistakes — the first step of the ladder.
  const thief = rooms.get(c.code).locks[0].puzzle.solution.thief;
  const wrong = (thief + 1) % ss.lineup.length;
  await kid.emit('submit', { action: 'accuse', i: wrong, asRole: 'scout' });
  await kid.emit('submit', { action: 'accuse', i: wrong, asRole: 'scout' });
  const acc = rooms.get(c.code).attempts.filter((a) => a.action === 'accuse');
  assert.ok(acc[0].breaks.length >= 1, 'a wrong accusation logs the clue it breaks');
  await kid.emit('submit', { kind: 'hint', asRole: 'scout' });
  await waitFor(() => kid.views.scout.lock.hints.length === 1);
  for (const s of [host, kid, extra]) s.socket.close();
});
