// Экран игры: рисует ту роль, которую прислал сервер. Решений здесь нет — только view своей роли.
import { createBlueprintStage } from './blueprint3d.js';

const socket = io({ transports: ['websocket', 'polling'] });
const app = document.getElementById('app');
const topRight = document.getElementById('topRight');
const params = new URLSearchParams(location.search);

// Игрок привязан к вкладке: обновление страницы возвращает в игру, а новая вкладка — это новый игрок.
const ls = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  code: params.get('room'),
  playerIds: [],
  views: {},          // role → последний role_view
  activeRole: null,   // чей экран сейчас показан
  curtainFor: null,   // режим одного устройства: шторка перед сменой игрока
  sel: null,          // выбранный подозреваемый
  hintDeadline: {},   // role → локальное время, когда станет доступна подсказка
  stage: null, stageEl: null, stageLock: null,
  tool: 'add',
  doorShownFor: null,
  lastPhase: null,
};
window.__kq = S; // для отладки: только данные своей роли, решений здесь нет

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const child = (t) => esc(String(t || '').replaceAll('{child}', currentView()?.childName || 'юного исследователя'));
const ROLE_ICON = { scout: '🔭', keeper: '📜' };

// ---------------------------------------------------------------- озвучка (Web Speech API)
function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Озвучка не поддерживается в этом браузере');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replaceAll('{child}', currentView()?.childName || ''));
  u.lang = 'ru-RU';
  const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith('ru'));
  if (v) u.voice = v;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}
window.__speak = speak;

let toastTimer;
function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast ' + kind), 2600);
}

// ---------------------------------------------------------------- соединение
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
  // Первое подключение и переподключение после обрыва сети.
  if (S.playerIds.length) socket.emit('join_room', { code: S.code, playerIds: S.playerIds }, () => {});
  else if (!S.booted) { S.booted = true; boot(); }
});
socket.on('disconnect', () => toast('Связь потерялась, переподключаемся…', 'bad'));

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
  if (ev.kind === 'wrong' && mine) toast('✋ ' + ev.message, 'bad');
  if (ev.kind === 'key') toast('🗝️ ' + ev.message, 'good');
  if (ev.kind === 'round') toast('✨ ' + ev.message, 'good');
  if (ev.kind === 'next_round') toast('🔆 ' + ev.message);
  if (u.ratingDelta && (u.ratingDelta.role === S.activeRole || v.mode === 'single')) {
    const d = u.ratingDelta.deltas.map((x) => `${x.skill}: ${x.delta >= 0 ? '+' : ''}${x.delta} → ур. ${x.level}`).join(' · ');
    setTimeout(() => toast('📈 ' + d, 'good'), 1400);
  }
  if (u.opened && S.doorShownFor !== u.lockIdx) {
    S.doorShownFor = u.lockIdx;
    showDoor(v.lock.idx + 1 < v.lock.total ? 'Дверь открыта!' : 'Сундук найден!');
  }
});

function submit(payload) {
  socket.emit('submit', { ...payload, asRole: S.activeRole }, (res) => {
    if (res && res.error) toast(res.error, 'bad');
  });
}
const currentView = () => S.views[S.activeRole] || Object.values(S.views)[0];

function showError(msg) {
  app.innerHTML = `<div class="card center narrow" style="margin:40px auto"><div class="chest">🌧️</div><h2>Упс</h2><p>${esc(msg || 'Что-то пошло не так')}</p><a class="btn" href="/">На главную</a></div>`;
}

