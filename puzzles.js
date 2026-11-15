// Kinquest puzzle generators and solvers that verify the answer is unique.
// This code does everything that must be exact. Solutions never go to the browser:
// only role-specific views are sent out (see scoutView / keeperView).

'use strict';

// ---------- seeded randomness ----------
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
function shuffle(r, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const clampLevel = (l) => Math.max(1, Math.min(10, Math.round(l || 1)));

// =====================================================================
// 1. DETECTIVE (logic, critical thinking)
// =====================================================================

const HATS = ['none', 'cap', 'crown', 'feather'];
const HAT_LABEL = { none: 'no hat', cap: 'a cap', crown: 'a crown', feather: 'a feathered hat' };
const HAT_ICON = { none: '', cap: '🧢', crown: '👑', feather: '🪶' };
const COLORS = ['red', 'blue', 'green', 'yellow'];
const COLOR_LABEL = { red: 'red', blue: 'blue', green: 'green', yellow: 'yellow' };
const COLOR_ADJ = COLOR_LABEL;
const ANIMALS = [
  { emoji: '🦊', name: 'Foxy Fern' },
  { emoji: '🐰', name: 'Tim the Rabbit' },
  { emoji: '🦉', name: 'Wise Owl Ada' },
  { emoji: '🐻', name: 'Bo the Bear Cub' },
  { emoji: '🐿️', name: 'Rusty Squirrel' },
  { emoji: '🦔', name: 'Spike Hedgehog' },
  { emoji: '🐸', name: 'Croaky Frog' },
  { emoji: '🐢', name: 'Slowpoke Turtle' },
  { emoji: '🦝', name: 'Rocky Raccoon' },
];

// Clue types. holds(lineup, i) — whether the condition is true for suspect i.
// who: 'scout' — picture clue for the child; 'keeper' — text condition for the adult.
const CLUE_TYPES = {
  hat_is: {
    who: 'scout', minLevel: 1,
    params: () => HATS.map((h) => ({ h })),
    holds: (L, i, p) => L[i].hat === p.h,
    picture: (p) => p.h === 'none'
      ? { icon: '💇', text: 'We found a tuft of fur but no hat at all. The thief wore no hat.' }
      : { icon: HAT_ICON[p.h], text: `We found a clue: ${{ cap: 'the brim of a cap', crown: 'a sparkle from a crown', feather: 'a feather from a hat' }[p.h]}. The thief wore ${HAT_LABEL[p.h]}.` },
  },
  color_is: {
    who: 'scout', minLevel: 1,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => L[i].color === p.c,
    picture: (p) => ({ icon: '🧵', color: p.c, text: `A ${COLOR_ADJ[p.c]} thread is caught on a branch. The thief wears ${COLOR_LABEL[p.c]}.` }),
  },
  umbrella_is: {
    who: 'scout', minLevel: 1,
    params: () => [{ u: true }, { u: false }],
    holds: (L, i, p) => L[i].umbrella === p.u,
    picture: (p) => p.u
      ? { icon: '☂️', text: 'There is a dry circle under the window. The thief had an umbrella.' }
      : { icon: '💧', text: 'The thief’s footprints are wet from the rain. No umbrella!' },
  },
  not_color: {
    who: 'keeper', minLevel: 1,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => L[i].color !== p.c,
    text: (p) => `The thief is not wearing ${COLOR_LABEL[p.c]}.`,
  },
  not_hat: {
    who: 'keeper', minLevel: 1,
    params: () => HATS.map((h) => ({ h })),
    holds: (L, i, p) => L[i].hat !== p.h,
    text: (p) => (p.h === 'none' ? 'The thief was wearing something on their head.' : `The thief was not wearing ${HAT_LABEL[p.h]}.`),
  },
  left_of_umbrella: {
    who: 'keeper', minLevel: 2,
    params: () => [{}],
    holds: (L, i) => L.some((s, j) => j > i && s.umbrella),
    text: () => 'The thief stood somewhere left of a neighbor with an umbrella.',
  },
  right_of_hat: {
    who: 'keeper', minLevel: 3,
    params: () => HATS.filter((h) => h !== 'none').map((h) => ({ h })),
    holds: (L, i, p) => L.some((s, j) => j < i && s.hat === p.h),
    text: (p) => `The thief stood somewhere right of a neighbor wearing ${HAT_LABEL[p.h]}.`,
  },
  next_to_color: {
    who: 'keeper', minLevel: 3,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => (L[i - 1] && L[i - 1].color === p.c) || (L[i + 1] && L[i + 1].color === p.c),
    text: (p) => `Right next to the thief stood someone in ${COLOR_LABEL[p.c]}.`,
  },
  not_edge: {
    who: 'keeper', minLevel: 2,
    params: () => [{}],
    holds: (L, i) => i > 0 && i < L.length - 1,
    text: () => 'The thief was not standing at either end of the line.',
  },
  if_umbrella_then_color: {
    who: 'keeper', minLevel: 5,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => !L[i].umbrella || L[i].color === p.c,
    text: (p) => `If the thief had an umbrella, then the thief wears ${COLOR_LABEL[p.c]}.`,
  },
};

function detectiveSize(level) {
  return Math.min(9, 4 + Math.ceil(level / 2)); // lvl 1→5, lvl 10→9
}

function candidates(lineup, clues) {
  const out = [];
  for (let i = 0; i < lineup.length; i++) {
    if (clues.every((c) => CLUE_TYPES[c.type].holds(lineup, i, c.p))) out.push(i);
  }
  return out;
}

function generateDetective(seed, opts = {}) {
  const levelScout = clampLevel(opts.levelScout);
  const levelKeeper = clampLevel(opts.levelKeeper);
  const level = Math.max(levelScout, levelKeeper);
  const r = rng(seed);
  const n = detectiveSize(level);
  const cast = opts.cast && opts.cast.length >= n ? opts.cast : ANIMALS;

  for (let attempt = 0; attempt < 2000; attempt++) {
    const actors = shuffle(r, cast).slice(0, n);
    const lineup = actors.map((a) => ({
      name: a.name, emoji: a.emoji,
      hat: pick(r, HATS), color: pick(r, COLORS), umbrella: r() < 0.45,
    }));
    const sig = new Set(lineup.map((s) => `${s.hat}|${s.color}|${s.umbrella}`));
    if (sig.size < n - 1) continue; // too many lookalikes
    const thief = Math.floor(r() * n);

    const trueClues = (who, lvl) => shuffle(r, Object.entries(CLUE_TYPES)
      .filter(([, t]) => t.who === who && t.minLevel <= lvl)
      .flatMap(([type, t]) => t.params().map((p) => ({ type, p })))
      .filter((c) => CLUE_TYPES[c.type].holds(lineup, thief, c.p)));

    // Scout clues: 1–2 pictures, but on their own they must not reveal the thief.
    const scoutCount = levelScout >= 4 ? 2 : 1;
    const scout = [];
    for (const c of trueClues('scout', levelScout)) {
      if (scout.some((s) => s.type === c.type)) continue;
      const next = [...scout, c];
      if (candidates(lineup, next).length < 2) continue;
      scout.push(c);
      if (scout.length === scoutCount) break;
    }
    if (scout.length !== scoutCount) continue;

    // Keeper conditions: add until exactly one suspect remains.
    const keeper = [];
    const maxKeeper = levelKeeper >= 6 ? 4 : 3;
    for (const c of trueClues('keeper', levelKeeper)) {
      const before = candidates(lineup, [...scout, ...keeper]).length;
      const after = candidates(lineup, [...scout, ...keeper, c]).length;
      if (after >= before) continue; // useless condition
      if (candidates(lineup, [...keeper, c]).length < 2) continue; // the adult must not solve it alone
      keeper.push(c);
      if (after === 1 || keeper.length === maxKeeper) break;
    }
    const all = [...scout, ...keeper];
    const sol = candidates(lineup, all);
    if (sol.length !== 1 || sol[0] !== thief) continue;
    if (candidates(lineup, scout).length < 2 || candidates(lineup, keeper).length < 2) continue;
    if (keeper.length < 2) continue;

    return {
      type: 'detective', seed, levels: { scout: levelScout, keeper: levelKeeper },
      lineup, scoutClues: scout, keeperClues: keeper,
      solution: { thief },
    };
  }
  throw new Error('detective: failed to generate a puzzle for seed ' + seed);
}

function solveDetective(puz) {
  return candidates(puz.lineup, [...puz.scoutClues, ...puz.keeperClues]);
}

function detectiveViews(puz) {
  const lineup = puz.lineup.map((s, i) => ({ i, name: s.name, emoji: s.emoji, hat: s.hat, color: s.color, umbrella: s.umbrella }));
  return {
    scout: {
      lineup,
      clues: puz.scoutClues.map((c) => CLUE_TYPES[c.type].picture(c.p)),
    },
    keeper: {
      lineup,
      clues: puz.keeperClues.map((c) => CLUE_TYPES[c.type].text(c.p)),
    },
  };
}

// Short words for a clue ("the thief wears red"), used in explanations and the report.
function clueShort(c) {
  const p = c.p;
  if (c.type === 'hat_is') return p.h === 'none' ? 'the thief wore no hat' : `the thief wore ${HAT_LABEL[p.h]}`;
  if (c.type === 'color_is') return `the thief wears ${COLOR_LABEL[p.c]}`;
  if (c.type === 'umbrella_is') return p.u ? 'the thief had an umbrella' : 'the thief had no umbrella';
  const t = CLUE_TYPES[c.type].text(p);
  return t.charAt(0).toLowerCase() + t.slice(1).replace(/\.$/, '');
}

// What a picture clue looks at on one suspect: "wears red", "has no umbrella".
function suspectFact(s, type) {
  if (type === 'hat_is') return s.hat === 'none' ? 'wears no hat' : `wears ${HAT_LABEL[s.hat]}`;
  if (type === 'color_is') return `wears ${COLOR_LABEL[s.color]}`;
  if (type === 'umbrella_is') return s.umbrella ? 'has an umbrella' : 'has no umbrella';
  return null;
}

// Checks one clue against one suspect and says why, without naming the thief.
// holds=true: the clue fits this suspect, so it can't rule them out.
function explainClue(lineup, i, c) {
  const s = lineup[i];
  const holds = CLUE_TYPES[c.type].holds(lineup, i, c.p);
  const fact = suspectFact(s, c.type);
  const short = clueShort(c);
  let text;
  if (fact) text = holds ? `${s.name} ${fact}, and ${short}.` : `${s.name} ${fact}, but ${short}.`;
  else text = holds ? `${s.name} fits the note “${CLUE_TYPES[c.type].text(c.p)}”` : `${s.name} doesn’t fit the note “${CLUE_TYPES[c.type].text(c.p)}”`;
  return { holds, text, short };
}

// Every clue (Scout's first, then the Keeper's) checked against one suspect.
function checkSuspect(puz, i) {
  return [
    ...puz.scoutClues.map((c, k) => ({ who: 'scout', k, ...explainClue(puz.lineup, i, c) })),
    ...puz.keeperClues.map((c, k) => ({ who: 'keeper', k, ...explainClue(puz.lineup, i, c) })),
  ];
}

// The Scout's solo chest: a small lineup and 2–3 picture clues, all on the kid's own screen.
// Same method as the family Detective: no single clue is enough, together they leave one suspect.
function generateSoloDetective(seed, opts = {}) {
  const level = clampLevel(opts.level);
  const r = rng(seed ^ 0x51f15e);
  const n = level >= 5 ? 5 : 4;
  const clueCount = level >= 7 ? 3 : 2;
  const cast = opts.cast && opts.cast.length >= n ? opts.cast : ANIMALS;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const lineup = shuffle(r, cast).slice(0, n).map((a) => ({ name: a.name, emoji: a.emoji, hat: pick(r, HATS), color: pick(r, COLORS), umbrella: r() < 0.5 }));
    if (new Set(lineup.map((s) => `${s.hat}|${s.color}|${s.umbrella}`)).size < n) continue;
    const thief = Math.floor(r() * n);
    const pool = shuffle(r, Object.entries(CLUE_TYPES)
      .filter(([, t]) => t.who === 'scout')
      .flatMap(([type, t]) => t.params().map((p) => ({ type, p })))
      .filter((c) => CLUE_TYPES[c.type].holds(lineup, thief, c.p)));
    const clues = [];
    for (const c of pool) {
      if (clues.some((x) => x.type === c.type)) continue;
      if (candidates(lineup, [c]).length < 2) continue; // one clue alone must never be enough
      const before = candidates(lineup, clues).length;
      if (candidates(lineup, [...clues, c]).length >= before) continue;
      clues.push(c);
      if (clues.length === clueCount) break;
    }
    if (clues.length !== clueCount) continue;
    const sol = candidates(lineup, clues);
    if (sol.length !== 1 || sol[0] !== thief) continue;
    return { type: 'detective', solo: true, seed, levels: { scout: level }, lineup, scoutClues: clues, keeperClues: [], solution: { thief } };
  }
  throw new Error('solo detective: failed to generate a puzzle for seed ' + seed);
}

