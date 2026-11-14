// Game screen: renders whatever role the server sent. There are no solutions here — only this role's view.
import { createBlueprintStage } from './blueprint3d.js';

const socket = io({ transports: ['websocket', 'polling'] });
const app = document.getElementById('app');
const topRight = document.getElementById('topRight');
const params = new URLSearchParams(location.search);

// A player is bound to the browser tab: a refresh rejoins the game, a new tab is a new player.
const ls = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  code: params.get('room'),
  playerIds: [],
  views: {},          // role → latest role_view
  activeRole: null,   // whose screen is showing
  curtainFor: null,   // one-device mode: the curtain before the next player
  sel: null,          // selected suspect
  hintDeadline: {},   // role → local time when a hint unlocks
  stage: null, stageEl: null, stageLock: null,
  tool: 'add',
  doorShownFor: null,
  lastPhase: null,
};
window.__kq = S; // for debugging: only this role's data, no solutions

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const child = (t) => esc(String(t || '').replaceAll('{child}', currentView()?.childName || 'Explorer'));
const ROLE_ICON = { scout: '🔭', keeper: '📜' };
const ROLE_NAME = { scout: 'Scout', keeper: 'Keeper' };

// ---------------------------------------------------------------- read-aloud (Web Speech API)
function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Read-aloud isn’t supported in this browser.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replaceAll('{child}', currentView()?.childName || ''));
  u.lang = 'en-US';
  const v = speechSynthesis.getVoices().find((x) => x.lang === 'en-US');
  if (v) u.voice = v;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

let toastTimer;
function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast ' + kind), 2800);
}

// ---------------------------------------------------------------- connection
function storeIds(code, ids) {
  S.code = code;
  S.playerIds = ids;
  ls.set('kq_room_' + code, ids);
  if (params.get('create')) history.replaceState(null, '', '/game.html?room=' + code);
}

function boot() {
  if (params.get('create') && !S.code) {
    let opts = {};
    try { opts = JSON.parse(sessionStorage.getItem('kq_create') || '{}'); } catch {}
    socket.emit('create_room', opts, (res) => {
      if (!res.ok) return showError(res.error);
      try { sessionStorage.removeItem('kq_create'); } catch {}
      try { localStorage.setItem('kq_familyId', res.familyId); } catch {}
      storeIds(res.code, res.playerIds);
    });
    return;
  }
  if (!S.code) return (location.href = '/');
  const ids = ls.get('kq_room_' + S.code) || [];
  if (ids.length) {
    socket.emit('join_room', { code: S.code, playerIds: ids }, (res) => {
      if (res.ok) storeIds(res.code, res.playerIds);
      else showJoin(res.error);
    });
  } else showJoin();
}

socket.on('connect', () => {
  // First connect, and reconnect after a dropped network.
  if (S.playerIds.length) socket.emit('join_room', { code: S.code, playerIds: S.playerIds }, () => {});
  else if (!S.booted) { S.booted = true; boot(); }
});
socket.on('disconnect', () => toast('Connection lost. Reconnecting…', 'bad'));

socket.on('role_view', (v) => {
  S.views[v.me.role] = v;
  if (!S.activeRole) S.activeRole = v.me.role;
  if (v.mode === 'single' && v.phase === 'lock' && S.lastPhase !== 'lock' && S.views.scout && S.views.keeper) {
    S.activeRole = 'scout';
    S.curtainFor = 'scout';
  }
  if (v.mode !== 'single') S.activeRole = v.me.role;
  if (v.me.role === S.activeRole || v.mode !== 'single') {
    S.lastPhase = v.phase;
    render();
  }
});

socket.on('lock_update', (u) => {
  const v = currentView();
  if (!v || !v.lock || u.lockIdx !== v.lock.idx) return;
  const ev = u.event || {};
  const mine = ev.role === S.activeRole || v.mode === 'single';
  if (ev.kind === 'wrong' && mine) toast(ev.message, 'bad');
  if (ev.kind === 'key') toast('🗝️ ' + ev.message, 'good');
  if (ev.kind === 'round') toast('✨ ' + ev.message, 'good');
  if (ev.kind === 'next_round') toast(ev.message);
  if (u.ratingDelta && (u.ratingDelta.role === S.activeRole || v.mode === 'single')) {
    const d = u.ratingDelta.deltas.map((x) => `${x.skill} ${x.delta >= 0 ? '+' : ''}${x.delta} → Level ${x.level}`).join(' · ');
    setTimeout(() => toast('📈 ' + d, 'good'), 1400);
  }
  if (u.opened && S.doorShownFor !== u.lockIdx) {
    S.doorShownFor = u.lockIdx;
    showDoor(v.lock.idx + 1 < v.lock.total ? 'The Door Is Open!' : 'You Found the Chest!');
  }
});