// ---------------------------------------------------------------- вход ребёнка
function showJoin(err) {
  let age = '8-10';
  app.innerHTML = `
  <form class="card narrow" style="margin:20px auto" id="jf" autocomplete="off">
    <span class="pill teal">Комната ${esc(S.code)}</span>
    <h2 style="margin-top:10px">Привет, исследователь! 👋</h2>
    <p class="muted">Ты будешь <b>Разведчиком</b>: у тебя улики и предметы, а у взрослого — правила.</p>
    ${err ? `<p class="rule-note">${esc(err)}</p>` : ''}
    <label class="f" for="nm">Как тебя зовут?</label>
    <input type="text" id="nm" maxlength="24" placeholder="Ник, например Макс" required>
    <label class="f">Сколько тебе лет?</label>
    <div class="chips" id="age"><button type="button" class="chip" data-v="6-7">6–7</button><button type="button" class="chip on" data-v="8-10">8–10</button></div>
    <div style="margin-top:18px"><button class="btn teal block">Войти в экспедицию</button></div>
  </form>`;
  document.getElementById('age').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    age = b.dataset.v;
    document.querySelectorAll('#age .chip').forEach((c) => c.classList.toggle('on', c === b));
  };
  document.getElementById('jf').onsubmit = (e) => {
    e.preventDefault();
    const name = document.getElementById('nm').value.trim();
    socket.emit('join_room', { code: S.code, name, ageBand: age }, (res) => {
      if (!res.ok) return showJoin(res.error);
      storeIds(res.code, res.playerIds);
    });
  };
}

// ---------------------------------------------------------------- рендер
function render() {
  const v = currentView();
  if (!v) return;
  renderTop(v);
  if (v.phase !== 'lock' && S.stage) { S.stage.destroy(); S.stage = null; S.stageEl = null; S.stageLock = null; }
  if (v.phase === 'lobby') return renderLobby(v);
  if (v.phase === 'intro') return renderIntro(v);
  if (v.phase === 'lock') return renderLock(v);
  if (v.phase === 'chest') return renderChest(v);
}

function renderTop(v) {
  const r = S.activeRole;
  topRight.innerHTML = r ? `<span class="role-badge ${r}">${ROLE_ICON[r]} ${esc(v.me.nickname)} · ${esc(v.me.roleLabel)}</span>` : '';
}

function renderLobby(v) {
  const host = v.me.isHost;
  const slots = [...v.players];
  while (slots.length < 2) slots.push(null);
  const playersHtml = slots.map((p) => p
    ? `<div class="player ${p.connected ? '' : 'off'}"><span class="dot"></span>${ROLE_ICON[p.role]} ${esc(p.nickname)} <span class="muted small">${esc(p.roleLabel)}</span></div>`
    : '<div class="player empty">⏳ ждём Разведчика…</div>').join('');
  const ready = v.players.length >= 2;
  if (host) {
    app.innerHTML = `
    <div class="grid2">
      <div class="card center">
        ${v.mode === 'single' ? '<h2>📱 Игра на одном устройстве</h2><p class="muted">Перед каждым ходом появится шторка — передавайте телефон и не подглядывайте.</p>' : `
        <p class="muted" style="margin:0">Отсканируйте QR или введите код на kinquest</p>
        <div class="big-code">${esc(v.code)}</div>
        <div class="qr">${v.qrSvg || ''}</div>
        <p class="small muted" style="word-break:break-all">${esc(v.joinUrl)}</p>`}
        <div class="players">${playersHtml}</div>
      </div>
      <div class="card">
        <h2>Экспедиция дня</h2>
        <p>Три замка: <b>Детектив</b>, <b>Шифр храма</b> и <b>Чертёжная мастерская</b>. Примерно 10 минут.</p>
        <div class="rule-note">🗣️ Главное правило: говорить можно, показывать свой экран — нельзя.</div>
        <p class="muted">Вы — <b>Хранитель</b>: у вас правила, схемы и условия. Ребёнок — <b>Разведчик</b>: у него улики, символы и 3D-фигура.</p>
        <button class="btn block" id="go" ${ready ? '' : 'disabled'}>${ready ? '🚀 Начать экспедицию' : 'Ждём второго игрока…'}</button>
      </div>
    </div>`;
    document.getElementById('go').onclick = (e) => { e.target.disabled = true; submit({ kind: 'start' }); };
  } else {
    app.innerHTML = `
    <div class="narrow" style="margin:0 auto">
      ${roleCard(v.me.role)}
      <div class="card center" style="margin-top:16px">
        <div class="players">${playersHtml}</div>
        <p class="muted">Ждём, пока Хранитель нажмёт «Начать экспедицию»…</p>
      </div>
    </div>`;
  }
}