// =====================================================================
// 2. TEMPLE CIPHER (patterns)
// =====================================================================

const SHAPES = ['circle', 'triangle', 'square', 'star', 'diamond'];
const SHAPE_LABEL = { circle: 'circle', triangle: 'triangle', square: 'square', star: 'star', diamond: 'diamond' };
const SHAPE_GLYPH = { circle: '●', triangle: '▲', square: '■', star: '★', diamond: '◆' };

const symKey = (s) => `${s.shape}|${s.color}|${s.dots}`;
const sameSym = (a, b) => symKey(a) === symKey(b);

// What a rulebook action indicates: which symbol must be pressed.
const CIPHER_ACTIONS = {
  next: { icon: '➡️', text: 'press the symbol that comes next in the row', pick: (seq, cyc) => cyc[seq.length % cyc.length] },
  two_back: { icon: '⬅️⬅️', text: 'press the symbol two steps back (the second to last)', pick: (seq) => seq[seq.length - 2] },
  first: { icon: '⏮️', text: 'press the symbol the row starts with', pick: (seq) => seq[0] },
  after_next: { icon: '⏭️', text: 'press the symbol that comes two spots later (skip the next one)', pick: (seq, cyc) => cyc[(seq.length + 1) % cyc.length] },
};

// Conditions are what only the Keeper knows, but only the Scout can check.
const CIPHER_CONDS = [
  { id: 'more_red', icon: '🔴 > 🔵 ?', needs: 'color', text: 'If the row has more red symbols than blue ones,', test: (seq) => seq.filter((s) => s.color === 'red').length > seq.filter((s) => s.color === 'blue').length },
  { id: 'last_star', icon: '… ★ ?', needs: 'shape', text: 'If the row ends with a star,', test: (seq) => seq[seq.length - 1].shape === 'star' },
  { id: 'has_three', icon: '••• ?', needs: 'dots', text: 'If at least one symbol has three dots,', test: (seq) => seq.some((s) => s.dots === 3) },
  { id: 'even_len', icon: '2 · 4 · 6 ?', needs: null, text: 'If the row has an even number of symbols,', test: (seq) => seq.length % 2 === 0 },
  { id: 'first_last_same_color', icon: '🎨 … 🎨 ?', needs: 'color', text: 'If the first and last symbols are the same color,', test: (seq) => seq[0].color === seq[seq.length - 1].color },
  { id: 'circles_gt2', icon: '● ● ● + ?', needs: 'shape', text: 'If the row has more than two circles,', test: (seq) => seq.filter((s) => s.shape === 'circle').length > 2 },
];

