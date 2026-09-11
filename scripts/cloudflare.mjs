import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { provisionInfrastructure } from "./infrastructure.mjs";
import { validSeason } from "../src/shared/season.ts";

/** @typedef {import("./cloudflare-types.js").Configuration} Configuration */
/** @typedef {import("./cloudflare-types.js").SourceConfiguration} SourceConfiguration */
/** @typedef {import("./cloudflare-types.js").Options} Options */
/** @typedef {import("./cloudflare-types.js").Runtime} Runtime */
/** @typedef {import("./cloudflare-types.js").Run} Run */
/** @typedef {import("./cloudflare-types.js").Api} Api */
/** @typedef {import("./cloudflare-types.js").Plan} Plan */
/** @typedef {import("./cloudflare-types.js").WorkflowPlan} WorkflowPlan */
/** @typedef {import("./cloudflare-types.js").Instance} Instance */
/** @typedef {import("./cloudflare-types.js").WorkflowEntry} WorkflowEntry */
/** @typedef {import("./cloudflare-types.js").WorkflowReport} WorkflowReport */
/** @typedef {import("./cloudflare-types.js").WakeupReport} WakeupReport */
/** @typedef {import("./cloudflare-types.js").Adapters} Adapters */
/** @typedef {import("./cloudflare-types.js").DomainInventory} DomainInventory */
/** @typedef {import("./cloudflare-types.js").ZoneResponse} ZoneResponse */
/** @typedef {import("./cloudflare-types.js").RawSource} RawSource */
/** @typedef {import("./cloudflare-types.js").RawConfiguration} RawConfiguration */
/** @typedef {import("./cloudflare-types.js").D1Plan} D1Plan */
/** @typedef {import("./cloudflare-types.js").CommandResult} CommandResult */
/** @typedef {import("./cloudflare-types.js").DomainRecord} DomainRecord */
/** @typedef {Runtime & { accountId: string }} AccountRuntime */
/** @typedef {RawSource & { env: Record<string, RawConfiguration> }} ProvisionSource */
/** @typedef {RawConfiguration & { assets?: Record<string, unknown> }} BuiltConfiguration */
/**
 * @typedef {Record<string, string> & {
 *   SESSION_SECRET: string;
 *   SUBMISSION_TOKEN_SECRET: string;
 * }} ApplicationSecrets
 */
/**
 * @typedef {object} RawWorkflowDocument
 * @property {unknown} [version]
 * @property {unknown} [environment]
 * @property {RawWorkflowEntry[]} workflows
 */
/** @typedef {{ id: unknown; params: unknown }} RawWorkflowEntry */
/** @typedef {{ id?: unknown; status?: unknown }} RawInstance */
/** @typedef {{ name?: unknown; script_name?: unknown }} RawWorkflow */
/** @typedef {{ success?: unknown; results?: Record<string, unknown>[] }} RawD1Result */
/** @typedef {{ success: true; results: Record<string, unknown>[] }} D1Result */
/** @typedef {{ sourceFlags: string[]; distFlags: string[] }} PlanFlags */

// Native contracts: developers.cloudflare.com/workers/wrangler/commands/{workers,d1,workflows}/
const secrets = [
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "SESSION_SECRET",
  "SUBMISSION_TOKEN_SECRET",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commands = [
  "plan",
  "provision",
  "prepare",
  "migrate",
  "import",
  "export",
  "publish",
  "activate",
  "unpause",
  "maintenance",
  "detach",
  "workflows",
];
/** @type {Record<string, string | undefined>} */
const hostnames = {
  staging: "pickem-staging.bholzer.me",
  production: "pickem.bholzer.me",
};
/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function requireThat(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** @type {Record<string, string[]>} */
const transitions = {
  provision: [
    "Require quiet source configuration and explicit cloud approval",
    "Initialize private environment-local Terraform state; reject configured D1 identity conflicts",
    "Inspect a saved Terraform plan allowing only D1 and Worker identity creation or no-op",
    "Apply the exact inspected plan and verify resource outputs",
    "Persist the verified D1 ID in the selected source environment; rebuild before Wrangler deploy",
  ],
  prepare: [
    "Require HTTP/admin writers stopped and in-flight work drained",
    "Fence D1 if present; pause/read back existing native Workflows; reconcile all pending history",
    "Deploy quiet configuration with routes and schedules disabled",
    "Verify the persistent fence and native stopped state",
  ],
  migrate: [
    "Require HTTP/admin writers stopped and in-flight work drained",
    "Fence D1 if present; pause/read back existing native Workflows; reconcile all pending history",
    "Apply schema migrations",
    "Verify the persistent fence and native stopped state",
  ],
  import: [
    "Require HTTP/admin writers stopped and in-flight work drained",
    "Fence D1; pause/read back existing native Workflows; reconcile all pending history",
    "Import verified SQL only after quiescence",
  ],
  publish: [
    "Require HTTP/admin writers stopped and in-flight work drained",
    "Require DNS freeze; verify exact account/zone/hostname ownership and no existing records for an unattached domain before mutation",
    "Fence D1; pause/read back existing native Workflows; reconcile all pending history",
    "Deploy source-matched public staging config with sends and all schedules disabled",
    "Read back the exact custom-domain association",
    "Freeze native work again; verify stopped history and retain D1 paused=1 without delivery wakeups",
  ],
  activate: [
    "D1 paused=1 and readback before deploy",
    "Require DNS freeze; verify exact account/zone/hostname ownership and no existing records for an unattached domain",
    "Deploy enabled source-matched config",
    "Read back the exact custom-domain association",
    "D1 paused=0 and readback after deploy",
    "Query registered non-individually-paused waiters; send native delivery-resume events; report every failed ID",
  ],
  unpause: [
    "Require DNS freeze and verify the exact custom-domain association",
    "D1 paused=0 and readback",
    "Query registered non-individually-paused waiters; send native delivery-resume events; never resume individually paused instances",
  ],
  maintenance: [
    "D1 paused=1 and readback first",
    "Persist maintenance source/dist while retaining routes",
    "Deploy maintenance config",
    "Enumerate and pause every nonterminal native Workflow",
    "Verify native stop; synchronize only nonterminal D1 history; verify persistent fence and history",
  ],
  export: [
    "Verify maintenance and stopped native inventory",
    "Verify D1 delivery fence and no active/unknown D1 history",
    "Reserve private new SQL output",
    "Native D1 export",
  ],
  detach: [
    "Require verified latest snapshot",
    "Verify exact account/zone/hostname and Worker ownership",
    "Delete only the approved custom-domain association via REST; verify absence",
    "Persist empty source/dist routes",
    "Deploy detached configuration",
  ],
  workflows: [
    "Validate target document and deterministic run IDs",
    "Trigger each native Workflow once",
    "On failure describe exact ID; report confirmed existing or partial failure without retries",
  ],
};

// Wrangler's non-interactive deploy overrides domain conflicts, and an empty
// route list does not detach domains. Use the scoped REST API for those guards.
/**
 * @param {string} method
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function cloudflareApi(method, path) {
  requireThat(
    process.env.CLOUDFLARE_API_TOKEN,
    "CLOUDFLARE_API_TOKEN required for domain ownership checks",
  );
  let response;
  /** @type {unknown} */
  let body;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        Accept: "application/json",
      },
    });
    body = await response.json();
  } catch {
    throw new Error("Cloudflare domain request failed; no automatic retry");
  }
  requireThat(
    response.ok &&
      typeof body === "object" &&
      body !== null &&
      "success" in body &&
      body.success === true,
    "Cloudflare domain request rejected; provider contents withheld",
  );
  return body;
}

/**
 * @param {Configuration["routes"]} routes
 * @param {string} hostname
 * @param {string} zoneId
 */
