// Генераторы задач Kinquest и решатели, проверяющие единственность ответа.
// Всё, что должно быть точным, делает этот код. Решения никогда не уходят в браузер:
// наружу отдаются только view для конкретной роли (см. scoutView / keeperView).

'use strict';

// ---------- случайность по зерну ----------
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
// 1. ДЕТЕКТИВ (логика, критическое мышление)
// =====================================================================

const HATS = ['none', 'cap', 'crown', 'feather'];
const HAT_LABEL = { none: 'без шляпы', cap: 'в кепке', crown: 'в короне', feather: 'в шляпе с пером' };
const HAT_ICON = { none: '', cap: '🧢', crown: '👑', feather: '🪶' };
const COLORS = ['red', 'blue', 'green', 'yellow'];
const COLOR_LABEL = { red: 'красном', blue: 'синем', green: 'зелёном', yellow: 'жёлтом' };
const COLOR_ADJ = { red: 'красный', blue: 'синий', green: 'зелёный', yellow: 'жёлтый' };
const ANIMALS = [
  { emoji: '🦊', name: 'Лиса Луша' },
  { emoji: '🐰', name: 'Заяц Тим' },
  { emoji: '🦉', name: 'Сова Фила' },
  { emoji: '🐻', name: 'Медвежонок Бо' },
  { emoji: '🐿️', name: 'Белка Рыжик' },
  { emoji: '🦔', name: 'Ёжик Колюч' },
  { emoji: '🐸', name: 'Лягушонок Ква' },
  { emoji: '🐢', name: 'Черепаха Тиша' },
  { emoji: '🦝', name: 'Енот Шмыг' },
];

// Типы улик. holds(lineup, i) — верно ли условие для подозреваемого i.
// who: 'scout' — улика-картинка для ребёнка; 'keeper' — текстовое условие для взрослого.
const CLUE_TYPES = {
  hat_is: {
    who: 'scout', minLevel: 1,
    params: () => HATS.map((h) => ({ h })),
    holds: (L, i, p) => L[i].hat === p.h,
    picture: (p) => p.h === 'none'
      ? { icon: '💇', text: 'На месте нашли клочок шерсти, но ни одной шляпы. Вор был без шляпы.' }
      : { icon: HAT_ICON[p.h], text: `Нашли улику: ${{ cap: 'козырёк от кепки', crown: 'блёстку от короны', feather: 'перо от шляпы' }[p.h]}. Вор — ${HAT_LABEL[p.h]}.` },
  },
  color_is: {
    who: 'scout', minLevel: 1,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => L[i].color === p.c,
    picture: (p) => ({ icon: '🧵', color: p.c, text: `На ветке висит ${COLOR_ADJ[p.c]} ниточка. Вор одет в ${COLOR_LABEL[p.c]}.` }),
  },
  umbrella_is: {
    who: 'scout', minLevel: 1,
    params: () => [{ u: true }, { u: false }],
    holds: (L, i, p) => L[i].umbrella === p.u,
    picture: (p) => p.u
      ? { icon: '☂️', text: 'Под окном сухой круг от зонта. У вора был зонт.' }
      : { icon: '💧', text: 'Следы вора мокрые от дождя. Зонта у него не было.' },
  },
  not_color: {
    who: 'keeper', minLevel: 1,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => L[i].color !== p.c,
    text: (p) => `Вор не одет в ${COLOR_LABEL[p.c]}.`,
  },
  not_hat: {
    who: 'keeper', minLevel: 1,
    params: () => HATS.map((h) => ({ h })),
    holds: (L, i, p) => L[i].hat !== p.h,
    text: (p) => (p.h === 'none' ? 'На воре был головной убор.' : `Вор был не ${HAT_LABEL[p.h]}.`),
  },
  left_of_umbrella: {
    who: 'keeper', minLevel: 2,
    params: () => [{}],
    holds: (L, i) => L.some((s, j) => j > i && s.umbrella),
    text: () => 'Вор стоял левее кого-то с зонтом.',
  },
  right_of_hat: {
    who: 'keeper', minLevel: 3,
    params: () => HATS.filter((h) => h !== 'none').map((h) => ({ h })),
    holds: (L, i, p) => L.some((s, j) => j < i && s.hat === p.h),
    text: (p) => `Вор стоял правее кого-то ${HAT_LABEL[p.h]}.`,
  },
  next_to_color: {
    who: 'keeper', minLevel: 3,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => (L[i - 1] && L[i - 1].color === p.c) || (L[i + 1] && L[i + 1].color === p.c),
    text: (p) => `Рядом с вором стоял кто-то в ${COLOR_LABEL[p.c]}.`,
  },
  not_edge: {
    who: 'keeper', minLevel: 2,
    params: () => [{}],
    holds: (L, i) => i > 0 && i < L.length - 1,
    text: () => 'Вор не стоял с краю.',
  },
  if_umbrella_then_color: {
    who: 'keeper', minLevel: 5,
    params: () => COLORS.map((c) => ({ c })),
    holds: (L, i, p) => !L[i].umbrella || L[i].color === p.c,
    text: (p) => `Если у вора был зонт, то он одет в ${COLOR_LABEL[p.c]}.`,
  },
};