function roleCard(role) {
  return role === 'scout'
    ? `<div class="role-card scout"><div class="em">🔭</div><h2>Ты — Разведчик</h2><p>Ты видишь улики, светящиеся знаки и фигуру из кубиков. Рассказывай Хранителю, что видишь, и спрашивай!</p></div>`
    : `<div class="role-card keeper"><div class="em">📜</div><h2>Вы — Хранитель</h2><p>У вас правила, условия и чертёж. Задавайте Разведчику вопросы и объясняйте так, чтобы было понятно ребёнку. Не решайте за него!</p></div>`;
}

function renderIntro(v) {
  if (!v.story) {
    app.innerHTML = `<div class="card center narrow" style="margin:40px auto"><div class="chest">✍️</div><h2>Сочиняем сюжет дня…</h2><p class="muted">ИИ придумывает приключение под интересы команды</p></div>`;
    return;
  }
  const host = v.me.isHost;
  app.innerHTML = `
  <div class="grid2">
    <div class="card">
      <span class="pill violet">🗺️ ${esc(v.story.region)}</span>
      <div class="panel-title" style="margin-top:10px"><h1 style="font-size:32px">${child(v.story.title)}</h1><button class="speak" id="say">🔊</button></div>
      <p style="font-size:20px;line-height:1.5">${child(v.story.intro)}</p>
      <ol style="font-weight:800;line-height:1.8">${v.story.lockNames.map((n) => `<li>${child(n)}</li>`).join('')}</ol>
      <p class="small muted">${v.story.source === 'claude' ? '✨ Сюжет написал Claude специально для вашей команды' : '📖 Сюжет из библиотеки Kinquest'}</p>
    </div>
    <div>
      ${roleCard(S.activeRole)}
      <div class="rule-note" style="margin-top:16px">🗣️ Говорить можно, показывать экран — нельзя.</div>
      ${host || v.mode === 'single' ? '<button class="btn block" id="go">🧭 В путь!</button>' : '<p class="card center muted">Ждём, пока Хранитель скажет «В путь!»</p>'}
    </div>
  </div>`;
  document.getElementById('say').onclick = () => speak(v.story.title + '. ' + v.story.intro);
  const go = document.getElementById('go');
  if (go) go.onclick = () => { go.disabled = true; submit({ kind: 'begin' }); };
}

// ---------------------------------------------------------------- замки
function keybar(v) {
  const k = v.lock.keys;
  const name = (role) => (v.players.find((p) => p.role === role) || {}).nickname || '';
  const cell = (role) => `
    <div class="k"><div class="keyhole ${k[role].lit ? 'lit' : ''}">${k[role].lit ? '🗝️' : '🔒'}</div>
    <div class="who">${esc(name(role))}<small>${role === 'scout' ? 'Разведчик' : 'Хранитель'}${k[role].progress ? ' · ' + k[role].progress : ''}</small></div></div>`;
  return `<div class="keybar">${cell('scout')}<span style="font-size:26px">🚪</span>${cell('keeper')}</div>`;
}

function hintBlock(v) {
  const L = v.lock;
  const role = S.activeRole;
  const key = `${L.idx}:${role}:${L.round ?? 0}:${L.hintLevel}`;
  if (S.hintKey !== key) { S.hintKey = key; S.hintDeadline[role] = Date.now() + (L.hintReadyIn || 0); }
  const left = Math.max(0, Math.ceil((S.hintDeadline[role] - Date.now()) / 1000));
  const can = !L.solved && L.hintLevel < L.hintMax;
  return `<div class="hints">
    ${L.hints.map((h, i) => `<div class="hint-item">💡 Подсказка ${i + 1}: ${esc(h)}</div>`).join('')}
    ${can ? `<button class="btn ghost small" id="hintBtn" ${left > 0 ? 'disabled' : ''} style="margin-top:10px">💡 ${left > 0 ? `Подсказка через ${left} с` : `Подсказка (${L.hintLevel + 1} из ${L.hintMax})`}</button>` : ''}
  </div>`;
}
setInterval(() => {
  const b = document.getElementById('hintBtn');
  const v = currentView();
  if (!b || !v || !v.lock) return;
  const left = Math.max(0, Math.ceil((S.hintDeadline[S.activeRole] - Date.now()) / 1000));
  b.disabled = left > 0;
  b.textContent = left > 0 ? `💡 Подсказка через ${left} с` : `💡 Подсказка (${v.lock.hintLevel + 1} из ${v.lock.hintMax})`;
}, 1000);