function cipherParams(level) {
  return {
    cycleLen: Math.min(5, 2 + Math.floor((level - 1) / 3)), // 2..5
    attrs: level <= 2 ? ['shape'] : level <= 5 ? ['shape', 'color'] : ['shape', 'color', 'dots'],
  };
}

function makeCycle(r, len, attrs) {
  for (let t = 0; t < 200; t++) {
    const base = { shape: pick(r, SHAPES), color: pick(r, COLORS), dots: randInt(r, 1, 3) };
    const cyc = [];
    for (let i = 0; i < len; i++) {
      const s = { ...base };
      for (const a of attrs) {
        if (a === 'shape') s.shape = pick(r, SHAPES);
        if (a === 'color') s.color = pick(r, COLORS);
        if (a === 'dots') s.dots = randInt(r, 1, 3);
      }
      cyc.push(s);
    }
    if (new Set(cyc.map(symKey)).size === len) return cyc;
  }
  return null;
}

// levelRow: whoever sees the row; levelRule: whoever reads the rule book (swapped in the last round).
// opts.needNext: one branch says "press what comes next", so the Scout's prediction is used.
// opts.focusAttr: the row varies in that feature, and the panel has a decoy that differs only in it.
function generateCipherRound(r, levelScout, levelKeeper, opts = {}) {
  const base = cipherParams(levelScout);
  const cycleLen = base.cycleLen;
  const attrs = opts.focusAttr && !base.attrs.includes(opts.focusAttr) ? [...base.attrs, opts.focusAttr] : base.attrs;
  for (let t = 0; t < 500; t++) {
    const cyc = makeCycle(r, cycleLen, attrs);
    if (!cyc) continue;
    const len = cycleLen * 2 + randInt(r, 0, cycleLen);
    const seq = Array.from({ length: len }, (_, i) => cyc[i % cyc.length]);

    const conds = CIPHER_CONDS.filter((c) => !c.needs || attrs.includes(c.needs) || levelKeeper >= 4);
    const cond = pick(r, conds);
    const actionIds = shuffle(r, Object.keys(CIPHER_ACTIONS)).filter((a) => levelKeeper >= 3 || a !== 'after_next');
    if (opts.needNext && !actionIds.slice(0, 2).includes('next')) continue;
    const thenA = actionIds[0];
    const elseA = actionIds[1];
    const thenSym = CIPHER_ACTIONS[thenA].pick(seq, cyc);
    const elseSym = CIPHER_ACTIONS[elseA].pick(seq, cyc);
    if (sameSym(thenSym, elseSym)) continue; // a wrong condition must lead to a different button

    const branch = cond.test(seq) ? 'then' : 'else';
    const answer = branch === 'then' ? thenSym : elseSym;

    // Panel of 6 distinct buttons: both candidates + cycle signs + random ones.
    const buttons = [thenSym, elseSym];
    if (opts.focusAttr) {
      const decoy = { ...answer };
      for (let g = 0; g < 20 && sameSym(decoy, answer); g++) {
        if (opts.focusAttr === 'shape') decoy.shape = pick(r, SHAPES);
        if (opts.focusAttr === 'color') decoy.color = pick(r, COLORS);
        if (opts.focusAttr === 'dots') decoy.dots = randInt(r, 1, 3);
      }
      if (!buttons.some((b) => sameSym(b, decoy))) buttons.push(decoy);
    }
    for (const s of shuffle(r, cyc)) if (!buttons.some((b) => sameSym(b, s))) buttons.push(s);
    // Decoy buttons may differ by any feature, otherwise 6 can't be reached with one feature.
    for (let guard = 0; buttons.length < 6 && guard < 500; guard++) {
      const s = { ...pick(r, cyc) };
      const a = pick(r, ['shape', 'color', 'dots']);
      if (a === 'shape') s.shape = pick(r, SHAPES);
      if (a === 'color') s.color = pick(r, COLORS);
      if (a === 'dots') s.dots = randInt(r, 1, 3);
      if (!buttons.some((b) => sameSym(b, s))) buttons.push(s);
    }
    if (buttons.length < 6) continue;
    const panel = shuffle(r, buttons.slice(0, 6));
    const out = {
      seq, cycle: cyc, cond: cond.id, condText: cond.text, condIcon: cond.icon, thenA, elseA,
      panel,
      solution: { branch, button: panel.findIndex((b) => sameSym(b, answer)) },
    };
    if (opts.predict) {
      // The Scout's own step: pick what comes next and say which features change along the row.
      const next = CIPHER_ACTIONS.next.pick(seq, cyc);
      const options = [next];
      for (let g = 0; options.length < 4 && g < 200; g++) {
        const s = { ...next };
        const a = pick(r, attrs.length > 1 || g > 40 ? ['shape', 'color', 'dots'] : attrs);
        if (a === 'shape') s.shape = pick(r, SHAPES);
        if (a === 'color') s.color = pick(r, COLORS);
        if (a === 'dots') s.dots = randInt(r, 1, 3);
        if (!options.some((o) => sameSym(o, s))) options.push(s);
      }
      const shuffled = shuffle(r, options);
      out.predict = { options: shuffled };
      out.solution.predict = shuffled.findIndex((o) => sameSym(o, next));
      out.solution.changes = ['shape', 'color', 'dots'].filter((a) => new Set(cyc.map((c) => c[a])).size > 1);
    }
    return out;
  }
  throw new Error('cipher: failed to generate a round');
}

