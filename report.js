// Parent report metrics. Computed only from the attempt log — no invented numbers.
// A child is only ever compared with their own earlier self.
'use strict';
const { SKILLS } = require('./activities');
const { ratingToLevel, SKILL_KEYS } = require('./store');
const { focusFor, FOCUS } = require('./focus');

const LOCK_SKILLS = { detective: ['logic', 'critical'], cipher: ['patterns'], blueprint: ['spatial'] };
const LOCK_LABEL = { detective: 'Detective', cipher: 'Temple Cipher', blueprint: 'Blueprint Workshop' };
const MIN_PARTS = 3;

const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

// The report's subject: the first child player (or the given nickname).
function pickSubject(sessions, nickKey) {
  if (nickKey) return nickKey;
  for (const s of sessions) {
    const c = s.players.find((p) => p.kind === 'child');
    if (c) return c.key;
  }
  return sessions[0] && sessions[0].players[0] && sessions[0].players[0].key;
}

function skillMetrics(sessions, who) {
  const out = {};
  for (const skill of SKILL_KEYS) out[skill] = { skill, label: SKILLS[skill], parts: 0, firstTry: 0, times: [], hints: 0, byType: {} };
  let rotations = [], rotationsOnFail = [], wrongExclusions = 0, detectiveParts = 0, whyTotal = 0, whyRight = 0;
  const parentRatings = [];
  let solvedAsRole = { scout: 0, keeper: 0 };

  for (const s of sessions) {
    if (s.parentRating) parentRatings.push(s.parentRating);
    for (const a of s.attempts) {
      if (a.player !== who) continue;
      const skills = LOCK_SKILLS[a.type] || [];
      if (a.action === 'part_solved') {
        solvedAsRole[a.role] = (solvedAsRole[a.role] || 0) + 1;
        for (const sk of skills) {
          const m = out[sk];
          m.parts++;
          if (a.errors === 0 && a.hints === 0) m.firstTry++;
          m.hints += a.hints;
          m.times.push(a.ms);
          const t = (m.byType[`${a.type}@${a.level}`] ||= { type: a.type, level: a.level, n: 0, clean: 0 });
          t.n++;
          if (a.errors === 0 && a.hints === 0) t.clean++;
        }
        if (a.type === 'blueprint' && a.role === 'scout') {
          rotations.push(a.rotations || 0);
          if (a.errors > 0) rotationsOnFail.push(a.rotations || 0);
        }
        if (a.type === 'detective') detectiveParts++;
      }
      if (a.action === 'exclude' && a.correct === false) wrongExclusions++;
      if (a.action === 'exclude' && a.linkValid === true) { whyTotal++; whyRight++; }
      if (a.action === 'exclude_link') whyTotal++;
    }
  }

  const res = {};
  for (const sk of SKILL_KEYS) {
    const m = out[sk];
    res[sk] = {
      skill: sk, label: m.label, parts: m.parts,
      enoughData: sk === 'communication' ? parentRatings.length >= 1 : m.parts >= MIN_PARTS,
      firstTryPct: pct(m.firstTry, m.parts),
      hints: m.hints,
      medianSec: m.times.length ? Math.round(median(m.times) / 1000) : null,
      byType: Object.values(m.byType),
    };
  }
  res.communication.parentRatingAvg = parentRatings.length ? +(parentRatings.reduce((a, b) => a + b, 0) / parentRatings.length).toFixed(1) : null;
  res.communication.parts = parentRatings.length;
  res.spatial.rotationsAvg = rotations.length ? +(rotations.reduce((a, b) => a + b, 0) / rotations.length).toFixed(1) : null;
  res.spatial.rotationsOnFailAvg = rotationsOnFail.length ? +(rotationsOnFail.reduce((a, b) => a + b, 0) / rotationsOnFail.length).toFixed(1) : null;
  res.logic.wrongExclusions = wrongExclusions;
  res.critical.cluePct = pct(whyRight, whyTotal);
  res.critical.clueTotal = whyTotal;
  res.solvedAsRole = solvedAsRole;
  return res;
}

function levels(sessions, who) {
  const first = sessions.find((s) => s.ratings && s.ratings[who]);
  const last = [...sessions].reverse().find((s) => s.ratings && s.ratings[who]);
  const out = {};
  for (const sk of SKILL_KEYS) {
    const before = first ? first.ratings[who].before[sk] : null;
    const after = last ? last.ratings[who].after[sk] : null;
    out[sk] = {
      rating: after, ratingBefore: before,
      level: after != null ? ratingToLevel(after) : null,
      levelBefore: before != null ? ratingToLevel(before) : null,
    };
  }
  return out;
}