function lockHeader(v) {
  const L = v.lock;
  const steps = Array.from({ length: L.total }, (_, i) => `<span class="${v.locksDone && v.locksDone[i] ? 'done' : i === L.idx ? 'cur' : ''}"></span>`).join('');
  return `<div class="game-top"><div><div class="lock-steps">${steps}</div><h2 style="margin:8px 0 0">Замок ${L.idx + 1}. ${child(L.name)}</h2><span class="pill">${esc(L.skill)}</span></div>
  ${v.mode === 'single' ? `<button class="btn ghost small" id="pass">🔄 Передать ход: ${S.activeRole === 'scout' ? 'Хранителю' : 'Разведчику'}</button>` : ''}</div>`;
}

function renderLock(v) {
  if (v.mode === 'single' && S.curtainFor) return renderCurtain(v);
  const L = v.lock;
  const role = S.activeRole;
  let body = '';
  if (L.type === 'detective') body = role === 'scout' ? detectiveScout(L) : detectiveKeeper(L);
  else if (L.type === 'cipher') body = role === 'scout' ? cipherScout(L) : cipherKeeper(L);
  else body = role === 'scout' ? blueprintScout(L) : blueprintKeeper(L);
  const done = L.solved ? `<div class="rule-note center">🗝️ Твой ключ горит! Помоги партнёру — дверь ждёт всех.</div>` : '';
  const preserved = S.stageEl && S.stageLock === `${L.idx}` && L.type === 'blueprint' && role === 'scout' ? S.stageEl : null;
  app.innerHTML = lockHeader(v) + keybar(v) + done + body + hintBlock(v);
  bindLock(v);
  if (L.type === 'blueprint' && role === 'scout') mountStage(L, preserved);
  else if (S.stage) { S.stage.destroy(); S.stage = null; S.stageEl = null; S.stageLock = null; }
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
    <div class="curtain ${role}"><div>
      <div class="em">${role === 'scout' ? '🔭' : '📜'}</div>
      <h1>Передай устройство: ${esc(p.nickname)}</h1>
      <p style="font-size:20px">${role === 'scout' ? 'Разведчик' : 'Хранитель'}, твой ход. Остальные — не подглядывать! 🙈</p>
      <button class="btn gold" id="reveal">Я ${esc(p.nickname)}, показать мой экран</button>
    </div></div>`;
  document.getElementById('reveal').onclick = () => {
    document.getElementById('overlay').innerHTML = '';
    S.activeRole = role;
    S.curtainFor = null;
    S.sel = null;
    if (S.stage) { S.stage.destroy(); S.stage = null; S.stageEl = null; S.stageLock = null; }
    render();
  };
}

// ---------- детектив
function suspectCard(s, L, i) {
  const out = L.excluded.includes(i);
  const hat = { cap: '🧢', crown: '👑', feather: '🪶', none: '' }[s.hat];
  const hatTxt = { cap: 'кепка', crown: 'корона', feather: 'шляпа с пером', none: 'без шляпы' }[s.hat];
  const colTxt = { red: 'красный', blue: 'синий', green: 'зелёный', yellow: 'жёлтый' }[s.color];
  return `<div class="suspect ${out ? 'out' : ''} ${S.sel === i ? 'sel' : ''}" data-i="${i}">
    <span class="pos">${i + 1}</span>
    <div class="face">${hat ? `<span class="hat">${hat}</span>` : ''}${s.emoji}${s.umbrella ? '<span class="umb">☂️</span>' : ''}</div>
    <div class="name">${esc(s.name)}</div>
    <div class="attrs">${hatTxt}<br>${colTxt}${s.umbrella ? ' · с зонтом' : ''}</div>
    <div class="stripe c-${s.color}" title="${colTxt}"></div>
    <button class="x" data-x="${i}" title="Точно не он">✕</button>
  </div>`;
}

function accuseBar(L) {
  if (L.solved) return '';
  const s = S.sel != null ? L.lineup[S.sel] : null;
  return `<div class="accuse-bar"><div>${s ? `Подозреваемый: <b>${s.emoji} ${esc(s.name)}</b>` : '<span class="muted">Нажми на подозреваемого, чтобы выбрать. ✕ — «точно не он»</span>'}</div>
  <button class="btn" id="accuse" ${s ? '' : 'disabled'}>🔎 Это вор!</button></div>`;
}

function detectiveScout(L) {
  return `<div class="card"><div class="panel-title"><h3>🧩 Твои улики</h3><button class="speak" id="sayClues">🔊</button></div>
    <div class="clues">${L.clues.map((c) => `<div class="clue-pic"><div class="ic">${c.color ? `<span class="col-${c.color}">${c.icon}</span>` : c.icon}</div><div class="tx">${esc(c.text)}</div></div>`).join('')}</div>
    <p class="muted small">Расскажи Хранителю, что нашёл. У него свои записки — спроси, что в них!</p>
    <h3>Жители в ряд (слева направо)</h3><div class="lineup">${L.lineup.map((s, i) => suspectCard(s, L, i)).join('')}</div>${accuseBar(L)}</div>`;
}

function detectiveKeeper(L) {
  return `<div class="card"><h3>📓 Записки свидетелей</h3>
    <ol class="notebook">${L.clues.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
    <p class="muted small">Ваших записок не хватит, чтобы найти вора. Спросите Разведчика, какие улики нашёл он.</p>
    <h3>Жители в ряд (слева направо)</h3><div class="lineup">${L.lineup.map((s, i) => suspectCard(s, L, i)).join('')}</div>${accuseBar(L)}</div>`;
}

function whyModal(L, i) {
  document.getElementById('overlay').innerHTML = `<div class="door-overlay"><div class="card narrow" style="width:min(520px,92vw)">
    <h2>Почему ты так думаешь?</h2><p class="muted">${L.lineup[i].emoji} ${esc(L.lineup[i].name)}</p>
    <div style="display:grid;gap:10px">${L.why.map((o) => `<button class="btn ghost block" data-why="${o.id}">${esc(o.text)}</button>`).join('')}</div></div></div>`;
  document.querySelectorAll('[data-why]').forEach((b) => (b.onclick = () => {
    document.getElementById('overlay').innerHTML = '';
    submit({ action: 'accuse', i, why: b.dataset.why });
    S.sel = null;
  }));
}

// ---------- шифр
const GLYPH = { circle: '●', triangle: '▲', square: '■', star: '★', diamond: '◆' };
const symHtml = (s, i) => `<div class="sym" style="animation-delay:${i * 0.12}s"><span class="g col-${s.color}">${GLYPH[s.shape]}</span><span class="d">${'•'.repeat(s.dots)}</span></div>`;
const roundDots = (L) => `<div class="round-dots">${Array.from({ length: L.rounds }, (_, i) => `<span class="${i < L.round || (i === L.round && L.roundSolved) ? 'done' : ''}"></span>`).join('')}</div>`;

function cipherScout(L) {
  return `<div class="card"><div class="panel-title"><h3>✨ Светящиеся знаки · раунд ${L.round + 1} из ${L.rounds}</h3>${roundDots(L)}</div>
    <div class="seq">${L.seq.map(symHtml).join('')}<div class="sym q">?</div></div>
    <p class="muted small center">Опиши Хранителю знаки: форму, цвет и сколько точек. Он знает, какую кнопку нажать.</p>
    ${L.roundSolved ? '<div class="rule-note center">✅ Верно! Ждём Хранителя.</div>' : `<div class="panel6">${L.panel.map((s, i) => `<button data-press="${i}"><span class="n">${i + 1}</span><span class="g col-${s.color}">${GLYPH[s.shape]}</span><span class="d">${'•'.repeat(s.dots)}</span></button>`).join('')}</div>`}</div>`;
}

function cipherKeeper(L) {
  return `<div class="card"><div class="panel-title"><h3>📖 Книга правил храма · раунд ${L.round + 1} из ${L.rounds}</h3>${roundDots(L)}</div>
    <div class="rulebook"><b>${esc(L.rule.cond)}</b> ${esc(L.rule.then)}.<br><b>Иначе</b> ${esc(L.rule.else)}.</div>
    <p class="muted small">Вы не видите знаки. Расспросите Разведчика, решите, какое правило работает, и объясните, какой знак нажать.</p>
    ${L.roundSolved ? '<div class="rule-note center">✅ Правило выбрано верно! Помогите Разведчику нажать нужный знак.</div>' : `
    <div class="branch-btns"><button class="btn teal" data-branch="then">✔️ Условие выполняется</button><button class="btn ghost" data-branch="else">✖️ Не выполняется («иначе»)</button></div>`}</div>`;
}

// ---------- чертёж
function blueprintScout(L) {
  return `<div class="card"><div class="panel-title"><h3>🧱 Твоя деталь</h3>
    <div class="tool-toggle"><button data-tool="add" class="${S.tool === 'add' ? 'on' : ''}">＋ Добавить</button><button data-tool="remove" class="${S.tool === 'remove' ? 'on' : ''}">－ Убрать</button></div></div>
    <p class="muted small">Крути фигуру пальцем. Нажми на кубик или клетку, чтобы ${S.tool === 'add' ? 'поставить кубик сверху' : 'убрать верхний кубик'}. Деталь отличается от чертежа на 1–3 кубика — спроси Хранителя!</p>
    <div id="stageSlot"></div>
    ${L.solved ? '' : '<div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn teal" id="check">✅ Проверить деталь</button></div>'}</div>`;
}

function mountStage(L, preserved) {
  const slot = document.getElementById('stageSlot');
  if (!slot) return;
  if (preserved) {
    slot.replaceWith(preserved);
  } else {
    if (S.stage) S.stage.destroy();
    const el = document.createElement('div');
    el.className = 'stage3d';
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
  return `<div class="center"><svg width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}">${rects}<line x1="0" x2="${W}" y1="${Hh - 3}" y2="${Hh - 3}" stroke="#fff" stroke-width="2"/></svg><div class="small">${label}</div></div>`;
}