function submit(payload) {
  socket.emit('submit', { ...payload, asRole: S.activeRole }, (res) => {
    if (res && res.error) toast(res.error, 'bad');
  });
}
const currentView = () => S.views[S.activeRole] || Object.values(S.views)[0];

function showError(msg) {
  app.innerHTML = `<div class="card center narrow" style="margin-top:40px"><div class="chest" aria-hidden="true">🌧️</div><h1 style="font-size:28px">Something went wrong</h1><p>${esc(msg || 'Please try again.')}</p><a class="btn" href="/">Back to Home</a></div>`;
}

// ---------------------------------------------------------------- the child joins
function showJoin(err) {
  let age = '8-10';
  app.innerHTML = `
  <form class="card narrow" style="margin-top:24px" id="jf" autocomplete="off" novalidate>
    <span class="pill scout">Room ${esc(S.code)}</span>
    <h1 style="font-size:32px;margin-top:14px">Hi, explorer! 👋</h1>
    <p class="muted">You’ll be the <b>Scout</b>: you get the clues and objects, and your grown-up gets the rules.</p>
    <label class="f" for="nm">What’s your name?</label>
    <input type="text" id="nm" name="nickname" maxlength="24" placeholder="A nickname, like Max…" spellcheck="false" aria-describedby="nm-err">
    <div id="nm-err" class="field-error" aria-live="polite">${err ? esc(err) : ''}</div>
    <span class="f-label" id="age-l">How old are you?</span>
    <div class="chips" id="age" role="group" aria-labelledby="age-l"><button type="button" class="chip" data-v="6-7" aria-pressed="false">6–7</button><button type="button" class="chip" data-v="8-10" aria-pressed="true">8–10</button></div>
    <div style="margin-top:24px"><button class="btn scout block">Join the Expedition</button></div>
  </form>`;
  document.getElementById('age').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    age = b.dataset.v;
    document.querySelectorAll('#age .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
  };
  document.getElementById('jf').onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById('nm');
    const name = input.value.trim();
    if (!name) { document.getElementById('nm-err').textContent = 'Type your name so your team knows who you are.'; input.focus(); return; }
    socket.emit('join_room', { code: S.code, name, ageBand: age }, (res) => {
      if (!res.ok) return showJoin(res.error);
      storeIds(res.code, res.playerIds);
    });
  };
}

// ---------------------------------------------------------------- render
function render() {
  const v = currentView();
  if (!v) return;
  renderTop(v);
  if (v.phase !== 'lock') destroyStage();
  if (v.phase === 'lobby') return renderLobby(v);
  if (v.phase === 'intro') return renderIntro(v);
  if (v.phase === 'lock') return renderLock(v);
  if (v.phase === 'chest') return renderChest(v);
}

function destroyStage() {
  if (S.stage) { S.stage.destroy(); S.stage = null; S.stageEl = null; S.stageLock = null; }
}

function renderTop(v) {
  const r = S.activeRole;
  topRight.innerHTML = r ? `<span class="role-badge ${r}">${ROLE_ICON[r]} ${esc(v.me.nickname)} · ${ROLE_NAME[r]}</span>` : '';
}

