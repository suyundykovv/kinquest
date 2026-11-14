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
  assert.ok(ss.why && !ks.why, '"Why?" is asked only of the child');

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
  await kid.emit('submit', { action: 'accuse', i: wrong, why: 'guess', asRole: 'scout' });
  await kid.emit('submit', { action: 'accuse', i: wrong, why: 'guess', asRole: 'scout' });
  await kid.emit('submit', { kind: 'hint', asRole: 'scout' });
  await waitFor(() => kid.views.scout.lock.hints.length === 1);
  for (const s of [host, kid, extra]) s.socket.close();
});
