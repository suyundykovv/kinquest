// Отчёт для родителя: цифры считает сервер по журналу попыток, текст — Claude (или шаблон).
(function () {
  const app = document.getElementById('app');
  const q = new URLSearchParams(location.search);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SKILL_ORDER = ['spatial', 'patterns', 'logic', 'critical', 'communication'];
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  const url = q.get('session') ? `/api/report/session/${encodeURIComponent(q.get('session'))}` : `/api/report/week?family=${encodeURIComponent(q.get('family') || 'demo')}`;

  fetch(url).then((r) => r.json().then((j) => ({ ok: r.ok, j }))).then(({ ok, j }) => {
    if (!ok) throw new Error(j.error || 'Ошибка');
    render(j);
  }).catch((e) => {
    app.innerHTML = `<div class="card center"><div class="chest">🗺️</div><h2>${esc(e.message)}</h2><p class="muted">Сыграйте первую экспедицию — и здесь появится отчёт.</p><div class="row" style="justify-content:center"><a class="btn" href="/">Начать экспедицию</a><a class="btn ghost" href="/report.html?family=demo">Пример отчёта</a></div></div>`;
  });

  function render(d) {
    const m = d.metrics, t = d.text;
    const name = m.subject.nickname || 'Ребёнок';
    const fill = (s) => esc(String(s || '').replaceAll('{child}', name));
    const age = m.subject.ageBand ? `${m.subject.ageBand.replace('-', '–')} лет` : '';
    const isWeek = d.kind === 'week';
    const switchLink = isWeek
      ? ''
      : `<a class="btn ghost small" href="/report.html?family=${encodeURIComponent(d.session.familyId)}">Отчёт за неделю</a>`;

    const skillRows = SKILL_ORDER.map((sk) => {
      const s = m.skills[sk], l = m.levels[sk];
      if (sk === 'communication') {
        const avg = s.parentRatingAvg;
        return `<div class="skill-row"><b>${esc(s.label)}</b>
          <div class="bar">${avg ? `<i style="width:${(avg / 3) * 100}%"></i>` : ''}</div>
          <div class="lvl">${avg ? `${avg} / 3` : '<span class="nodata">нет оценки</span>'}</div></div>`;
      }
      if (!s.enoughData) {
        return `<div class="skill-row"><b>${esc(s.label)}</b><div class="bar">${l.level ? `<i style="width:${l.level * 10}%;opacity:.35"></i>` : ''}</div><div class="lvl"><span class="nodata">мало данных · ${s.parts}/${m.minParts}</span></div></div>`;
      }
      const delta = (l.level ?? 0) - (l.levelBefore ?? l.level ?? 0);
      return `<div class="skill-row"><b>${esc(s.label)}</b>
        <div class="bar">${l.levelBefore != null ? `<i class="prev" style="width:${l.levelBefore * 10}%"></i>` : ''}<i style="width:${l.level * 10}%;opacity:.9"></i></div>
        <div class="lvl">ур. ${l.level} <span class="${delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted'}">${delta > 0 ? '▲' + delta : delta < 0 ? '▼' + -delta : '·'}</span></div></div>`;
    }).join('');

    const ev = (h) => (h ? `<ul class="evidence">${h.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');

    app.innerHTML = `
    ${d.family && d.family.demo ? '<div class="demo-banner">🤖 Демо-семья: 6 экспедиций сыграл бот-симулятор через настоящий сервер игры (генераторы, проверка ответов, журнал попыток, рейтинги). Это пример формата — перед питчем замените на сессии реальной тестовой семьи.</div>' : ''}
    <div class="report-head">
      <div>
        <span class="pill gold">${isWeek ? '🗓️ Недельный отчёт' : '🎮 Отчёт по экспедиции'}</span>
        <h1 style="margin-top:8px">${esc(name)}${age ? `, ${age}` : ''}</h1>
        <div class="muted">${isWeek ? `${fmtDate(m.period.from)} — ${fmtDate(m.period.to)} · ${esc(d.family.name || '')}` : `${esc(d.session.title)} · ${fmtDate(d.session.startedAt)}`}</div>
      </div>
      <div class="row no-print">${switchLink}<button class="btn ghost small" onclick="print()">🖨️ Сохранить PDF</button></div>
    </div>

    <div class="card">
      <h2 style="font-size:24px">${fill(t.headline)}</h2>
      <div class="big3">
        <div class="stat"><b>🔥 ${m.team.streakDays}</b>дней подряд</div>
        <div class="stat"><b>${m.team.minutes}</b>минут вместе</div>
        <div class="stat"><b>${m.team.locks}</b>замков открыто</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Профиль навыков <span class="muted small">(уровень 1–10; серая полоса — начало периода)</span></h3>
      ${skillRows}
      <p class="small muted" style="margin-bottom:0">Сравниваем только с самим ребёнком. Если задач по навыку меньше ${m.minParts}, честно пишем «мало данных».</p>
    </div>

    <div class="grid2" style="margin-top:16px">
      <div class="card sg"><h3>💪 Сильная сторона</h3><p>${fill(t.strength)}</p>${ev(m.highlights.strength)}</div>
      <div class="card gr"><h3>🌱 Зона роста</h3><p>${fill(t.growth)}</p>${ev(m.highlights.growth)}</div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>🧠 Стиль мышления</h3>
      <ul style="line-height:1.6">${(t.style || []).map((s) => `<li>${fill(s)}</li>`).join('')}</ul>
      <p class="small muted">Это наблюдения за поведением в игре, а не диагнозы.</p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>🏡 Попробуйте на неделе — без экрана</h3>
      ${d.activities.map((a, i) => `<div class="act"><span class="n">${i + 1}</span><div>${esc(a.text)}<div class="small muted">${esc(d.skills[a.skill])}</div></div></div>`).join('')}
      <div class="rule-note">🔧 Что Kinquest изменит сам: ${fill(t.next_week)}</div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>👨‍👩‍👧 Команда семьи</h3>
      <p>${fill(t.team)}</p>
      <div class="stat-row" style="justify-content:flex-start">
        <div class="stat"><b>${m.team.firstTryLocks}/${m.team.locks}</b>замков с первой попытки</div>
        <div class="stat"><b>${m.team.sessions}</b>экспедиций</div>
        ${m.team.stuckOn ? `<div class="stat"><b style="font-size:18px">${esc(m.team.stuckOn)}</b>чаще всего задерживались</div>` : ''}
      </div>
    </div>

    <p class="src">Цифры посчитаны сервером по журналу действий (${isWeek ? d.sessionIds.length + ' сессий' : 'эта сессия'}). Текст: ${t.source === 'claude' ? 'написан Claude только по этим цифрам; советы выбраны из библиотеки Kinquest' : 'шаблон Kinquest (Claude недоступен)'}. Имя ребёнка в ИИ не передаётся.</p>`;
  }
})();