function teamMetrics(sessions) {
  let locks = 0, firstTryLocks = 0, ms = 0;
  const stuck = {};
  for (const s of sessions) {
    ms += Math.max(0, (s.endedAt || s.startedAt) - s.startedAt);
    for (const l of s.locks || []) {
      if (!l.opened) continue;
      locks++;
      if (l.errors === 0 && l.hints === 0) firstTryLocks++;
      stuck[l.type] = (stuck[l.type] || 0) + l.errors + l.hints;
    }
  }
  const days = [...new Set(sessions.map((s) => dayKey(s.startedAt)))].sort();
  let streak = 0;
  if (days.length) {
    streak = 1;
    for (let i = days.length - 1; i > 0; i--) {
      const diff = (new Date(days[i]) - new Date(days[i - 1])) / 86400000;
      if (diff === 1) streak++; else break;
    }
  }
  const worst = Object.entries(stuck).sort((a, b) => b[1] - a[1])[0];
  return {
    sessions: sessions.length, minutes: Math.round(ms / 60000), locks, firstTryLocks,
    streakDays: streak, daysPlayed: days.length,
    stuckOn: worst && worst[1] > 0 ? LOCK_LABEL[worst[0]] : null,
  };
}

const UNIT = { detective: ['lock', 'locks'], cipher: ['round', 'rounds'], blueprint: ['model', 'models'] };
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;
const lvlRange = (a, b) => (a === b ? `level ${a}` : `levels ${a}–${b}`);
const OFF_WORD = { color: 'color', shape: 'shape', dots: 'number of dots' };

// Results by puzzle type: what was played, at which level, first try or not, hints used.
function results(sessions, who) {
  const out = {};
  for (const s of sessions) {
    for (const a of s.attempts) {
      if (a.player !== who || a.action !== 'part_solved') continue;
      const r = (out[a.type] ||= { type: a.type, label: LOCK_LABEL[a.type], parts: 0, firstTry: 0, hints: 0, levelMin: a.level, levelMax: a.level, withTool: 0 });
      r.parts++;
      if (a.errors === 0 && a.hints === 0) r.firstTry++;
      r.hints += a.hints || 0;
      r.levelMin = Math.min(r.levelMin, a.level);
      r.levelMax = Math.max(r.levelMax, a.level);
      const det = a.type === 'detective' && (s.locks || []).find((l) => l.type === 'detective');
      if (det && det.focus && det.focus.stage === 'scaffold') r.withTool++;
    }
  }
  return ['detective', 'cipher', 'blueprint'].map((t) => out[t]).filter(Boolean);
}

// Solo chests: a home try after the family expedition. The grown-up's help mark is context, not proof.
function soloStats(sessions) {
  const played = sessions.map((s) => s.solo).filter((x) => x && (x.state === 'solved' || x.tries > 0));
  return {
    offered: sessions.filter((s) => s.solo).length,
    played: played.length,
    solved: played.filter((x) => x.solved).length,
    firstTry: played.filter((x) => x.solved && x.tries === 1).length,
    helped: played.filter((x) => x.helped).length,
    last: played[played.length - 1] || null,
    robots: sessions.map((s) => s.solo && s.solo.robot).filter((r) => r && r.state !== 'offer' && r.state !== 'skipped').length,
    robotsFixed: sessions.map((s) => s.solo && s.solo.robot).filter((r) => r && r.fixed).length,
    robotsFirstStep: sessions.map((s) => s.solo && s.solo.robot).filter((r) => r && r.fixed && r.stepTries === 1).length,
    offscreen: sessions.filter((s) => s.offscreen).map((s) => s.offscreen.title),
  };
}

