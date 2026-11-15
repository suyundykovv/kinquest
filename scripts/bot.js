// Bot players for the end-to-end test and demo session recording. They connect to the real server over Socket.IO
// and play through an expedition. To "know" the right answers, the bot peeks into server memory (rooms) —
// this is only possible in tests/simulation; the browser never gets solutions.
'use strict';
const { io: connect } = require('socket.io-client');
const P = require('../puzzles');

function client(url) {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
  const st = { socket: s, views: {} };
  s.on('role_view', (v) => (st.views[v.me.role] = v));
  st.emit = (ev, data) => new Promise((res) => s.emit(ev, data, res));
  return st;
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// profile: child's success probabilities by skill (0..1) and habits (rotations, guessy, solo chest, adult help).
async function playExpedition({ url, rooms, clock, rnd = Math.random, profile = {}, opts = {} }) {
  const p = { logic: 0.8, patterns: 0.8, spatial: 0.8, rotations: 3, guessy: 0.1, keeper: 0.92, rating: 3, solo: 0.9, helped: 0.25, robot: 0.7, offscreen: 0.5, ...profile };
  let virtual = clock ? clock.now() : Date.now();
  const think = (lo, hi) => { if (clock) { virtual += Math.round((lo + rnd() * (hi - lo)) * 1000); } };
  if (clock) clock.now = () => virtual;

  const host = client(url);
  const kid = client(url);
  const created = await host.emit('create_room', { parentName: opts.parentName || 'Mom', interest: opts.interest || 'ocean', ageBand: opts.ageBand || '8-10', familyId: opts.familyId || '', familyName: opts.familyName, demoFamily: opts.demoFamily });
  if (!created.ok) throw new Error(created.error);
  const joined = await kid.emit('join_room', { code: created.code, name: opts.childName || 'Max', ageBand: opts.ageBand || '8-10' });
  if (!joined.ok) throw new Error(joined.error);
  const room = rooms.get(created.code);
  const H = (msg) => host.emit('submit', { ...msg, asRole: 'keeper' });
  const K = (msg) => kid.emit('submit', { ...msg, asRole: 'scout' });

  await waitFor(() => host.views.keeper && host.views.keeper.players.length === 2);
  await H({ kind: 'start' });
  await waitFor(() => host.views.keeper.phase === 'intro' && host.views.keeper.story);
  think(15, 25);
  await H({ kind: 'begin' });

  for (let idx = 0; idx < 3; idx++) {
    await waitFor(() => kid.views.scout && kid.views.scout.phase === 'lock' && kid.views.scout.lock.idx === idx && host.views.keeper.lock && host.views.keeper.lock.idx === idx);
    const lock = room.locks[idx];
    const puz = lock.puzzle;

    if (lock.type === 'detective') {
      const thief = puz.solution.thief;
      const others = puz.lineup.map((_, i) => i).filter((i) => i !== thief);
      // A believable wrong pick: someone who matches one clue but breaks another.
      const mixups = others.filter((i) => { const c = P.checkSuspect(puz, i); return c.some((x) => x.holds) && c.some((x) => !x.holds); });
      const wrongPick = () => (mixups.length ? mixups[Math.floor(rnd() * mixups.length)] : others[Math.floor(rnd() * others.length)]);
      think(10, 30);
      await H({ action: 'accuse', i: rnd() < p.keeper ? thief : others[0] });
      if (!lock.keys.keeper) { think(10, 20); await H({ action: 'accuse', i: thief }); }
      // The Scout crosses out the innocent and ties each cross-out to a clue; sometimes picks a clue that doesn't apply.
      for (const i of others.slice(0, 2 + Math.floor(rnd() * 2))) {
        think(4, 12);
        const checks = P.checkSuspect(puz, i).filter((c) => c.who === 'scout');
        const rules = checks.find((c) => !c.holds);
        const fits = checks.find((c) => c.holds);
        if (fits && rnd() > p.logic + 0.15) { await K({ action: 'exclude', i, clue: fits.k }); think(3, 8); }
        await K({ action: 'exclude', i, clue: rules ? rules.k : 'keeper' });
      }
      if (rnd() > p.logic + 0.1) { think(3, 6); await K({ action: 'exclude', i: thief }); think(2, 4); await K({ action: 'exclude', i: thief }); }
      const tool = lock.focus && lock.focus.stage === 'scaffold';
      let attempts = 0;
      while (!lock.keys.scout && attempts < 4) {
        const right = rnd() < p.logic + (tool ? 0.15 : 0) || attempts >= 2;
        const i = right ? thief : wrongPick();
        think(8, 35);
        if (attempts >= 2 && rnd() < 0.6) {
          room.locks[idx].part.scout.lastProgress -= 91000; // the child thought for a long time — hint available
          await K({ kind: 'hint' });
        }
        if (tool) {
          // The check tool: the kid answers each clue for their pick; a "no" means cross them out instead.
          let ruledOut = false;
          for (const c of P.checkSuspect(puz, i).filter((x) => x.who === 'scout')) {
            think(3, 8);
            if (rnd() < 0.15) await K({ action: 'check_clue', i, k: c.k, answer: !c.holds });
            await K({ action: 'check_clue', i, k: c.k, answer: c.holds });
            if (!c.holds) { if (!lock.excluded.scout.includes(i)) await K({ action: 'exclude', i, clue: c.k }); ruledOut = true; break; }
          }
          if (ruledOut) { attempts++; continue; }
        }
        await K({ action: 'accuse', i, checked: tool || undefined });
        attempts++;
      }
    }

    if (lock.type === 'cipher') {
      for (let r = 0; r < puz.rounds.length; r++) {
        await waitFor(() => lock.round === r);
        const rd = puz.rounds[r];
        // Round 1: the Scout predicts first (sometimes off by one feature) and names what changes.
        if (rd.predict) {
          let pt = 0;
          while (!lock.predicted && pt < 4) {
            think(6, 20);
            const right = rnd() < p.patterns || pt >= 1;
            const wrongK = rd.predict.options.findIndex((_, k) => k !== rd.solution.predict);
            const changes = rnd() < p.patterns ? rd.solution.changes : rd.solution.changes.slice(0, 1).concat(rd.solution.changes.length ? [] : ['color']);
            await K({ action: 'predict', choice: right ? rd.solution.predict : wrongK, changes });
            pt++;
          }
        }
        if (rd.swapped) {
          // Role swap: the kid reads the rule (picks the branch), the grown-up presses.
          think(8, 25);
          const wrongBranch = rd.solution.branch === 'then' ? 'else' : 'then';
          if (rnd() > p.patterns) { await K({ action: 'branch', branch: wrongBranch }); think(5, 12); }
          await K({ action: 'branch', branch: rd.solution.branch });
          think(4, 10);
          await H({ action: 'press', button: rd.solution.button });
          continue;
        }
        let tries = 0;
        while (!lock.roundKeys.scout && lock.round === r) {
          const right = rnd() < p.patterns || tries >= 2;
          const fast = rnd() < p.guessy;
          think(fast ? 1 : 6, fast ? 4 : 25);
          // A believable miss: a decoy that differs only in the feature this kid tends to skip.
          const want = rd.panel[rd.solution.button];
          const near = rd.panel.findIndex((b, i) => i !== rd.solution.button && ['shape', 'color', 'dots'].filter((a) => b[a] !== want[a]).length === 1);
          const wrongBtn = near >= 0 && rnd() < 0.7 ? near : (rd.solution.button + 1 + Math.floor(rnd() * 5)) % 6;
          await K({ action: 'press', button: right ? rd.solution.button : wrongBtn });
          tries++;
          if (tries > 5) break;
        }
        // The Keeper picks a rule branch (sometimes errs first).
        think(5, 15);
        const wrongBranch = rd.solution.branch === 'then' ? 'else' : 'then';
        if (rnd() > p.keeper) { await H({ action: 'branch', branch: wrongBranch }); think(5, 10); }
        await H({ action: 'branch', branch: rd.solution.branch });
      }
    }

    if (lock.type === 'blueprint') {
      // Before turning: guess the right-side view (weaker spatial skill → more misses).
      if (lock.viewQ && rnd() < 0.9) { think(5, 15); await K({ action: 'predict_view', choice: rnd() < p.spatial + 0.2 ? lock.viewQ.answer : (lock.viewQ.answer + 1) % lock.viewQ.options.length }); }
      const rot = Math.max(0, Math.round(p.rotations + (rnd() - 0.5) * 2));
      for (let i = 0; i < rot; i++) { think(2, 6); await K({ action: 'rotate' }); }
      // The Keeper marks differences (sometimes incomplete at first).
      const diffs = puz.solution.diffCells;
      for (const c of diffs) { think(5, 15); await H({ action: 'toggle_mark', z: c.z, x: c.x }); }
      if (rnd() > p.keeper && diffs.length > 1) { await H({ action: 'toggle_mark', z: diffs[0].z, x: diffs[0].x }); await H({ action: 'mark' }); await H({ action: 'toggle_mark', z: diffs[0].z, x: diffs[0].x }); }
      await H({ action: 'mark' });
      // The Scout fixes the figure. Weak spatial skill → misses the hidden difference and checks too early.
      const fixes = diffs.map((c) => ({ ...c, delta: Math.sign(puz.target[c.z][c.x] - puz.start[c.z][c.x]) }));
      const miss = rnd() > p.spatial;
      for (const f of miss ? fixes.slice(1) : fixes) { think(5, 15); await K({ action: 'edit', z: f.z, x: f.x, delta: f.delta }); }
      if (miss) {
        think(2, 4);
        await K({ action: 'check' });
        if (rnd() < 0.5) { room.locks[idx].part.scout.lastProgress -= 91000; await K({ kind: 'hint' }); }
        think(10, 25);
        await K({ action: 'rotate' });
        await K({ action: 'edit', z: fixes[0].z, x: fixes[0].x, delta: fixes[0].delta });
      }
      think(3, 8);
      await K({ action: 'check' });
    }

    await waitFor(() => lock.opened, 5000);
    think(3, 4);
  }

  await waitFor(() => host.views.keeper.phase === 'chest', 10000);
  // The solo chest: the kid tries one small Detective alone; the grown-up sometimes marks help.
  if (rnd() < p.solo) {
    const solo = room.solo;
    const S = (msg) => kid.emit('submit', { kind: 'solo', ...msg, asRole: 'scout' });
    await S({ action: 'start' });
    const thief = solo.puzzle.solution.thief;
    const wrongs = solo.puzzle.lineup.map((_, i) => i).filter((i) => i !== thief);
    if (rnd() > p.logic) { think(10, 30); await S({ action: 'accuse', i: wrongs[Math.floor(rnd() * wrongs.length)] }); }
    think(10, 40);
    await S({ action: 'accuse', i: thief });
    if (rnd() < p.helped) await host.emit('submit', { kind: 'solo', action: 'helped', value: true, asRole: 'keeper' });
    // Bonus: fix Robo's case.
    if (rnd() < p.robot) {
      const rb = solo.robot.puzzle;
      await S({ action: 'robot_start' });
      think(10, 30);
      if (rnd() > p.logic) await S({ action: 'robot_step', k: (rb.solution.wrongStep + 1) % rb.steps.length });
      await S({ action: 'robot_step', k: rb.solution.wrongStep });
      think(5, 15);
      await S({ action: 'robot_thief', i: rb.solution.thief });
    } else await S({ action: 'robot_skip' });
  } else await H({ kind: 'solo', action: 'skip' });
  if (rnd() < p.offscreen) await H({ kind: 'offscreen', value: true });
  if (p.rating) await H({ kind: 'rating', value: p.rating });
  const sessionId = room.chest.sessionId;
  host.socket.close();
  kid.socket.close();
  return { sessionId, code: created.code, familyId: created.familyId, hostViews: host.views, kidViews: kid.views };
}

module.exports = { playExpedition, client, waitFor };
