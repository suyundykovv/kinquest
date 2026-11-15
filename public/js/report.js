// Parent report: the server computes the numbers from the attempt log; Gemini (or a template) writes the text.
(function () {
  const app = document.getElementById('app');
  const q = new URLSearchParams(location.search);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SKILL_ORDER = ['spatial', 'patterns', 'logic', 'critical', 'communication'];
  const fmtDate = (ts) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ts));
  const fmtNum = (n) => new Intl.NumberFormat('en-US').format(n);

  const url = q.get('session') ? `/api/report/session/${encodeURIComponent(q.get('session'))}` : `/api/report/week?family=${encodeURIComponent(q.get('family') || 'demo')}`;

  fetch(url).then((r) => r.json().then((j) => ({ ok: r.ok, j }))).then(({ ok, j }) => {
    if (!ok) throw new Error(j.error || 'Something went wrong');
    render(j);
  }).catch((e) => {
    app.innerHTML = `<div class="card center"><div class="chest" aria-hidden="true">🗺️</div><h1 style="font-size:28px">${esc(e.message)}</h1><p class="muted">Play your first expedition and your report will show up here.</p><div class="row" style="justify-content:center"><a class="btn" href="/">Start an Expedition</a><a class="btn ghost" href="/report.html?family=demo">See a Sample Report</a></div></div>`;
  }).finally(() => app.removeAttribute('aria-busy'));

  function render(d) {
    const m = d.metrics, t = d.text;
    const name = m.subject.nickname || 'Your child';
    const fill = (s) => esc(String(s || '').replaceAll('{child}', name));
    const age = m.subject.ageBand ? `, age ${m.subject.ageBand.replace('-', '–')}` : '';
    const isWeek = d.kind === 'week';
    document.title = `${name} · Kinquest ${isWeek ? 'Weekly' : 'Expedition'} Report`;
    const switchLink = isWeek ? '' : `<a class="btn ghost sm" href="/report.html?family=${encodeURIComponent(d.session.familyId)}">See This Week</a>`;

    const skillRows = SKILL_ORDER.map((sk) => {
      const s = m.skills[sk], l = m.levels[sk];
      if (sk === 'communication') {
        const avg = s.parentRatingAvg;
        return `<div class="skill-row"><b>${esc(s.label)}</b>
          <div class="bar" role="img" aria-label="${avg ? `Parent rating ${avg} of 3` : 'No rating yet'}">${avg ? `<i style="width:${(avg / 3) * 100}%"></i>` : ''}</div>
          <div class="lvl">${avg ? `${avg} / 3` : '<span class="nodata">No rating yet</span>'}</div></div>`;
      }
      if (!s.enoughData) {
        return `<div class="skill-row"><b>${esc(s.label)}</b><div class="bar" role="img" aria-label="Not enough data">${l.level ? `<i style="width:${l.level * 10}%;opacity:.35"></i>` : ''}</div><div class="lvl"><span class="nodata">Not enough data · ${s.parts}/${m.minParts}</span></div></div>`;
      }
      const delta = (l.level ?? 0) - (l.levelBefore ?? l.level ?? 0);
      return `<div class="skill-row"><b>${esc(s.label)}</b>
        <div class="bar" role="img" aria-label="Level ${l.level} of 10${l.levelBefore != null ? `, was ${l.levelBefore}` : ''}">${l.levelBefore != null ? `<i class="prev" style="width:${l.levelBefore * 10}%"></i>` : ''}<i style="width:${l.level * 10}%;opacity:.9"></i></div>
        <div class="lvl">Level ${l.level} <span class="${delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted'}">${delta > 0 ? '▲' + delta : delta < 0 ? '▼' + -delta : '·'}</span></div></div>`;
    }).join('');

    const b = m.blocks;
    const li = (xs) => (xs.length ? `<ul class="block-list">${xs.map((x) => `<li>${fill(x)}</li>`).join('')}</ul>` : '');
    const nextBtn = isWeek && d.family.demo
      ? '<a class="btn" href="/#start">Start Your Own Expedition</a>'
      : `<a class="btn" href="/#start">${b.next.id ? `Start “${esc(b.next.title)}”` : 'Start the Next Expedition'}</a>`;
    const resultRows = m.results.map((r) => `<tr><td>${esc(r.label)}${r.withTool ? `<div class="small muted">${r.withTool} with the check tool</div>` : ''}</td><td class="num">${r.firstTry}/${r.parts}</td><td class="num">${r.hints}</td><td class="num">${r.levelMin === r.levelMax ? r.levelMin : `${r.levelMin}–${r.levelMax}`}</td></tr>`).join('');
    const robot = m.solo.robots ? `<tr><td>Fix the Robot<div class="small muted">bonus after the solo chest</div></td><td class="num">${m.solo.robotsFirstStep}/${m.solo.robots}</td><td class="num">—</td><td class="num">—</td></tr>` : '';
    const solo = m.solo.played ? `<tr><td>Solo chest<div class="small muted">home try, ${m.solo.helped ? `help marked ${m.solo.helped}×` : 'no help marked'}</div></td><td class="num">${m.solo.firstTry}/${m.solo.played}</td><td class="num">—</td><td class="num">${m.solo.last ? m.solo.last.level : '—'}</td></tr>` : '';

    app.innerHTML = `
    ${d.family && d.family.demo ? '<div class="demo-banner">🤖 Demo family: these expeditions were played by a bot through the real game server (generators, answer checks, move log, ratings). It shows the report format. Before a pitch, swap in sessions from a real test family.</div>' : ''}
    <div class="report-head">
      <div>
        <span class="pill key">${isWeek ? '🗓️ Weekly Report' : '🎮 Expedition Report'}</span>
        <h1 style="margin-top:12px">${esc(name)}${age}</h1>
        <div class="muted">${isWeek ? `${fmtDate(m.period.from)} – ${fmtDate(m.period.to)} · ${esc(d.family.name || '')}` : `${esc(d.session.title)} · ${fmtDate(d.session.startedAt)}`}</div>
      </div>
      <div class="row no-print">${switchLink}<button class="btn ghost sm" onclick="print()">Save as PDF</button></div>
    </div>

    <section class="card" aria-labelledby="hl">
      <h2 id="hl" style="font-size:24px">${fill(t.headline)}</h2>
      <div class="big3">
        <div class="stat"><b>🔥 ${fmtNum(m.team.streakDays)}</b>day streak</div>
        <div class="stat"><b>${fmtNum(m.team.minutes)}</b>minutes together</div>
        <div class="stat"><b>${fmtNum(m.team.locks)}</b>locks opened</div>
      </div>
    </section>

    <div class="grid2" style="margin-top:16px">
      <section class="card sg"><h2 style="font-size:20px">✅ What Went Well</h2><p>${fill(t.went_well)}</p>${li(b.wins)}</section>
      <section class="card gr"><h2 style="font-size:20px">🧩 Where It Got Tricky</h2><p>${fill(t.stuck)}</p>${li(b.stuck.map((x) => x.text))}</section>
    </div>

    <div class="grid2" style="margin-top:16px">
      <section class="card">
        <h2 style="font-size:20px">🗣️ Try This Together</h2>
        <p>${fill(t.parent_try)}</p>
        <div class="note">${esc(b.tip.q)}</div>
        ${d.activities.map((a, i) => `<div class="act"><span class="n" aria-hidden="true">${i + 1}</span><div>${esc(a.text)}<div class="small muted">${esc(d.skills[a.skill])} · screens off</div></div></div>`).join('')}
      </section>
      <section class="card next-mission">
        <h2 style="font-size:20px">🎯 Next Mission</h2>
        <p>${fill(t.next_mission)}</p>
        ${b.next.because ? `<p class="small muted">${fill(b.next.because)}</p>` : ''}
        <div class="row no-print">${nextBtn}</div>
        <p class="small muted" style="margin-bottom:0">Kinquest applies this to the next expedition your family starts. One lock changes; the other two stay varied.</p>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <h2 style="font-size:20px">📋 Results by Puzzle</h2>
      <table class="results"><thead><tr><th scope="col">Puzzle</th><th scope="col">First try</th><th scope="col">Hints</th><th scope="col">Level</th></tr></thead>
      <tbody>${resultRows}${solo}${robot}</tbody></table>
      <p class="small muted" style="margin:12px 0 0">Family puzzles are solved together, so they show what the team did. The solo chest is ${esc(name)}’s own try at home, and a help mark is the grown-up’s note, not a test result.</p>
    </section>

    <section class="card" style="margin-top:16px">
      <h2 style="font-size:20px">👨‍👩‍👧 Teamwork</h2>
      <p>${fill(t.team)}</p>
      ${b.offscreen ? `<p class="small muted">🏡 ${esc(b.offscreen)}</p>` : ''}
      <div class="stat-row" style="justify-content:flex-start">
        <div class="stat"><b>${m.team.firstTryLocks}/${m.team.locks}</b>first-try locks</div>
        <div class="stat"><b>${m.team.sessions}</b>expedition${m.team.sessions === 1 ? '' : 's'}</div>
        ${m.team.stuckOn ? `<div class="stat"><b style="font-size:18px">${esc(m.team.stuckOn)}</b>took the most talk</div>` : ''}
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <details class="levels"><summary>Skill levels (1–10), used to pick puzzle difficulty</summary>
      <p class="muted small">The gray bar is where ${esc(name)} started this period. Levels set how hard the next puzzles are; they aren’t a score of ability.</p>
      ${skillRows}
      <p class="small muted" style="margin:12px 0 0">With fewer than ${m.minParts} puzzles in a skill, we say so instead of guessing.</p></details>
    </section>

    <p class="src">Facts come straight from the game’s move log (${isWeek ? `${d.sessionIds.length} sessions` : 'this session'}). Text: ${t.source === 'gemini' ? 'worded by Gemini from these facts only; activities picked from the Kinquest library' : 'Kinquest template (AI unavailable)'}. Your child’s name is never sent to the AI.</p>`;
  }
})();
