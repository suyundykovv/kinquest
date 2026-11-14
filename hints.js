// Лесенка подсказок (3 ступени): наводящий вопрос → сужение → один шаг решения.
// Полный ответ подсказка не даёт никогда. Шаблоны в коде, данные — из задачи на сервере.
'use strict';
const P = require('./puzzles');

const HINT_AFTER_ERRORS = 2;
const HINT_AFTER_MS = 90000;

function nonThieves(puz) {
  return puz.lineup.map((s, i) => i).filter((i) => i !== puz.solution.thief);
}

function detectiveHint(puz, role, level, seedPick) {
  const others = nonThieves(puz);
  const name = (i) => `${puz.lineup[i].emoji} ${puz.lineup[i].name}`;
  if (level === 1) {
    return role === 'scout'
      ? 'Спроси Хранителя: что сказано в его записках про зонты, цвета и место в ряду?'
      : 'Попросите Разведчика описать каждую найденную улику-картинку — что на ней нарисовано?';
  }
  if (level === 2) {
    // Сужение: вычёркиваем примерно половину невиновных, но оставляем минимум двух кандидатов.
    const keep = Math.max(1, Math.floor(others.length / 2));
    const drop = others.slice(0, others.length - keep).sort((a, b) => ((a * 7 + seedPick) % 5) - ((b * 7 + seedPick) % 5));
    return `Точно не воры: ${drop.map(name).join(', ')}.`;
  }
  // Ступень 3: «один шаг решения» — остаются два кандидата, выбор за игроками.
  const decoy = others[seedPick % others.length];
  return `Вор — один из двух: ${[decoy, puz.solution.thief].sort((a, b) => a - b).map(name).join(' или ')}. Проверьте улики ещё раз!`;
}

function cipherHint(puz, roundIdx, role, level) {
  const rd = puz.rounds[roundIdx];
  const cond = P.CIPHER_CONDS.find((c) => c.id === rd.cond);
  if (role === 'keeper') {
    if (level === 1) return 'Спросите Разведчика ровно то, что нужно для условия: посчитайте вместе нужные знаки вслух.';
    if (level === 2) return `Чтобы проверить условие, нужен признак: ${{ color: 'цвет знаков', shape: 'форма знаков', dots: 'число точек', null: 'количество знаков' }[cond.needs]}. Остальное не важно.`;
    return `Знаков в ряду: ${rd.seq.length}. Первый знак — ${P.SHAPE_LABEL[rd.seq[0].shape]}, последний — ${P.SHAPE_LABEL[rd.seq[rd.seq.length - 1].shape]}.`;
  }
  const wrong = rd.panel.map((b, i) => i).filter((i) => i !== rd.solution.button);
  if (level === 1) return 'Назови Хранителю все знаки по порядку: форму, цвет и сколько точек. Он скажет, какое правило работает.';
  if (level === 2) return `Кнопки №${wrong.slice(0, 2).map((i) => i + 1).join(' и №')} точно не подходят.`;
  return `Кнопки №${wrong.slice(0, 4).map((i) => i + 1).join(', №')} не подходят. Осталось выбрать из двух.`;
}

function blueprintHint(puz, role, level, current) {
  const diffs = [];
  for (let z = 0; z < puz.d; z++) for (let x = 0; x < puz.w; x++) if ((current ? current[z][x] : puz.start[z][x]) !== puz.target[z][x]) diffs.push({ z, x });
  const rowName = (z) => (z === puz.d - 1 ? 'передний ряд' : z === 0 ? 'задний ряд' : `${puz.d - z}-й ряд спереди`);
  const cellName = (c) => `${rowName(c.z)}, ${c.x + 1}-я башня слева`;
  if (role === 'keeper') {
    if (level === 1) return 'Попросите Разведчика повернуть фигуру и назвать высоту каждой башни слева направо, ряд за рядом.';
    if (level === 2) return `Отличий от чертежа всего: ${puz.solution.diffCells.length}.`;
    const c = puz.solution.diffCells[0];
    return `Одно из отличий: ${cellName(c)}.`;
  }
  if (level === 1) return 'Спроси Хранителя, сколько кубиков в каждой башне заднего ряда. Поверни фигуру, чтобы увидеть спрятанные кубики!';
  if (!diffs.length) return 'Похоже, фигура уже совпадает — нажми «Проверить».';
  if (level === 2) {
    const left = diffs.filter((c) => c.x < puz.w / 2).length;
    return left >= diffs.length - left ? 'Ошибка есть в левой половине фигуры.' : 'Ошибка есть в правой половине фигуры.';
  }
  const c = diffs[0];
  return { text: `Посмотри на подсвеченную башню: в ней кубиков ${current && current[c.z][c.x] > puz.target[c.z][c.x] ? 'больше' : 'меньше'}, чем нужно.`, highlight: c };
}

module.exports = { detectiveHint, cipherHint, blueprintHint, HINT_AFTER_ERRORS, HINT_AFTER_MS };