function generateCipher(seed, opts = {}) {
  const levelScout = clampLevel(opts.levelScout);
  const levelKeeper = clampLevel(opts.levelKeeper);
  const r = rng(seed);
  const f = { focusAttr: opts.focusAttr };
  // Round 1: the Scout predicts first and the rule uses it. Round 3: roles swap, the kid holds the rule.
  const rounds = [
    generateCipherRound(r, levelScout, levelKeeper, { ...f, predict: true, needNext: true }),
    generateCipherRound(r, levelScout, levelKeeper, f),
    { ...generateCipherRound(r, levelKeeper, levelScout), swapped: true },
  ];
  return { type: 'cipher', seed, levels: { scout: levelScout, keeper: levelKeeper }, rounds };
}

// Solver: from the visible row and the rulebook, finds all buttons that satisfy the rule.
function solveCipherRound(round) {
  const cond = CIPHER_CONDS.find((c) => c.id === round.cond);
  const branch = cond.test(round.seq) ? 'then' : 'else';
  const act = CIPHER_ACTIONS[branch === 'then' ? round.thenA : round.elseA];
  const target = act.pick(round.seq, round.cycle);
  const buttons = round.panel.map((b, i) => (sameSym(b, target) ? i : -1)).filter((i) => i >= 0);
  return { branch, buttons };
}

