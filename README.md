# NFL Pick'em

React/TypeScript client with a Cloudflare Worker API, D1 persistence, and native
Workflows for scheduled Discord deliveries. Development, tests, and deployment
use the native Node/npm toolchain.

## Local development

Use Node 22.22.2 or later in the Node 22 line and npm 10.9.7.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

For ordinary development, create `.dev.vars` from `.dev.vars.example` if it does
not already exist. Keep secrets out of `wrangler.jsonc` and source control.
Discord sends and scheduled work are disabled by default.

For a self-contained browser session with synthetic users and games:

```sh
npm run build
npm run rehearsal:serve
```

Open the printed player or administrator link on `http://127.0.0.1:5180`.
This runs the compiled Worker, static-assets router, D1, and native Workflows,
not a mocked application API. It uses temporary state and generated signing keys;
it does not load `.dev.vars`, deployment secret bundles, or existing local databases.
ESPN is replaced at the outbound transport boundary. Discord calls and all
unrecognized outbound requests are blocked. Stop the process to remove its state.
The developer server uses port 5173; the isolated rehearsal uses port 5180.

## Corn Town interface

The application presents itself as **Corn Town**, with **Weekly picks** as its
supporting context. The approved editorial direction, shared tokens, responsive
behavior, and accessibility rules are documented in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
Fonts are self-hosted; appearance follows the system or a saved light/dark preference.

Picks and standings are the primary destinations. Home opens unfinished picks or
the selected week's standings after submission, without changing explicit deep links.
Account, theme, and administrator controls are grouped in the account menu.
Season, week, theme, and job filters use styled keyboard-accessible option lists.
Pick progress stays beside submit/update in the sticky dock. Saved submissions
use borderless team rows and a neutral Picked label. Separate icon-and-text badges
identify correct, incorrect, and pending outcomes without coloring the selection.
The default Compact view uses single-line away @ home matchups (vs at neutral
sites), with every separator at the panel's true center and Picked beside the
chosen side. Phones use result icons with a visible key; wider screens retain
logos and result words. Detailed restores full names and kickoff information.
The browser remembers the display choice.

Unsubmitted picks can recover from this device's local storage, scoped to the
authenticated user, season, and week. A draft is **not a submission**: users must
explicitly submit. Expired drafts and drafts based on an older saved submission
are not restored; submission and sign-out clear the relevant drafts. If storage
is unavailable, the form remains usable and reports that the draft was not saved.
Closed browsers cannot perform background deletion of expired local data.

The rehearsal above runs the same interface against isolated synthetic data.
It does not contact Discord or use a staging/production database.

## Verification

```sh
npm run format:check
npm run typecheck
npm run lint
npm run deadcode
npm run metrics
npm test
npm run build
npx --no-install playwright install chromium
npm run test:e2e
npx --no-install wrangler deploy --dry-run --config dist/server/wrangler.json
```

The browser suite covers signed links, pick persistence, cross-season history
and standings, archived pick locks, authorization, logout through the actual asset
router, and native job failure reporting with sending disabled. Desktop and
mobile/dark-mode projects save screenshots under `tmp/playwright`; failure traces
stay local.
CI enforces formatting, strict types/lint, complexity limits, and the dead-code
audit before Node tests. Native Worker, build/packaging, and Chromium jobs remain
separate. Readability reports are retained as CI artifacts; CI does not deploy.

## Code quality

Run `npm run format` for Prettier's default 80-column target and the official
Tailwind class sorter. Long literal strings are not a hard formatting failure.
Generated output, secrets, the golden ESPN reference JSON, and Markdown are
excluded from bulk formatting. Use `terraform fmt -check infrastructure/cloudflare`
for the separately managed HCL.

