// 200 задач каждого типа на разных уровнях: у каждой ровно одно решение,
// и ни один игрок не может решить свою часть в одиночку.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../puzzles');

const N = 200;

test('детектив: ровно один вор, и никто не решает в одиночку', () => {
  for (let i = 0; i < N; i++) {
    const level = 1 + (i % 10);
    const puz = P.generateDetective(1000 + i, { levelScout: level, levelKeeper: level });
    const sol = P.solveDetective(puz);
    assert.deepStrictEqual(sol, [puz.solution.thief], `seed ${1000 + i}`);
    assert.ok(P.candidates(puz.lineup, puz.scoutClues).length >= 2, 'улик Разведчика не должно хватать');
    assert.ok(P.candidates(puz.lineup, puz.keeperClues).length >= 2, 'условий Хранителя не должно хватать');
    const views = P.detectiveViews(puz);
    assert.ok(!JSON.stringify(views).includes('thief'), 'решение не должно попадать во view');
  }
});

test('шифр: ровно одна верная кнопка и разные ответы у веток правила', () => {
  for (let i = 0; i < N; i++) {
    const level = 1 + (i % 10);
    const puz = P.generateCipher(5000 + i, { levelScout: level, levelKeeper: level });
    assert.strictEqual(puz.rounds.length, 3);
    for (const rd of puz.rounds) {
      const s = P.solveCipherRound(rd);
      assert.strictEqual(s.buttons.length, 1, 'на панели ровно одна подходящая кнопка');
      assert.strictEqual(s.buttons[0], rd.solution.button);
      assert.strictEqual(s.branch, rd.solution.branch);
      assert.strictEqual(new Set(rd.panel.map(P.symKey)).size, 6, '6 разных кнопок');
      const thenSym = P.CIPHER_ACTIONS[rd.thenA].pick(rd.seq, rd.cycle);
      const elseSym = P.CIPHER_ACTIONS[rd.elseA].pick(rd.seq, rd.cycle);
      assert.ok(!P.sameSym(thenSym, elseSym), 'неверная ветка ведёт к другой кнопке');
    }
    const v = P.cipherViews(puz, 0);
    assert.ok(!('cond' in v.keeper.rule && typeof v.keeper.rule.cond !== 'string'));
    assert.ok(!JSON.stringify(v).includes('solution'));
  }
});

test('чертёж: 1–3 отличия, цель однозначно задана планом', () => {
  for (let i = 0; i < N; i++) {
    const level = 1 + (i % 10);
    const puz = P.generateBlueprint(9000 + i, { levelScout: level, levelKeeper: level });
    const s = P.solveBlueprint(puz);
    assert.ok(s.diffs.length >= 1 && s.diffs.length <= 3);
    assert.deepStrictEqual(s.diffs.map((c) => `${c.z},${c.x}`).sort(), puz.solution.diffCells.map((c) => `${c.z},${c.x}`).sort());
    const n = P.sumH(puz.target);
    assert.ok(n >= 4 && n <= 14, `кубиков ${n}`);
    const v = P.blueprintViews(puz);
    assert.ok(!('target' in v.scout) && !('diffCells' in v.keeper));
  }
});

test('генераторы детерминированы по seed', () => {
  assert.deepStrictEqual(P.generateDetective(42, { levelScout: 3, levelKeeper: 3 }), P.generateDetective(42, { levelScout: 3, levelKeeper: 3 }));
  assert.deepStrictEqual(P.generateCipher(42, { levelScout: 3, levelKeeper: 3 }), P.generateCipher(42, { levelScout: 3, levelKeeper: 3 }));
});
