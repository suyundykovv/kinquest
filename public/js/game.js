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
  if ((ev.kind === 'wrong' || ev.kind === 'look_again') && mine) toast(ev.message, 'bad');
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

function submit(payload, then) {
  socket.emit('submit', { ...payload, asRole: S.activeRole }, (res) => {
    if (res && res.error) toast(res.error, 'bad');
    if (then) then(res || {});
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
  else if (L.type === 'cipher') body = L.view === 'row' ? cipherRow(L, role) : cipherRule(L, role);
  else body = role === 'scout' ? blueprintScout(L) : blueprintKeeper(L);
  const done = L.solved ? `<div class="note ok center">🗝️ Your key is lit! Help your partner — the door waits for everyone.</div>` : '';
  const preserved = S.stageEl && S.stageLock === `${L.idx}` && L.type === 'blueprint' && role === 'scout' ? S.stageEl : null;
  app.innerHTML = lockHeader(v) + keybar(v) + focusNote(L, role) + coachNote(L) + done + body + hintBlock(v);
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

// Today's focus (from the next-mission rules) and the grown-up's coaching line.
function focusNote(L, role) {
  if (!L.focus) return '';
  const tool = L.focus.stage === 'scaffold';
  return `<div class="focus-note"><span class="pill key">🎯 Today’s focus: ${esc(L.focus.title)}</span>
    <p>${role === 'scout' ? (tool ? 'Before you accuse, you’ll check your suspect against each clue, one at a time.' : 'No check tool today. Can you check every clue on your own?') : esc(L.focus.goal)}</p></div>`;
}
function coachNote(L) {
  if (!L.coach) return '';
  return `<div class="coach" role="status"><span class="micro">🗣️ Try asking</span><p>${child(L.coach.text)}</p></div>`;
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
    <div class="clues">${L.clues.map((c) => `<div class="clue-pic"><div class="ic" aria-hidden="true">${clueIcon(c)}</div><div class="tx">${esc(c.text)}</div></div>`).join('')}</div>
    <p class="muted">Tell the Keeper what you found. They have their own notes — ask what they say! When you cross someone out (✕), pick the clue that rules them out.</p>
    <h3>The lineup, left to right</h3><div class="lineup">${L.lineup.map((s, i) => suspectCard(s, L, i)).join('')}</div>${accuseBar(L)}</div>`;
}

function detectiveKeeper(L) {
  return `<div class="card"><h2 style="font-size:22px">📓 Witness Notes</h2>
    <ol class="notebook">${L.clues.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
    <p class="muted">Your notes alone won’t catch the thief. Ask the Scout what clues they found.</p>
    <h3>The lineup, left to right</h3><div class="lineup">${L.lineup.map((s, i) => suspectCard(s, L, i)).join('')}</div>${accuseBar(L)}</div>`;
}

const clueIcon = (c) => (c.color ? `<span class="col-${c.color}">${c.icon}</span>` : c.icon);
function closeModal() {
  document.getElementById('overlay').innerHTML = '';
  if (S.modalReturn) { const el = app.querySelector(S.modalReturn); if (el) el.focus(); S.modalReturn = null; }
}
function modal(html, label) {
  const ov = document.getElementById('overlay');
  ov.innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="${label}"><div class="card modal">${html}</div></div>`;
  ov.onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  const first = ov.querySelector('button');
  if (first) first.focus();
  return ov;
}

// The Scout crosses someone out and says which of their clues rules them out.
// One tap, and "just cross out" is always there: a reason is welcome, never a chore.
function clueChooser(L, i) {
  const s = L.lineup[i];
  S.modalReturn = `[data-x="${i}"]`;
  const ov = modal(`<h2 id="cc-t" style="font-size:24px">Which clue rules out ${esc(s.emoji)} ${esc(s.name)}?</h2>
    <div class="stack" style="margin-top:12px">${L.clues.map((c, k) => `<button class="btn ghost block clue-opt" data-clue="${k}"><span class="ic" aria-hidden="true">${clueIcon(c)}</span>${esc(c.text)}</button>`).join('')}
    <button class="btn ghost block" data-clue="keeper">📜 Something the Keeper told me</button></div>
    <button class="btn sm ghost" id="ccPlain" style="margin-top:14px">Just cross out</button>
    <button class="btn sm ghost" id="ccBack" style="margin-top:14px">Go Back</button>`, 'cc-t');
  ov.querySelectorAll('[data-clue]').forEach((b) => (b.onclick = () => {
    const clue = b.dataset.clue === 'keeper' ? 'keeper' : Number(b.dataset.clue);
    closeModal();
    submit({ action: 'exclude', i, clue });
  }));
  document.getElementById('ccPlain').onclick = () => { closeModal(); submit({ action: 'exclude', i }); };
  document.getElementById('ccBack').onclick = closeModal;
}

// Check tool (focus "Two Clues", first stage): suspect vs. each picture clue, then the Keeper's notes.
function checkTool(L, i, k = 0, msg = '') {
  const s = L.lineup[i];
  S.modalReturn = '#accuse';
  if (k < L.clues.length) {
    const c = L.clues[k];
    const ov = modal(`<span class="micro">Check ${k + 1} of ${L.clues.length + 1}</span>
      <h2 id="ct-t" style="font-size:24px;margin-top:6px">Does ${esc(s.emoji)} ${esc(s.name)} match this clue?</h2>
      <div class="clue-pic" style="margin:12px 0"><div class="ic" aria-hidden="true">${clueIcon(c)}</div><div class="tx">${esc(c.text)}</div></div>
      ${msg ? `<div class="note bad" role="alert">${esc(msg)}</div>` : ''}
      <div class="row"><button class="btn scout" data-ans="yes">✔ Yes, it matches</button><button class="btn ghost" data-ans="no">✖ No</button></div>
      <button class="btn sm ghost" id="ctBack" style="margin-top:14px">Go Back</button>`, 'ct-t');
    ov.querySelectorAll('[data-ans]').forEach((b) => (b.onclick = () => {
      const answer = b.dataset.ans === 'yes';
      ov.querySelectorAll('button').forEach((x) => (x.disabled = true));
      submit({ action: 'check_clue', i, k, answer }, (res) => {
        if (res.correct === false) return checkTool(L, i, k, res.text);
        if (!answer) {
          // A clue that doesn't match rules the suspect out.
          const ov2 = modal(`<h2 id="ct2-t" style="font-size:24px">Then ${esc(s.name)} can’t be the thief!</h2>
            <p>One clue that doesn’t match is enough to rule someone out.</p>
            <div class="row"><button class="btn scout" id="ctOut">✕ Cross Out ${esc(s.name)}</button><button class="btn ghost" id="ctBack2">Go Back</button></div>`, 'ct2-t');
          ov2.querySelector('#ctOut').onclick = () => { closeModal(); S.sel = null; if (!L.excluded.includes(i)) submit({ action: 'exclude', i, clue: k }); };
          ov2.querySelector('#ctBack2').onclick = closeModal;
          return;
        }
        checkTool(L, i, k + 1);
      });
    }));
    document.getElementById('ctBack').onclick = closeModal;
    return;
  }
  const ov = modal(`<span class="micro">Check ${k + 1} of ${L.clues.length + 1}</span>
    <h2 id="ct3-t" style="font-size:24px;margin-top:6px">${esc(s.name)} matches all your clues!</h2>
    <p>Now ask the Keeper: <b>“Does ${esc(s.name)} match every one of your notes?”</b></p>
    <div class="row"><button class="btn" id="ctYes">🔎 Yes, Every Note! Accuse</button><button class="btn ghost" id="ctNo">Not Every Note</button></div>`, 'ct3-t');
  ov.querySelector('#ctYes').onclick = () => { closeModal(); S.sel = null; submit({ action: 'accuse', i, checked: true }); };
  ov.querySelector('#ctNo').onclick = () => { closeModal(); toast(`Then it’s not ${s.name}. Who else is left?`); };
}

// ---------- cipher
const GLYPH = { circle: '●', triangle: '▲', square: '■', star: '★', diamond: '◆' };
const symLabel = (s) => `${s.color} ${s.shape}, ${s.dots} dot${s.dots > 1 ? 's' : ''}`;
const symHtml = (s, i) => `<div class="sym" style="animation-delay:${i * 0.12}s" role="listitem" aria-label="${symLabel(s)}"><span class="g col-${s.color}" aria-hidden="true">${GLYPH[s.shape]}</span><span class="d" aria-hidden="true">${'•'.repeat(s.dots)}</span></div>`;
const roundDots = (L) => `<div class="round-dots" aria-label="Round ${L.round + 1} of ${L.rounds}">${Array.from({ length: L.rounds }, (_, i) => `<span class="${i < L.round || (i === L.round && L.roundSolved) ? 'done' : ''}"></span>`).join('')}</div>`;

// Focus "Watch the Colors" (first stage): a label under each symbol for the feature in practice.
const ATTR_LABEL = { color: (x) => x.color, shape: (x) => x.shape, dots: (x) => `${x.dots} dot${x.dots > 1 ? 's' : ''}` };
function rowLabels(L) {
  return L.focus && L.focus.attr && L.focus.stage === 'scaffold' ? L.focus.attr : null;
}
const symTile = (x, i, attr) => `<div class="sym" style="animation-delay:${i * 0.12}s" role="listitem" aria-label="${symLabel(x)}"><span class="g col-${x.color}" aria-hidden="true">${GLYPH[x.shape]}</span><span class="d" aria-hidden="true">${'•'.repeat(x.dots)}</span>${attr ? `<span class="lab" aria-hidden="true">${ATTR_LABEL[attr](x)}</span>` : ''}</div>`;

// The row holder: the Scout in rounds 1–2, the Keeper in the role-swap round.
function cipherRow(L, role) {
  const attr = rowLabels(L);
  const intro = L.swapped
    ? '<div class="note">🔄 <b>Role swap!</b> This time the Scout holds the rule book. Describe each symbol to the Scout: its shape, color, and dots. They’ll tell you which rule applies.</div>'
    : '';
  let action;
  if (L.roundSolved) action = `<div class="note ok center">✅ Correct! Waiting for the ${L.swapped ? 'Scout' : 'Keeper'}.</div>`;
  else if (L.predict) action = predictCard(L);
  else action = `<p class="muted center">${L.swapped ? 'When the Scout tells you which symbol, press it.' : 'Describe each symbol to the Keeper. Their rule says which button to press.'}</p>
    <div class="panel6">${L.panel.map((x, i) => `<button data-press="${i}" aria-label="Button ${i + 1}: ${symLabel(x)}"><span class="n" aria-hidden="true">${i + 1}</span><span class="g col-${x.color}" aria-hidden="true">${GLYPH[x.shape]}</span><span class="d" aria-hidden="true">${'•'.repeat(x.dots)}</span></button>`).join('')}</div>`;
  return `<div class="card"><div class="panel-title"><h2>✨ Glowing Symbols · Round ${L.round + 1} of ${L.rounds}</h2>${roundDots(L)}</div>${intro}
    <div class="seq" role="list" aria-label="Symbol row">${L.seq.map((x, i) => symTile(x, i, attr)).join('')}<div class="sym q" role="listitem" aria-label="What comes next?">?</div></div>
    ${action}</div>`;
}

// The Scout's own step in round 1: what comes next, and what changes along the row.
function predictCard(L) {
  const sel = S.predSel;
  const ch = S.predChanges || [];
  return `<div class="predict"><h3>Your turn first: what comes next in the row?</h3>
    <div class="pred-opts" role="group" aria-label="Pick the next symbol">${L.predict.options.map((x, i) => `<button class="pred" data-pred="${i}" aria-pressed="${sel === i}" aria-label="${symLabel(x)}"><span class="g col-${x.color}" aria-hidden="true">${GLYPH[x.shape]}</span><span class="d" aria-hidden="true">${'•'.repeat(x.dots)}</span></button>`).join('')}</div>
    <h3 style="margin-top:16px">What changes from one symbol to the next?</h3>
    <div class="chips" role="group" aria-label="What changes">${['shape', 'color', 'dots'].map((a) => `<button type="button" class="chip" data-chg="${a}" aria-pressed="${ch.includes(a)}">${a === 'dots' ? 'The dots' : `The ${a}`}</button>`).join('')}</div>
    <button class="btn scout" id="predGo" style="margin-top:16px" ${sel == null ? 'disabled' : ''}>🔮 Lock In My Prediction</button></div>`;
}

// The rule holder: the Keeper in rounds 1–2, the Scout (with picture rules) in the role-swap round.
function cipherRule(L, role) {
  const kidRule = role === 'scout';
  const ic = L.rule.icons || {};
  const rule = kidRule
    ? `<div class="rulebook kid"><div class="rl"><span class="ri" aria-hidden="true">${esc(ic.cond)}</span><b>${esc(L.rule.cond)}</b></div>
       <div class="rl"><span class="ri" aria-hidden="true">✔ ${esc(ic.then)}</span>then ${esc(L.rule.then)}.</div>
       <div class="rl"><span class="ri" aria-hidden="true">✖ ${esc(ic.else)}</span>Otherwise, ${esc(L.rule.else)}.</div></div>`
    : `<div class="rulebook"><b>${esc(L.rule.cond)}</b> ${esc(L.rule.then)}.<br><b>Otherwise,</b> ${esc(L.rule.else)}.</div>`;
  const tip = kidRule
    ? '<div class="note">🔄 <b>Role swap!</b> You hold the rule book now. Ask the Keeper about the symbols, decide if the rule is true, then tell them which symbol to press.</div>'
    : `<p class="muted" style="margin-top:12px">You can’t see the symbols. Ask the Scout, decide which rule applies, and explain which symbol to press.${L.usesPrediction ? ' <b>The Scout predicts the next symbol first: your rule may need it.</b>' : ''}</p>`;
  return `<div class="card"><div class="panel-title"><h2>📖 The Temple Rule Book · Round ${L.round + 1} of ${L.rounds}</h2>${roundDots(L)}</div>
    ${kidRule ? tip + rule : rule + tip}
    ${L.roundSolved ? `<div class="note ok center">✅ You picked the right rule! Help the ${kidRule ? 'Keeper' : 'Scout'} press the right symbol.</div>` : `
    <div class="branch-btns"><button class="btn ${kidRule ? 'scout' : 'keeper'}" data-branch="then">✔ ${kidRule ? 'Yes, It’s True' : 'The Condition Is True'}</button><button class="btn ghost" data-branch="else">✖ ${kidRule ? 'No (Otherwise)' : 'It’s False (“Otherwise”)'}</button></div>`}</div>`;
}

// ---------- blueprint
function blueprintScout(L) {
  return `<div class="card"><div class="panel-title"><h2>🧱 Your Model</h2>
    <div class="seg" role="group" aria-label="Tool"><button data-tool="add" aria-pressed="${S.tool === 'add'}">＋ Add</button><button data-tool="remove" aria-pressed="${S.tool === 'remove'}">－ Remove</button></div></div>
    <p class="muted">Drag to spin the model. Tap a cube or a tile to ${S.tool === 'add' ? 'stack a cube on top' : 'remove the top cube'}. Your model is off by 1–3 cubes. Ask the Keeper!</p>
    ${L.viewQ ? viewQCard(L) : ''}
    <div id="stageSlot"></div>
    ${L.solved ? '' : '<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn scout" id="check">✅ Check My Model</button></div>'}</div>`;
}

// Before turning the model: guess its right-side view, then turn it to check.
function viewQCard(L) {
  return `<div class="predict"><h3>Before you turn it: which picture shows your model from the <b>right side</b>?</h3>
    <div class="view-opts" role="group" aria-label="Right-side view options">${L.viewQ.options.map((o, i) => `<button class="view-opt" data-view="${i}" aria-label="Option ${i + 1}: heights ${o.join(', ')}">${projSvg(o, `Option ${i + 1}`)}</button>`).join('')}</div>
    <button class="btn sm ghost" data-view="skip" style="margin-top:10px">Skip</button></div>`;
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
  app.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.x);
    if (S.activeRole === 'scout' && L.type === 'detective' && !L.excluded.includes(i)) clueChooser(L, i);
    else submit({ action: 'exclude', i });
  }));
  const acc = document.getElementById('accuse');
  if (acc) acc.onclick = () => {
    if (S.sel == null) return;
    if (S.activeRole === 'scout' && L.checkTool) checkTool(L, S.sel);
    else { submit({ action: 'accuse', i: S.sel }); S.sel = null; }
  };
  const sc = document.getElementById('sayClues');
  if (sc) sc.onclick = () => speak(L.clues.map((c) => c.text).join(' '));
  app.querySelectorAll('[data-pred]').forEach((b) => (b.onclick = () => { S.predSel = Number(b.dataset.pred); render(); }));
  app.querySelectorAll('[data-chg]').forEach((b) => (b.onclick = () => {
    const a = b.dataset.chg;
    const ch = S.predChanges || [];
    S.predChanges = ch.includes(a) ? ch.filter((x) => x !== a) : [...ch, a];
    render();
  }));
  const pg = document.getElementById('predGo');
  if (pg) pg.onclick = () => {
    pg.disabled = true;
    submit({ action: 'predict', choice: S.predSel, changes: S.predChanges || [] }, (res) => {
      if (res.correct) { S.predSel = null; S.predChanges = []; }
      if (res.changesNote) setTimeout(() => toast(res.changesNote, res.correct ? 'good' : 'bad'), res.correct ? 1600 : 2900);
    });
  };
  app.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => submit({ action: 'predict_view', choice: b.dataset.view === 'skip' ? 'skip' : Number(b.dataset.view) }, (res) => {
    if (res.correct === true) toast('🎯 Right! Now turn the model to the right side to check.', 'good');
    else if (res.correct === false) toast('Not quite. Turn the model to the right side and look.', 'bad');
  })));
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
  app.innerHTML = soloBlock(v) + `
  <div class="center"><div class="chest" aria-hidden="true">🎁</div><h1>Expedition Complete!</h1>
  <p class="muted">New piece of your family map: <b>${esc(c.mapPiece)}</b></p>
  <div class="stat-row" style="margin:20px 0">
    <div class="stat"><b>${mins(c.durationSec)}</b>team time</div>
    <div class="stat"><b>${mins(c.newRecord ? c.durationSec : c.recordSec)}</b>${c.recordSec == null ? '🏆 first family record' : c.newRecord ? '🏆 new record!' : 'family record'}</div>
    <div class="stat"><b>🔥 ${c.streak}</b>day${c.streak === 1 ? '' : 's'} in a row</div>
  </div></div>
  ${c.mission ? `<div class="card narrow mission-card" style="margin-bottom:16px"><span class="micro">🏡 Tonight’s off-screen mission</span><h3 style="margin:6px 0">${esc(c.mission.title)}</h3><p style="margin:0">${esc(c.mission.text)}</p>
    ${adult || v.mode === 'single' ? `<label class="check-row" style="justify-content:flex-start"><input type="checkbox" id="missionDone" ${c.mission.done ? 'checked' : ''}> We did it</label>` : ''}</div>` : ''}
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
  bindSolo(v);
  if (adult) { try { localStorage.setItem('kq_familyId', v.familyId); } catch {} }
}

// ---------------------------------------------------------------- the Scout's solo chest
// One small Detective with every clue on the kid's screen. Optional, no timer; the grown-up can mark help.
function soloBlock(v) {
  const so = v.solo;
  if (!so || so.state === 'skipped') return '';
  const name = esc(so.childName);
  const helped = v.me.kind === 'adult' || v.mode === 'single'
    ? `<label class="check-row"><input type="checkbox" id="soloHelped" ${so.helped ? 'checked' : ''}> I helped ${name} with the solo chest</label>` : '';
  if (!so.lineup) {
    // The grown-up's screen in two-device mode: no puzzle, just the nudge and the help mark.
    const status = so.state === 'solved' ? `🎉 ${name} opened the solo chest${so.tries > 1 ? ` on try ${so.tries}` : ' on the first try'}!`
      : so.state === 'playing' ? `${name} is working on the solo chest…` : `${name} can open a solo chest on their screen.`;
    return `<div class="card narrow solo-card" style="margin-bottom:20px"><span class="pill scout">🧰 Solo Chest</span><h2 style="font-size:22px;margin-top:10px">${status}</h2>
      <p class="muted">Let ${name} try it alone: it’s one small puzzle using today’s Detective skill. It’s a home try, not a test, so helping is fine. Just mark it.</p>${helped}</div>`;
  }
  if (so.state === 'offer') {
    return `<div class="card narrow solo-card center" style="margin-bottom:20px"><div class="chest" aria-hidden="true">🧰</div>
      <h2 style="font-size:26px">Your Own Chest, ${name}!</h2>
      <p>You opened the doors together. Now help the little explorer open their own chest: one small mystery, and every clue is on your screen.</p>
      <div class="row" style="justify-content:center"><button class="btn scout" id="soloStart">Try It Myself</button><button class="btn ghost" id="soloSkip">Not Today</button></div>${helped}</div>`;
  }
  if (so.state === 'solved') {
    return `<div class="card narrow solo-card center" style="margin-bottom:20px"><div class="chest" aria-hidden="true">🎉</div>
      <h2 style="font-size:26px">You opened your own chest!</h2><p class="muted">${so.tries > 1 ? `It took ${so.tries} tries, and you kept going.` : 'First try!'}</p>${helped}</div>${robotBlock(so)}`;
  }
  const sel = S.soloSel != null && so.lineup[S.soloSel] ? so.lineup[S.soloSel] : null;
  return `<div class="card solo-card" style="margin-bottom:20px"><div class="panel-title"><h2>🧰 Your Own Chest</h2><button class="speak" id="soloSay" aria-label="Read the clues aloud">🔊</button></div>
    <p class="muted">Who took the key to your chest? Check each animal against <b>every</b> clue.</p>
    <div class="clues">${so.clues.map((c) => `<div class="clue-pic"><div class="ic" aria-hidden="true">${clueIcon(c)}</div><div class="tx">${esc(c.text)}</div></div>`).join('')}</div>
    ${so.lastWrong ? `<div class="note bad" role="alert">${esc(so.lastWrong)}</div>` : ''}
    <div class="lineup">${so.lineup.map((s, i) => soloCard(s, i)).join('')}</div>
    <div class="accuse-bar"><div>${sel ? `Pick: <b>${sel.emoji} ${esc(sel.name)}</b>` : '<span class="muted">Tap an animal to pick them.</span>'}</div>
    <button class="btn scout" id="soloAccuse" ${sel ? '' : 'disabled'}>🔑 Open My Chest</button></div>${helped}</div>`;
}

// Bonus after the solo chest: Robo solved a case with one wrong step. Find it, then name the real thief.
function robotBlock(so) {
  const rb = so.robot;
  if (!rb || rb.state === 'skipped') return '';
  if (rb.state === 'offer') {
    return `<div class="card narrow solo-card center" style="margin-bottom:20px"><div class="chest" aria-hidden="true">🤖</div>
      <h2 style="font-size:24px">Bonus: Fix the Robot!</h2><p>Robo the Robot solved a case too, but one of its steps is wrong. Can you find it?</p>
      <div class="row" style="justify-content:center"><button class="btn scout" id="robotStart">Check Robo’s Work</button><button class="btn ghost" id="robotSkip">Not Today</button></div></div>`;
  }
  if (rb.state === 'done') {
    return `<div class="card narrow solo-card center" style="margin-bottom:20px"><div class="chest" aria-hidden="true">🤖🔧</div><h2 style="font-size:24px">You fixed Robo’s case!</h2><p class="muted">Robo says thank you. Beep boop!</p></div>`;
  }
  const clues = `<div class="clues">${rb.clues.map((c) => `<div class="clue-pic"><div class="ic" aria-hidden="true">${clueIcon(c)}</div><div class="tx">${esc(c.text)}</div></div>`).join('')}</div>`;
  const warn = rb.lastWrong ? `<div class="note bad" role="alert">${esc(rb.lastWrong)}</div>` : '';
  if (rb.state === 'step') {
    return `<div class="card solo-card" style="margin-bottom:20px"><h2>🤖 Robo’s Case</h2>${clues}
      <p class="muted">Robo’s steps. Which one is wrong? Tap it.</p>
      <div class="stack">${rb.steps.map((t, k) => `<button class="btn ghost block clue-opt" data-rstep="${k}">🤖 ${esc(t)}</button>`).join('')}
      <div class="note" style="margin:0">🤖 “Only ${esc(rb.accused)} is left, so ${esc(rb.accused)} is the thief!”</div></div>${warn}</div>`;
  }
  return `<div class="card solo-card" style="margin-bottom:20px"><h2>🤖 You Found Robo’s Mistake!</h2>${clues}
    <p>That animal does match the clue, so Robo shouldn’t have crossed them out. <b>Who is the real thief?</b></p>${warn}
    <div class="lineup">${rb.lineup.map((s, i) => soloCard(s, i, 'rthief')).join('')}</div></div>`;
}

function soloCard(s, i, attr = 'solo') {
  const [hatIcon, hatTxt] = HAT[s.hat];
  return `<div class="suspect-wrap"><button type="button" class="suspect" data-${attr}="${i}" aria-pressed="${attr === 'solo' && S.soloSel === i}" aria-label="${esc(`${s.name}: ${hatTxt}, wearing ${s.color}${s.umbrella ? ', with an umbrella' : ''}`)}">
    <span class="face" aria-hidden="true">${hatIcon ? `<span class="hat">${hatIcon}</span>` : ''}${s.emoji}${s.umbrella ? '<span class="umb">☂️</span>' : ''}</span>
    <span class="name" aria-hidden="true" style="display:block">${esc(s.name)}</span>
    <span class="attrs" aria-hidden="true" style="display:block">${hatTxt}<br>${s.color}${s.umbrella ? ' · umbrella' : ''}</span>
    <span class="stripe c-${s.color}" aria-hidden="true" style="display:block"></span></button></div>`;
}

function bindSolo(v) {
  const solo = (action, extra = {}) => submit({ kind: 'solo', action, ...extra });
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('soloStart', () => { S.activeRole = v.mode === 'single' ? 'scout' : S.activeRole; solo('start'); });
  on('soloSkip', () => solo('skip'));
  on('soloAccuse', () => { if (S.soloSel != null) solo('accuse', { i: S.soloSel }); S.soloSel = null; });
  on('soloSay', () => speak(v.solo.clues.map((c) => c.text).join(' ')));
  app.querySelectorAll('[data-solo]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.solo);
    S.soloSel = S.soloSel === i ? null : i;
    render();
    const again = app.querySelector(`[data-solo="${i}"]`);
    if (again) again.focus();
  }));
  on('robotStart', () => solo('robot_start'));
  on('robotSkip', () => solo('robot_skip'));
  app.querySelectorAll('[data-rstep]').forEach((b) => (b.onclick = () => solo('robot_step', { k: Number(b.dataset.rstep) })));
  app.querySelectorAll('[data-rthief]').forEach((b) => (b.onclick = () => solo('robot_thief', { i: Number(b.dataset.rthief) })));
  const md = document.getElementById('missionDone');
  if (md) md.onchange = () => { S.activeRole = v.mode === 'single' ? 'keeper' : S.activeRole; submit({ kind: 'offscreen', value: md.checked }); };
  const h = document.getElementById('soloHelped');
  if (h) h.onchange = () => { S.activeRole = v.mode === 'single' ? 'keeper' : S.activeRole; solo('helped', { value: h.checked }); };
}