`eslint.config.mjs` combines strict type-aware TypeScript rules with selected
SonarJS and React Hooks rules. Cognitive complexity is capped at **15**, modified
cyclomatic complexity at **10**, and control-flow nesting at **3**. Functions
over **80** nonblank/noncomment lines or **4** parameters require review rather
than automatic splitting. Prefer cohesive components, explicit state transitions,
and named operations; do not move complexity into generic callback frameworks.

Operational `.mjs` implementations are checked through JSDoc, not hidden behind
declaration-only sidecars. `noUncheckedIndexedAccess` keeps necessary boundary
checks visible. Node tooling uses Node ambient types; modules shared with it
import Worker binding types explicitly to avoid Worker global stubs weakening
Node API types.

The narrow rule exceptions are intentional: unread `using` declarations still
own disposal, Playwright's fixture file requires empty dependency destructuring,
and numeric template interpolation expresses counts and IDs. Knip checks entry
exports, follows CSS imports, and recognizes framework configuration. Its only
external-tool exceptions are Workerd's `cloudflare:*` module namespace and the
installed Terraform executable. Review findings before deleting code; do not
remove native Workflow exports or pinned test-runtime peers.

`npm run metrics` writes `tmp/quality/metrics.json` using the official ESLint and
SonarJS rules, with separate application, operations, quality-tool, and test
populations. Threshold-zero probes expose scores, not additional lint failures.
The report records tool versions, maxima, nearest-rank p95 values, advisory
outliers, and source-line widths; declaration files and generated code are excluded.

The 2026-09-11 cleanup compared the formatting-only baseline with the refactor:

| Metric | Application before → after | Operations before → after |
| --- | --- | --- |
| Maximum cognitive complexity | 106 → 14 | 38 → 10 |
| Cognitive complexity p95 | 9 → 6 | 13 → 7 |
| Maximum modified cyclomatic complexity | 53 → 10 | 54 → 10 |
| Functions above cyclomatic limit | 24 → 0 | 15 → 0 |
| Maximum nesting | 6 → 3 | 4 → 3 |
| Longest function, excluding blanks/comments | 435 → 158 | 298 → 89 |
| Functions over 80 lines | 18 → 8 | 4 → 1 |

Reviewed length outliers retain cohesive JSX, the shared job mutation/selection
hook, and visible Workflow/maintenance sequencing. Five-argument database and
deployment boundaries remain explicit rather than introducing opaque context
objects solely for a score. Long test narratives remain intact.

## Application contracts

- Authentication uses HttpOnly signed session cookies, server-side authorization,
  and CSRF checks. Submission-link JWTs must include a signed `season` and `week`.
  Yearless links are rejected and must be reissued, not assigned the current year.
  `SUBMISSION_TOKEN_SECRET` remains separate from `SESSION_SECRET`; no key rotation
  is needed for this cutover.
- A season is its starting year: the **2026 season includes January 2027**.
  Submissions are unique by user, season, and regular-season week (1–18). Picks,
  deadlines, scoring, and tiebreakers are enforced on the server. Historical
  summary and SHA-256 formatting are unchanged.
- Public standings do not disclose competitors' unplayed picks or hidden
  tiebreakers. Owners and administrators retain their authorized detail views.
- Season selection is preserved across picks, standings, history, and job
  administration. Detail URLs identify a stored submission by ID; its stored
  season/week overrides conflicting query parameters.
- Job administration supports season-pinned enqueue, filtered history/detail,
  retry, pause/resume, cancellation, bulk actions, and immediate replacement of
  a scheduled hash job.
- Workflow checkpoints, D1 effect records, delivery scopes, and standings
  markers suppress repeated work. Discord sends and database commits cannot be
  atomic: an interrupted remote send can still have an ambiguous outcome.
  Review that outcome before retrying or recovering service.
- Scheduled hashes read submissions after their durable kickoff wait. Imported
  dispatch times remain separate from computed kickoff times. Unresolved jobs
  stay pinned to their enqueue season; resolved retries retain the exact season
  and week. Scheduled delivery is gated outside the current regular season.

