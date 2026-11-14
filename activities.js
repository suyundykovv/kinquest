// Library of off-screen activities. The AI only picks from here by id; it may not invent new advice.
'use strict';

const ACTIVITIES = [
  // Spatial
  { id: 'lego_top', skill: 'spatial', text: 'Build a tower from LEGO or blocks and have your child draw what it looks like from the top. Then switch roles.' },
  { id: 'what_changed', skill: 'spatial', text: 'Play “What changed?”: set 5 objects on the table, your child looks away, and you swap two of them.' },
  { id: 'shadow', skill: 'spatial', text: 'At night, use a flashlight to guess objects by their shadow, then turn them so the shadow changes.' },
  { id: 'map_room', skill: 'spatial', text: 'Draw a map of a room from above together and hide a “treasure” on it for the other person to find.' },
  { id: 'fold_paper', skill: 'spatial', text: 'Fold a sheet of paper in half, cut out a shape, and ask what it will look like once unfolded.' },
  // Patterns
  { id: 'bead_pattern', skill: 'patterns', text: 'String beads or line up buttons by a rule; the other person continues the row and names the rule.' },
  { id: 'clap_rhythm', skill: 'patterns', text: 'Clap a rhythm of 3–4 claps and stomps; your child repeats it, then makes up their own.' },
  { id: 'car_plates', skill: 'patterns', text: 'On a drive, look for license plates with repeating digits and guess the rule behind them.' },
  { id: 'odd_one', skill: 'patterns', text: 'Play “Odd one out”: name 4 words where one does not fit, and let your child explain why.' },
  { id: 'calendar', skill: 'patterns', text: 'Look at the family calendar: which days have practice, guests, or pizza? Is there a rule?' },
  // Logic
  { id: 'twenty_q', skill: 'logic', text: 'Play 20 Questions: think of an object; your child may only ask yes-or-no questions.' },
  { id: 'who_where', skill: 'logic', text: 'Dinner-table riddle: “Dad is not by the window, Mom sits next to Dad. Where does Grandma sit?”' },
  { id: 'sort_rules', skill: 'logic', text: 'Sort socks, toys, or cards by two rules at once: “red AND soft.”' },
  { id: 'tic_tac', skill: 'logic', text: 'Play 4×4 tic-tac-toe and after each move ask, “What will the other player do next?”' },
  // Critical thinking
  { id: 'fact_or_guess', skill: 'critical', text: 'Play “Fact or guess?”: take turns saying things about your day; the other decides which it is and why.' },
  { id: 'check_before', skill: 'critical', text: 'Before answering a riddle, agree to count to five and check your idea out loud.' },
  { id: 'two_truths', skill: 'critical', text: 'Play “Two truths and a lie” about your day and hunt for the one that is not true.' },
  { id: 'detective_story', skill: 'critical', text: 'During a bedtime story, pause and ask: “How do we know that? Did a character say it, or did it really happen?”' },
  // Communication
  { id: 'blind_draw', skill: 'communication', text: 'Blind drawing: one person describes a picture, the other draws it without seeing it. Then compare.' },
  { id: 'directions', skill: 'communication', text: 'Ask your child to guide you from the kitchen to their bed using only words while you follow them literally.' },
  { id: 'ask_more', skill: 'communication', text: 'After your child tells a story, ask one follow-up question, then let them ask you one.' },
];

const SKILLS = {
  spatial: 'Spatial Reasoning',
  patterns: 'Patterns',
  logic: 'Logic',
  critical: 'Critical Thinking',
  communication: 'Communication',
};

module.exports = { ACTIVITIES, SKILLS };
