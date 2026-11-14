// MVP storage: JSON files in data/. Families, skill ratings, played sessions.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
const FAMILIES = path.join(DATA_DIR, 'families.json');
const SEED = path.join(__dirname, 'seed-sessions.json');
fs.mkdirSync(SESS_DIR, { recursive: true });

const SKILL_KEYS = ['spatial', 'patterns', 'logic', 'critical', 'communication'];
const START_RATING = 1000;
// Starting level before calibration: ages 6–7 → 2, ages 8–10 → 3, adult → 5.
const startRating = (kind, ageBand) => (kind === 'adult' ? 1200 : ageBand === '6-7' ? 900 : START_RATING);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const newId = (n = 8) => crypto.randomBytes(n).toString('hex');

// ---------- families ----------
function loadFamilies() { return readJson(FAMILIES, {}); }
function getFamily(id) { return loadFamilies()[id] || null; }
function saveFamily(fam) {
  const all = loadFamilies();
  all[fam.id] = fam;
  writeJson(FAMILIES, all);
}
function ensureFamily(id, name) {
  const fam = (id && getFamily(id)) || { id: id && /^[a-f0-9]{16}$/.test(id) ? id : newId(), name: name || 'Our Family', createdAt: Date.now(), members: {} };
  if (name) fam.name = name;
  saveFamily(fam);
  return fam;
}
function ensureMember(fam, nickname, kind, ageBand) {
  const key = nickname.trim().toLowerCase();
  if (!fam.members[key]) {
    fam.members[key] = { nickname: nickname.trim(), kind, ageBand: ageBand || null, ratings: Object.fromEntries(SKILL_KEYS.map((s) => [s, startRating(kind, ageBand)])) };
  } else if (ageBand) {
    fam.members[key].ageBand = ageBand;
  }
  return fam.members[key];
}

// ---------- skill rating (like in chess) ----------
// Puzzle level is converted to a "puzzle rating"; solving your part above your level raises the rating more,
// with mistakes or hints, less.
const levelToRating = (lvl) => 700 + lvl * 100;
const ratingToLevel = (r) => Math.max(1, Math.min(10, Math.round((r - 700) / 100)));
function partScore({ errors, hints }) {
  if (hints > 0) return Math.max(0.2, 0.6 - 0.15 * (hints - 1));
  if (errors === 0) return 1;
  return Math.max(0.5, 0.85 - 0.1 * (errors - 1));
}
function updateRating(rating, puzzleLevel, outcome) {
  const expected = 1 / (1 + Math.pow(10, (levelToRating(puzzleLevel) - rating) / 400));
  const k = 48;
  return Math.round(rating + k * (partScore(outcome) - expected));
}

// ---------- sessions ----------
function saveSession(session) {
  writeJson(path.join(SESS_DIR, session.id + '.json'), session);
}
function getSession(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  return readJson(path.join(SESS_DIR, id + '.json'), null) || loadSeed().find((s) => s.id === id) || null;
}
function loadSeed() { return readJson(SEED, []); }
function familySessions(familyId) {
  if (familyId === 'demo') return loadSeed();
  const out = [];
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = readJson(path.join(SESS_DIR, f), null);
    if (s && s.familyId === familyId) out.push(s);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = {
  SKILL_KEYS, START_RATING, newId,
  getFamily, saveFamily, ensureFamily, ensureMember,
  levelToRating, ratingToLevel, updateRating, partScore,
  saveSession, getSession, familySessions, loadSeed,
};
