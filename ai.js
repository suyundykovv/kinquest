// Two Gemini calls: the story of the day and the report text. Both fall back to a template on any error
// or when no key is set.
// Privacy: only the age band, the interest and game numbers reach the model. Never the child's name —
// the model writes the {child} token and the browser fills in the nickname.
'use strict';
const { ACTIVITIES } = require('./activities');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 20000);
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const hasKey = () => Boolean(process.env.GEMINI_API_KEY);

// ---------- regions and template stories ----------
const REGIONS = {
  ocean: {
    region: 'Undersea Kingdom',
    cast: [
      { emoji: '🐙', name: 'Ollie Octopus' }, { emoji: '🦀', name: 'Pinch the Crab' }, { emoji: '🐠', name: 'Sparky Fish' },
      { emoji: '🐢', name: 'Shelly Turtle' }, { emoji: '🐬', name: 'Splash Dolphin' }, { emoji: '🦭', name: 'Pudge the Seal' },
      { emoji: '🐡', name: 'Puff the Blowfish' }, { emoji: '🦑', name: 'Inky Squid' }, { emoji: '🐳', name: 'Big Blue Whale' },
    ],
    title: 'The Sunken Octopus Temple',
    intro: "Team {child} dives down to a sunken temple. Someone took Ollie Octopus's magic pearl, and the water around the temple is getting cloudy. Let's find who took it, open the temple doors, and fix the old coral bridge!",
    lock_names: ['Who Took the Pearl?', 'The Temple Doors', 'The Coral Bridge'],
    card: 'Why do you think an octopus needs three hearts?',
  },
  space: {
    region: 'Star Station',
    cast: [
      { emoji: '👽', name: 'Zig the Alien' }, { emoji: '🤖', name: 'Bolt the Robot' }, { emoji: '🐶', name: 'Laika the Pup' },
      { emoji: '🐱', name: 'Comet Cat' }, { emoji: '🦊', name: 'Orbit Fox' }, { emoji: '🐼', name: 'Luna Panda' },
      { emoji: '🐧', name: 'Rocket Penguin' }, { emoji: '🐹', name: 'Meteor Hamster' }, { emoji: '🦉', name: 'Twinkle Owl' },
    ],
    title: 'The Missing Star Key',
    intro: "Team {child} lands on Polaris Station. Someone ran off with the star key, and the station can't turn its lights on. Let's find it, crack the airlock code, and build the antenna from the blueprint!",
    lock_names: ['Who Took the Key?', 'The Airlock', 'The Radio Antenna'],
    card: 'If you lived on a space station, what would you miss most from home?',
  },
  dinosaurs: {
    region: 'Dino Valley',
    cast: [
      { emoji: '🦕', name: 'Dottie Diplodocus' }, { emoji: '🦖', name: 'Rex the Roarer' }, { emoji: '🐊', name: 'Croc Tail' },
      { emoji: '🦎', name: 'Zippy Lizard' }, { emoji: '🐢', name: 'Shell Turtle' }, { emoji: '🦤', name: 'Dodo Bird' },
      { emoji: '🐸', name: 'Hoppy Frog' }, { emoji: '🦔', name: 'Prickles' }, { emoji: '🐿️', name: 'Nutty Squirrel' },
    ],
    title: 'The Mystery of the Golden Egg',
    intro: "Team {child} heads into Dino Valley. The golden egg is missing from its nest! Let's find who carried it off, open the cave gate, and build a bridge across the river.",
    lock_names: ['Who Took the Egg?', 'The Cave Gate', 'The River Bridge'],
    card: 'Would you rather be a big, slow dinosaur or a small, fast one? Why?',
  },
  animals: {
    region: 'Whispering Woods',
    cast: [
      { emoji: '🦊', name: 'Foxy Fern' }, { emoji: '🐰', name: 'Tim the Rabbit' }, { emoji: '🦉', name: 'Wise Owl Ada' },
      { emoji: '🐻', name: 'Bo the Bear Cub' }, { emoji: '🐿️', name: 'Rusty Squirrel' }, { emoji: '🦔', name: 'Spike Hedgehog' },
      { emoji: '🐸', name: 'Croaky Frog' }, { emoji: '🐢', name: 'Slowpoke Turtle' }, { emoji: '🦝', name: 'Rocky Raccoon' },
    ],
    title: 'The Lost Acorn of Wisdom',
    intro: "Team {child} sets off into the Whispering Woods. The acorn of wisdom has vanished from the old oak tree! Let's find who took it, crack the code on the hollow's door, and fix the bridge over the creek.",
    lock_names: ['Who Took the Acorn?', 'The Hollow Door', 'The Creek Bridge'],
    card: 'If you could talk to any animal in the woods, what would you ask it?',
  },
};
const regionFor = (interest) => REGIONS[interest] || REGIONS.animals;

