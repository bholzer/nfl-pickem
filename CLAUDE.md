# CLAUDE.md

## Project overview

NFL Pick'em is a React/TypeScript application backed by a Cloudflare Worker,
D1, and native Workflows. Players use Discord sign-in or signed submission
links to make weekly picks; background jobs deliver links, hashes, and standings.

## Development and verification

Use Node 22.22.2 or later in the Node 22 line and npm 10.9.7.

```sh
npm ci
npm run db:migrate:local
npm run dev

npm run format
npm run format:check
npm run typecheck
npm run lint
npm run deadcode
npm run metrics
npm test
npm run test:unit
npm run test:workers
npm run test:client

npm run build
npx --no-install playwright install chromium
npm run test:e2e
npm run rehearsal:serve

npm run deploy:dry-run
```

Ordinary development uses port 5173. Create `.dev.vars` from `.dev.vars.example`
only if it does not already exist; never overwrite local secrets.

The browser suite and rehearsal use a local build, temporary synthetic D1 data,
generated signing keys, and blocked non-fixture outbound transport. The rehearsal
prints player/admin links at `http://127.0.0.1:5180`; stopping it removes its
temporary state. Screenshots and failure traces go under `tmp/playwright`.
`deploy:dry-run` builds staging and packages it without publishing.

## Readability policy

- Use Prettier defaults and the Tailwind sorter; do not hand-format code or
  reformat golden reference data. Bulk formatting excludes Markdown and private
  or generated files.
- Strict typed ESLint covers application code, tests, configuration, and checked
  `.mjs` implementations. No blanket `any`, disabled rules, or unchecked sidecars.
- Cognitive complexity must stay at or below 15, modified cyclomatic complexity
  at or below 10, and nesting at or below 3. More than 80 nonblank/noncomment
  function lines or 4 parameters is a review signal, not a reason for arbitrary
  helpers or fragmenting a coherent test scenario.
- Preserve Node-only ambient types for operational scripts; import Worker binding
  types explicitly where modules cross that boundary. Keep indexed-access checks.
- The documented exceptions cover disposal-owning `using` declarations,
  Playwright fixture dependency patterns, numeric template interpolation,
  Workerd module names, and the external Terraform CLI.
- Knip findings require reference/framework review before deletion. The metrics
  reporter uses official rule scores and writes `tmp/quality/metrics.json`;
  compare like populations rather than diluting application scores with tests.
- See `README.md` for measured cleanup results and the rationale for remaining
  long UI/durable-orchestration functions.

## Architecture

- `src/client/`: React navigation, picks/standings, job administration, API client,
  shared UI components, and Tailwind styles.
- `src/server/index.ts`: Worker entry point, middleware, asset routing, and
  environment-level request gates.
- `src/server/auth.ts` and `tokens.ts`: Discord authentication, signed sessions,
  submission-link tokens, and authorization.
- `src/server/routes.ts` and `db.ts`: application endpoints and D1 persistence.
- `src/server/services/`: ESPN access, scoring, grouping, summaries, and Discord
  delivery. Reuse these services rather than duplicating domain or transport logic.
- `src/server/jobs/` and `workflows.ts`: job administration, durable history,
  delivery/effect state, and native Workflow execution.
- `src/shared/contracts.ts` and `season.ts`: client/server contracts and season
  validation/date rules, also shared with checked Node tooling.
- `migrations/`: native D1 SQL schema migrations.
- `scripts/cloudflare.mjs` and `infrastructure.mjs`: guarded deployment lifecycle
  and Terraform integration.
- `tests/`: domain/client/native Worker tests, compatibility fixtures, and
  browser scenarios. Cached reference fixtures do not require another runtime.

## Application invariants

- Enforce identity, authorization, CSRF, pick deadlines, scoring, and tiebreakers
  on the server. Public standings must not reveal unplayed picks or hidden
  tiebreakers.
- Submission links require signed season and week claims. Reject/reissue yearless
  links; never infer their season from today's date. Preserve summary/hash format
  and the intended `SUBMISSION_TOKEN_SECRET`; use separate `SESSION_SECRET`
  values for native sessions in each environment.
- A season is its starting year; January 2027 belongs to season 2026. Submissions
  are unique by user/season/week, and stored submission IDs determine detail
  periods even when URL query parameters conflict.
- Competition IDs and team IDs are strings. Use the ESPN service's
  `site.web.api.espn.com` transport with explicit season, regular-season type, and
  week. Validate returned period metadata; never reinterpret postseason week
  numbers as regular-season weeks. Reuse status/time and summary formatting.
- Keep durable delivery fencing, effect records, job history, and suppression
  expiry intact. Discord delivery and D1 commits are not atomic; review ambiguous
  sends before retrying. Do not claim exactly-once external delivery.
- Scheduled hashes must read submissions after the durable kickoff wait.
  Preserve imported dispatch times. Jobs, retry children, delivery state, and
  suppression keys are season-scoped; unresolved jobs cannot drift to another
  season, and resolved retries retain their exact season/week.
- Keep sends and schedules disabled unless explicitly approved. Do not bypass
  recipient/channel allowlists or start duplicate dispatchers.

## Deployment and private data

Read `README.md` for the complete guarded lifecycle before any remote operation.
`node scripts/cloudflare.mjs --help` lists the current command contract;
`plan` is offline. Cloud changes and Discord activation require separate,
explicit approvals.

Terraform owns D1 and Worker identity; Wrangler owns deployments, assets,
bindings, native Workflow definitions/schedules, and approved custom domains.
Retain the provider lock and private per-environment Terraform state under
`~/.config/nfl-pickem/terraform/`. Never clear state or resource IDs to force a retry.

Keep native secret bundles outside the repository, owner-only. Do not print
tokens, secret values, or database snapshots. Preserve `.dev.vars`, local D1
state, private credentials, and uncommitted user work.

Use `maintenance` to fence delivery, disable schedules/sends, pause Workflows,
and retain routes for a current export. `--source-quiesced` acknowledges frozen
source writers and dispatchers. Recovery requires verified data and a deliberate
native publication/activation; individually paused Workflows do not auto-resume.
Migration `0003_seasons.sql` requires old native instances to be retired, not just
paused, and rejects nonterminal D1 history. Never resume pre-cutover native code;
recover reviewed work through new season-pinned retry children retaining delivery
scopes. Verify timestamp-derived historical season backfills and an actual private
backup before migration. Follow README's existing-staging cutover sequence.

For an unscheduled Workflow, omit `schedules` instead of assigning an empty array.
Use native Workflow schedules, not duplicate Worker crons. Build the selected
environment and deploy its generated `dist/server/wrangler.json` without `--env`.
Do not change unrelated DNS records, zone configuration, or OAuth callbacks.

Historical implementation/data backups are private and outside this checkout;
see the retirement-backup section in `README.md`. Do not restore them over current
source or databases.

## UI design

Follow @DESIGN_SYSTEM.md: mobile-first, flat, information-dense, high-contrast,
accessible interfaces with visible focus states and both light/dark styling.

`src/client/styles.css` uses Tailwind v4 with a class-based `dark` variant.
`ThemePicker` in `src/client/ui.tsx` maintains the root `dark` class and the
`theme` localStorage preference (`light`, `dark`, or `auto`), including system
preference changes and unavailable browser storage. Reuse existing components
and styles rather than introducing a second theme or component convention.