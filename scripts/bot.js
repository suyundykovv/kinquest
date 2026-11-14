// Бот-игроки для сквозного теста и записи демо-сессий. Подключаются к настоящему серверу по Socket.IO
// и проходят экспедицию. Чтобы «знать» верные ответы, бот заглядывает в память сервера (rooms) —
// так можно только в тесте/симуляции, браузер решений не получает.
'use strict';
const { io: connect } = require('socket.io-client');

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

// profile: вероятности успеха ребёнка по навыкам (0..1) и привычки (rotations, guessy).
async function playExpedition({ url, rooms, clock, rnd = Math.random, profile = {}, opts = {} }) {
  const p = { logic: 0.8, patterns: 0.8, spatial: 0.8, rotations: 3, guessy: 0.1, why: 0.8, keeper: 0.92, rating: 3, ...profile };
  let virtual = clock ? clock.now() : Date.now();
  const think = (lo, hi) => { if (clock) { virtual += Math.round((lo + rnd() * (hi - lo)) * 1000); } };
  if (clock) clock.now = () => virtual;

  const host = client(url);
  const kid = client(url);
  const created = await host.emit('create_room', { parentName: opts.parentName || 'Мама', interest: opts.interest || 'ocean', ageBand: opts.ageBand || '8-10', familyId: opts.familyId || '', familyName: opts.familyName });
  if (!created.ok) throw new Error(created.error);
  const joined = await kid.emit('join_room', { code: created.code, name: opts.childName || 'Макс', ageBand: opts.ageBand || '8-10' });
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
      think(10, 30);
      await H({ action: 'accuse', i: rnd() < p.keeper ? thief : others[0] });
      if (!lock.keys.keeper) { think(10, 20); await H({ action: 'accuse', i: thief }); }
      // Разведчик вычёркивает невиновных, иногда ошибочно — настоящего вора.
      for (const i of others.slice(0, 2 + Math.floor(rnd() * 2))) { think(4, 12); await K({ action: 'exclude', i }); }
      if (rnd() > p.logic + 0.1) { think(3, 6); await K({ action: 'exclude', i: thief }); think(2, 4); await K({ action: 'exclude', i: thief }); }
      // Ребёнок: иногда отвечает наугад быстро, иногда ошибается после раздумий.
      let attempts = 0;
      while (!lock.keys.scout && attempts < 4) {
        const right = rnd() < p.logic || attempts >= 2;
        const fast = rnd() < p.guessy;
        think(fast ? 1 : 8, fast ? 4 : 35);
        if (attempts >= 2 && rnd() < 0.6) {
          room.locks[idx].part.scout.lastProgress -= 91000; // ребёнок долго думал — подсказка доступна
          await K({ kind: 'hint' });
        }
        const why = rnd() < p.why ? 'all_clues' : rnd() < 0.5 ? 'guess' : 'looks';
        await K({ action: 'accuse', i: right ? thief : others[Math.floor(rnd() * others.length)], why });
        attempts++;
      }
    }

    if (lock.type === 'cipher') {
      for (let r = 0; r < puz.rounds.length; r++) {
        await waitFor(() => lock.round === r);
        const rd = puz.rounds[r];
        let tries = 0;
        while (!lock.roundKeys.scout && lock.round === r) {
          const right = rnd() < p.patterns || tries >= 2;
          const fast = rnd() < p.guessy;
          think(fast ? 1 : 6, fast ? 4 : 25);
          const wrongBtn = (rd.solution.button + 1 + Math.floor(rnd() * 5)) % 6;
          await K({ action: 'press', button: right ? rd.solution.button : wrongBtn });
          tries++;
          if (tries > 5) break;
        }
        // Хранитель выбирает ветку правила (иногда сначала ошибается).
        think(5, 15);
        const wrongBranch = rd.solution.branch === 'then' ? 'else' : 'then';
        if (rnd() > p.keeper) { await H({ action: 'branch', branch: wrongBranch }); think(5, 10); }
        await H({ action: 'branch', branch: rd.solution.branch });
      }
    }

    if (lock.type === 'blueprint') {
      const rot = Math.max(0, Math.round(p.rotations + (rnd() - 0.5) * 2));
      for (let i = 0; i < rot; i++) { think(2, 6); await K({ action: 'rotate' }); }
      // Хранитель отмечает отличия (иногда сначала неполно).
      const diffs = puz.solution.diffCells;
      for (const c of diffs) { think(5, 15); await H({ action: 'toggle_mark', z: c.z, x: c.x }); }
      if (rnd() > p.keeper && diffs.length > 1) { await H({ action: 'toggle_mark', z: diffs[0].z, x: diffs[0].x }); await H({ action: 'mark' }); await H({ action: 'toggle_mark', z: diffs[0].z, x: diffs[0].x }); }
      await H({ action: 'mark' });
      // Разведчик правит фигуру. Слабый пространственный навык → пропускает спрятанное отличие и проверяет раньше времени.
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
  if (p.rating) await H({ kind: 'rating', value: p.rating });
  const sessionId = room.chest.sessionId;
  host.socket.close();
  kid.socket.close();
  return { sessionId, code: created.code, familyId: created.familyId, hostViews: host.views, kidViews: kid.views };
}

module.exports = { playExpedition, client, waitFor };
