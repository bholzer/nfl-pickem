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
separate. Readability reports are retained as CI artifacts. CI does not deploy;
the separate [Deploy workflow](#github-actions-deployment) is manually dispatched.

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
dependency exception is Workerd's `cloudflare:*` module namespace. Review findings
before deleting code; do not remove native Workflow exports or pinned test-runtime
peers.

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

Those measurements predate removal of the custom deployment tooling. Remaining
long UI and durable-orchestration functions retain cohesive JSX and explicit
sequencing rather than fragmenting behavior solely for a score.

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

## Cloud deployment

Deployment uses native Wrangler commands, not a project deployment script.
Terraform owns D1 and Worker identity; Wrangler owns application versions, assets,
bindings, native Workflow configuration, and approved custom domains.
Cloud changes and Discord activation require separate, explicit approvals.

### GitHub Actions deployment

Create GitHub Environments named `staging` and `production`. Restrict deployment
branches to `main`, and require a production reviewer where available. Set these
values separately in each environment:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Approved account ID matching `wrangler.jsonc` |
| Secret | `CLOUDFLARE_API_TOKEN` | Account-scoped deployment token |
| Secret | `DISCORD_CLIENT_SECRET` | Discord OAuth client secret |
| Secret | `DISCORD_BOT_TOKEN` | Discord bot token |
| Secret | `SESSION_SECRET` | Environment-specific session signing key |
| Secret | `SUBMISSION_TOKEN_SECRET` | Intended submission-link signing key |

In **Actions → Deploy → Run workflow**, select `main` and the target environment,
then run the workflow after reviewing the pending migrations.
Deploy a reviewed revision whose CI has passed; this workflow does not rerun or
automatically wait for the CI suite.

The workflow caches npm downloads, installs locked dependencies, builds the
selected environment, and then:

1. Checks the build's environment/account.
2. Applies pending migrations with `wrangler d1 migrations apply`.
3. Uploads a uniquely tagged version with `wrangler versions upload`, including
   the four secrets, with strict checks and resource provisioning disabled.
4. Deploys that exact tag to 100% of traffic with `wrangler versions deploy`.
5. Checks the public `/up` response.

These commands are exposed as `db:migrate:remote`, `deploy:upload`, and `deploy`
in `package.json`; there is no custom runtime behind them. Version deployment
updates code, assets, variables, secrets, and existing bindings without
republishing custom domains or Workflow schedules. It does not pause/resume jobs,
reconcile history, or change the durable delivery fence. Review configuration
changes explicitly; there is no custom live-configuration drift validator.

The four application secrets remain individual GitHub secrets. The workflow uses
`jq` to serialize them into an owner-only temporary file for Wrangler, removes
them from the child process environment, and deletes the file on exit. Secret
values are not passed as command-line arguments.

Runs are serialized per environment and do not cancel an in-progress release.
Do not run local cloud operations concurrently. First provisioning/publication,
breaking migrations, domain or Workflow configuration changes, and deliberate
delivery activation remain operator tasks below. Production currently has no
D1 ID or public route; initialize it and commit the approved configuration first.

### Routine migrations

Wrangler applies all pending migrations without an application-specific schema
gate. The operator is responsible for reviewing compatibility and coordinating
any breaking changes with the currently deployed Worker and in-flight Workflow
versions. Keep applied migration files unchanged and present in the checkout.

Wrangler records applied migrations, so rerunning a release skips completed
files. A failed migration prevents version upload/publication, but earlier
successful migrations can remain applied. A later upload, deployment, or health
failure does not undo database changes. Inspect partial changes before retrying;
there is no automatic rollback.

### Infrastructure as code

Use Terraform `>=1.5,<2` directly with `infrastructure/cloudflare/main.tf`.
Retain the provider lock (Cloudflare `5.24.0`) and the existing per-environment
state at `~/.config/nfl-pickem/terraform/<environment>/terraform.tfstate`.
The provider manages only `cloudflare_d1_database.app` and
`cloudflare_worker.app`, both with `prevent_destroy`. Do not add a second
Terraform owner for Wrangler deployments or native Workflows.

Back up state privately first. Existing state, account/environment, names, and
configured D1 IDs must agree. Missing state is not permission to recreate or
adopt existing resources. Preserve `.backup` files and use one operator at a
time; a local lock is not distributed coordination. Never clear IDs, state, or
locks to force a retry.

Use a clean operator shell with the approved `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, without unexpected Terraform CLI, workspace, variable,
logging, or authentication overrides. Check existing private path ownership and
permissions; `umask` protects new files, not existing ones.

```sh
umask 077
ENV=staging
STATE_DIR="$HOME/.config/nfl-pickem/terraform/$ENV"
export TF_DATA_DIR="$STATE_DIR/data" TF_WORKSPACE=default
export TF_VAR_environment="$ENV" TF_VAR_account_id="$CLOUDFLARE_ACCOUNT_ID"
mkdir -p "$TF_DATA_DIR"
PLAN_DIR=$(mktemp -d "$STATE_DIR/plan-XXXXXX")
terraform -chdir=infrastructure/cloudflare init -input=false -reconfigure \
  -lockfile=readonly -backend-config="path=$STATE_DIR/terraform.tfstate"
terraform -chdir=infrastructure/cloudflare output -json
terraform -chdir=infrastructure/cloudflare plan -input=false -lock-timeout=0s \
  -out="$PLAN_DIR/approved.tfplan"
terraform -chdir=infrastructure/cloudflare show "$PLAN_DIR/approved.tfplan"
```

Stop and review the exact saved plan. Existing resources should normally be
no-ops. Unexpected updates, replacements, imports, unrelated resources, deletions,
or identity drift require a separate decision; `prevent_destroy` is not a full
plan validator. With explicit approval, apply that same file:

```sh
terraform -chdir=infrastructure/cloudflare apply -input=false -lock-timeout=0s \
  "$PLAN_DIR/approved.tfplan"
terraform -chdir=infrastructure/cloudflare output -json
```

Saved-plan apply has no confirmation prompt. Keep plans and provider diagnostics
private. After legitimate new provisioning, record the verified D1 ID in the
selected environment of `wrangler.jsonc`, commit it, and rebuild. Do not change
another environment's ID or replace the existing private state layout.

### First publication and configuration changes

These are separately approved operator operations, not the routine workflow.
Identify the exact account, D1, Worker, Workflow, hostname, and zone before acting.
Freeze concurrent operators and DNS ownership changes. For an existing target,
follow maintenance below before a breaking change.

For a **fresh, offline target only**, apply its initial schema directly:

```sh
ENV=staging
npm run db:migrate:remote -- --env "$ENV"
```

Verify the initialized data and `job_settings.paused=1`. Configure only the
approved environment: its D1 ID, exact HTTPS `APP_ORIGIN`, custom domain and zone,
OAuth client/callback, and Discord allowlists. Keep `workers.dev` and preview
URLs disabled. Public staging needs no imported data and can keep
`DISCORD_SEND_ENABLED` and `SCHEDULES_ENABLED` false indefinitely.

For an unscheduled Workflow, omit `schedules`; do not assign an empty array.
Only with separate delivery approval, verified data, and disabled duplicate
source dispatchers should you enable sends/schedules and configure the six UTC
native schedules from `src/server/jobs/store.ts`. Do not add Worker cron triggers.

Use a private, owner-only JSON secrets file outside the repository containing the
same four application keys as GitHub. Build the selected environment and publish
the generated configuration without `--env`:

```sh
npm run "build:$ENV"
npx --no-install wrangler deploy --config dist/server/wrangler.json \
  --strict --experimental-provision=false \
  --secrets-file "$HOME/.config/nfl-pickem/native-$ENV-secrets.json"
```

Unlike version deployment, this command publishes domains and Workflow
configuration. **`--strict` does not prevent custom-domain takeover in
noninteractive Wrangler.** Inspect exact hostname ownership/DNS beforehand and
verify the resulting association, bindings, and schedules afterward. Do not
automate full publication by assuming that flag supplies a domain safety check.
Retain delivery fences until all checks pass.

Check `/up`, HTTPS redirection, sign-in/OAuth initiation, and protected API
rejection. `/up` is liveness, not proof of correct data or a write fence.
Discord login still requires an existing pool user; publication does not seed
users or bypass registration. Valid season-bearing submission links retain
signed-link registration behavior.

### Secrets and permissions

Use distinct session keys per environment and a distinct intended submission
key, generated with at least 32 random bytes. Preserve the intended
`SUBMISSION_TOKEN_SECRET`; the season cutover does not require rotating it.
Yearless JWTs must be reissued even with valid signatures. Verify imported
signing-key provenance; retired credential files are not native configuration.
Never commit or print secret values, tokens, SQL snapshots, or Terraform state.

Scope deployment tokens to the approved account with Account Settings: Read,
Workers Scripts: Edit, and D1: Edit. Operators publishing or inspecting domains
also need Zone: Read, DNS: Read, and Workers Routes: Edit for `bholzer.me` only.
Cloudflare may label Edit as Write. Use an expiring custom API token, not a
Global API key; Wrangler browser-login scopes do not supply DNS-record reads.
An authorization failure is not an empty DNS inventory.

## Maintenance and recovery

There is no automatic maintenance/cutover controller. Use native tools and
existing application administration, with explicit approval and one operator.
Do not restore an old business snapshot after the Worker has accepted writes.

1. Establish an administrator session at `/admin/jobs` before maintenance blocks
   OAuth callbacks. Use global Pause and verify `job_settings.paused=1`. This is
   a durable delivery fence, not an HTTP write freeze or recall of in-flight sends.
   If administration is unavailable, an approved D1 update of that existing row
   to `paused=1`, followed by readback, is a one-way safety fallback.
2. Set the selected source environment to `MAINTENANCE_MODE="true"`,
   `DISCORD_SEND_ENABLED="false"`, and `SCHEDULES_ENABLED="false"`. Omit Workflow
   schedules, retain approved routes, rebuild, and use the full publication
   command above. Verify native schedules are removed and the actual HTTP write
   fence works. Drain in-flight requests/sends and stop source/admin writers.
3. Inventory all Workflows belonging to this Worker and every page of their
   instances, plus D1 job history. Use application Pause/Cancel for known jobs;
   it coordinates native state with durable history. Inspect orphan instances,
   missing history, delivery outcomes, and ambiguous sends before retrying work.
4. Finish reconciliation, stop all remaining writers, then take and verify a
   fresh private D1 export. Some job-history reads reconcile state and therefore
   write to D1; perform them before the final snapshot freeze.
5. Recover through reviewed compatible code/configuration while delivery remains
   fenced. Enable sends/schedules only with separate approval, verified data,
   domain/OAuth/allowlists, and stopped duplicate dispatchers. Leave maintenance,
   then use application global Unpause; it wakes registered delivery waiters.
   SQL `paused=0` omits those wakeups. A partially failed unpause can already have
   cleared the fence; review and deliberately retry the same operation.

Native inventory/control commands use source configuration and are remote by
default. Repeat inventory for **every page** and inspect exact Worker ownership;
do not operate on another application's similarly named Workflow.

```sh
WF="nfl-pickem-$ENV-jobs"
npx --no-install wrangler workflows list \
  --config wrangler.jsonc --env "$ENV" --page 1 --per-page 100 --json
npx --no-install wrangler workflows describe "$WF" \
  --config wrangler.jsonc --env "$ENV" --json
npx --no-install wrangler workflows instances list "$WF" \
  --config wrangler.jsonc --env "$ENV" --page 1 --per-page 100 --json
npx --no-install wrangler workflows instances describe "$WF" "$ID" \
  --config wrangler.jsonc --env "$ENV" --json
```

For reviewed orphan/old instances, native `workflows instances pause` or
`terminate` takes the same Workflow name and explicit ID; never use `latest`.
Read back the final state: `waitingForPause` is not paused. Native controls alone
do not update D1. In particular, history reads skip already-paused D1 rows, so
terminating an instance does not automatically retire its paused row. Prefer
application Cancel, or a separately reviewed per-ID repair if compatible
administration is unavailable.

Individually paused jobs remain paused after global Unpause. Review them
separately; preserve delivery scopes, effect/message records, suppression expiry,
and original dispatch timing. Prefer app Enqueue/Retry over bulk native triggers.
Imported work requires reviewed season-qualified parameters and exact IDs; after
an ambiguous creation failure, inspect that ID rather than creating a duplicate.
Discord sends and D1 commits are not atomic or exactly-once.

## Data import and snapshots

Keep original snapshots and the latest verified export in owner-only directories
outside the checkout. After writer/dispatcher freeze, drain, and reconciliation:

```sh
umask 077
npx --no-install wrangler d1 export "nfl-pickem-$ENV" --remote \
  --config wrangler.jsonc --env "$ENV" --output "$BACKUP_SQL"
```

Use a new private output path and verify actual contents and restore suitability.
For an approved business-data import into a fresh, offline, already-migrated
target, use `wrangler d1 execute DB --remote --config wrangler.jsonc --env "$ENV"
--file "$IMPORT_SQL"`. A complete schema-bearing backup is not a data-only import;
do not blindly execute it into existing tables. An entire SQL import is not
guaranteed atomic. Keep a partially changed target offline and inspect it before
retrying. Verify an actual target export before enabling deliveries.

### Season schema cutover (`0003_seasons.sql`)

This is **not rolling-compatible**. The SQL rejects nonterminal **D1 history**;
it cannot inspect native instances. For an already-published target:

1. Complete the maintenance fence and writer/dispatcher freeze above.
2. Cancel/terminate every unfinished old native instance, including paused ones.
   Require only native `complete`, `errored`, or `terminated` states; unknown
   states block cutover. Reconcile D1 separately, including paused/orphan rows.
   The following query must return no rows, but does not prove native retirement:
   `SELECT id,status FROM job_runs WHERE status NOT IN
   ('complete','errored','cancelled','superseded','creation_failed')`.
3. Take and verify the latest actual private export. Preserve original
   configuration, IDs, timestamps, picks/tiebreakers, autoincrement high-water
   marks, job relationships, delivery scopes/outcomes, and suppression expiry.
4. With all fences still held, run `npm run db:migrate:remote -- --env "$ENV"`.
   There is no need to remove routes for a D1 command. Verify migration history,
   business content/identities, season backfills, and `PRAGMA foreign_key_check`.
5. Publish reviewed compatible code, leave maintenance deliberately, and retain
   delivery fences until separately approved recovery.

Backfill uses original `created_at`; January/February belong to the preceding
starting year. Verify historical timestamps before migrating imports whose
creation dates may not identify their actual season. Ambiguous yearless standings
suppression expires rather than crossing seasons. Never resume pre-cutover native
code: recover reviewed work through **new season-pinned retry children** retaining
delivery scopes.

## DNS ownership

Staging is `pickem-staging.bholzer.me`; production is `pickem.bholzer.me`, both in
the existing `bholzer.me` zone `edfc5bace78326d69aedc239f8e3fa91`.
Do not migrate the zone, precreate custom-domain DNS records, or modify unrelated
records. Before full publication, verify the exact zone/account and either the
intended Worker's existing association or an unattached hostname with no existing
DNS records of any type. Conflicts require a separate ownership decision, not
automatic takeover. Keep DNS changes frozen through publication and readback.

Register the exact Discord callback `<APP_ORIGIN>/auth/discord/callback`.
Changing `APP_ORIGIN` does not rewrite distributed links or redirect other hosts.
Domain removal is a separate approved operation after latest-snapshot/restore
verification: remove only the confirmed owned association and verify its absence.
An empty source routes array alone is not proof of detachment. Keep delivery
fenced and handle existing links explicitly; preserve unrelated DNS and callbacks.

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