function templateStory(interest) {
  const r = regionFor(interest);
  return { title: r.title, intro: r.intro, lock_names: r.lock_names, conversation_card: r.card, region: r.region, cast: r.cast, source: 'template' };
}

async function callJson({ system, prompt, schema, thinking = 'minimal' }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          thinkingConfig: { thinkingLevel: thinking },
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(body.error && body.error.message) || 'request failed'}`);
    const cand = body.candidates && body.candidates[0];
    if (!cand || cand.finishReason === 'SAFETY' || cand.finishReason === 'MAX_TOKENS') throw new Error(`Gemini finish: ${cand ? cand.finishReason : 'no candidate'}`);
    const text = (cand.content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const shortStr = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;

// ---------- 1. story of the day ----------
async function generateStory({ ageBand, interest, suspects }) {
  const base = templateStory(interest);
  if (!hasKey()) return base;
  const schema = {
    type: 'object',
    required: ['title', 'intro', 'lock_names', 'suspect_names', 'conversation_card'],
    properties: {
      title: { type: 'string' },
      intro: { type: 'string' },
      lock_names: { type: 'array', items: { type: 'string' } },
      suspect_names: { type: 'array', items: { type: 'string' } },
      conversation_card: { type: 'string' },
    },
  };
  const prompt = `Family: a child {child} (age ${ageBand || '6-10'}) and a grown-up. This week's region: ${base.region}.
Today's locks, in order: detective (find which of ${suspects} animal neighbors took something), cipher (a code of glowing symbols on a door), blueprint (build a part from cubes to fix a bridge or a machine).
The suspects are animals, in exactly this order: ${base.cast.slice(0, suspects).map((c) => c.emoji).join(' ')}.
Return JSON:
- title: expedition name, 6 words max;
- intro: up to 3 short sentences in simple words that start with "Team {child}"; say where the team is going and why;
- lock_names: exactly 3 short, story-themed names for the locks, in order: the mystery (who took it?), the coded door, the thing to rebuild. Example for a forest: "Who Took the Acorn?", "The Hollow Door", "The Creek Bridge";
- suspect_names: exactly ${suspects} friendly names for the animals in the same order, like "Ollie Octopus", 20 characters max each;
- conversation_card: one open question about today's theme to talk about off-screen.
Write the placeholder {child} literally, with the curly braces, exactly where the child's name goes. Never invent a name for the child.
US English. No violence, nothing scary. The culprit is a prankster, not a villain.`;
  try {
    const out = await callJson({ system: 'You write warm, short adventures for a family puzzle game for kids 6-10. Plain US English.', prompt, schema, thinking: 'low' });
    if (!String(out.intro).includes('{child}')) throw new Error('intro has no {child} placeholder');
    if (out.lock_names.some((n) => /^(detective|cipher|blueprint)$/i.test(String(n).trim()))) throw new Error('lock names are type ids');
    if (!shortStr(out.title, 80) || !shortStr(out.intro, 450) || !shortStr(out.conversation_card, 220)) throw new Error('bad story fields');
    if (!Array.isArray(out.lock_names) || out.lock_names.length !== 3 || !out.lock_names.every((s) => shortStr(s, 40))) throw new Error('bad lock names');
    const names = Array.isArray(out.suspect_names) && out.suspect_names.length >= suspects && out.suspect_names.every((s) => shortStr(s, 24)) ? out.suspect_names : null;
    return {
      title: out.title, intro: out.intro, lock_names: out.lock_names, conversation_card: out.conversation_card,
      region: base.region,
      cast: base.cast.map((c, i) => ({ emoji: c.emoji, name: (names && i < suspects && names[i]) || c.name })),
      source: 'gemini',
    };
  } catch (e) {
    console.warn('[ai] story fallback:', e.message);
    return base;
  }
}

// ---------- 2. report text ----------
// Code picks the facts for each of the four blocks (report.js → blocks); the AI only words them.
function pickActivities(m) {
  const sk = m.blocks.tip.skill;
  return [...ACTIVITIES.filter((a) => a.skill === sk).slice(0, 2), ...(sk === 'communication' ? [] : ACTIVITIES.filter((a) => a.skill === 'communication').slice(0, 1))];
}

function templateReport(m) {
  const b = m.blocks;
  const t = m.team;
  return {
    headline: `${t.locks} locks opened in ${t.minutes} minutes together.${b.wins.length ? ' Here is what {child} did, move by move.' : ''}`,
    went_well: b.wins.length ? 'From the move log:' : 'Not enough moves yet to name something specific. Play another expedition.',
    stuck: b.stuck.length ? 'One spot where the puzzle pushed back:' : 'No clear mix-ups in this period.',
    parent_try: b.stuck.length ? 'One question to ask, off-screen:' : 'Keep the talk going, off-screen:',
    next_mission: b.next.text,
    activity_ids: pickActivities(m).map((a) => a.id),
    team: t.firstTryLocks
      ? `You opened ${t.firstTryLocks} of ${t.locks} locks on the first try.${t.stuckOn ? ` You spent the most time talking through “${t.stuckOn}.”` : ''}`
      : `Locks opened: ${t.locks}.${t.stuckOn ? ` You talked the most through “${t.stuckOn}.”` : ''}`,
    source: 'template',
  };
}

async function writeReport(metrics) {
  const base = templateReport(metrics);
  if (!hasKey()) return base;
  const ids = ACTIVITIES.map((a) => a.id);
  const schema = {
    type: 'object',
    required: ['headline', 'went_well', 'stuck', 'parent_try', 'next_mission', 'activity_ids', 'team'],
    properties: {
      headline: { type: 'string' }, went_well: { type: 'string' }, stuck: { type: 'string' },
      parent_try: { type: 'string' }, next_mission: { type: 'string' }, team: { type: 'string' },
      activity_ids: { type: 'array', items: { type: 'string', enum: ids } },
    },
  };
  const facts = { blocks: metrics.blocks, results: metrics.results, solo: metrics.solo, team: metrics.team, ageBand: metrics.subject.ageBand }; // no nickname
  const prompt = `Facts from the move log of the family game Kinquest for child {child} (JSON):\n${JSON.stringify(facts)}\n