function renderLobby(v) {
  const host = v.me.isHost;
  const slots = [...v.players];
  while (slots.length < 2) slots.push(null);
  const playersHtml = slots.map((p) => p
    ? `<div class="player ${p.connected ? '' : 'off'}"><span class="dot" aria-hidden="true"></span>${ROLE_ICON[p.role]} ${esc(p.nickname)} <span class="muted small">${ROLE_NAME[p.role]}${p.connected ? '' : ' · offline'}</span></div>`
    : '<div class="player empty">Waiting for the Scout…</div>').join('');
  const ready = v.players.length >= 2;
  if (host) {
    app.innerHTML = `
    <div class="grid2">
      <div class="card center">
        ${v.mode === 'single' ? '<h1 style="font-size:28px">📱 One-Device Mode</h1><p class="muted">A curtain appears before each turn. Pass the device and no peeking!</p>' : `
        <div class="micro">Scan the QR or enter the code</div>
        <div class="big-code" aria-label="Room code ${esc(v.code.split('').join(' '))}">${esc(v.code)}</div>
        <div class="qr" role="img" aria-label="QR code to join this room">${v.qrSvg || ''}</div>
        <p class="small muted" style="word-break:break-all;margin-top:12px">${esc(v.joinUrl)}</p>`}
        <div class="players">${playersHtml}</div>
      </div>
      <div class="card">
        <h1 style="font-size:30px">Today’s Expedition</h1>
        <p>Three locks: <b>The Detective</b>, <b>The Temple Cipher</b>, and <b>The Blueprint Workshop</b>. About 10 minutes.</p>
        <div class="note">🗣️ The one rule: talking is allowed, showing your screen is not.</div>
        <p class="muted">You’re the <b>Keeper</b>: rules, notes, and blueprints. Your child is the <b>Scout</b>: clues, symbols, and the 3D model.</p>
        <button class="btn block" id="go" ${ready ? '' : 'disabled'}>${ready ? 'Start the Expedition' : 'Waiting for the Second Player…'}</button>
      </div>
    </div>`;
    document.getElementById('go').onclick = (e) => { e.target.disabled = true; e.target.textContent = 'Starting…'; submit({ kind: 'start' }); };
  } else {
    app.innerHTML = `
    <div class="narrow stack">
      ${roleCard(v.me.role)}
      <div class="card center"><div class="players">${playersHtml}</div><p class="muted" style="margin:16px 0 0">Waiting for the Keeper to start the expedition…</p></div>
    </div>`;
  }
}

function roleCard(role) {
  return role === 'scout'
    ? `<div class="role-card scout"><div class="em" aria-hidden="true">🔭</div><h2>You’re the Scout</h2><p>You see the clues, the glowing symbols, and the cube model. Tell the Keeper what you see and ask lots of questions!</p></div>`
    : `<div class="role-card keeper"><div class="em" aria-hidden="true">📜</div><h2>You’re the Keeper</h2><p>You hold the rules, the notes, and the blueprint. Ask the Scout questions and explain things so a kid can follow. Don’t solve it for them!</p></div>`;
}

function renderIntro(v) {
  if (!v.story) {
    app.innerHTML = `<div class="card center narrow" style="margin-top:40px"><div class="chest" aria-hidden="true">✍️</div><h1 style="font-size:28px">Writing today’s story…</h1><p class="muted">The AI is making up an adventure around your team’s interests.</p></div>`;
    return;
  }
  const host = v.me.isHost;
  app.innerHTML = `
  <div class="grid2">
    <div class="card">
      <span class="pill key">🗺️ ${esc(v.story.region)}</span>
      <div class="panel-title" style="margin-top:12px"><h1 style="font-size:34px;margin:0">${child(v.story.title)}</h1><button class="speak" id="say" aria-label="Read the story aloud">🔊</button></div>
      <p style="font-size:19px">${child(v.story.intro)}</p>
      <ol style="font-weight:600;color:var(--ink);line-height:1.9">${v.story.lockNames.map((n) => `<li>${child(n)}</li>`).join('')}</ol>
      <p class="small muted" style="margin:0">${v.story.source === 'gemini' ? '✨ Story written by Gemini for your team' : '📖 Story from the Kinquest library'}</p>
    </div>
    <div class="stack">
      ${roleCard(S.activeRole)}
      <div class="note">🗣️ Talking is allowed. Showing your screen is not.</div>
      ${host || v.mode === 'single' ? '<button class="btn block" id="go">Let’s Go! <span class="arrow" aria-hidden="true">→</span></button>' : '<p class="card center muted">Waiting for the Keeper to say “Let’s go!”</p>'}
    </div>
  </div>`;
  document.getElementById('say').onclick = () => speak(v.story.title + '. ' + v.story.intro);
  const go = document.getElementById('go');
  if (go) go.onclick = () => { go.disabled = true; submit({ kind: 'begin' }); };
}