function assertApprovedRoute(routes, hostname, zoneId) {
  const route = routes?.[0];
  requireThat(
    !route ||
      (routes.length === 1 &&
        route.custom_domain === true &&
        route.pattern === hostname &&
        route.zone_id === zoneId),
    "Domain approval differs from configured route",
  );
}

/**
 * @param {Configuration} config
 * @param {Options} options
 * @param {string} environment
 */
function domainTarget(config, options, environment) {
  const hostname = new URL(config.vars.APP_ORIGIN).hostname;
  const route = config.routes?.[0];
  const zoneId = options["zone-id"] ?? route?.zone_id;
  requireThat(
    zoneId &&
      /^[0-9a-f]{32}$/i.test(zoneId) &&
      hostname &&
      !hostname.endsWith(".invalid"),
    "Domain operation requires actual origin and --zone-id or configured route zone",
  );
  assertApprovedRoute(config.routes, hostname, zoneId);
  requireThat(
    hostname === hostnames[environment],
    "Domain belongs to a different application environment",
  );
  return { hostname, zoneId };
}

/**
 * @param {string} zoneId
 * @param {Api} api
 * @param {AccountRuntime} runtime
 */
async function verifyDomainZone(zoneId, api, runtime) {
  const zone = /** @type {ZoneResponse} */ (
    await api("GET", `/zones/${zoneId}`, runtime)
  );
  requireThat(
    zone.result?.id === zoneId &&
      zone.result.account?.id === runtime.accountId &&
      zone.result.name === "bholzer.me",
    "Domain zone/account approval mismatch",
  );
}

/**
 * @param {DomainRecord} domain
 * @param {string} worker
 * @param {string} hostname
 * @param {string} zoneId
 */
function assertDomainOwner(domain, worker, hostname, zoneId) {
  // Domain identifiers are opaque; unlike zone IDs, they are not fixed-length.
  requireThat(
    domain.hostname === hostname &&
      domain.zone_id === zoneId &&
      domain.service === worker &&
      domain.environment === "production" &&
      typeof domain.id === "string" &&
      /^[a-z0-9_-]+$/i.test(domain.id),
    "Custom domain belongs to another Worker or zone",
  );
}

/**
 * @param {Plan} plan
 * @param {Api} api
 * @param {AccountRuntime} runtime
 */