ESPN requests use `site.web.api.espn.com` and explicitly select `dates=<season>`,
`seasontype=2`, and `week`. The previous `site.api.espn.com` host returned HTTP 403
from Cloudflare Workers. Both scoreboard and event metadata are checked against
the requested period; postseason week numbers cannot become regular-season picks.
Current-season discovery follows ESPN metadata, not the calendar year. Default
views use Week 1 in preseason and Week 18 after the regular season.
The competition's `neutralSite` flag selects `vs` instead of `@` in pick forms and
compact submission details. Neutral-site games retain ESPN's nominal home/away
assignments; picks and scoring do not change.

`GET /api/seasons` lists the ESPN current season plus stored submission/job seasons.
Week and standings reads accept `?season=YYYY`; omission selects the current season.
Saving `PUT /api/submissions/:week?season=YYYY` requires the season explicitly.
Job enqueue requests and private Workflow plans require `season`; a null week
resolves only within that pinned season's current regular-season period.

## Data import and snapshots

Use owner-only directories outside source control for SQL snapshots and Workflow
plans. Freeze source writers and dispatchers, drain in-flight work, and keep the
original snapshots intact. `--source-quiesced` acknowledges that the source
system cannot accept writes or dispatch work during the operation.

Use the guarded `import` command only for an approved SQL data migration into a
fresh, offline D1 target with the native `migrations/` applied. Do not assume an
entire Wrangler SQL import is atomic. On partial failure, keep the target offline
and resolve its state; do not blindly retry or merge into it.

Verify an actual target export, not just an input manifest, before enabling
deliveries. Preserve job history, delivery outcomes, and suppression expiry when
preparing a Workflow plan. The guarded `export` command requires maintenance,
stopped writers, and reconciled native job history.

### Season schema cutover (`0003_seasons.sql`)

This is not a rolling-compatible schema change. Migration refuses nonterminal
D1 jobs and unfinished native Workflows, including paused instances. Paused
instances retain their old code and must never resume across this cutover.

For an already published staging target:

1. Build staging and use `maintenance --inflight-reviewed`. Confirm the deployed
   write fence, drain in-flight HTTP work, and keep Discord/schedules disabled.
2. Review and explicitly terminate every unfinished old native instance. Reconcile
   orphan D1 history as well. Maintenance/export synchronizes terminated native
   instances to cancelled history; pausing alone is insufficient.
3. Use `export --output "$BACKUP_SQL" --writers-stopped` in an owner-only directory
   and verify the actual export. Preserve the backup and original configuration.
4. Temporarily set staging source `routes` to `[]`, retain maintenance mode, and
   rebuild staging. Run `migrate --writers-stopped` with the normal cloud/account
   approvals. This D1 operation does not detach the deployed maintenance hostname;
   do not publish the route-free configuration.
5. Verify users, submission IDs/data, job relationships, and foreign keys. Restore
   the approved staging route, set maintenance false, rebuild, and use the guarded
   `publish` command below. Keep delivery paused and sends/schedules disabled.

Backfill uses original `created_at`: January/February belong to the previous
starting year. Verify historical timestamps before migrating imported data whose
creation dates may not identify its actual season. IDs, timestamps, picks,
autoincrement high-water marks, job relationships, and delivery outcomes are
preserved. Ambiguous yearless standings suppression expires rather than crossing
seasons. Recover reviewed work with **new season-pinned retry children** that retain
delivery scopes, never by resuming old native instances. Production activation
remains a separate approval.

## Cloud deployment gates

Terraform declares the foundational resources; `wrangler.jsonc` declares the
application configuration. Local, staging, and production have separate names.
Native origins are `https://pickem-staging.bholzer.me` and
`https://pickem.bholzer.me`. Provisioning records each remote D1 ID in its selected
environment; public routes remain empty and sends/schedules disabled until
explicitly approved.

### Infrastructure as code