// ---------------------------------------------------------------- locks
function keybar(v) {
  const k = v.lock.keys;
  const name = (role) => (v.players.find((p) => p.role === role) || {}).nickname || '';
  const cell = (role) => `
    <div class="k"><div class="keyhole ${k[role].lit ? 'lit' : ''}" aria-hidden="true">${k[role].lit ? '🗝️' : '🔒'}</div>
    <div class="who">${esc(name(role))}<small>${ROLE_NAME[role]}${k[role].progress ? ' · ' + k[role].progress : ''}${k[role].lit ? ' · key lit' : ''}</small></div></div>`;
  return `<div class="keybar" role="status" aria-label="Keys">${cell('scout')}<span class="door" aria-hidden="true">🚪</span>${cell('keeper')}</div>`;
}

function hintBlock(v) {
  const L = v.lock;
  const role = S.activeRole;
  const key = `${L.idx}:${role}:${L.round ?? 0}:${L.hintLevel}`;
  if (S.hintKey !== key) { S.hintKey = key; S.hintDeadline[role] = Date.now() + (L.hintReadyIn || 0); }
  const left = Math.max(0, Math.ceil((S.hintDeadline[role] - Date.now()) / 1000));
  const can = !L.solved && L.hintLevel < L.hintMax;
  return `<div class="hints">
    ${L.hints.map((h, i) => `<div class="hint-item">💡 Hint ${i + 1}: ${esc(h)}</div>`).join('')}
    ${can ? `<button class="btn ghost sm" id="hintBtn" ${left > 0 ? 'disabled' : ''} style="margin-top:12px">${hintLabel(left, L)}</button>` : ''}
  </div>`;
}
const hintLabel = (left, L) => (left > 0 ? `💡 Hint unlocks in ${left}s` : `💡 Get a Hint (${L.hintLevel + 1} of ${L.hintMax})`);
setInterval(() => {
  const b = document.getElementById('hintBtn');
  const v = currentView();
  if (!b || !v || !v.lock) return;
  const left = Math.max(0, Math.ceil((S.hintDeadline[S.activeRole] - Date.now()) / 1000));
  b.disabled = left > 0;
  b.textContent = hintLabel(left, v.lock);
}, 1000);

function lockHeader(v) {
  const L = v.lock;
  const steps = Array.from({ length: L.total }, (_, i) => `<span class="${v.locksDone && v.locksDone[i] ? 'done' : i === L.idx ? 'cur' : ''}"></span>`).join('');
  return `<div class="game-top"><div><div class="lock-steps" aria-label="Lock ${L.idx + 1} of ${L.total}">${steps}</div><h1>Lock ${L.idx + 1}: ${child(L.name)}</h1><span class="pill">${esc(L.skill)}</span></div>
  ${v.mode === 'single' ? `<button class="btn ghost sm" id="pass">🔄 Pass to the ${S.activeRole === 'scout' ? 'Keeper' : 'Scout'}</button>` : ''}</div>`;
}

function renderLock(v) {
  if (v.mode === 'single' && S.curtainFor) return renderCurtain(v);
  const L = v.lock;
  const role = S.activeRole;
  let body = '';
  if (L.type === 'detective') body = role === 'scout' ? detectiveScout(L) : detectiveKeeper(L);
  else if (L.type === 'cipher') body = role === 'scout' ? cipherScout(L) : cipherKeeper(L);
  else body = role === 'scout' ? blueprintScout(L) : blueprintKeeper(L);
  const done = L.solved ? `<div class="note ok center">🗝️ Your key is lit! Help your partner — the door waits for everyone.</div>` : '';
  const preserved = S.stageEl && S.stageLock === `${L.idx}` && L.type === 'blueprint' && role === 'scout' ? S.stageEl : null;
  app.innerHTML = lockHeader(v) + keybar(v) + done + body + hintBlock(v);
  bindLock(v);
  if (L.type === 'blueprint' && role === 'scout') mountStage(L, preserved);
  else destroyStage();
  const pass = document.getElementById('pass');
  if (pass) pass.onclick = () => { S.curtainFor = role === 'scout' ? 'keeper' : 'scout'; render(); };
  const hb = document.getElementById('hintBtn');
  if (hb) hb.onclick = () => submit({ kind: 'hint' });
}