async function domainInventory(plan, api, runtime) {
  requireThat(plan.domain, "Domain operation requires approved target");
  const { hostname, zoneId } = plan.domain;
  await verifyDomainZone(zoneId, api, runtime);
  const response = /** @type {DomainInventory} */ (
    await api(
      "GET",
      `/accounts/${runtime.accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
      runtime,
    )
  );
  requireThat(
    Array.isArray(response.result) &&
      response.result.length <= 1 &&
      !((response.result_info?.total_pages ?? 0) > 1),
    "Ambiguous custom-domain inventory",
  );
  for (const domain of response.result) {
    assertDomainOwner(domain, plan.worker, hostname, zoneId);
  }
  return /** @type {(DomainRecord & { id: string })[]} */ (response.result);
}

/**
 * @param {Plan} plan
 * @param {Options} options
 * @param {Api} api
 * @param {AccountRuntime} runtime
 */
async function verifyDeploymentDomain(plan, options, api, runtime) {
  requireThat(
    options["dns-quiesced"],
    "Public deployment requires --dns-quiesced during domain ownership verification and deployment",
  );
  if ((await domainInventory(plan, api, runtime)).length) {
    return;
  }
  requireThat(plan.domain, "Domain operation requires approved target");
  const response = /** @type {DomainInventory} */ (
    await api(
      "GET",
      `/zones/${plan.domain.zoneId}/dns_records?name=${encodeURIComponent(plan.domain.hostname)}&per_page=100`,
      runtime,
    )
  );
  requireThat(
    Array.isArray(response.result) &&
      !((response.result_info?.total_pages ?? 0) > 1),
    "Incomplete DNS record inventory",
  );
  requireThat(
    response.result.length === 0,
    "Existing DNS records at the approved hostname; refusing non-interactive overwrite",
  );
}
/**
 * @param {string} text
 * @param {number} start
 */
function quotedEnd(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return text.length;
}

/** @param {string} text */
function stripConfigComments(text) {
  let result = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === '"') {
      const end = quotedEnd(text, index);
      result += text.slice(index, end);
      index = end;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end + 1;
      result += "\n";
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      requireThat(end !== -1, "Unclosed config comment");
      index = end + 2;
      result += " ";
    } else {
      result += text.charAt(index);
      index++;
    }
  }
  return result;
}

/** @param {string} text */
function stripTrailingCommas(text) {
  let result = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === '"') {
      const end = quotedEnd(text, index);
      result += text.slice(index, end);
      index = end;
      continue;
    }
    if (text[index] !== "," || !/^\s*[}\]]/.test(text.slice(index + 1))) {
      result += text.charAt(index);
    }
    index++;
  }
  return result;
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonc(text) {
  // Treat comments and commas only outside quoted JSON; never evaluate config code.
  /** @type {unknown} */
  const value = JSON.parse(stripTrailingCommas(stripConfigComments(text)));
  return value;
}

/**
 * @param {RawSource} source
 * @param {RawConfiguration} config
 * @param {string} environment
 */
function assertSeparateResources(source, config, environment) {
  for (const [other, candidate] of Object.entries(source.env ?? {})) {
    if (other === environment) {
      continue;
    }
    requireThat(
      !candidate.d1_databases?.some(
        (db) =>
          db.database_id &&
          db.database_id === config.d1_databases?.[0]?.database_id,
      ),
      "D1 ID shared across environments",
    );
    requireThat(
      candidate.name !== config.name &&
        !candidate.workflows?.some(
          (w) => w.name === config.workflows?.[0]?.name,
        ),
      "Resource shared across environments",
    );
  }
}

/**
 * @param {RawConfiguration} config
 * @param {string} environment
 */
function validateEnvironmentBindings(config, environment) {
  requireThat(
    config.d1_databases?.length === 1 &&
      config.d1_databases[0]?.binding === "DB",
    "Exactly one DB binding required",
  );
  requireThat(
    config.workflows?.length === 1 && config.workflows[0]?.binding === "JOBS",
    "Exactly one JOBS binding required",
  );
  requireThat(
    config.d1_databases[0].database_name === `nfl-pickem-${environment}`,
    "D1 name must identify target environment",
  );
  requireThat(
    config.workflows[0].name === `nfl-pickem-${environment}-jobs`,
    "Workflow name must identify target environment",
  );
}

/**
 * @param {unknown} input
 * @param {string | undefined} environment
 * @returns {Configuration}
 */
function environmentConfig(input, environment) {
  const source = /** @type {RawSource} */ (input);
  requireThat(
    environment === "staging" || environment === "production",
    "Explicit --env staging or production required",
  );
  const config = source.env?.[environment];
  requireThat(
    config && config.vars?.APP_ENV === environment,
    "Source environment identity mismatch",
  );
  requireThat(
    config.vars.APP_ORIGIN === `https://${hostnames[environment]}`,
    "APP_ORIGIN must match the approved environment hostname",
  );
  requireThat(
    config.name === `nfl-pickem-${environment}`,
    "Worker name must identify target environment",
  );
  validateEnvironmentBindings(config, environment);
  assertSeparateResources(source, config, environment);
  const vars = config.vars;
  requireThat(
    !secrets.some((name) => name in vars || name in (source.vars ?? {})),
    "Secrets must not be in source vars",
  );
  return /** @type {Configuration} */ ({
    ...source,
    ...config,
    env: undefined,
  });
}

/**
 * @param {Configuration} config
 * @param {BuiltConfiguration} dist
 */
function verifyBuiltBindings(config, dist) {
  for (const key of ["binding", "run_worker_first", "not_found_handling"]) {
    requireThat(
      isDeepStrictEqual(config.assets?.[key], dist.assets?.[key]),
      `Source/dist assets ${key} mismatch; rebuild target`,
    );
  }
  requireThat(dist.d1_databases?.length === 1, "Unexpected dist DB bindings");
  for (const key of ["binding", "database_name", "database_id"]) {
    requireThat(
      config.d1_databases[0][key] === dist.d1_databases[0]?.[key],
      `Source/dist D1 ${key} mismatch`,
    );
  }
  requireThat(
    uuid.test(config.d1_databases[0].database_id ?? ""),
    "Provision source D1 ID before building/deploying",
  );
}

/**
 * @param {unknown} source
 * @param {unknown} built
 * @param {string | undefined} environment
 */
export function verifyDist(source, built, environment) {
  const dist = /** @type {BuiltConfiguration} */ (built);
  const config = environmentConfig(source, environment);
  requireThat(
    dist.targetEnvironment === environment &&
      dist.vars?.APP_ENV === environment,
    "Stale dist environment; rebuild target",
  );
  for (const key of ["name", "vars", "workers_dev", "preview_urls", "route"]) {
    requireThat(
      isDeepStrictEqual(config[key], dist[key]),
      `Source/dist ${key} mismatch; rebuild target`,
    );
  }
  for (const key of ["routes", "workflows"]) {
    requireThat(
      isDeepStrictEqual(config[key] ?? [], dist[key] ?? []),
      `Source/dist ${key} mismatch; rebuild target`,
    );
  }
  requireThat(
    isDeepStrictEqual(config.triggers ?? {}, dist.triggers ?? {}),
    "Source/dist triggers mismatch",
  );
  verifyBuiltBindings(config, dist);
  requireThat(
    !secrets.some((name) => name in (dist.vars ?? {})),
    "Secrets must not be in dist vars",
  );
  return config;
}

/** @param {Configuration} config */
function assertQuiescent(config) {
  requireThat(
    config.workers_dev === false &&
      config.preview_urls === false &&
      !config.routes?.length &&
      !config.route,
    "Prepare/import requires no public routes, workers.dev or preview URLs",
  );
  requireThat(
    config.vars.DISCORD_SEND_ENABLED === "false" &&
      config.vars.SCHEDULES_ENABLED === "false",
    "Prepare/import requires sends and schedules disabled",
  );
  requireThat(
    !config.triggers?.crons?.length &&
      !config.workflows.some((w) => w.schedules?.length),
    "Prepare/import requires no native schedules",
  );
}

/**
 * @param {URL} url
 * @param {string} origin
 */
function assertPublicOrigin(url, origin) {
  requireThat(
    url.protocol === "https:" &&
      !url.hostname.endsWith(".invalid") &&
      !url.username &&
      !url.password &&
      url.origin === origin,
    "Public deployment requires a real HTTPS APP_ORIGIN without path",
  );
}

/**
 * @param {Configuration} config
 * @param {string} environment
 */
function assertPublicDomain(config, environment) {
  const url = new URL(config.vars.APP_ORIGIN);
  assertPublicOrigin(url, config.vars.APP_ORIGIN);
  requireThat(
    config.workers_dev === false && config.preview_urls === false,
    "Public deployment uses explicit custom domains only",
  );
  requireThat(
    !config.route &&
      config.routes?.length === 1 &&
      config.routes[0]?.custom_domain === true &&
      config.routes[0].pattern === url.hostname &&
      /^[0-9a-f]{32}$/i.test(config.routes[0].zone_id ?? ""),
    "Public deployment requires one explicit custom-domain route with actual zone_id",
  );
  requireThat(
    url.hostname === hostnames[environment],
    "Public deployment may attach only the approved environment hostname",
  );
}

/**
 * @param {Configuration} config
 * @param {string} environment
 */
function assertActive(config, environment) {
  assertPublicDomain(config, environment);
  requireThat(
    config.vars.MAINTENANCE_MODE === "false",
    "Activation requires maintenance disabled in source",
  );
  requireThat(
    config.vars.DISCORD_SEND_ENABLED === "true" &&
      config.vars.SCHEDULES_ENABLED === "true",
    "Activation requires explicit enabled source config",
  );
  requireThat(
    (config.workflows[0].schedules?.length ?? 0) > 0 &&
      !config.triggers?.crons?.length,
    "Activation requires native Workflow schedules, not duplicate Worker cron triggers",
  );
  assertDiscordAllowlist(config.vars);
}

/** @param {Configuration["vars"]} vars */
function assertDiscordAllowlist(vars) {
  for (const name of ["DISCORD_CLIENT_ID", "DISCORD_CHANNEL_ID"]) {
    requireThat(
      /^\d{17,20}$/.test(vars[name] ?? ""),
      `Activation requires ${name}`,
    );
  }
  for (const name of [
    "DISCORD_ALLOWED_USER_IDS",
    "DISCORD_ALLOWED_CHANNEL_IDS",
  ]) {
    requireThat(
      /^[0-9]{17,20}(,[0-9]{17,20})*$/.test(vars[name] ?? ""),
      `Activation requires explicit ${name}`,
    );
  }
  requireThat(
    vars.DISCORD_ALLOWED_CHANNEL_IDS.split(",").includes(
      vars.DISCORD_CHANNEL_ID,
    ),
    "Configured channel must be allowlisted",
  );
}

/**
 * @param {Configuration} config
 * @param {string} environment
 */
function assertPublication(config, environment) {
  requireThat(
    environment === "staging",
    "Publication is staging-only; production requires activation",
  );
  assertPublicDomain(config, environment);
  requireThat(
    config.vars.MAINTENANCE_MODE === "false",
    "Publication requires maintenance disabled in source",
  );
  requireThat(
    config.vars.DISCORD_SEND_ENABLED === "false" &&
      config.vars.SCHEDULES_ENABLED === "false",
    "Publication requires sends and schedules disabled",
  );
  requireThat(
    !config.triggers?.crons?.length &&
      !config.workflows.some((workflow) => workflow.schedules?.length),
    "Publication requires no native schedules",
  );
  requireThat(
    /^\d{17,20}$/.test(config.vars.DISCORD_CLIENT_ID ?? ""),
    "Publication requires DISCORD_CLIENT_ID",
  );
}

/**
 * @param {string} action
 * @param {Options} options
 * @param {Configuration} config
 * @param {string} environment
 */
function validatePlanAction(action, options, config, environment) {
  if (["prepare", "migrate", "import"].includes(action)) {
    assertQuiescent(config);
  }
  if (action === "publish") {
    assertPublication(config, environment);
  }
  if (action === "activate" || action === "unpause") {
    assertActive(config, environment);
    requireThat(
      options["verified-data"] && options["source-quiesced"],
      "Activation requires --verified-data and --source-quiesced after snapshot verification",
    );
  }
  if (action === "provision") {
    assertQuiescent(config);
  }
}

/**
 * @param {string} action
 * @param {Options} options
 * @param {Configuration} config
 * @param {string} environment
 * @param {PlanFlags} flags
 */
function planSteps(
  action,
  options,
  config,
  environment,
  { sourceFlags, distFlags },
) {
  /** @type {string[][]} */
  let steps = [];
  validatePlanAction(action, options, config, environment);
  if (["prepare", "publish", "activate"].includes(action)) {
    requireThat(
      options["secrets-file"],
      "Private --secrets-file JSON required",
    );
    steps = [
      [
        "deploy",
        ...distFlags,
        "--secrets-file",
        resolve(options["secrets-file"]),
        "--experimental-auto-create=false",
      ],
    ];
  }
  if (action === "migrate") {
    steps = [["d1", "migrations", "apply", "DB", "--remote", ...sourceFlags]];
  }
  if (action === "import") {
    requireThat(
      options.file && options["source-quiesced"],
      "Import requires --file SQL and --source-quiesced",
    );
    steps = [
      [
        "d1",
        "execute",
        "DB",
        "--remote",
        "--file",
        resolve(options.file),
        "--yes",
        ...sourceFlags,
      ],
    ];
  }
  if (action === "export") {
    requireThat(options.output, "Export requires new --output SQL path");
    steps = [
      [
        "d1",
        "export",
        "DB",
        "--remote",
        "--output",
        resolve(options.output),
        "--skip-confirmation",
        ...sourceFlags,
      ],
    ];
  }
  if (action === "detach") {
    requireThat(
      options["snapshot-verified"] &&
        config.vars.MAINTENANCE_MODE === "true" &&
        config.vars.DISCORD_SEND_ENABLED === "false" &&
        config.vars.SCHEDULES_ENABLED === "false",
      "Detach requires maintenance mode and --snapshot-verified after the latest data round trip",
    );
    steps = [["deploy", ...distFlags, "--experimental-auto-create=false"]];
  }
  return steps;
}

/**
 * @param {string} action
 * @param {Options} options
 * @param {unknown} source
 * @param {unknown} [dist]
 * @returns {Plan}
 */
export function makePlan(action, options, source, dist) {
  requireThat(commands.includes(action), "Unknown operation");
  const environment = options.env;
  requireThat(environment, "Explicit --env staging or production required");
  const config = ["plan", "provision"].includes(action)
    ? environmentConfig(source, environment)
    : verifyDist(source, dist, environment);
  const sourcePath = resolve(options.source ?? "wrangler.jsonc");
  const distPath = resolve(options.dist ?? "dist/server/wrangler.json");
  const sourceFlags = ["--config", sourcePath, "--env", environment];
  const distFlags = ["--config", distPath]; // Vite selects environment at BUILD time, never --env on dist.
  const steps = planSteps(action, options, config, environment, {
    sourceFlags,
    distFlags,
  });
  return {
    action,
    environment,
    worker: config.name,
    database: config.d1_databases[0].database_name,
    databaseId: config.d1_databases[0].database_id ?? null,
    workflow: config.workflows[0].name,
    steps,
    transitions: transitions[action] ?? [],
    sourcePath,
    distPath,
    ...(["plan", "provision"].includes(action)
      ? {
          infrastructure: {
            owner: "terraform",
            configurationPath: resolve("infrastructure/cloudflare"),
            stateEnvironment: environment,
            stateDirectory: `~/.config/nfl-pickem/terraform/${environment}/`,
            resources: [
              {
                address: "cloudflare_d1_database.app",
                type: "cloudflare_d1_database",
                name: config.d1_databases[0].database_name,
              },
              {
                address: "cloudflare_worker.app",
                type: "cloudflare_worker",
                name: config.name,
              },
            ],
            wranglerOwns: ["versions", "deployments", "bindings", "workflows"],
          },
        }
      : {}),
    ...(["publish", "activate", "detach", "unpause"].includes(action)
      ? { domain: domainTarget(config, options, environment) }
      : {}),
  };
}

/**
 * @param {string[]} args
 * @param {Runtime} [runtime]
 * @returns {Promise<CommandResult>}
 */
async function nativeRun(args, { input, accountId } = {}) {
  return await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve("node_modules/wrangler/bin/wrangler.js"), ...args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          CLOUDFLARE_ACCOUNT_ID: accountId,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG: args.includes("--json") ? "log" : "error",
          WRANGLER_LOG_SANITIZE: "true",
          WRANGLER_WRITE_LOGS: "false",
        },
      },
    );
    let stdout = "";
    child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.resume(); // Never replay provider output: it can contain credentials or SQL/personal data.
    child.on("error", () => {
      reject(new Error("Unable to start native Wrangler"));
    });
    child.on("close", (code) => {
      done({ code, stdout });
    });
    child.stdin.end(input);
  });
}