// In a swapped round the grown-up sees the row and presses; the kid reads a picture rule and picks the branch.
function cipherViews(puz, roundIdx) {
  const rd = puz.rounds[roundIdx];
  const row = { view: 'row', round: roundIdx, rounds: puz.rounds.length, seq: rd.seq, panel: rd.panel, swapped: !!rd.swapped, predict: rd.predict ? { options: rd.predict.options } : null };
  const rule = {
    view: 'rule', round: roundIdx, rounds: puz.rounds.length, swapped: !!rd.swapped,
    rule: {
      cond: rd.condText, then: CIPHER_ACTIONS[rd.thenA].text, else: CIPHER_ACTIONS[rd.elseA].text,
      icons: { cond: rd.condIcon, then: CIPHER_ACTIONS[rd.thenA].icon, else: CIPHER_ACTIONS[rd.elseA].icon },
    },
    usesPrediction: !!rd.predict,
  };
  return rd.swapped ? { scout: rule, keeper: row } : { scout: row, keeper: rule };
}
// Which role presses the panel (the row holder) in this round.
const cipherPresser = (rd) => (rd.swapped ? 'keeper' : 'scout');

// =====================================================================
// 3. BLUEPRINT WORKSHOP (space)
// =====================================================================
// The figure is a height map on a W×D grid (towers of cubes, no overhangs).
// The Keeper sees the blueprint: top plan with numbers + front and side views.
// The Scout sees a 3D figure that differs by 1–3 cubes and fixes it.