function renderCurtain(v) {
  const role = S.curtainFor;
  const p = v.players.find((x) => x.role === role) || {};
  app.innerHTML = '';
  document.getElementById('overlay').innerHTML = `
    <div class="curtain ${role}" role="dialog" aria-modal="true" aria-labelledby="ct"><div>
      <div class="em" aria-hidden="true">${ROLE_ICON[role]}</div>
      <h1 id="ct">Pass the device to ${esc(p.nickname)}</h1>
      <p style="font-size:19px">${ROLE_NAME[role]}, it’s your turn. Everyone else: no peeking! 🙈</p>
      <button class="btn key" id="reveal">I’m ${esc(p.nickname)} — Show My Screen</button>
    </div></div>`;
  const reveal = document.getElementById('reveal');
  reveal.focus();
  reveal.onclick = () => {
    document.getElementById('overlay').innerHTML = '';
    S.activeRole = role;
    S.curtainFor = null;
    S.sel = null;
    destroyStage();
    render();
  };
}

// ---------- detective
const HAT = { cap: ['🧢', 'cap'], crown: ['👑', 'crown'], feather: ['🪶', 'feathered hat'], none: ['', 'no hat'] };
function suspectCard(s, L, i) {
  const out = L.excluded.includes(i);
  const [hatIcon, hatTxt] = HAT[s.hat];
  const desc = `${s.name}, number ${i + 1}: ${hatTxt}, wearing ${s.color}${s.umbrella ? ', with an umbrella' : ''}${out ? ', crossed out' : ''}`;
  return `<div class="suspect-wrap ${out ? 'out' : ''}">
    <button type="button" class="suspect" data-i="${i}" aria-pressed="${S.sel === i}" aria-label="${esc(desc)}">
      <span class="pos" aria-hidden="true">${i + 1}</span>
      <span class="face" aria-hidden="true">${hatIcon ? `<span class="hat">${hatIcon}</span>` : ''}${s.emoji}${s.umbrella ? '<span class="umb">☂️</span>' : ''}</span>
      <span class="name" aria-hidden="true" style="display:block">${esc(s.name)}</span>
      <span class="attrs" aria-hidden="true" style="display:block">${hatTxt}<br>${s.color}${s.umbrella ? ' · umbrella' : ''}</span>
      <span class="stripe c-${s.color}" aria-hidden="true" style="display:block"></span>
    </button>
    <button type="button" class="xbtn" data-x="${i}" aria-label="${out ? 'Bring back' : 'Cross out'} ${esc(s.name)}">${out ? '↺' : '✕'}</button>
  </div>`;
}

function accuseBar(L) {
  if (L.solved) return '';
  const s = S.sel != null ? L.lineup[S.sel] : null;
  return `<div class="accuse-bar"><div>${s ? `Suspect: <b>${s.emoji} ${esc(s.name)}</b>` : '<span class="muted">Tap a suspect to pick them. ✕ means “definitely not.”</span>'}</div>
  <button class="btn" id="accuse" ${s ? '' : 'disabled'}>🔎 That’s the Thief!</button></div>`;
}

function detectiveScout(L) {
  return `<div class="card"><div class="panel-title"><h2>🧩 Your Clues</h2><button class="speak" id="sayClues" aria-label="Read the clues aloud">🔊</button></div>
    <div class="clues">${L.clues.map((c) => `<div class="clue-pic"><div class="ic" aria-hidden="true">${c.color ? `<span class="col-${c.color}">${c.icon}</span>` : c.icon}</div><div class="tx">${esc(c.text)}</div></div>`).join('')}</div>
    <p class="muted">Tell the Keeper what you found. They have their own notes — ask what they say!</p>
    <h3>The lineup, left to right</h3><div class="lineup">${L.lineup.map((s, i) => suspectCard(s, L, i)).join('')}</div>${accuseBar(L)}</div>`;
}

function detectiveKeeper(L) {
  return `<div class="card"><h2 style="font-size:22px">📓 Witness Notes</h2>
    <ol class="notebook">${L.clues.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
    <p class="muted">Your notes alone won’t catch the thief. Ask the Scout what clues they found.</p>
    <h3>The lineup, left to right</h3><div class="lineup">${L.lineup.map((s, i) => suspectCard(s, L, i)).join('')}</div>${accuseBar(L)}</div>`;
}