/**
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function privateJson(path) {
  const info = await stat(path);
  requireThat(
    info.isFile() &&
      (info.mode & 0o077) === 0 &&
      info.uid === process.getuid?.(),
    "Input must be an owner-only regular file (chmod 600)",
  );
  try {
    /** @type {unknown} */
    const value = JSON.parse(await readFile(path, "utf8"));
    return value;
  } catch {
    throw new Error("Unable to parse private secret JSON; contents withheld");
  }
}

/**
 * @param {unknown} values
 * @returns {values is ApplicationSecrets}
 */
function hasApplicationSecrets(values) {
  if (!values || typeof values !== "object") {
    return false;
  }
  const entries = /** @type {Record<string, unknown>} */ (values);
  return (
    Object.keys(entries).length === secrets.length &&
    secrets.every((key) => {
      const value = entries[key];
      return typeof value === "string" && Boolean(value.trim());
    })
  );
}

/** @param {string} path */
export async function validateSecrets(path) {
  const values = await privateJson(path);
  requireThat(
    hasApplicationSecrets(values),
    "Secret JSON must contain exactly the four application secrets",
  );
  requireThat(
    Buffer.byteLength(values.SESSION_SECRET) >= 32 &&
      Buffer.byteLength(values.SUBMISSION_TOKEN_SECRET) >= 32 &&
      values.SESSION_SECRET !== values.SUBMISSION_TOKEN_SECRET,
    "Signing secrets must be distinct and at least 32 bytes",
  );
}

class PartialWorkflowError extends Error {
  /** @param {WorkflowReport} report */
  constructor(report) {
    super(
      "Workflow operation failed; inspect confirmed IDs before resuming. No automatic retries.",
    );
    this.report = report;
  }
}

class WakeupError extends Error {
  /** @param {WakeupReport} report */
  constructor(report) {
    super(
      "Dispatch is unpaused but registered delivery wakeups failed; retry the explicit approved unpause command.",
    );
    this.report = report;
  }
}

/**
 * @param {RawWorkflowEntry} item
 * @param {Set<string>} ids
 */
function validateWorkflowEntry(item, ids) {
  requireThat(
    typeof item.id === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(item.id) &&
      !ids.has(item.id) &&
      item.params &&
      typeof item.params === "object" &&
      "runId" in item.params &&
      item.params.runId === item.id,
    "Invalid/duplicate Workflow entry or run ID mismatch",
  );
  requireThat(
    "season" in item.params && validSeason(item.params.season),
    "Workflow entry requires an explicit season (1920–9999); replace yearless plans with season-qualified work",
  );
  ids.add(item.id);
}

/**
 * @param {unknown} input
 * @param {WorkflowPlan} plan
 */
function workflowEntries(input, plan) {
  const document = /** @type {RawWorkflowDocument} */ (input);
  requireThat(
    document.version === 1 &&
      document.environment === plan.environment &&
      Array.isArray(document.workflows),
    "Workflow plan version/environment mismatch",
  );
  /** @type {Set<string>} */
  const ids = new Set();
  for (const item of document.workflows) {
    validateWorkflowEntry(item, ids);
  }
  return /** @type {WorkflowEntry[]} */ (document.workflows);
}

/**
 * @param {WorkflowEntry} item
 * @param {WorkflowPlan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 */
async function triggerWorkflow(item, plan, run, runtime) {
  const flags = [
    "--config",
    plan.sourcePath,
    "--env",
    plan.environment,
    "--json",
  ];
  try {
    const result = await run(
      [
        "workflows",
        "trigger",
        plan.workflow,
        JSON.stringify(item.params),
        "--id",
        item.id,
        ...flags,
      ],
      runtime,
    );
    if (result.code === 0) {
      return "created";
    }
  } catch {
    // A thrown trigger can still have created its deterministic instance ID.
  }
  // Never retry creation or classify it as existing without a successful describe.
  try {
    const check = await run(
      ["workflows", "instances", "describe", plan.workflow, item.id, ...flags],
      runtime,
    );
    if (check.code === 0) {
      /** @type {unknown} */
      const value = JSON.parse(String(check.stdout));
      const existing = /** @type {{ id?: unknown } | null} */ (value);
      if (existing?.id === item.id) {
        return "existing";
      }
    }
  } catch {
    // Failed verification remains a failed creation.
  }
  return "failed";
}