function blueprintParams(level) {
  return {
    w: level <= 3 ? 3 : 4,
    d: level <= 6 ? 3 : 4,
    minCubes: Math.min(12, 3 + level),
    maxCubes: Math.min(14, 6 + level),
    diffs: level <= 3 ? 1 : level <= 7 ? 2 : 3,
    maxH: level <= 4 ? 2 : 3,
  };
}

const sumH = (g) => g.reduce((a, row) => a + row.reduce((x, y) => x + y, 0), 0);

function projections(g) {
  const d = g.length, w = g[0].length;
  const front = Array.from({ length: w }, (_, x) => Math.max(...g.map((row) => row[x]))); // view from the front: by columns
  const side = g.map((row) => Math.max(...row)); // view from the right: by rows (back to front)
  const top = g.map((row) => row.map((h) => (h > 0 ? 1 : 0)));
  return { front, side, top, w, d };
}

function generateBlueprint(seed, opts = {}) {
  const levelScout = clampLevel(opts.levelScout);
  const levelKeeper = clampLevel(opts.levelKeeper);
  const r = rng(seed);
  const p = blueprintParams(levelScout);
  for (let t = 0; t < 2000; t++) {
    const target = Array.from({ length: p.d }, () => Array.from({ length: p.w }, () => (r() < 0.75 ? randInt(r, 1, p.maxH) : 0)));
    const n = sumH(target);
    if (n < p.minCubes || n > p.maxCubes) continue;
    const start = target.map((row) => row.slice());
    const cells = shuffle(r, Array.from({ length: p.w * p.d }, (_, k) => [Math.floor(k / p.w), k % p.w]));
    const diffCells = [];
    for (const [z, x] of cells) {
      if (diffCells.length === p.diffs) break;
      const h = target[z][x];
      const opts2 = [];
      if (h < p.maxH + 1) opts2.push(+1);
      if (h > 0) opts2.push(-1);
      const delta = pick(r, opts2);
      start[z][x] = h + delta;
      diffCells.push({ z, x });
    }
    if (diffCells.length !== p.diffs) continue;
    if (sumH(start) < 3) continue;
    return {
      type: 'blueprint', seed, levels: { scout: levelScout, keeper: levelKeeper },
      w: p.w, d: p.d, start, target,
      solution: { target, diffCells },
    };
  }
  throw new Error('blueprint: failed to generate a puzzle');
}