function whyModal(L, i) {
  const ov = document.getElementById('overlay');
  ov.innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="why-t"><div class="card modal">
    <h2 id="why-t" style="font-size:26px">Why do you think so?</h2><p class="muted">${L.lineup[i].emoji} ${esc(L.lineup[i].name)}</p>
    <div class="stack">${L.why.map((o) => `<button class="btn ghost block" data-why="${o.id}">${esc(o.text)}</button>`).join('')}</div>
    <button class="btn sm ghost" id="whyCancel" style="margin-top:16px">Go Back</button></div></div>`;
  ov.querySelector('[data-why]').focus();
  ov.querySelectorAll('[data-why]').forEach((b) => (b.onclick = () => {
    ov.innerHTML = '';
    submit({ action: 'accuse', i, why: b.dataset.why });
    S.sel = null;
  }));
  document.getElementById('whyCancel').onclick = () => (ov.innerHTML = '');
}

// ---------- cipher
const GLYPH = { circle: '●', triangle: '▲', square: '■', star: '★', diamond: '◆' };
const symLabel = (s) => `${s.color} ${s.shape}, ${s.dots} dot${s.dots > 1 ? 's' : ''}`;
const symHtml = (s, i) => `<div class="sym" style="animation-delay:${i * 0.12}s" role="listitem" aria-label="${symLabel(s)}"><span class="g col-${s.color}" aria-hidden="true">${GLYPH[s.shape]}</span><span class="d" aria-hidden="true">${'•'.repeat(s.dots)}</span></div>`;
const roundDots = (L) => `<div class="round-dots" aria-label="Round ${L.round + 1} of ${L.rounds}">${Array.from({ length: L.rounds }, (_, i) => `<span class="${i < L.round || (i === L.round && L.roundSolved) ? 'done' : ''}"></span>`).join('')}</div>`;

function cipherScout(L) {
  return `<div class="card"><div class="panel-title"><h2>✨ Glowing Symbols · Round ${L.round + 1} of ${L.rounds}</h2>${roundDots(L)}</div>
    <div class="seq" role="list" aria-label="Symbol row">${L.seq.map(symHtml).join('')}<div class="sym q" role="listitem" aria-label="What comes next?">?</div></div>
    <p class="muted center">Describe each symbol to the Keeper: its shape, color, and how many dots. They know which button to press.</p>
    ${L.roundSolved ? '<div class="note ok center">✅ Correct! Waiting for the Keeper.</div>' : `<div class="panel6">${L.panel.map((s, i) => `<button data-press="${i}" aria-label="Button ${i + 1}: ${symLabel(s)}"><span class="n" aria-hidden="true">${i + 1}</span><span class="g col-${s.color}" aria-hidden="true">${GLYPH[s.shape]}</span><span class="d" aria-hidden="true">${'•'.repeat(s.dots)}</span></button>`).join('')}</div>`}</div>`;
}

function cipherKeeper(L) {
  return `<div class="card"><div class="panel-title"><h2>📖 The Temple Rule Book · Round ${L.round + 1} of ${L.rounds}</h2>${roundDots(L)}</div>
    <div class="rulebook"><b>${esc(L.rule.cond)}</b> ${esc(L.rule.then)}.<br><b>Otherwise,</b> ${esc(L.rule.else)}.</div>
    <p class="muted" style="margin-top:12px">You can’t see the symbols. Ask the Scout, decide which rule applies, and explain which symbol to press.</p>
    ${L.roundSolved ? '<div class="note ok center">✅ You picked the right rule! Help the Scout press the right symbol.</div>' : `
    <div class="branch-btns"><button class="btn keeper" data-branch="then">✔ The Condition Is True</button><button class="btn ghost" data-branch="else">✖ It’s False (“Otherwise”)</button></div>`}</div>`;
}

// ---------- blueprint
function blueprintScout(L) {
  return `<div class="card"><div class="panel-title"><h2>🧱 Your Model</h2>
    <div class="seg" role="group" aria-label="Tool"><button data-tool="add" aria-pressed="${S.tool === 'add'}">＋ Add</button><button data-tool="remove" aria-pressed="${S.tool === 'remove'}">－ Remove</button></div></div>
    <p class="muted">Drag to spin the model. Tap a cube or a tile to ${S.tool === 'add' ? 'stack a cube on top' : 'remove the top cube'}. Your model is off by 1–3 cubes. Ask the Keeper!</p>
    <div id="stageSlot"></div>
    ${L.solved ? '' : '<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn scout" id="check">✅ Check My Model</button></div>'}</div>`;
}

function mountStage(L, preserved) {
  const slot = document.getElementById('stageSlot');
  if (!slot) return;
  if (preserved) {
    slot.replaceWith(preserved);
  } else {
    destroyStage();
    const el = document.createElement('div');
    el.className = 'stage3d';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', '3D model built from cubes. Drag to rotate, tap to edit.');
    slot.replaceWith(el);
    S.stageEl = el;
    S.stageLock = `${L.idx}`;
    S.stage = createBlueprintStage(el, {
      onEdit: ({ x, z, delta }) => submit({ action: 'edit', x, z, delta }),
      onRotate: () => submit({ action: 'rotate' }),
    });
  }
  S.stage.setMode(S.tool);
  S.stage.update({ w: L.w, d: L.d, grid: L.grid, highlight: L.highlight || null });
}

function projSvg(values, label) {
  const cell = 18, h = Math.max(3, ...values);
  const W = values.length * cell + 8, Hh = h * cell + 8;
  const rects = values.map((v, i) => Array.from({ length: v }, (_, y) => `<rect x="${4 + i * cell}" y="${Hh - 4 - (y + 1) * cell}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="#9fd0ff" stroke="#fff" stroke-width="1"/>`).join('')).join('');
  return `<div class="center"><svg width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${label}: heights ${values.join(', ')}">${rects}<line x1="0" x2="${W}" y1="${Hh - 3}" y2="${Hh - 3}" stroke="#fff" stroke-width="2"/></svg><div>${label}</div></div>`;
}