/**
 * @param {unknown} input
 * @param {WorkflowPlan} plan
 * @param {Run} run
 * @param {Runtime} [runtime]
 */
export async function createWorkflows(input, plan, run, runtime = {}) {
  const entries = workflowEntries(input, plan);
  /** @type {WorkflowReport} */
  const report = { created: [], existing: [], failed: [], unattempted: [] };
  for (const [index, item] of entries.entries()) {
    const outcome = await triggerWorkflow(item, plan, run, runtime);
    report[outcome].push(item.id);
    if (outcome === "failed") {
      report.unattempted = entries.slice(index + 1).map((entry) => entry.id);
      throw new PartialWorkflowError(report);
    }
  }
  return report;
}

/**
 * @param {WorkflowPlan} plan
 * @param {Run} run
 * @param {Runtime} [runtime]
 */
export async function listInstances(plan, run, runtime) {
  /** @type {Instance[]} */
  const instances = [];
  const seen = new Set();
  for (let page = 1; ; page++) {
    const result = await run(
      [
        "workflows",
        "instances",
        "list",
        plan.workflow,
        "--page",
        String(page),
        "--per-page",
        "100",
        "--json",
        "--config",
        plan.sourcePath,
        "--env",
        plan.environment,
      ],
      runtime,
    );
    requireThat(
      result.code === 0,
      "Cannot enumerate native Workflow instances; keep all writers stopped",
    );
    /** @type {unknown} */
    const value = JSON.parse(String(result.stdout));
    const rows = /** @type {RawInstance[] | null} */ (value);
    requireThat(
      Array.isArray(rows),
      "Unexpected native Workflow list response",
    );
    for (const row of rows) {
      requireThat(
        typeof row.id === "string" &&
          !seen.has(row.id) &&
          typeof row.status === "string" &&
          [
            "queued",
            "running",
            "paused",
            "errored",
            "terminated",
            "complete",
            "waitingForPause",
            "waiting",
            "rollingBack",
          ].includes(row.status),
        "Invalid or unstable native Workflow inventory",
      );
      seen.add(row.id);
      instances.push(/** @type {Instance} */ (row));
    }
    if (rows.length < 100) {
      return instances;
    }
  }
}

/**
 * @param {RawD1Result | null} entry
 * @returns {entry is D1Result}
 */
function hasD1Results(entry) {
  return entry?.success === true && Array.isArray(entry.results);
}

/**
 * @param {D1Plan} plan
 * @param {string} sql
 * @param {Run} run
 * @param {Runtime} runtime
 * @param {boolean} [json]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function d1Command(plan, sql, run, runtime, json = false) {
  const result = await run(
    [
      "d1",
      "execute",
      "DB",
      "--remote",
      "--command",
      sql,
      "--yes",
      ...(json ? ["--json"] : []),
      "--config",
      plan.sourcePath,
      "--env",
      plan.environment,
    ],
    runtime,
  );
  requireThat(
    result.code === 0,
    "D1 fence/history operation failed; do not export or release native delivery",
  );
  if (!json) {
    return [];
  }
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(String(result.stdout));
  } catch {
    throw new Error("Cannot verify D1 fence response");
  }
  const response = /** @type {(RawD1Result | null)[] | null} */ (value);
  requireThat(
    Array.isArray(response) && response.every(hasD1Results),
    "Invalid D1 fence response",
  );
  return response.flatMap((entry) => entry.results);
}

/**
 * @param {D1Plan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 * @param {boolean} [requireStopped]
 */
async function verifyFence(plan, run, runtime, requireStopped = true) {
  const rows = await d1Command(
    plan,
    "SELECT paused, (SELECT COUNT(*) FROM job_runs WHERE status NOT IN ('queued','sleeping','paused','complete','errored','cancelled','superseded','creation_failed')) AS active FROM job_settings WHERE id=1",
    run,
    runtime,
    true,
  );
  requireThat(
    rows.length === 1 &&
      rows[0]?.paused === 1 &&
      (!requireStopped || rows[0].active === 0),
    "D1 delivery fence is not paused or job history is still active; do not export",
  );
}

/**
 * @param {Instance[]} instances
 * @param {D1Plan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 */
async function verifyNativeHistory(instances, plan, run, runtime) {
  const pausedIds = instances
    .filter((instance) => instance.status === "paused")
    .map((instance) => instance.id);
  for (let offset = 0; offset < pausedIds.length; offset += 50) {
    const ids = pausedIds.slice(offset, offset + 50);
    const known = await d1Command(
      plan,
      `SELECT id FROM job_runs WHERE id IN (${ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(",")})`,
      run,
      runtime,
      true,
    );
    const knownIds = new Set(known.map((row) => row.id));
    requireThat(
      ids.every((id) => knownIds.has(id)),
      "Paused native instance has no D1 history; reconcile its parameters before exporting",
    );
  }
}

/**
 * @param {Instance[]} instances
 * @param {D1Plan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 */
export async function synchronizePausedInstances(
  instances,
  plan,
  run,
  runtime,
) {
  await verifyNativeHistory(instances, plan, run, runtime);
  /** @type {Record<string, string | undefined>} */
  const mapping = {
    paused: "paused",
    complete: "complete",
    errored: "errored",
    terminated: "cancelled",
  };
  const now = new Date().toISOString();
  for (let offset = 0; offset < instances.length; offset += 50) {
    const sql = instances
      .slice(offset, offset + 50)
      .map((instance) => {
        const status = mapping[instance.status];
        requireThat(status, "Cannot synchronize active native instance");
        const id = instance.id.replaceAll("'", "''");
        return `UPDATE job_runs SET status='${status}',updated_at='${now}' WHERE id='${id}' AND status NOT IN ('complete','errored','cancelled','superseded','creation_failed');`;
      })
      .join("\n");
    await d1Command(plan, sql, run, runtime);
  }
}

/**
 * @param {Plan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 */
async function verifyWorkflowOwner(plan, run, runtime) {
  let exists = false;
  for (let page = 1; ; page++) {
    const result = await run(
      [
        "workflows",
        "list",
        "--page",
        String(page),
        "--per-page",
        "100",
        "--json",
        "--config",
        plan.sourcePath,
        "--env",
        plan.environment,
      ],
      runtime,
    );
    requireThat(result.code === 0, "Cannot verify deployed Workflow ownership");
    /** @type {unknown} */
    const value = JSON.parse(String(result.stdout));
    const workflows = /** @type {(RawWorkflow | null)[] | null} */ (value);
    requireThat(Array.isArray(workflows), "Invalid Workflow inventory");
    for (const workflow of workflows) {
      requireThat(
        typeof workflow?.name === "string",
        "Invalid Workflow inventory",
      );
      if (workflow.name !== plan.workflow) {
        continue;
      }
      requireThat(
        !exists && workflow.script_name === plan.worker,
        "Workflow belongs to another Worker or its ownership is ambiguous",
      );
      exists = true;
    }
    if (workflows.length < 100) {
      return exists;
    }
  }
}

/** @param {Plan} plan @param {Instance[]} instances */
function assertMigrationReady(plan, instances) {
  requireThat(
    plan.action !== "migrate" ||
      instances.every((instance) =>
        ["complete", "errored", "terminated"].includes(instance.status),
      ),
    "Terminate all unfinished native Workflows before schema migration; paused instances retain their old code. Recover with new season-pinned retry children afterward.",
  );
}