This follows Cloudflare's documented
[Terraform + Wrangler ownership split](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/):

| Owner | Declared resources and configuration |
| --- | --- |
| Terraform, `infrastructure/cloudflare/main.tf` | D1 database, Worker identity, disabled `workers.dev` and preview URLs |
| Wrangler, `wrangler.jsonc` | Application versions/deployments, assets, bindings, native Workflow definition and schedules, approved custom-domain attachment |

The Workflow is not an imperative one-off: its declaration is deployed with
the Worker by `prepare` or staging `publish`, following the
[native Workflows deployment model](https://developers.cloudflare.com/workflows/get-started/guide/).
Do not add a second Terraform owner for the same Workflow or Worker deployment.
Worker secrets come from the private JSON bundle, not Terraform configuration.

Install Terraform `>=1.5,<2`. The Cloudflare provider is pinned to `5.24.0`;
retain `infrastructure/cloudflare/.terraform.lock.hcl` in version control.
The guarded `provision` command initializes Terraform, validates the saved plan
against the exact environment/account/resource identities, and applies that
same plan. Only creates and no-ops are allowed; updates, replacements, imports,
unrelated resources, and deletion are refused. Both resources have
`prevent_destroy`. A configured D1 ID must agree with existing state; a missing
state file is not permission to adopt or recreate resources.

State is local and separate per environment:
`~/.config/nfl-pickem/terraform/<environment>/terraform.tfstate`.
Directories are owner-only and state files must have no group/other access.
No shared/remote backend is provisioned. Securely back up this directory and
restore or deliberately migrate it before operating from another machine.
Use one operator at a time; the local lock is not a distributed lock.
Do not clear recorded IDs or state to force a retry after an ambiguous failure.
Failed Terraform commands retain owner-only diagnostics under a private
`plan-*` directory and report its path without printing provider output.

With `CLOUDFLARE_API_TOKEN` supplied privately to the process and the approved
account ID in `CLOUDFLARE_ACCOUNT_ID`:

```sh
node scripts/cloudflare.mjs provision --env staging --approve-cloud \
  --account-id "$CLOUDFLARE_ACCOUNT_ID"
npm run build:staging
```

Re-running `provision` with the same quiescent configuration and state is a no-op
and retains the D1 ID. Provisioning requires no public routes; use `publish` for
subsequent public-staging application deployments. Production remains a separate,
explicit approval and state file.

### Guarded lifecycle

```sh
node scripts/cloudflare.mjs --help
node scripts/cloudflare.mjs plan --env staging --operation provision
```

`plan` is offline. Actual operations require `--approve-cloud` and the explicit
`--account-id`; activation, unpause, and imported Workflow creation also require
`--approve-discord`. These flags acknowledge an operator decision, not permission
to bypass the delivery checklist.

#### Public staging without delivery

Once staging's schema and private resources are initialized, `publish` makes
`https://pickem-staging.bholzer.me` available without importing business data or
enabling Discord. Keep `DISCORD_SEND_ENABLED` and `SCHEDULES_ENABLED` false,
`MAINTENANCE_MODE` false, and `workers.dev`/preview URLs disabled. Declare only
the staging custom domain in `env.staging.routes`; do not precreate its DNS
record. Wrangler owns the custom-domain association and its managed DNS/TLS.

Keep native schedules absent. For an unscheduled Workflow, omit `schedules`;
the pinned Wrangler rejects an explicitly empty Workflow schedule array.
Freeze staging HTTP/admin writers and DNS ownership changes during publication:

```sh
npm run build:staging
node scripts/cloudflare.mjs publish --env staging --approve-cloud \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --secrets-file "$HOME/.config/nfl-pickem/native-staging-secrets.json" \
  --writers-stopped --dns-quiesced
```

`publish` is staging-only. It verifies domain/Workflow ownership, stops existing
native work, deploys the matching build, reads back ownership, and retains
`job_settings.paused=1`. It neither imports data nor creates/resumes Workflow
instances, and does not waive the production activation gates below.

All asset requests run through the Worker first so HTTP receives a 308 HTTPS
redirect before app content or OAuth state cookies. Local development still
supports HTTP. No zone-wide HTTPS policy change is required.

Anonymous smoke checks cover `/up`, the sign-in page, OAuth initiation, and
authentication rejection at protected APIs. Discord sign-in still requires an
existing pool user; publication does not seed users or bypass registration.
An empty user table therefore prevents a completed Discord login. Valid
season-bearing submission links retain signed-link registration behavior.

#### Live delivery and data cutover

1. Approve the Cloudflare account and its existing `bholzer.me` zone, the exact
   environment hostname, OAuth application, and Discord recipient/channel allowlists.
2. Use `provision`, then rebuild the selected environment if its D1 ID changed.
   Provisioning records the ID in source; older build output with another ID
   is rejected.
3. Use `prepare` with private secrets and no public routes or schedules, then
   `migrate`. Use `import` only for an approved business-data migration. All three
   require `--writers-stopped` after freezing HTTP/admin writers and draining
   in-flight work; import additionally requires `--source-quiesced`. Existing D1
   delivery is fenced and existing native Workflows are paused/read back before
   mutation. A same-named Workflow must belong to the intended Worker; foreign
   or ambiguous ownership is rejected before controlling its instances.
4. Verify the actual target export and operational plan. Do not enable sends
   against an unverified database.
5. Keep the selected environment's exact configured HTTPS origin and add one
   custom-domain route with the existing zone's ID, OAuth client ID, Discord
   allowlists, and native Workflow schedules. Register the corresponding OAuth
   callback before activation. Enable sending/schedules only when approved.
   Use the existing six UTC schedules, not duplicate Worker cron triggers.
6. Rebuild with `npm run build:staging` or `npm run build:production`.
   Deploy the generated `dist/server/wrangler.json`; do not pass `--env` to it.
   Source/build mismatches are rejected.
7. Use `activate` with `--verified-data`, `--source-quiesced`, both approvals,
   `--dns-quiesced`, and `--secrets-file`. Keep DNS changes frozen while it
   checks the exact account, `bholzer.me` zone, hostname, and existing owner.
   An unattached hostname must have no existing DNS records of any type; the
   operation refuses to overwrite records or adopt another Worker's domain.
   Delivery is fenced before deployment and released only after the custom
   domain is read back as owned by the intended Worker. `unpause` requires the
   same domain verification and DNS freeze before retrying registered wakeups.
8. Use `workflows --file "$WORKFLOW_PLAN"` for the verified
   imported jobs, with the same data/quiescence acknowledgments and approvals.
   Review confirmed IDs on partial failure instead of blindly repeating jobs.

The private secrets JSON contains `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`SESSION_SECRET`, and `SUBMISSION_TOKEN_SECRET`. Keep it owner-only and outside
the repository. Never paste production secrets into chat or commit them.

Keep a separate `SESSION_SECRET` for each environment. Preserve the intended
`SUBMISSION_TOKEN_SECRET` for valid season-bearing links; the season cutover does
not require rotating it. Historical yearless JWTs must be reissued even if their
signatures are valid. Verify signing-key provenance before relying on any imported
links; a local credential backup alone does not establish live-production
provenance. The native application reads its configured secrets, not the retired
application's credential files.

Domain inspection, publication, activation, unpause, and detach require an
appropriately account/zone-scoped `CLOUDFLARE_API_TOKEN` in the operator
environment, even when Wrangler itself uses an existing login.

Wrangler's browser login can read zone and Workers identities, but its available
OAuth scopes do not include DNS-record reads. A DNS API `403` must not be treated
as an empty record set. Use a custom API token for the guarded deployment commands:

| Resource scope | Permissions |
| --- | --- |
| Only the configured Cloudflare account | Account Settings: Read; Workers Scripts: Edit; D1: Edit |
| Only `bholzer.me` | Zone: Read; DNS: Read; Workers Routes: Edit |

Cloudflare may label write permissions as **Write** rather than **Edit**.
Keep the token private, set an appropriate expiry, and supply it as
`CLOUDFLARE_API_TOKEN` only to the deployment process. Do not use a Global API key.

## DNS ownership

Native staging uses `pickem-staging.bholzer.me`; production uses
`pickem.bholzer.me`. Both belong to the user's **existing Cloudflare `bholzer.me`
zone**. No zone migration, full-zone ownership, or registrar changes are needed.
Other hostnames and DNS records remain under their existing management.
The existing zone ID is `edfc5bace78326d69aedc239f8e3fa91`.

Activation verifies the returned zone ID, exact zone name, and approved account.
For an unattached hostname, the exact-name DNS inventory must be complete and
empty. Do not precreate address records: the approved Workers custom-domain
attachment supplies DNS and TLS. Any existing record or another Worker's
association blocks activation; resolve ownership explicitly outside this tool
rather than deleting unrelated DNS. An existing association with the intended
Worker in the approved zone is safe to activate again.

Changing the public origin requires registering its exact Discord OAuth callback:
`https://pickem-staging.bholzer.me/auth/discord/callback` for staging and
`https://pickem.bholzer.me/auth/discord/callback` for production.

Changing `APP_ORIGIN` does not rewrite already-distributed links or redirect
traffic from other hostnames. Handle those links explicitly; do not change
unrelated DNS records or OAuth callbacks implicitly.

## Maintenance and recovery

Do not restore an old business snapshot after the Worker has accepted writes.

1. Use `node scripts/cloudflare.mjs maintenance --env staging` (or `production`)
   with `--approve-cloud`, the approved `--account-id`, and `--inflight-reviewed`.
   It sets the durable D1 delivery fence first, persists/deploys maintenance mode
   while retaining routes, disables schedules and sends, pauses native instances,
   and reconciles paused history. Keep delivery fenced if any step fails.
2. Drain in-flight HTTP requests and freeze administrator changes. Use `export`
   with `--writers-stopped` and a new `--output` SQL path to capture the latest
   quiesced D1 state. Export refuses paused native instances without corresponding
   D1 history; reconcile their original parameters before taking the snapshot.
3. Verify business content, job history, delivery outcomes, and suppression expiry.
   Resolve ambiguous sends before retrying work. Preserve both original snapshots
   and the latest verified export.
4. Recover through a deliberately rebuilt, source-matched native publication or
   activation with its required approvals. Activation does not automatically
   resume individually paused Workflows; review them through native job
   administration before resuming or replacing work.

Domain removal is a separate decision, not a normal recovery step. `detach` needs
`--snapshot-verified` after latest-snapshot and restore verification. It deletes
only the verified custom-domain association and confirms its absence before
persisting/deploying empty routes. Use `--zone-id` when retrying after routes are
already empty. Keep delivery fenced, retain verified snapshots, and handle
already-distributed links explicitly.

## Retired implementation backups

The Rails application, Ruby/Kamal/Docker tooling, and framework-specific migration
adapters have been removed from the working tree. Native SQL migrations and
compatibility fixtures remain; normal development and verification do not need Ruby.

Retirement backups on the cleanup workstation are stored outside the repository:
`~/.config/nfl-pickem/retired-rails/<timestamp>/`. The owner-only archives and
checksum manifests preserve local databases, the master key with its encrypted
credentials, uncommitted deployment/migration files, and pre-edit copies of affected
files. Tracked originals are also recoverable from the Git revision in the manifest.

Keep these backups private and back them up securely; they are not in Git. Extract
only into a new private directory, never over the working checkout or current
databases. Current native secret bundles and Terraform state remain in their
existing private locations and are not replaced by these historical backups.
