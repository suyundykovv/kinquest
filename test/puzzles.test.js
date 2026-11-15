// 200 puzzles of each type at different levels: each has exactly one solution,
// and no player can solve their part alone.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../puzzles');

const N = 200;

test('detective: exactly one thief, and nobody can solve it alone', () => {
  for (let i = 0; i < N; i++) {
    const level = 1 + (i % 10);
    const puz = P.generateDetective(1000 + i, { levelScout: level, levelKeeper: level });
    const sol = P.solveDetective(puz);
    assert.deepStrictEqual(sol, [puz.solution.thief], `seed ${1000 + i}`);
    assert.ok(P.candidates(puz.lineup, puz.scoutClues).length >= 2, 'Scout clues must not be enough');
    assert.ok(P.candidates(puz.lineup, puz.keeperClues).length >= 2, 'Keeper conditions must not be enough');
    const views = P.detectiveViews(puz);
    assert.ok(!JSON.stringify(views).includes('"solution"'), 'the solution must not leak into the view');
  }
});

test('cipher: exactly one correct button and different answers for the rule branches', () => {
  for (let i = 0; i < N; i++) {
    const level = 1 + (i % 10);
    const puz = P.generateCipher(5000 + i, { levelScout: level, levelKeeper: level });
    assert.strictEqual(puz.rounds.length, 3);
    for (const rd of puz.rounds) {
      const s = P.solveCipherRound(rd);
      assert.strictEqual(s.buttons.length, 1, 'exactly one matching button on the panel');
      assert.strictEqual(s.buttons[0], rd.solution.button);
      assert.strictEqual(s.branch, rd.solution.branch);
      assert.strictEqual(new Set(rd.panel.map(P.symKey)).size, 6, '6 distinct buttons');
      const thenSym = P.CIPHER_ACTIONS[rd.thenA].pick(rd.seq, rd.cycle);
      const elseSym = P.CIPHER_ACTIONS[rd.elseA].pick(rd.seq, rd.cycle);
      assert.ok(!P.sameSym(thenSym, elseSym), 'the wrong branch leads to a different button');
    }
    const v = P.cipherViews(puz, 0);
    assert.ok(!('cond' in v.keeper.rule && typeof v.keeper.rule.cond !== 'string'));
    assert.ok(!JSON.stringify(v).includes('solution'));
  }
});

test('blueprint: 1–3 differences, target uniquely defined by the plan', () => {
  for (let i = 0; i < N; i++) {
    const level = 1 + (i % 10);
    const puz = P.generateBlueprint(9000 + i, { levelScout: level, levelKeeper: level });
    const s = P.solveBlueprint(puz);
    assert.ok(s.diffs.length >= 1 && s.diffs.length <= 3);
    assert.deepStrictEqual(s.diffs.map((c) => `${c.z},${c.x}`).sort(), puz.solution.diffCells.map((c) => `${c.z},${c.x}`).sort());
    const n = P.sumH(puz.target);
    assert.ok(n >= 4 && n <= 14, `cubes ${n}`);
    const v = P.blueprintViews(puz);
    assert.ok(!('target' in v.scout) && !('diffCells' in v.keeper));
  }
});

test('generators are deterministic by seed', () => {
  assert.deepStrictEqual(P.generateDetective(42, { levelScout: 3, levelKeeper: 3 }), P.generateDetective(42, { levelScout: 3, levelKeeper: 3 }));
  assert.deepStrictEqual(P.generateCipher(42, { levelScout: 3, levelKeeper: 3 }), P.generateCipher(42, { levelScout: 3, levelKeeper: 3 }));
});

test('solo chest: 200 puzzles, exactly one answer, no single clue is enough', () => {
  for (let i = 0; i < 200; i++) {
    const z = P.generateSoloDetective(5000 + i, { level: 1 + (i % 10) });
    assert.deepStrictEqual(P.solveDetective(z), [z.solution.thief]);
    for (const c of z.scoutClues) assert.ok(P.candidates(z.lineup, [c]).length >= 2);
    // The thief fits every clue; anyone else breaks at least one.
    z.lineup.forEach((_, j) => assert.strictEqual(P.checkSuspect(z, j).every((x) => x.holds), j === z.solution.thief));
  }
});

test('cipher extras: prediction, role swap, focus decoy', () => {
  for (let i = 0; i < 200; i++) {
    const z = P.generateCipher(9000 + i, { levelScout: 1 + (i % 10), levelKeeper: 1 + ((i * 7) % 10), focusAttr: ['color', 'shape', 'dots'][i % 3] });
    const [r1, , r3] = z.rounds;
    assert.ok([r1.thenA, r1.elseA].includes('next'), 'round 1 uses the prediction');
    assert.ok(P.sameSym(r1.predict.options[r1.solution.predict], P.CIPHER_ACTIONS.next.pick(r1.seq, r1.cycle)));
    assert.strictEqual(new Set(r1.predict.options.map(P.symKey)).size, r1.predict.options.length);
    assert.ok(r3.swapped && P.cipherViews(z, 2).scout.view === 'rule' && P.cipherViews(z, 2).keeper.view === 'row');
    assert.ok(!JSON.stringify(P.cipherViews(z, 0)).includes('"solution"'));
  }
});

test('side-view question: one right answer among distinct options', () => {
  for (let i = 0; i < 200; i++) {
    const z = P.generateBlueprint(700 + i, { levelScout: 1 + (i % 10) });
    const q = P.viewQuestion(z.start, i);
    assert.ok(q.options.length >= 2 && q.answer >= 0);
    assert.strictEqual(new Set(q.options.map(String)).size, q.options.length);
    assert.deepStrictEqual(q.options[q.answer], P.projections(z.start).side.slice().reverse());
  }
});

test('fix the robot: exactly one wrong step, and it crossed out the real thief', () => {
  for (let i = 0; i < 200; i++) {
    const z = P.generateRobotCase(300 + i, { level: 1 + (i % 10) });
    assert.strictEqual(z.steps.length, z.lineup.length - 1);
    assert.ok(z.steps[z.solution.wrongStep].includes(z.lineup[z.solution.thief].name));
    assert.notStrictEqual(z.accused, z.solution.thief);
  }
});
