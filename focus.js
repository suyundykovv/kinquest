// Next-mission rules: an event seen in the move log changes what the next expedition asks for.
// Plain rules, no model. One focus at a time, and it touches one lock only, so the rest keeps its variety.
// Steps: notice a specific mix-up → that lock with a helper tool (scaffold) → the same kind of lock
// without the tool (independent) → done, or back to the tool if the mix-up returns.
'use strict';

const OFF_WORD = { color: 'color', shape: 'shape', dots: 'number of dots' };
const FOCUS = {
  two_clues: {
    lock: 'detective', title: 'Two Clues',
    goal: 'Check each suspect against every clue, one at a time, before you accuse.',
    tool: 'a check tool: pick a suspect, check clue 1, check clue 2, then confirm or change the pick',
    parentTip: 'Ask: “Which clue could prove your answer wrong?”',
  },
  watch_color: {
    lock: 'cipher', attr: 'color', title: 'Watch the Colors',
    goal: 'Say the color of each symbol out loud before you press.',
    tool: 'color labels under each symbol in the row, and one decoy button that differs only in color',
    parentTip: 'Ask: “What color comes next?”',
  },
  watch_shape: {
    lock: 'cipher', attr: 'shape', title: 'Watch the Shapes',
    goal: 'Say the shape of each symbol out loud before you press.',
    tool: 'shape labels under each symbol in the row, and one decoy button that differs only in shape',
    parentTip: 'Ask: “What shape comes next?”',
  },
  watch_dots: {
    lock: 'cipher', attr: 'dots', title: 'Count the Dots',
    goal: 'Count the dots on each symbol out loud before you press.',
    tool: 'dot counts under each symbol in the row, and one decoy button that differs only in dots',
    parentTip: 'Ask: “How many dots come next?”',
  },
};

// The child's Detective events in one session: a pick that matched one clue but broke another.
function detectiveEvents(session, childKey) {
  let mixup = null, solved = false;
  for (const a of session.attempts || []) {
    if (a.player !== childKey || a.type !== 'detective') continue;
    if (a.action === 'accuse' && !a.correct && a.fits && a.fits.length && a.breaks && a.breaks.length) {
      mixup = { name: a.name, fits: a.fits[0], breaks: a.breaks[0], solo: false };
    }
    if (a.action === 'part_solved') solved = true;
  }
  const solo = session.solo;
  if (!mixup && solo && solo.wrongs && solo.wrongs.length) {
    const w = solo.wrongs.find((x) => x.fits.length && x.breaks.length);
    if (w) mixup = { name: w.name, fits: w.fits[0], breaks: w.breaks[0], solo: true };
  }
  return { mixup, solved };
}

// The child's Cipher events: a symbol that was right except for exactly one feature.
function cipherEvents(session, childKey) {
  const off = {};
  let solved = false;
  for (const a of session.attempts || []) {
    if (a.player !== childKey || a.type !== 'cipher') continue;
    if ((a.action === 'press' || a.action === 'predict') && a.off && a.off.length === 1) off[a.off[0]] = (off[a.off[0]] || 0) + 1;
    if (a.action === 'part_solved') solved = true;
  }
  const top = Object.entries(off).sort((a, b) => b[1] - a[1])[0];
  return { mixup: top ? { attr: top[0], count: top[1] } : null, solved };
}

const childOf = (session) => (session.players.find((p) => p.kind === 'child') || {}).key;

function reasonText(id, r) {
  if (!r) return null;
  if (FOCUS[id].lock === 'detective') return `in the ${r.solo ? 'solo chest' : 'family Detective'}, {child} picked ${r.name}, who matched “${r.fits}” but not “${r.breaks}”`;
  return `in the Temple Cipher, {child} pressed a symbol that was right except for the ${OFF_WORD[r.attr]} (${r.count} time${r.count === 1 ? '' : 's'})`;
}

// Folds a family's sessions (oldest first) into the focus for the next expedition.
// Returns { next, history }: next is null when nothing needs practice.
function focusFor(sessions, childKey) {
  let next = null;
  const history = [];
  for (const s of sessions) {
    const who = childKey || childOf(s);
    const ev = { detective: detectiveEvents(s, who), cipher: cipherEvents(s, who) };
    const playedLock = (s.locks || []).find((l) => l.focus);
    if (playedLock) {
      const played = playedLock.focus;
      const e = ev[playedLock.type];
      const sameMixup = e.mixup && (playedLock.type === 'detective' || e.mixup.attr === FOCUS[played.id].attr);
      if (played.stage === 'scaffold') {
        next = e.solved ? { ...played, stage: 'independent' } : played;
        history.push({ sessionId: s.id, id: played.id, stage: 'scaffold', solved: e.solved });
      } else if (sameMixup) {
        next = { ...played, stage: 'scaffold', reason: e.mixup };
        history.push({ sessionId: s.id, id: played.id, stage: 'independent', mastered: false });
      } else {
        next = null;
        history.push({ sessionId: s.id, id: played.id, stage: 'independent', mastered: true });
      }
      continue;
    }
    // Nothing in practice: start one focus, the Detective first.
    if (!next && ev.detective.mixup) {
      next = { id: 'two_clues', stage: 'scaffold', reason: ev.detective.mixup, since: s.id };
      history.push({ sessionId: s.id, id: 'two_clues', noticed: ev.detective.mixup });
    } else if (!next && ev.cipher.mixup) {
      const id = 'watch_' + ev.cipher.mixup.attr;
      next = { id, stage: 'scaffold', reason: ev.cipher.mixup, since: s.id };
      history.push({ sessionId: s.id, id, noticed: ev.cipher.mixup });
    }
  }
  return { next: next && { ...next, ...FOCUS[next.id], because: reasonText(next.id, next.reason) }, history };
}

module.exports = { FOCUS, focusFor, detectiveEvents, cipherEvents, OFF_WORD };