/**
 * @param {Plan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 */
async function freezeExistingWork(plan, run, runtime) {
  const exists = await verifyWorkflowOwner(plan, run, runtime);
  const tables = await d1Command(
    plan,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('job_settings','job_runs')",
    run,
    runtime,
    true,
  );
  requireThat(
    tables.length === 0 || tables.length === 2,
    "Incomplete job schema; reconcile before migration",
  );
  if (tables.length) {
    await d1Command(
      plan,
      "UPDATE job_settings SET paused=1 WHERE id=1",
      run,
      runtime,
    );
    await verifyFence(plan, run, runtime, false);
  }
  if (exists) {
    for (const instance of await listInstances(plan, run, runtime)) {
      if (
        ["paused", "complete", "errored", "terminated"].includes(
          instance.status,
        )
      ) {
        continue;
      }
      requireThat(
        (
          await run(
            [
              "workflows",
              "instances",
              "pause",
              plan.workflow,
              instance.id,
              "--config",
              plan.sourcePath,
              "--env",
              plan.environment,
            ],
            runtime,
          )
        ).code === 0,
        "Cannot pause old Workflow before migration",
      );
    }
    const instances = await listInstances(plan, run, runtime);
    requireThat(
      instances.every((instance) =>
        ["paused", "complete", "errored", "terminated"].includes(
          instance.status,
        ),
      ),
      "Native Workflow is still active; retry only after pause completes",
    );
    requireThat(
      tables.length ||
        instances.every((instance) => instance.status !== "paused"),
      "Native pending work lacks D1 history; reconcile before migration",
    );
    if (tables.length) {
      await synchronizePausedInstances(instances, plan, run, runtime);
    }
    assertMigrationReady(plan, instances);
  }
  if (tables.length) {
    await verifyFence(plan, run, runtime);
  }
}

/**
 * @param {WorkflowPlan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 */
async function releaseDispatch(plan, run, runtime) {
  await d1Command(
    plan,
    "UPDATE job_settings SET paused=0 WHERE id=1",
    run,
    runtime,
  );
  const settings = await d1Command(
    plan,
    "SELECT paused FROM job_settings WHERE id=1",
    run,
    runtime,
    true,
  );
  requireThat(
    settings.length === 1 && settings[0]?.paused === 0,
    "D1 unpause could not be verified; retry explicit approved unpause",
  );
  // Match the application's registered-wait handshake. Never resume native paused
  // instances or clear per-run pause state: maintenance-paused jobs remain paused.
  const waiting = await d1Command(
    plan,
    "SELECT id FROM job_runs WHERE gate_paused=1 AND status NOT IN ('paused','complete','errored','cancelled','superseded','creation_failed') ORDER BY id",
    run,
    runtime,
    true,
  );
  /** @type {WakeupReport} */
  const report = { notified: [], failed: [] };
  for (const row of waiting) {
    requireThat(
      typeof row.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(row.id),
      "Invalid registered waiting run ID; retry unpause after reconciliation",
    );
    let result;
    try {
      result = await run(
        [
          "workflows",
          "instances",
          "send-event",
          plan.workflow,
          row.id,
          "--type",
          "delivery-resume",
          "--payload",
          "{}",
          "--json",
          "--config",
          plan.sourcePath,
          "--env",
          plan.environment,
        ],
        runtime,
      );
    } catch {
      result = { code: 1 };
    }
    (result.code === 0 ? report.notified : report.failed).push(row.id);
  }
  if (report.failed.length) {
    throw new WakeupError(report);
  }
  return report;
}

/**
 * @typedef {object} Services
 * @property {Run} run
 * @property {Api} api
 * @property {AccountRuntime} runtime
 * @property {NonNullable<Adapters["load"]>} load
 */

/**
 * @param {Options} options
 * @param {SourceConfiguration} source
 * @param {Configuration | undefined} dist
 * @param {Configuration} desired
 */
function approveOperation(options, source, dist, desired) {
  requireThat(
    options["approve-cloud"] === true,
    "Remote operation requires --approve-cloud",
  );
  requireThat(
    /^[0-9a-f]{32}$/i.test(options["account-id"] ?? ""),
    "Explicit actual --account-id required",
  );
  requireThat(
    !source.account_id || source.account_id === options["account-id"],
    "Source account ID mismatch",
  );
  requireThat(
    !desired.account_id || desired.account_id === options["account-id"],
    "Source environment account ID mismatch",
  );
  requireThat(
    !dist?.account_id || dist.account_id === options["account-id"],
    "Dist account ID mismatch",
  );
}

/**
 * @param {Options} options
 * @param {ProvisionSource} source
 * @param {Configuration} desired
 * @param {Plan} plan
 * @param {NonNullable<Adapters["provisionInfrastructure"]>} provision
 */
async function provisionTarget(options, source, desired, plan, provision) {
  requireThat(options["account-id"], "Explicit actual --account-id required");
  requireThat(
    options["approve-cloud"],
    "Remote operation requires --approve-cloud",
  );
  const result = await provision({
    environment: plan.environment,
    accountId: options["account-id"],
    approveCloud: options["approve-cloud"],
    databaseId: plan.databaseId ?? undefined,
  });
  requireThat(
    uuid.test(result.databaseId),
    "Infrastructure output must contain a verified D1 UUID",
  );
  requireThat(
    !plan.databaseId || plan.databaseId === result.databaseId,
    "Infrastructure D1 ID conflicts with configured source database",
  );
  for (const [environment, config] of Object.entries(source.env)) {
    if (environment !== plan.environment) {
      requireThat(
        !config.d1_databases?.some(
          (db) => db.database_id === result.databaseId,
        ),
        "D1 ID shared across environments",
      );
    }
  }
  const databaseIdChanged = plan.databaseId !== result.databaseId;
  if (databaseIdChanged) {
    desired.d1_databases[0].database_id = result.databaseId;
    await writeFile(plan.sourcePath, JSON.stringify(source, null, 2) + "\n");
  }
  return {
    action: "provision",
    environment: plan.environment,
    databaseId: result.databaseId,
    workerId: result.workerId,
    changed: result.changed,
    statePath: result.statePath,
    next: databaseIdChanged
      ? `Build ${plan.environment} again; previous dist is stale.`
      : "D1 ID unchanged; no rebuild required for provisioning.",
  };
}

/**
 * @param {Options} options
 * @param {SourceConfiguration} source
 * @param {Configuration} dist
 * @param {Plan} plan
 * @param {Services} services
 */