// Solver: the top plan with numbers defines the figure uniquely; differences are cells where heights differ.
function solveBlueprint(puz) {
  const diffs = [];
  for (let z = 0; z < puz.d; z++) for (let x = 0; x < puz.w; x++) if (puz.start[z][x] !== puz.target[z][x]) diffs.push({ z, x });
  return { target: puz.target, diffs };
}

// "How does your model look from the right side?" asked before the Scout turns it.
// Options: the real right-side view, the front view (a classic mix-up) and a one-tower change.
function viewQuestion(grid, seed) {
  const r = rng(seed ^ 0x5eed);
  const p = projections(grid);
  // Seen from the right, the front row is on the viewer's left (same as the Keeper's blueprint drawing).
  const side = p.side.slice().reverse();
  const key = (a) => a.join(',');
  const options = [side];
  const add = (a) => { if (a.length && !options.some((o) => key(o) === key(a))) options.push(a); };
  if (p.front.length === side.length) add(p.front);
  add(p.side.slice());
  for (let g = 0; options.length < 3 && g < 50; g++) {
    const a = side.slice();
    const i = Math.floor(r() * a.length);
    a[i] = Math.max(0, Math.min(4, a[i] + (r() < 0.5 ? -1 : 1)));
    add(a);
  }
  const shuffled = shuffle(r, options.slice(0, 3));
  return { options: shuffled, answer: shuffled.findIndex((o) => key(o) === key(side)) };
}

function blueprintViews(puz) {
  return {
    scout: { w: puz.w, d: puz.d, grid: puz.start },
    keeper: { w: puz.w, d: puz.d, plan: puz.target, ...projections(puz.target) },
  };
}

// "Fix the Robot": Robo solved a small case, but one cross-out is wrong: it ruled out the real
// thief with a clue that fits them. The kid finds the wrong step, then names the real thief.
function generateRobotCase(seed, opts = {}) {
  const puz = generateSoloDetective(seed ^ 0xb07, opts);
  const r = rng(seed ^ 0xb07b07);
  const thief = puz.solution.thief;
  const innocents = shuffle(r, puz.lineup.map((_, i) => i).filter((i) => i !== thief));
  const leftOver = innocents.pop(); // Robo never checks this one and accuses them
  const step = (i, c, wrong) => {
    const s = puz.lineup[i];
    return { i, wrong, text: `${s.name} ${suspectFact(s, c.type)}. The clue says ${clueShort(c)}. That doesn’t match, so I crossed ${s.name} out!` };
  };
  const steps = innocents.map((i) => step(i, puz.scoutClues.find((c) => !CLUE_TYPES[c.type].holds(puz.lineup, i, c.p)), false));
  const misread = puz.scoutClues[Math.floor(r() * puz.scoutClues.length)];
  steps.push(step(thief, misread, true));
  const ordered = shuffle(r, steps);
  return {
    ...puz, robot: true,
    steps: ordered.map((x) => x.text),
    accused: leftOver,
    solution: { thief, wrongStep: ordered.findIndex((x) => x.wrong) },
  };
}

module.exports = {
  rng, shuffle, clampLevel,
  generateDetective, solveDetective, detectiveViews, candidates, CLUE_TYPES,
  clueShort, explainClue, checkSuspect, generateSoloDetective,
  generateCipher, solveCipherRound, cipherViews, cipherPresser, viewQuestion, generateRobotCase, suspectFact, CIPHER_CONDS, CIPHER_ACTIONS, SHAPE_LABEL, SHAPE_GLYPH, symKey, sameSym,
  generateBlueprint, solveBlueprint, blueprintViews, projections, sumH,
  HAT_LABEL, COLOR_LABEL, COLOR_ADJ, ANIMALS,
};