// The four report blocks, from events in the log. Each line points at one concrete event.
function blocks(sessions, who, res, solo) {
  const wins = [];
  const best = res.filter((r) => r.firstTry > 0).sort((a, b) => b.firstTry / b.parts - a.firstTry / a.parts || b.levelMax - a.levelMax)[0];
  if (best) wins.push(`${best.label}: ${best.firstTry} of ${plural(best.parts, UNIT[best.type])} solved on the first try with no hints, at ${lvlRange(best.levelMin, best.levelMax)}.`);
  let links = 0, checks = 0, checksRight = 0, lastTool = null;
  let preds = 0, predsRight = 0, changesRight = 0, views = 0, viewsRight = 0, swapsLed = 0;
  const mixups = [], badLinks = [], off = {}, blueprintMisses = [], viewMisses = [];
  for (const s of sessions) {
    for (const a of s.attempts) {
      if (a.player !== who) continue;
      if (a.action === 'exclude' && a.linkValid) links++;
      if (a.action === 'check_clue') { checks++; if (a.correct) checksRight++; lastTool = s.id; }
      if (a.action === 'accuse' && a.type === 'detective' && !a.correct && a.breaks) mixups.push({ name: a.name, fits: a.fits, breaks: a.breaks, solo: false, t: a.t });
      if (a.action === 'exclude_link') badLinks.push(a);
      if ((a.action === 'press' || a.action === 'predict') && a.off && a.off.length === 1) off[a.off[0]] = (off[a.off[0]] || 0) + 1;
      if (a.action === 'predict') { preds++; if (a.correct) predsRight++; if (a.changesCorrect) changesRight++; }
      if (a.action === 'predict_view' && !a.skipped) { views++; if (a.correct) viewsRight++; else viewMisses.push(a); }
      if (a.action === 'part_solved' && a.type === 'cipher' && a.swapped) swapsLed++;
      if (a.action === 'check' && a.type === 'blueprint' && !a.correct) blueprintMisses.push(a);
    }
    if (s.solo && s.solo.wrongs) for (const w of s.solo.wrongs) mixups.push({ ...w, solo: true, t: s.endedAt });
  }
  if (links) wins.push(`Crossed out ${plural(links, ['suspect', 'suspects'])} using a clue that really rules them out.`);
  if (checks) wins.push(`Used the check tool: ${checksRight} of ${checks} clue checks were right.`);
  if (predsRight) wins.push(`Predicted the next symbol in the Temple Cipher before pressing (${predsRight} of ${plural(preds, ['try', 'tries'])}) and named what changes along the row ${plural(changesRight, ['time', 'times'])}.`);
  if (swapsLed) wins.push(`Led the role-swap round ${plural(swapsLed, ['time', 'times'])}: held the rule book and told the grown-up what to press.`);
  if (viewsRight) wins.push(`Pictured the model’s right-side view before turning it: ${viewsRight} of ${views} right.`);
  if (solo.robotsFixed) wins.push(`Fixed Robo’s case ${plural(solo.robotsFixed, ['time', 'times'])}: found the wrong step${solo.robotsFirstStep ? ` (${solo.robotsFirstStep} on the first try)` : ''} and named the real thief.`);
  if (solo.solved) {
    const l = solo.last;
    wins.push(solo.played === 1 && l
      ? `Opened the solo chest ${l.tries === 1 ? 'on the first try' : `after ${l.tries} tries`}${l.helped ? ', with a grown-up’s help' : ', with no help marked'} (${l.clues} clues, ${l.suspects} suspects).`
      : `Opened ${solo.solved} of ${solo.played} solo chests, ${solo.firstTry} on the first try; ${solo.helped ? `a grown-up marked help on ${solo.helped}` : 'no help marked'}.`);
  }

  const stuck = [];
  const mix = mixups.filter((m) => m.breaks && m.breaks.length).pop();
  if (mix) {
    stuck.push({
      kind: 'two_clues',
      text: mix.fits && mix.fits.length
        ? `${mix.solo ? 'In the solo chest, picked' : 'In the Detective, picked'} ${mix.name}, who matched “${mix.fits[0]}” but not “${mix.breaks[0]}”.`
        : `${mix.solo ? 'In the solo chest, picked' : 'In the Detective, picked'} ${mix.name}, who didn’t match “${mix.breaks[0]}”.`,
    });
  }
  const bl = badLinks.pop();
  if (bl) stuck.push({ kind: 'bad_link', text: `Tried to cross out ${bl.name} with the clue “${bl.short}”, but that clue fits ${bl.name}.` });
  const topOff = Object.entries(off).sort((a, b) => b[1] - a[1])[0];
  if (topOff) stuck.push({ kind: 'cipher_' + topOff[0], text: `In the Temple Cipher, pressed a symbol that was right except for the ${OFF_WORD[topOff[0]]} (${plural(topOff[1], ['time', 'times'])}).` });
  const vm = viewMisses.pop();
  if (vm) stuck.push({ kind: 'blueprint_view', text: `Before turning the model, picked the wrong right-side view${viewMisses.length ? ` (${viewMisses.length + 1} times)` : ''}.` });
  if (blueprintMisses.length) stuck.push({ kind: 'blueprint', text: `Checked the cube model ${plural(blueprintMisses.length, ['time', 'times'])} before it matched the blueprint.` });

  const TIPS = {
    two_clues: { q: 'Ask: “Which clue could prove your answer wrong?”', skill: 'logic' },
    bad_link: { q: 'Ask: “Show me the clue that rules them out.”', skill: 'critical' },
    cipher_color: { q: 'Ask: “What changes from one symbol to the next: the shape, the color, or the dots?”', skill: 'patterns' },
    cipher_shape: { q: 'Ask: “What changes from one symbol to the next: the shape, the color, or the dots?”', skill: 'patterns' },
    cipher_dots: { q: 'Ask: “Count the dots out loud. What comes next?”', skill: 'patterns' },
    blueprint: { q: 'Ask: “What would this look like from the back?”', skill: 'spatial' },
    blueprint_view: { q: 'Ask: “If you walked around to the side, what would you see?”', skill: 'spatial' },
  };
  const tip = stuck[0] ? TIPS[stuck[0].kind] : { q: 'Ask: “Which puzzle was the trickiest today, and how did you crack it?”', skill: 'communication' };

  const f = focusFor(sessions, who);
  const lastH = f.history[f.history.length - 1];
  let next;
  if (f.next) {
    const lock = LOCK_LABEL[f.next.lock];
    next = {
      id: f.next.id, title: f.next.title, stage: f.next.stage, goal: f.next.goal, lock: f.next.lock,
      text: f.next.stage === 'scaffold'
        ? `Next ${lock}: “${f.next.title}” with ${f.next.tool}.`
        : `Next ${lock}: “${f.next.title}” again, without the helper, to see if it sticks.`,
      because: f.next.because ? `Because ${f.next.because}.` : null,
    };
  } else if (lastH && lastH.mastered) {
    next = { id: null, stage: 'done', text: `“${FOCUS[lastH.id].title}” is done: {child} did it without the helper. The next expedition is a regular one.` };
  } else {
    next = { id: null, stage: 'none', text: 'No mix-ups to practice right now. The next expedition keeps the level {child} is at.' };
  }
  const counts = {};
  for (const t of solo.offscreen) counts[t] = (counts[t] || 0) + 1;
  const offscreen = solo.offscreen.length ? `Off-screen missions marked done by the grown-up: ${Object.entries(counts).map(([t, n]) => (n > 1 ? `${t} (${n}×)` : t)).join(', ')}.` : null;
  // One line per kind of evidence; the best puzzle result first, then the kid's own decisions.
  const order = ['solved on the first try', 'Led the role-swap', 'Fixed Robo', 'Opened', 'Predicted', 'Pictured', 'Crossed out', 'Used the check tool'];
  const rank = (w) => { const k = order.findIndex((o) => w.includes(o)); return k < 0 ? order.length : k; };
  return { wins: wins.sort((a, b) => rank(a) - rank(b)).slice(0, 5), stuck: stuck.slice(0, 2), tip, next, offscreen };
}

function buildMetrics(sessions, nickKey) {
  if (!sessions.length) return null;
  const who = pickSubject(sessions, nickKey);
  const player = sessions.flatMap((s) => s.players).find((p) => p.key === who) || { nickname: who, ageBand: null };
  const skills = skillMetrics(sessions, who);
  const lv = levels(sessions, who);
  const res = results(sessions, who);
  const solo = soloStats(sessions);
  return {
    subject: { key: who, nickname: player.nickname, ageBand: player.ageBand, kind: player.kind },
    period: { from: sessions[0].startedAt, to: sessions[sessions.length - 1].endedAt || sessions[sessions.length - 1].startedAt },
    team: teamMetrics(sessions),
    skills, levels: lv,
    results: res, solo,
    blocks: blocks(sessions, who, res, solo),
    minParts: MIN_PARTS,
  };
}

module.exports = { buildMetrics, LOCK_SKILLS, LOCK_LABEL };
