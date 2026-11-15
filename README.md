# Kinquest 🗝️

**A 10-minute daily co-op puzzle for kids 6–10 and their grown-ups.** Each player sees only their part of the puzzle on their own device, and the door opens only when every player's key is lit.

> Duolingo for family thinking: 10 minutes a day where a kid and a parent solve a puzzle together, and every week the parent sees which skills are growing.

## What works end to end

| Step | What happens |
|---|---|
| Room | A grown-up opens an expedition and gets a 4-digit code plus a QR code. The kid scans it on their own phone or tablet and enters a nickname and age group |
| Roles | The **Keeper** (grown-up) gets rules, witness notes, and blueprints. The **Scout** (kid) gets picture clues, glowing symbols, and a 3D model. **Solutions stay on the server** |
| Story | Gemini writes the story of the day around the kid's interest (ocean, space, dinosaurs, animals). Without a key, a story from the built-in library is used |
| Lock 1 · The Detective | Logic and critical thinking: cross out suspects and pick the clue that rules each one out (the server checks the link), then accuse. A wrong pick is explained by the exact clue it breaks |
| Lock 2 · The Temple Cipher | Patterns: the Scout sees a row of symbols, the Keeper reads an if/otherwise rule book. 3 rounds. Round 1: the Scout first predicts the next symbol and says what changes along the row, and the rule uses that prediction. Round 3 is a role swap: the kid holds a picture rule book and the grown-up presses |
| Lock 3 · The Blueprint Workshop | Spatial reasoning: before turning the 3D cube model (Three.js), the Scout picks how it looks from the right side, then turns it to check and fixes it; the Keeper sees the plan and projections and marks the differences |
| Hints | A 3-step ladder after 2 mistakes or 90 seconds: a leading question → narrowing down → one step. Never the full answer. The grown-up also gets “Try asking” lines tied to the kid’s last move |
| Ratings | A chess-style skill rating per player; the next expedition is built at the new level |
| The chest | Team time vs. family record, day streak, an off-screen conversation card, and a one-tap parent rating |
| Solo chest | After the expedition, the Scout can try one small Detective alone, with every clue on their screen. Optional, no timer; the grown-up can mark “I helped.” Logged as a home try. Bonus: “Fix the Robot”: Robo solved a case with one wrong step; the kid finds it and names the real thief |
| Off-screen mission | The chest suggests one screen-free game tied to the lock that took the most work (or today’s focus); the grown-up can mark “We did it” |
| Next mission | Plain rules in `focus.js`, one focus at a time. Detective: a pick that matched one clue but broke another → a check tool (suspect vs. each clue). Cipher: a symbol right except for one feature → labels for that feature under the row and a decoy that differs only in it. Then the same lock without the helper → done, or back to the helper. Only one lock changes |
| Report | Built from the move log for one session or a week, in four blocks: what went well, where it got tricky (tied to the exact clue), one question for the grown-up plus screen-free activities, and the next mission. Then results by puzzle type with levels and hints. Skill levels 1–10 are kept only as the difficulty setting |
| Backup mode | One-device play with a “pass the device, no peeking” curtain between turns |

## Why the puzzles are fair

Code handles everything that must be exact; AI handles everything that should feel alive.

- `puzzles.js` has three seeded generators and solvers. The Detective adds conditions until exactly one suspect remains and checks that neither the Scout nor the Keeper can solve it alone. In the Cipher, the wrong rule branch always leads to a different button, and exactly one button on the panel matches.
- `test/puzzles.test.js` generates 200 puzzles of each type across all 10 levels: each has exactly one solution.
- `test/e2e.test.js` runs the real server with two socket clients through a full expedition to the chest and the report, and checks that no view ever contains a solution.

```bash
npm test
```

## Run it

```bash
npm install
cp .env.example .env    # add your GEMINI_API_KEY
npm start               # http://localhost:3000
```

Without a key everything still works; story and report text come from built-in templates.

| Variable | Purpose |
|---|---|
| `PORT` | port (Railway sets it) |
| `GEMINI_API_KEY` | story of the day and report text from Gemini |
| `GEMINI_MODEL` | default `gemini-3.5-flash-lite` (about 1.5 s per call) |
| `PUBLIC_URL` | public URL for the QR code when behind a proxy |
| `DATA_DIR` | where families and sessions are stored (default `./data`) |

To try it locally, open the game in a normal window and a private window (or two tabs): those are two players. A phone on the same Wi-Fi can join via the QR code using your computer's LAN address.

## Deploy to Railway

1. New Project → Deploy from GitHub repo → this repository.
2. Variables: `GEMINI_API_KEY`.
3. Settings → Networking → Generate Domain. That URL goes into the QR code.
4. Every push to `main` redeploys.

MVP data lives in JSON files (`data/`). On Railway, attach a Volume and set `DATA_DIR`, or sessions reset on redeploy.

## The weekly report: about the demo data

A brand-new install has no week of data. So `/report.html?family=demo` shows a week played by a **bot simulator** (`npm run simulate`): 6 expeditions through the real server, with real generators, answer checks, attempt log, and ratings. The page labels this clearly as demo data. Before a pitch, replace it with 4–5 sessions from a real test family: play the expeditions, then copy files from `data/sessions/` into `seed-sessions.json` (set `familyId` to `"demo"`).

The report for a game you just played (`/report.html?session=…`) is always built from real moves.

## Privacy (COPPA)

- Accounts and data belong to grown-ups only. A kid has a nickname and an age group, no voice or photos.
- Gemini only receives the age group, the interest, and game numbers. The kid's name is replaced with a `{child}` token and filled in by the browser.
- Report activities are picked by id from a curated library (`activities.js`); the AI can't invent new advice.

## Design

The visual system lives in [`DESIGN.md`](DESIGN.md): near-white canvas, ink text, one coral accent, Scout teal and Keeper blue, one shadow tier, 44px+ touch targets, visible focus rings, reduced-motion support, and US formats via `Intl`.

## Layout

```
server.js        Express + Socket.IO: rooms, roles, answer checks, attempt log, ratings, report API
puzzles.js       Detective, Cipher, and Blueprint generators + solvers
hints.js         hint ladder (templates)
report.js        report metrics from the attempt log
ai.js            2 Gemini calls (story, report text) with template fallbacks
focus.js         next-mission rules: mix-up → check tool → without the tool
activities.js    screen-free activity library
store.js         families, ratings, sessions (JSON files)
seed-sessions.json  demo week
public/          index · game · report · pricing; js/blueprint3d.js is the Three.js cube model
scripts/         bot.js: bot players; simulate.js: records the demo week
```

Browser ↔ server messages: `create_room`, `join_room`, `role_view`, `submit`, `lock_update`.

## Not in the MVP yet

Accounts and Google sign-in, 3–5 players (Liaison and Advisor roles), role swaps, the Saturday boss and the region atlas, Stripe Checkout, report emails via Resend, AI-written hints, and the Master add-on.