Off-screen activity library (pick only from here, by id):\n${ACTIVITIES.map((a) => `${a.id} [${a.skill}]: ${a.text}`).join('\n')}\n
The report shows four blocks. Under each block the app lists the exact facts, so your sentence introduces them. Rules:
- use only the facts in the JSON; never invent numbers or events;
- describe actions in this game, not the child's character; no "smart", "genius", "weak", no IQ, no comparison with other kids;
- solo chest results are a home try; if a grown-up marked help, say so plainly;
- refer to the child only as {child};
- the facts cover ${metrics.team.sessions === 1 ? 'one expedition (today)' : `${metrics.team.sessions} expeditions over ${metrics.team.daysPlayed} days (a week), so don't say "today"`};
- headline: one warm sentence;
- went_well: one sentence about blocks.wins (or say there is not enough yet);
- stuck: one sentence about blocks.stuck, framed as the next step, not a weakness (or say there were no clear mix-ups);
- parent_try: one sentence that leads into the question in blocks.tip.q; don't repeat the question, the app shows it right below;
- next_mission: one sentence that restates blocks.next.text in plain words;
- activity_ids: 2-3 ids from the library for skill ${metrics.blocks.tip.skill};
- team: one sentence on how the family worked together.`;
  try {
    const out = await callJson({ system: 'You write short, warm, honest notes for parents about what their child did in a puzzle game. Plain US English.', prompt, schema });
    const activity_ids = (out.activity_ids || []).filter((id) => ids.includes(id)).slice(0, 3);
    for (const k of ['headline', 'went_well', 'stuck', 'parent_try', 'next_mission', 'team']) if (!shortStr(out[k], 400)) throw new Error('bad report field ' + k);
    return { ...out, activity_ids: activity_ids.length ? activity_ids : base.activity_ids, source: 'gemini' };
  } catch (e) {
    console.warn('[ai] report fallback:', e.message);
    return base;
  }
}

module.exports = { generateStory, writeReport, templateStory, templateReport, REGIONS, hasKey, MODEL };