async function maintainTarget(options, source, dist, plan, services) {
  const { run, runtime } = services;
  const desired = source.env[plan.environment];
  requireThat(desired, "Source environment identity mismatch");
  requireThat(
    options["inflight-reviewed"],
    "Maintenance requires --inflight-reviewed; account for in-flight sends before exporting or recovering native delivery",
  );
  // This persistent fence is authoritative for already-running Workflow versions.
  await d1Command(
    plan,
    "UPDATE job_settings SET paused=1 WHERE id=1",
    run,
    runtime,
  );
  await verifyFence(plan, run, runtime, false);
  await verifyWorkflowOwner(plan, run, runtime);
  // Freeze writes while retaining routes until the latest snapshot is captured.
  // Never use versions rollback: it can restore an old version with sends enabled.
  const quiet = structuredClone(dist);
  quiet.vars.MAINTENANCE_MODE = "true";
  quiet.vars.DISCORD_SEND_ENABLED = "false";
  quiet.vars.SCHEDULES_ENABLED = "false";
  // Wrangler requires Workflow schedules to be absent, not explicitly empty.
  quiet.triggers = { crons: [] };
  quiet.workflows.forEach((w) => {
    delete w.schedules;
  });
  desired.vars = structuredClone(quiet.vars);
  desired.triggers = { crons: [] };
  desired.workflows.forEach((w) => {
    delete w.schedules;
  });
  await writeFile(plan.sourcePath, JSON.stringify(source, null, 2) + "\n");
  await writeFile(plan.distPath, JSON.stringify(quiet) + "\n");
  requireThat(
    (
      await run(
        [
          "deploy",
          "--config",
          plan.distPath,
          "--experimental-auto-create=false",
        ],
        runtime,
      )
    ).code === 0,
    "Maintenance deploy failed; keep delivery fenced and do not export until maintenance is deployed",
  );
  const terminal = new Set(["errored", "terminated", "complete"]);
  const paused = [];
  for (const instance of await listInstances(plan, run, runtime)) {
    if (terminal.has(instance.status) || instance.status === "paused") {
      continue;
    }
    requireThat(
      (
        await run(
          [
            "workflows",
            "instances",
            "pause",
            plan.workflow,
            instance.id,
            "--config",
            plan.sourcePath,
            "--env",
            plan.environment,
          ],
          runtime,
        )
      ).code === 0,
      `Maintenance pause failed for ${instance.id}; keep delivery fenced and do not export`,
    );
    paused.push(instance.id);
  }
  const inventory = await listInstances(plan, run, runtime);
  requireThat(
    inventory.every(
      (instance) =>
        terminal.has(instance.status) || instance.status === "paused",
    ),
    "Native Workflows still active or waiting for pause; do not export or release delivery. Re-run maintenance after drain",
  );
  await synchronizePausedInstances(inventory, plan, run, runtime);
  await verifyFence(plan, run, runtime);
  return {
    action: "maintenance",
    environment: plan.environment,
    paused,
    next: "Maintenance source/dist persisted; routes retained. After all in-flight HTTP work drains, export with --writers-stopped and verify the business/operations snapshot. Keep delivery fenced during recovery; deliberately configure and rebuild the native target before approved activation. Individually paused Workflows require separate reconciliation. No DNS changes performed.",
  };
}

/**
 * @param {SourceConfiguration} source
 * @param {Configuration} dist
 * @param {Plan} plan
 * @param {Services} services
 */
async function detachTarget(source, dist, plan, services) {
  const { run, runtime, api } = services;
  const desired = source.env[plan.environment];
  requireThat(desired, "Source environment identity mismatch");
  const domains = await domainInventory(plan, api, runtime);
  await verifyWorkflowOwner(plan, run, runtime);
  for (const domain of domains) {
    await api(
      "DELETE",
      `/accounts/${runtime.accountId}/workers/domains/${domain.id}`,
      runtime,
    );
  }
  requireThat(
    (await domainInventory(plan, api, runtime)).length === 0,
    "Custom domain remains attached; keep maintenance enabled and reconcile domain ownership before recovery",
  );
  desired.routes = [];
  delete desired.route;
  dist.routes = [];
  delete dist.route;
  await writeFile(plan.sourcePath, JSON.stringify(source, null, 2) + "\n");
  await writeFile(plan.distPath, JSON.stringify(dist) + "\n");
  await runSteps(plan, run, runtime);
  return completed(plan);
}

/**
 * @param {Options} options
 * @param {Configuration} dist
 * @param {Plan} plan
 * @param {Services} services
 */
async function exportTarget(options, dist, plan, services) {
  const { run, runtime } = services;
  requireThat(
    options["writers-stopped"],
    "Consistent export requires --writers-stopped after maintenance, HTTP drain and admin freeze",
  );
  requireThat(
    dist.vars.MAINTENANCE_MODE === "true" &&
      dist.vars.SCHEDULES_ENABLED === "false" &&
      dist.vars.DISCORD_SEND_ENABLED === "false",
    "Export requires a deployed maintenance config",
  );
  requireThat(
    !dist.triggers?.crons?.length &&
      !dist.workflows.some((workflow) => workflow.schedules?.length),
    "Export requires native schedules removed",
  );
  await verifyWorkflowOwner(plan, run, runtime);
  const instances = await listInstances(plan, run, runtime);
  requireThat(
    instances.every((instance) =>
      ["paused", "errored", "terminated", "complete"].includes(instance.status),
    ),
    "Export refused while native jobs can write",
  );
  await verifyNativeHistory(instances, plan, run, runtime);
  await verifyFence(plan, run, runtime);
  // Reserve output privately so a failure never overwrites an earlier backup.
  requireThat(options.output, "Export requires new --output SQL path");
  await writeFile(options.output, "", { mode: 0o600, flag: "wx" });
  await runSteps(plan, run, runtime);
  return completed(plan);
}

/**
 * @param {Options} options
 * @param {SourceConfiguration} source
 * @param {Configuration} dist
 * @param {Plan} plan
 * @param {Services} services
 */
async function triggerTarget(options, source, dist, plan, services) {
  const { run, runtime, load } = services;
  assertActive(verifyDist(source, dist, plan.environment), plan.environment);
  requireThat(
    options.file && options["source-quiesced"] && options["verified-data"],
    "Workflow creation requires --file, --source-quiesced and --verified-data",
  );
  requireThat(
    await verifyWorkflowOwner(plan, run, runtime),
    "Deploy the owned Workflow before creating instances",
  );
  return await createWorkflows(await load(options.file), plan, run, runtime);
}

/**
 * @param {Plan} plan
 * @param {Run} run
 * @param {Runtime} runtime
 */
async function runSteps(plan, run, runtime) {
  for (const args of plan.steps) {
    requireThat(
      (await run(args, runtime)).code === 0,
      `${plan.action} failed; no later steps executed. For a partial import, recreate the target instead of retrying.`,
    );
  }
}

/** @param {Plan} plan */
function completed(plan) {
  return {
    action: plan.action,
    environment: plan.environment,
    completed: true,
  };
}

/**
 * @param {Options} options
 * @param {Plan} plan
 * @param {Services} services
 */
async function publishTarget(options, plan, { api, run, runtime }) {
  await verifyDeploymentDomain(plan, options, api, runtime);
  await freezeExistingWork(plan, run, runtime);
  await verifyFence(plan, run, runtime);
  await runSteps(plan, run, runtime);
  requireThat(
    (await domainInventory(plan, api, runtime)).length === 1,
    "Published custom domain could not be verified; delivery remains fenced",
  );
  await freezeExistingWork(plan, run, runtime);
  await verifyFence(plan, run, runtime);
  return completed(plan);
}

/**
 * @param {Options} options
 * @param {Plan} plan
 * @param {Services} services
 */
async function activateTarget(options, plan, { api, run, runtime }) {
  if (plan.action === "activate") {
    await d1Command(
      plan,
      "UPDATE job_settings SET paused=1 WHERE id=1",
      run,
      runtime,
    );
    await verifyFence(plan, run, runtime, false);
    await verifyDeploymentDomain(plan, options, api, runtime);
    await verifyWorkflowOwner(plan, run, runtime);
  }
  await runSteps(plan, run, runtime);
  requireThat(
    options["dns-quiesced"],
    "Delivery activation requires --dns-quiesced while checking ownership",
  );
  requireThat(
    (await domainInventory(plan, api, runtime)).length === 1,
    "Activated custom domain could not be verified; delivery remains fenced",
  );
  await verifyWorkflowOwner(plan, run, runtime);
  return {
    ...completed(plan),
    wakeups: await releaseDispatch(plan, run, runtime),
  };
}

/**
 * @param {Plan} plan
 * @param {Services} services
 */
async function mutateQuietTarget(plan, { run, runtime }) {
  await freezeExistingWork(plan, run, runtime);
  await runSteps(plan, run, runtime);
  if (["prepare", "migrate"].includes(plan.action)) {
    await freezeExistingWork(plan, run, runtime);
  }
  return completed(plan);
}