function blueprintKeeper(L) {
  const marks = new Set((L.marks || []).map((c) => `${c.z},${c.x}`));
  const cells = L.plan.map((row, z) => row.map((h, x) => `<button class="cell ${h ? '' : 'empty'}" data-mz="${z}" data-mx="${x}" aria-pressed="${marks.has(`${z},${x}`)}" aria-label="Row ${z + 1} from the back, tower ${x + 1} from the left: ${h} cube${h === 1 ? '' : 's'}">${h || '·'}</button>`).join('')).join('');
  return `<div class="card"><h2 style="font-size:22px">📐 The Blueprint</h2>
    <div class="blueprint-paper">
      <h3>Top view: each number is how many cubes are in that tower</h3>
      <div class="center micro" style="color:rgba(255,255,255,.75)">Back</div>
      <div class="plan" style="grid-template-columns:repeat(${L.w}, 64px)">${cells}</div>
      <div class="front-label">▼ FRONT ▼</div>
      <div class="proj">${projSvg(L.front, 'Front view')}${projSvg(L.side.slice().reverse(), 'Right-side view')}</div>
    </div>
    <p class="muted" style="margin-top:14px">The Scout’s model is off by 1–3 cubes. Ask how many cubes each tower has, then <b>tap every tower that’s different</b>.</p>
    ${L.solved ? '' : '<div class="row" style="justify-content:flex-end"><button class="btn keeper" id="markDone">📍 Lock In My Marks</button></div>'}</div>`;
}

function bindLock(v) {
  const L = v.lock;
  app.querySelectorAll('.suspect').forEach((el) => (el.onclick = () => {
    const i = Number(el.dataset.i);
    S.sel = S.sel === i ? null : i;
    render();
    const again = app.querySelector(`.suspect[data-i="${i}"]`);
    if (again) again.focus();
  }));
  app.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => submit({ action: 'exclude', i: Number(b.dataset.x) })));
  const acc = document.getElementById('accuse');
  if (acc) acc.onclick = () => {
    if (S.sel == null) return;
    if (S.activeRole === 'scout' && L.why) whyModal(L, S.sel);
    else { submit({ action: 'accuse', i: S.sel }); S.sel = null; }
  };
  const sc = document.getElementById('sayClues');
  if (sc) sc.onclick = () => speak(L.clues.map((c) => c.text).join(' '));
  app.querySelectorAll('[data-press]').forEach((b) => (b.onclick = () => submit({ action: 'press', button: Number(b.dataset.press) })));
  app.querySelectorAll('[data-branch]').forEach((b) => (b.onclick = () => submit({ action: 'branch', branch: b.dataset.branch })));
  app.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { S.tool = b.dataset.tool; render(); }));
  const ck = document.getElementById('check');
  if (ck) ck.onclick = () => submit({ action: 'check' });
  app.querySelectorAll('[data-mz]').forEach((c) => (c.onclick = () => submit({ action: 'toggle_mark', z: Number(c.dataset.mz), x: Number(c.dataset.mx) })));
  const md = document.getElementById('markDone');
  if (md) md.onclick = () => submit({ action: 'mark' });
}

