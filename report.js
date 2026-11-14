// Parent report metrics. Computed only from the attempt log — no invented numbers.
// A child is only ever compared with their own earlier self.
'use strict';
const { SKILLS } = require('./activities');
const { ratingToLevel, SKILL_KEYS } = require('./store');

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
  for (const skill of SKILL_KEYS) out[skill] = { skill, label: SKILLS[skill], parts: 0, firstTry: 0, noHints: 0, times: [], answers: 0, fastWrong: 0, hints: 0, byType: {} };
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
          if (a.hints === 0) m.noHints++;
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
      if (['accuse', 'press', 'branch', 'check', 'mark'].includes(a.action)) {
        for (const sk of skills) {
          out[sk].answers++;
          if (!a.correct && a.ms < 5000) out[sk].fastWrong++;
        }
        if (!a.correct && a.ms < 5000 && !skills.includes('critical')) {
          out.critical.answers++;
          out.critical.fastWrong++;
        } else if (!skills.includes('critical')) {
          out.critical.answers++;
        }
      }
      if (a.action === 'exclude' && a.correct === false) wrongExclusions++;
      if (a.action === 'why') { whyTotal++; if (a.correct) whyRight++; }
    }
  }

  const res = {};
  for (const sk of SKILL_KEYS) {
    const m = out[sk];
    res[sk] = {
      skill: sk, label: m.label, parts: m.parts,
      enoughData: sk === 'communication' ? parentRatings.length >= 1 : m.parts >= MIN_PARTS,
      firstTryPct: pct(m.firstTry, m.parts),
      independencePct: pct(m.noHints, m.parts),
      hints: m.hints,
      medianSec: m.times.length ? Math.round(median(m.times) / 1000) : null,
      guessPct: pct(m.fastWrong, m.answers),
      byType: Object.values(m.byType),
    };
  }
  res.communication.parentRatingAvg = parentRatings.length ? +(parentRatings.reduce((a, b) => a + b, 0) / parentRatings.length).toFixed(1) : null;
  res.communication.parts = parentRatings.length;
  res.spatial.rotationsAvg = rotations.length ? +(rotations.reduce((a, b) => a + b, 0) / rotations.length).toFixed(1) : null;
  res.spatial.rotationsOnFailAvg = rotationsOnFail.length ? +(rotationsOnFail.reduce((a, b) => a + b, 0) / rotationsOnFail.length).toFixed(1) : null;
  res.logic.wrongExclusions = wrongExclusions;
  res.critical.whyPct = pct(whyRight, whyTotal);
  res.critical.whyTotal = whyTotal;
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

// Code picks the strength and growth area from the numbers; the AI only writes the text.
function highlights(skills, lv) {
  const ranked = ['spatial', 'patterns', 'logic', 'critical']
    .filter((sk) => skills[sk].enoughData)
    .map((sk) => ({ sk, score: (skills[sk].firstTryPct ?? 0) + 10 * ((lv[sk].level ?? 0) - (lv[sk].levelBefore ?? 0)) + 2 * (lv[sk].level ?? 0) }))
    .sort((a, b) => b.score - a.score);
  const strength = ranked[0] ? ranked[0].sk : null;
  const growth = ranked.length > 1 ? ranked[ranked.length - 1].sk : null;

  const evidence = (sk) => {
    const m = skills[sk], l = lv[sk];
    const parts = [];
    parts.push(`${m.firstTryPct}% solved on the first try (${m.parts} puzzles)`);
    if (m.independencePct != null) parts.push(`${m.independencePct}% without hints`);
    if (l.level != null) parts.push(l.levelBefore != null && l.levelBefore !== l.level ? `level ${l.levelBefore} → ${l.level}` : `level ${l.level}`);
    if (m.medianSec != null) parts.push(`median time ${m.medianSec} sec`);
    if (sk === 'spatial' && skills.spatial.rotationsAvg != null) parts.push(`${skills.spatial.rotationsAvg} model turns on average before answering`);
    if (sk === 'logic' && skills.logic.wrongExclusions) parts.push(`crossed out the real thief ${skills.logic.wrongExclusions} time(s)`);
    if (sk === 'critical' && skills.critical.whyPct != null) parts.push(`picked the right “why” ${skills.critical.whyPct}% of the time`);
    return parts;
  };

  const style = [];
  const guess = skills.critical.guessPct;
  if (guess != null && guess >= 25) style.push(`often answers in under 5 seconds and misses (${guess}% of answers), so practicing a quick double-check will help`);
  else if (guess === 0) style.push('takes a moment before answering: no fast wrong guesses');
  else if (guess != null) style.push(`rarely guesses: only ${guess}% of answers were fast and wrong`);
  if (skills.spatial.rotationsAvg) style.push(skills.spatial.rotationsAvg < 2 ? `rarely turns the 3D model (${skills.spatial.rotationsAvg} times on average) and relies on what is visible at first` : `turns the model a lot (${skills.spatial.rotationsAvg} times on average) before answering`);
  if (skills.critical.whyPct != null && skills.critical.whyTotal >= 2) style.push(`explains their choice correctly ${skills.critical.whyPct}% of the time`);

  return {
    strength: strength && { skill: strength, label: SKILLS[strength], evidence: evidence(strength) },
    growth: growth && growth !== strength && { skill: growth, label: SKILLS[growth], evidence: evidence(growth) },
    style,
  };
}

function buildMetrics(sessions, nickKey) {
  if (!sessions.length) return null;
  const who = pickSubject(sessions, nickKey);
  const player = sessions.flatMap((s) => s.players).find((p) => p.key === who) || { nickname: who, ageBand: null };
  const skills = skillMetrics(sessions, who);
  const lv = levels(sessions, who);
  return {
    subject: { key: who, nickname: player.nickname, ageBand: player.ageBand, kind: player.kind },
    period: { from: sessions[0].startedAt, to: sessions[sessions.length - 1].endedAt || sessions[sessions.length - 1].startedAt },
    team: teamMetrics(sessions),
    skills, levels: lv,
    highlights: highlights(skills, lv),
    minParts: MIN_PARTS,
  };
}

module.exports = { buildMetrics, LOCK_SKILLS, LOCK_LABEL };