function blueprintKeeper(L) {
  const marks = new Set((L.marks || []).map((c) => `${c.z},${c.x}`));
  const cells = L.plan.map((row, z) => row.map((h, x) => `<div class="cell ${h ? '' : 'empty'} ${marks.has(`${z},${x}`) ? 'mark' : ''}" data-mz="${z}" data-mx="${x}">${h || '·'}</div>`).join('')).join('');
  return `<div class="card"><h3>📐 Чертёж детали</h3>
    <div class="blueprint-paper">
      <h4>Вид сверху: цифра — сколько кубиков в башне</h4>
      <div class="center small" style="opacity:.8">ЗАД</div>
      <div class="plan" style="grid-template-columns:repeat(${L.w}, 64px)">${cells}</div>
      <div class="front-label">▼ ПЕРЕД ▼</div>
      <div class="proj">${projSvg(L.front, 'Вид спереди')}${projSvg(L.side.slice().reverse(), 'Вид справа')}</div>
    </div>
    <p class="muted small" style="margin-top:12px">Деталь Разведчика отличается на 1–3 кубика. Спрашивайте, сколько кубиков в каждой башне, и <b>отметьте касанием башни, где есть отличия</b>.</p>
    ${L.solved ? '' : '<div class="row" style="justify-content:flex-end"><button class="btn" id="markDone">📍 Отметки готовы</button></div>'}</div>`;
}