/**
 * @param {string} action
 * @param {Options} options
 * @param {Adapters} adapters
 */
async function approveDeliveryMutation(action, options, adapters) {
  if (["activate", "unpause", "workflows"].includes(action)) {
    requireThat(
      options["approve-discord"] === true,
      "Enabling sends/triggering jobs requires --approve-discord",
    );
  }
  if (["prepare", "publish", "activate"].includes(action)) {
    requireThat(
      options["secrets-file"],
      "Private --secrets-file JSON required",
    );
    await (adapters.validateSecrets ?? validateSecrets)(
      options["secrets-file"],
    );
  }
  if (["prepare", "publish", "migrate", "import"].includes(action)) {
    requireThat(
      options["writers-stopped"],
      "Mutation requires --writers-stopped after freezing HTTP/admin writes and draining in-flight work",
    );
  }
}

/**
 * @param {Options} options
 * @param {SourceConfiguration} source
 * @param {Configuration} dist
 * @param {Plan} plan
 * @param {Services} services
 */
async function executeDeployment(options, source, dist, plan, services) {
  switch (plan.action) {
    case "workflows":
      return await triggerTarget(options, source, dist, plan, services);
    case "maintenance":
      return await maintainTarget(options, source, dist, plan, services);
    case "detach":
      return await detachTarget(source, dist, plan, services);
    case "export":
      return await exportTarget(options, dist, plan, services);
    case "publish":
      return await publishTarget(options, plan, services);
    case "activate":
    case "unpause":
      return await activateTarget(options, plan, services);
    default:
      return await mutateQuietTarget(plan, services);
  }
}

/**
 * @param {string} action
 * @param {Options} options
 * @param {NonNullable<Adapters["load"]>} load
 */
async function loadTarget(action, options, load) {
  const source = /** @type {SourceConfiguration} */ (
    await load(options.source ?? "wrangler.jsonc")
  );
  const plannedAction =
    action === "plan" ? (options.operation ?? "plan") : action;
  const dist = ["plan", "provision"].includes(plannedAction)
    ? undefined
    : /** @type {Configuration} */ (
        await load(options.dist ?? "dist/server/wrangler.json")
      );
  const plan = makePlan(plannedAction, options, source, dist);
  return { source, dist, plan };
}

/**
 * @param {string} action
 * @param {Options} options
 * @param {Adapters} [adapters]
 */
export async function execute(action, options, adapters = {}) {
  const load =
    adapters.load ??
    (async (/** @type {string} */ path) =>
      parseJsonc(await readFile(path, "utf8")));
  const { source, dist, plan } = await loadTarget(action, options, load);
  if (action === "plan") {
    return {
      ...plan,
      dryRun: true,
      phases: commands.filter((command) => command !== "plan"),
    };
  }
  const desired = source.env[plan.environment];
  requireThat(desired, "Source environment identity mismatch");
  approveOperation(options, source, dist, desired);
  if (action === "provision") {
    return await provisionTarget(
      options,
      source,
      desired,
      plan,
      adapters.provisionInfrastructure ?? provisionInfrastructure,
    );
  }
  await approveDeliveryMutation(action, options, adapters);
  requireThat(options["account-id"], "Explicit actual --account-id required");
  requireThat(dist, "Stale dist environment; rebuild target");
  return await executeDeployment(options, source, dist, plan, {
    load,
    run: adapters.run ?? nativeRun,
    api: adapters.api ?? cloudflareApi,
    runtime: { accountId: options["account-id"] },
  });
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const action = argv[0] ?? "plan";
  requireThat(commands.includes(action), "Unknown operation");
  /** @type {Record<string, string | boolean | undefined>} */
  const options = {};
  const booleans = new Set([
    "approve-cloud",
    "approve-discord",
    "source-quiesced",
    "verified-data",
    "inflight-reviewed",
    "writers-stopped",
    "snapshot-verified",
    "dns-quiesced",
  ]);
  const strings = new Set([
    "env",
    "source",
    "dist",
    "account-id",
    "secrets-file",
    "file",
    "output",
    "operation",
    "zone-id",
  ]);
  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i];
    requireThat(argument, "Invalid/duplicate option");
    const key = argument.replace(/^--/, "");
    requireThat(
      argument.startsWith("--") && !(key in options),
      "Invalid/duplicate option",
    );
    if (booleans.has(key)) {
      options[key] = true;
    } else {
      requireThat(
        strings.has(key) && argv[i + 1] && !argv[i + 1]?.startsWith("--"),
        "Unknown option or missing value",
      );
      options[key] = argv[++i];
    }
  }
  return { action, options: /** @type {Options} */ (options) };
}

/** @param {unknown} error */
function operationErrorMessage(error) {
  if (error instanceof PartialWorkflowError || error instanceof WakeupError) {
    return JSON.stringify({ error: error.message, ...error.report });
  }
  if (error instanceof Error) {
    return error.message;
  }
  return undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes("--help")) {
    console.log(`node scripts/cloudflare.mjs <${commands.join("|")}> --env staging|production
Remote operations require --approve-cloud --account-id ACTUAL_ID.
plan: optional --operation ACTION previews that command using its required options; never reads secrets or calls cloud.
provision: requires Terraform >=1.5,<2 and CLOUDFLARE_API_TOKEN. Applies only reviewed creates/no-ops for D1 and Worker identity; private per-environment state lives in ~/.config/nfl-pickem/terraform. Wrangler prepare owns the Workflow.
prepare/publish/activate: --secrets-file OWNER_ONLY_JSON (DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, SESSION_SECRET, SUBMISSION_TOKEN_SECRET).
prepare/publish/migrate/import: --writers-stopped after freezing HTTP/admin writes and draining in-flight work; fences and pauses existing native work before mutation.
import: --file SQL --source-quiesced. export: --output NEW_SQL --writers-stopped; rejects paused native work without D1 history.
publish: staging-only --dns-quiesced; source-matched public custom domain with maintenance disabled, sends and ALL schedules disabled. Verifies ownership before mutation and after deployment, keeps D1 paused=1 and native jobs stopped; no data migration, Discord approval or delivery wakeups.
activate: --verified-data --source-quiesced --approve-discord --dns-quiesced (source deliberately activated and rebuilt first); validates domain ownership before deploy and after success, then releases/wakes delivery.
publish/activate/detach/unpause: scoped CLOUDFLARE_API_TOKEN required for the approved account and existing bholzer.me zone. Only pickem-staging.bholzer.me (staging) and pickem.bholzer.me (production) are allowed; unattached hostnames must have no existing DNS records.
unpause: --verified-data --source-quiesced --approve-discord --dns-quiesced; verifies domain ownership before retrying failed registered delivery wakeups, never resumes individually paused instances.
workflows: --file OPERATIONS_PLAN --verified-data --source-quiesced --approve-discord.
maintenance: --inflight-reviewed. D1 paused=1 FIRST; persists maintenance mode, disables schedules/sends, pauses ALL nonterminal Workflows, synchronizes D1 history, retains routes for latest snapshot. Export after HTTP/admin drain; verify the snapshot before native recovery. Does not switch DNS or release delivery.
detach: --snapshot-verified after latest quiesced snapshot and restore verification; explicitly deletes/readbacks the scoped domain association before deploying empty routes. Use --zone-id ACTUAL_ID when retrying with routes already empty. Keep delivery fenced during native recovery.
--source-quiesced acknowledges the source system is frozen and cannot accept writes or dispatch work during the operation.
No command manages the zone or unrelated DNS records. Verify business and operations round trips before activation.`);
  } else {
    try {
      const { action, options } = parseArgs(process.argv.slice(2));
      console.log(JSON.stringify(await execute(action, options), null, 2));
    } catch (error) {
      console.error(operationErrorMessage(error));
      process.exitCode = 1;
    }
  }
}