function showDoor(msg) {
  const ov = document.getElementById('overlay');
  ov.innerHTML = `<div class="overlay" role="status"><div class="door-big"><div class="frame"></div><div class="leaf" aria-hidden="true">🗝️</div><div class="door-msg">${esc(msg)}</div></div></div>`;
  setTimeout(() => { if (ov.querySelector('.door-big')) ov.innerHTML = ''; }, 3100);
}

// ---------------------------------------------------------------- the chest
function renderChest(v) {
  document.getElementById('overlay').innerHTML = '';
  const c = v.chest;
  const adult = v.me.kind === 'adult';
  const mins = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const levels = c.levels.map((p) => `<div class="card"><h3>${ROLE_ICON[p.role]} ${esc(p.nickname)}</h3>${Object.entries(p.skills).map(([k, s]) => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--hairline)"><span>${esc(k)}</span><b class="num" style="color:var(--ink)">${s.levelBefore !== s.level ? `Level ${s.levelBefore} → ${s.level}` : `Level ${s.level}`} <span class="small ${s.delta > 0 ? 'up' : s.delta < 0 ? 'down' : 'muted'}">${s.delta > 0 ? '▲' : s.delta < 0 ? '▼' : '·'}${s.delta ? Math.abs(s.delta) + ' pts' : ''}</span></b></div>`).join('')}</div>`).join('');
  app.innerHTML = `
  <div class="center"><div class="chest" aria-hidden="true">🎁</div><h1>Expedition Complete!</h1>
  <p class="muted">New piece of your family map: <b>${esc(c.mapPiece)}</b></p>
  <div class="stat-row" style="margin:20px 0">
    <div class="stat"><b>${mins(c.durationSec)}</b>team time</div>
    <div class="stat"><b>${mins(c.newRecord ? c.durationSec : c.recordSec)}</b>${c.recordSec == null ? '🏆 first family record' : c.newRecord ? '🏆 new record!' : 'family record'}</div>
    <div class="stat"><b>🔥 ${c.streak}</b>day${c.streak === 1 ? '' : 's'} in a row</div>
  </div></div>
  <div class="convo-card narrow">💬 Talk about it, screens off:<span class="q">${child(c.card)}</span><button class="speak" id="sayCard" aria-label="Read the question aloud">🔊</button>
  <p class="small muted" style="margin:10px 0 0;font-weight:500">You can close the app now and chat about it at dinner.</p></div>
  ${adult ? `<div class="card narrow center" style="margin-top:16px">
    <h3>How well did ${esc(v.childName || 'your child')} explain things today?</h3>
    <div class="smileys" role="group" aria-label="Rate explaining">${[1, 2, 3].map((n) => `<button data-rate="${n}" aria-pressed="${c.parentRating === n}" aria-label="${['Needed help', 'Pretty good', 'Great'][n - 1]}">${['😕', '🙂', '🤩'][n - 1]}</button>`).join('')}</div>
    <p class="small muted">One tap. It feeds the Communication skill in your report.</p>
    <div class="row" style="justify-content:center;margin-top:12px"><a class="btn" href="/report.html?session=${encodeURIComponent(c.sessionId)}">See Today’s Report</a><a class="btn ghost" href="/report.html?family=${encodeURIComponent(v.familyId)}">See This Week</a></div>
  </div>` : '<p class="center" style="font-size:22px;font-weight:600;color:var(--ink);margin-top:20px">See you tomorrow, explorer! 👋</p>'}
  <div class="grid2" style="margin-top:20px">${levels}</div>`;
  document.getElementById('sayCard').onclick = () => speak(c.card);
  app.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => { S.activeRole = 'keeper'; submit({ kind: 'rating', value: Number(b.dataset.rate) }); }));
  if (adult) { try { localStorage.setItem('kq_familyId', v.familyId); } catch {} }
}