function bindLock(v) {
  const L = v.lock;
  app.querySelectorAll('.suspect').forEach((el) => (el.onclick = (e) => {
    const x = e.target.closest('[data-x]');
    if (x) { submit({ action: 'exclude', i: Number(x.dataset.x) }); return; }
    const i = Number(el.dataset.i);
    S.sel = S.sel === i ? null : i;
    render();
  }));
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
  ov.innerHTML = `<div class="door-overlay"><div class="door-big"><div class="frame"></div><div class="leaf">🗝️</div><div class="door-msg">${esc(msg)}</div></div></div>`;
  setTimeout(() => { if (ov.querySelector('.door-overlay')) ov.innerHTML = ''; }, 3100);
}

// ---------------------------------------------------------------- сундук
function renderChest(v) {
  document.getElementById('overlay').innerHTML = '';
  const c = v.chest;
  const adult = v.me.kind === 'adult';
  const mins = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const levels = c.levels.map((p) => `<div class="card"><h3>${p.role === 'scout' ? '🔭' : '📜'} ${esc(p.nickname)}</h3>${Object.entries(p.skills).map(([k, s]) => `<div class="row" style="justify-content:space-between"><span>${esc(k)}</span><b>${s.levelBefore !== s.level ? `ур. ${s.levelBefore} → ${s.level}` : `ур. ${s.level}`} <span class="small ${s.delta > 0 ? 'up' : s.delta < 0 ? 'down' : 'muted'}">${s.delta > 0 ? '▲' : s.delta < 0 ? '▼' : '·'}${s.delta ? Math.abs(s.delta) + ' очк.' : ''}</span></b></div>`).join('')}</div>`).join('');
  app.innerHTML = `
  <div class="center"><div class="chest">🎁</div><h1>Экспедиция пройдена!</h1>
  <p class="muted">Новая деталь семейной карты: <b>${esc(c.mapPiece)}</b></p>
  <div class="stat-row" style="margin:16px 0">
    <div class="stat"><b>${mins(c.durationSec)}</b>время команды</div>
    <div class="stat"><b>${mins(c.newRecord ? c.durationSec : c.recordSec)}</b>${c.recordSec == null ? '🏆 первый рекорд семьи' : c.newRecord ? '🏆 новый рекорд!' : 'рекорд семьи'}</div>
    <div class="stat"><b>🔥 ${c.streak}</b>дней подряд</div>
  </div></div>
  <div class="convo-card narrow" style="margin:20px auto">💬 Вопрос для разговора без экрана:<br><span style="color:var(--coral-d)">${child(c.card)}</span> <button class="speak" id="sayCard">🔊</button>
  <p class="small muted" style="margin:10px 0 0;font-weight:600">Экран можно закрыть — поговорите об этом за ужином.</p></div>
  ${adult ? `<div class="card narrow center" style="margin:16px auto">
    <h3>Как сегодня объяснял(а) ${esc(v.childName || 'ребёнок')}?</h3>
    <div class="smileys">${[1, 2, 3].map((n) => `<button data-rate="${n}" class="${c.parentRating === n ? 'on' : ''}">${['😕', '🙂', '🤩'][n - 1]}</button>`).join('')}</div>
    <p class="small muted">Одно нажатие — это данные для навыка «Коммуникация» в отчёте.</p>
    <div class="row" style="justify-content:center;margin-top:10px"><a class="btn teal" href="/report.html?session=${encodeURIComponent(c.sessionId)}">📊 Отчёт по этой игре</a><a class="btn ghost" href="/report.html?family=${encodeURIComponent(v.familyId)}">Отчёт за неделю</a></div>
  </div>` : '<p class="center" style="font-size:20px;font-weight:800">До завтра, исследователь! 👋</p>'}
  <div class="grid2" style="margin-top:16px">${levels}</div>`;
  document.getElementById('sayCard').onclick = () => speak(c.card);
  app.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => { S.activeRole = 'keeper'; submit({ kind: 'rating', value: Number(b.dataset.rate) }); }));
  if (adult) { try { localStorage.setItem('kq_familyId', v.familyId); } catch {} }
}