function detectiveSize(level) {
  return Math.min(9, 4 + Math.ceil(level / 2)); // ур.1→5, ур.10→9
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
    if (sig.size < n - 1) continue; // слишком много близнецов
    const thief = Math.floor(r() * n);

    const trueClues = (who, lvl) => shuffle(r, Object.entries(CLUE_TYPES)
      .filter(([, t]) => t.who === who && t.minLevel <= lvl)
      .flatMap(([type, t]) => t.params().map((p) => ({ type, p })))
      .filter((c) => CLUE_TYPES[c.type].holds(lineup, thief, c.p)));

    // Улики Разведчика: 1–2 картинки, но сами по себе они не должны выдавать вора.
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

    // Условия Хранителя: добавляем, пока не останется ровно один подозреваемый.
    const keeper = [];
    const maxKeeper = levelKeeper >= 6 ? 4 : 3;
    for (const c of trueClues('keeper', levelKeeper)) {
      const before = candidates(lineup, [...scout, ...keeper]).length;
      const after = candidates(lineup, [...scout, ...keeper, c]).length;
      if (after >= before) continue; // бесполезное условие
      if (candidates(lineup, [...keeper, c]).length < 2) continue; // взрослый не должен решить в одиночку
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
  throw new Error('detective: не удалось сгенерировать задачу для seed ' + seed);
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

// Варианты «почему ты так думаешь?» для ребёнка: одно верное объяснение и два неверных.
function detectiveWhyOptions(seed) {
  const r = rng(seed ^ 0x9e3779b9);
  return shuffle(r, [
    { id: 'all_clues', text: 'Только он подходит под все улики сразу', correct: true },
    { id: 'looks', text: 'Он выглядит хитрее остальных', correct: false },
    { id: 'guess', text: 'Просто угадал', correct: false },
  ]).map(({ id, text }) => ({ id, text }));
}

// =====================================================================
// 2. ШИФР ХРАМА (закономерности)
// =====================================================================

const SHAPES = ['circle', 'triangle', 'square', 'star', 'diamond'];
const SHAPE_LABEL = { circle: 'круг', triangle: 'треугольник', square: 'квадрат', star: 'звезда', diamond: 'ромб' };
const SHAPE_GLYPH = { circle: '●', triangle: '▲', square: '■', star: '★', diamond: '◆' };

const symKey = (s) => `${s.shape}|${s.color}|${s.dots}`;
const sameSym = (a, b) => symKey(a) === symKey(b);

// Что подсказывает действие из книги правил: какой символ должен быть нажат.
const CIPHER_ACTIONS = {
  next: { text: 'нажмите знак, который продолжает ряд', pick: (seq, cyc) => cyc[seq.length % cyc.length] },
  two_back: { text: 'нажмите знак, который стоял два шага назад (предпоследний)', pick: (seq) => seq[seq.length - 2] },
  first: { text: 'нажмите знак, с которого начинается ряд', pick: (seq) => seq[0] },
  after_next: { text: 'нажмите знак, который будет в ряду через один (не следующий, а за ним)', pick: (seq, cyc) => cyc[(seq.length + 1) % cyc.length] },
};

// Условия — то, что знает только Хранитель, но проверить может только Разведчик.
const CIPHER_CONDS = [
  { id: 'more_red', needs: 'color', text: 'Если красных знаков в ряду больше, чем синих,', test: (seq) => seq.filter((s) => s.color === 'red').length > seq.filter((s) => s.color === 'blue').length },
  { id: 'last_star', needs: 'shape', text: 'Если ряд заканчивается звездой,', test: (seq) => seq[seq.length - 1].shape === 'star' },
  { id: 'has_three', needs: 'dots', text: 'Если хотя бы у одного знака три точки,', test: (seq) => seq.some((s) => s.dots === 3) },
  { id: 'even_len', needs: null, text: 'Если знаков в ряду чётное число,', test: (seq) => seq.length % 2 === 0 },
  { id: 'first_last_same_color', needs: 'color', text: 'Если первый и последний знак одного цвета,', test: (seq) => seq[0].color === seq[seq.length - 1].color },
  { id: 'circles_gt2', needs: 'shape', text: 'Если кругов в ряду больше двух,', test: (seq) => seq.filter((s) => s.shape === 'circle').length > 2 },
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

function generateCipherRound(r, levelScout, levelKeeper) {
  const { cycleLen, attrs } = cipherParams(levelScout);
  for (let t = 0; t < 500; t++) {
    const cyc = makeCycle(r, cycleLen, attrs);
    if (!cyc) continue;
    const len = cycleLen * 2 + randInt(r, 0, cycleLen);
    const seq = Array.from({ length: len }, (_, i) => cyc[i % cyc.length]);

    const conds = CIPHER_CONDS.filter((c) => !c.needs || attrs.includes(c.needs) || levelKeeper >= 4);
    const cond = pick(r, conds);
    const actionIds = shuffle(r, Object.keys(CIPHER_ACTIONS)).filter((a) => levelKeeper >= 3 || a !== 'after_next');
    const thenA = actionIds[0];
    const elseA = actionIds[1];
    const thenSym = CIPHER_ACTIONS[thenA].pick(seq, cyc);
    const elseSym = CIPHER_ACTIONS[elseA].pick(seq, cyc);
    if (sameSym(thenSym, elseSym)) continue; // ошибка в условии должна приводить к другой кнопке

    const branch = cond.test(seq) ? 'then' : 'else';
    const answer = branch === 'then' ? thenSym : elseSym;

    // Панель из 6 разных кнопок: оба кандидата + знаки цикла + случайные.
    const buttons = [thenSym, elseSym];
    for (const s of shuffle(r, cyc)) if (!buttons.some((b) => sameSym(b, s))) buttons.push(s);
    // Отвлекающие кнопки могут отличаться любым признаком, иначе при одном признаке не набрать 6.
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
    return {
      seq, cycle: cyc, cond: cond.id, condText: cond.text, thenA, elseA,
      panel,
      solution: { branch, button: panel.findIndex((b) => sameSym(b, answer)) },
    };
  }
  throw new Error('cipher: не удалось сгенерировать раунд');
}

function generateCipher(seed, opts = {}) {
  const levelScout = clampLevel(opts.levelScout);
  const levelKeeper = clampLevel(opts.levelKeeper);
  const r = rng(seed);
  const rounds = [0, 1, 2].map(() => generateCipherRound(r, levelScout, levelKeeper));
  return { type: 'cipher', seed, levels: { scout: levelScout, keeper: levelKeeper }, rounds };
}

// Решатель: по видимому ряду и книге правил находит все кнопки, удовлетворяющие правилу.
function solveCipherRound(round) {
  const cond = CIPHER_CONDS.find((c) => c.id === round.cond);
  const branch = cond.test(round.seq) ? 'then' : 'else';
  const act = CIPHER_ACTIONS[branch === 'then' ? round.thenA : round.elseA];
  const target = act.pick(round.seq, round.cycle);
  const buttons = round.panel.map((b, i) => (sameSym(b, target) ? i : -1)).filter((i) => i >= 0);
  return { branch, buttons };
}

function cipherViews(puz, roundIdx) {
  const rd = puz.rounds[roundIdx];
  return {
    scout: { round: roundIdx, rounds: puz.rounds.length, seq: rd.seq, panel: rd.panel },
    keeper: {
      round: roundIdx, rounds: puz.rounds.length,
      rule: { cond: rd.condText, then: CIPHER_ACTIONS[rd.thenA].text, else: CIPHER_ACTIONS[rd.elseA].text },
    },
  };
}

// =====================================================================
// 3. ЧЕРТЁЖНАЯ МАСТЕРСКАЯ (пространство)
// =====================================================================
// Фигура — карта высот на сетке W×D (башни из кубиков, без нависаний).
// Хранитель видит чертёж: план сверху с цифрами + вид спереди и сбоку.
// Разведчик видит 3D-фигуру, отличающуюся на 1–3 кубика, и правит её.

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
  const front = Array.from({ length: w }, (_, x) => Math.max(...g.map((row) => row[x]))); // смотрим спереди: по столбцам
  const side = g.map((row) => Math.max(...row)); // смотрим справа: по рядам (от заднего к переднему)
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
  throw new Error('blueprint: не удалось сгенерировать задачу');
}

// Решатель: план сверху с цифрами задаёт фигуру однозначно; отличия — клетки, где высоты разные.
function solveBlueprint(puz) {
  const diffs = [];
  for (let z = 0; z < puz.d; z++) for (let x = 0; x < puz.w; x++) if (puz.start[z][x] !== puz.target[z][x]) diffs.push({ z, x });
  return { target: puz.target, diffs };
}

function blueprintViews(puz) {
  return {
    scout: { w: puz.w, d: puz.d, grid: puz.start },
    keeper: { w: puz.w, d: puz.d, plan: puz.target, ...projections(puz.target) },
  };
}

module.exports = {
  rng, shuffle, clampLevel,
  generateDetective, solveDetective, detectiveViews, detectiveWhyOptions, candidates, CLUE_TYPES,
  generateCipher, solveCipherRound, cipherViews, CIPHER_CONDS, CIPHER_ACTIONS, SHAPE_LABEL, SHAPE_GLYPH, symKey, sameSym,
  generateBlueprint, solveBlueprint, blueprintViews, projections, sumH,
  HAT_LABEL, COLOR_LABEL, COLOR_ADJ, ANIMALS,
};
