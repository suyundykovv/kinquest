// Hint ladder (3 steps): a leading question → narrowing down → one step of the solution.
// A hint never gives the full answer. Templates live in code; the data comes from the puzzle on the server.
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
      ? 'Ask the Keeper: what do their notes say about umbrellas, colors, and places in line?'
      : 'Ask the Scout to describe every picture clue they found. What is on each one?';
  }
  if (level === 2) {
    // Narrowing down: rule out about half of the innocent suspects, but always leave at least two candidates.
    const keep = Math.max(1, Math.floor(others.length / 2));
    const drop = others.slice(0, others.length - keep).sort((a, b) => ((a * 7 + seedPick) % 5) - ((b * 7 + seedPick) % 5));
    return `Definitely not the thief: ${drop.map(name).join(', ')}.`;
  }
  // Step 3: "one step of the solution" — two candidates remain, the players still choose.
  const decoy = others[seedPick % others.length];
  return `The thief is one of these two: ${[decoy, puz.solution.thief].sort((a, b) => a - b).map(name).join(' or ')}. Check the clues again!`;
}

function cipherHint(puz, roundIdx, role, level) {
  const rd = puz.rounds[roundIdx];
  const cond = P.CIPHER_CONDS.find((c) => c.id === rd.cond);
  if (role === 'keeper') {
    if (level === 1) return 'Ask the Scout exactly what the rule needs: count the symbols out loud together.';
    if (level === 2) return `To check the rule you only need ${{ color: 'the colors', shape: 'the shapes', dots: 'the number of dots', null: 'the number of symbols' }[cond.needs]}. Nothing else matters.`;
    return `The row has ${rd.seq.length} symbols. The first is a ${P.SHAPE_LABEL[rd.seq[0].shape]}, the last is a ${P.SHAPE_LABEL[rd.seq[rd.seq.length - 1].shape]}.`;
  }
  const wrong = rd.panel.map((b, i) => i).filter((i) => i !== rd.solution.button);
  if (level === 1) return 'Tell the Keeper every symbol in order: its shape, its color, and how many dots. They know which rule applies.';
  if (level === 2) return `Buttons ${wrong.slice(0, 2).map((i) => i + 1).join(' and ')} are definitely wrong.`;
  return `Buttons ${wrong.slice(0, 4).map((i) => i + 1).join(', ')} are wrong. Two choices left.`;
}

function blueprintHint(puz, role, level, current) {
  const diffs = [];
  for (let z = 0; z < puz.d; z++) for (let x = 0; x < puz.w; x++) if ((current ? current[z][x] : puz.start[z][x]) !== puz.target[z][x]) diffs.push({ z, x });
  const ord = (n) => ['1st', '2nd', '3rd', '4th'][n] || `${n + 1}th`;
  const rowName = (z) => (z === puz.d - 1 ? 'the front row' : z === 0 ? 'the back row' : `the ${ord(puz.d - 1 - z)} row from the front`);
  const cellName = (c) => `${rowName(c.z)}, ${ord(c.x)} tower from the left`;
  if (role === 'keeper') {
    if (level === 1) return 'Ask the Scout to turn the model and call out the height of each tower, left to right, row by row.';
    if (level === 2) return `There are ${puz.solution.diffCells.length} difference(s) from the blueprint in total.`;
    const c = puz.solution.diffCells[0];
    return `One difference is in ${cellName(c)}.`;
  }
  if (level === 1) return 'Ask the Keeper how many cubes each tower in the back row has. Turn the model to find hidden cubes!';
  if (!diffs.length) return 'Looks like your model already matches. Tap “Check My Model.”';
  if (level === 2) {
    const left = diffs.filter((c) => c.x < puz.w / 2).length;
    return left >= diffs.length - left ? 'There is a mistake in the left half of the model.' : 'There is a mistake in the right half of the model.';
  }
  const c = diffs[0];
  return { text: `Look at the highlighted tower: it has ${current && current[c.z][c.x] > puz.target[c.z][c.x] ? 'too many' : 'too few'} cubes.`, highlight: c };
}

module.exports = { detectiveHint, cipherHint, blueprintHint, HINT_AFTER_ERRORS, HINT_AFTER_MS };
