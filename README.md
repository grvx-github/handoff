# Handoff: AI-powered knowledge and task management

Captures meetings and work handovers, turns raw notes into structured recaps, tracks every action item to closure, and gives anyone who missed a meeting (or is taking over) a short AI catch-up brief.

## Run
```
npm install && cp .env.example .env   # set MONGODB_URI and GEMINI_API_KEY
npm start                              # http://localhost:3000 (seeds sample data on first run)
```
Deploy: Render/Railway web service (build `npm install`, start `npm start`) + MongoDB Atlas free tier. Set the env vars from `.env.example`.

## Approach
Express API + MongoDB (Mongoose) serving a dependency-free vanilla JS UI from the same server (one deployable). Collections: `Meeting` (type = meeting or handover), `ActionItem` (owner, due date, status, outcome, per-item history), `Doc` (knowledge base). Flow: paste raw notes -> AI recap -> human reviews/edits -> save -> items and doc links are created. Creating a meeting with "carry open items from" copies open items forward (`carriedFromId`, `carryCount`, full history) and marks the originals `carried`. Closing or dropping an item requires an outcome.

## AI configuration
- Provider: Google Gemini REST API (`GEMINI_API_KEY`, model via `AI_MODEL`, default `gemini-2.5-flash`). Swap providers by editing `llm()` in `src/ai.js`.
- Four calls: **recap** (JSON, validated with Zod, one retry), **doc linking** (meeting and items to knowledge docs, doc IDs validated against real docs), **catch-up brief** (text), **follow-up nudge** (text).
- Prompts: low temperature, "use only facts in the notes", null for unknown owner/date, notes treated as data (prompt-injection guard).
- Failure handling: 25s timeout; recap falls back to a rule-based extractor (lines starting with action/decision), linking falls back to keyword matching, brief and nudge fall back to templates. The UI flags degraded output. User notes are saved before any AI call, so nothing is lost.

## Data source
Mongo seed data in `src/seed.js` (4 docs, a sprint meeting with overdue and repeatedly carried items, and a leave handover with unstructured notes ready for the recap demo). Auto-seeds only when the DB is empty.

## Logging
`pino` JSON logs to stdout and `logs/app.log`. Every request gets a `requestId` (honours incoming `x-request-id`, returned in the response header and error bodies) attached to all lines. Key events: `meeting.created`, `actionItem.created/reassigned/closed/status_changed`, `meeting.recap_saved`, `followup.nudge_drafted`. `ai.call` logs op, model, `latencyMs`, outcome. Errors log with context (stack only for 5xx). `apiKey` and auth headers are redacted; notes content is never logged. Level via `LOG_LEVEL`.

## Special feature: follow-up engine
`/api/followups` surfaces items that are overdue or carried forward 2+ times (the ones that silently rot between meetings), and the AI drafts a short, friendly nudge to the owner. This closes the "follow up on open items until closed" loop instead of just storing tasks.

## Assumptions and known limitations
- No authentication: "Me" in the header is a free-text name used as a default filter. Owners are plain strings, not user accounts.
- Re-saving a recap for the same meeting adds items again (no dedupe).
- Doc linking sends doc titles/excerpts to the LLM, so it suits small knowledge bases (no embeddings).
- Nudges are drafted, not sent. No email/calendar/recording ingestion: notes are pasted as text.
- No automated tests; the API validates input with Zod and returns consistent `{error, requestId}` JSON.
