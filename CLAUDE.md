# Kinquest — context for Claude Code

A 10-minute family expedition built on information asymmetry: the Scout (kid, 6–10) sees objects, the Keeper (grown-up) knows the rules. A lock opens only when both keys are lit. The product targets the US: all UI and copy are in US English.

## Hard rules
- **The solution never reaches the browser.** Clients only get their own role's view (`puzzles.js` → `*Views`). The e2e test checks this.
- Generators in code build the puzzles; solvers check the answer is unique. The AI never invents puzzles or clue logic.
- The AI (Gemini, `ai.js`) only writes the story of the day and the report text, always with a template fallback. Never send the kid's name to the AI: use the `{child}` token.
- Reports are built only from the attempt log (`room.attempts`) and the solo-chest log (`session.solo`). Never invent numbers; under 3 puzzles in a skill means "not enough data." Don't infer guessing from answer speed.
- Family puzzles show what the team did; the solo chest is a home try, and the grown-up's help mark is context, not proof.
- Coaching lines go to the grown-up only and never repeat the Scout's clue text: the halves are shared by talking.
- Next-mission changes come from plain rules in `focus.js`, one lock at a time.
- The demo week (`seed-sessions.json`) was played by a bot, and the UI always says so.
- Exactly five socket messages: `create_room`, `join_room`, `role_view`, `submit`, `lock_update`.
- UI follows `DESIGN.md` (no violet, one accent, `Intl` formats, visible focus, reduced motion).
- `GEMINI_API_KEY` lives in `.env` (git-ignored). Never commit it.

## Not in the MVP
Accounts, 3+ players, Stripe, emails, the atlas, AI hints, the Master add-on.

## Commands
- `npm start` — server (PORT, default 3000; loads `.env`)
- `npm test` — 200 puzzles of each type + an end-to-end two-client test
- `npm run simulate` — rebuild the demo week
