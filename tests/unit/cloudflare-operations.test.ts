import { describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import type {
  Configuration,
  SourceConfiguration,
  DatabaseBinding,
  WorkflowBinding,
  Environment,
} from "../../scripts/cloudflare-types.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createWorkflows,
  execute,
  makePlan,
  parseArgs,
  verifyDist,
  validateSecrets,
  listInstances,
  synchronizePausedInstances,
} from "../../scripts/cloudflare.mjs";

function executeSql(db: DatabaseSync, args: string[]) {
  const commandIndex = args.indexOf("--command");
  assert(commandIndex !== -1, "Only explicit D1 SQL commands are expected");
  const sql = args[commandIndex + 1];
  assert(sql, "D1 command requires SQL");
  if (sql.startsWith("SELECT")) {
    return {
      code: 0,
      stdout: JSON.stringify([
        { success: true, results: db.prepare(sql).all() },
      ]),
    };
  }
  db.exec(sql);
  return { code: 0, stdout: "" };
}

async function persistedSource(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as SourceConfiguration;
}

async function persistedDist(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Configuration;
}

const account = "a".repeat(32);
const databaseId = "11111111-1111-4111-8111-111111111111";
function configuration<E extends Environment = "staging">(
  active = false,
  environment: E = "staging" as E,
) {
  const hostname =
    environment === "staging"
      ? "pickem-staging.bholzer.me"
      : "pickem.bholzer.me";
  const config = {
    name: `nfl-pickem-${environment}`,
    workers_dev: false,
    preview_urls: false,
    vars: {
      APP_ENV: environment,
      APP_ORIGIN: `https://${hostname}`,
      MAINTENANCE_MODE: "false",
      DISCORD_SEND_ENABLED: active ? "true" : "false",
      SCHEDULES_ENABLED: active ? "true" : "false",
      DISCORD_CLIENT_ID: "12345678901234567",
      DISCORD_CHANNEL_ID: "12345678901234568",
      DISCORD_ALLOWED_CHANNEL_IDS: "12345678901234568",
      DISCORD_ALLOWED_USER_IDS: "12345678901234569",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: `nfl-pickem-${environment}`,
        database_id: databaseId,
      },
    ],
    workflows: [
      {
        binding: "JOBS",
        name: `nfl-pickem-${environment}-jobs`,
        class_name: "PickemWorkflow",
        ...(active ? { schedules: ["0 13 * * TUE"] } : {}),
      },
    ],
    routes: active
      ? [{ pattern: hostname, custom_domain: true, zone_id: account }]
      : [],
  } satisfies {
    d1_databases: [DatabaseBinding];
    workflows: [WorkflowBinding];
    [key: string]: unknown;
  };
  return {
    source: {
      env: { [environment]: structuredClone(config) } as Record<
        E,
        typeof config
      >,
    },
    dist: {
      ...structuredClone(config),
      targetEnvironment: environment,
      main: "index.js",
      assets: { directory: "../client" },
    },
  };
}
const approved = {
  env: "staging",
  "approve-cloud": true,
  "account-id": account,
  "dns-quiesced": true,
  "writers-stopped": true,
};
const prepareOptions = {
  env: "staging",
  "secrets-file": "/private/secrets.json",
};
const ownedDomain = {
  id: "b".repeat(40),
  hostname: "pickem-staging.bholzer.me",
  zone_id: account,
  service: "nfl-pickem-staging",
  environment: "production",
};
const domainApi = (_method: string, path: string) =>
  Promise.resolve(
    path.startsWith("/zones/")
      ? {
          result: { id: account, account: { id: account }, name: "bholzer.me" },
        }
      : { result: [ownedDomain] },
  );
function adapters(
  source: unknown,
  dist: unknown,
  run: (
    args: string[],
    runtime?: unknown,
  ) => Promise<{ code: number; stdout: string }> = vi.fn(() =>
    Promise.resolve({
      code: 0,
      stdout: "",
    }),
  ),
) {
  return {
    load: vi.fn((path: string) =>
      Promise.resolve(path.includes("dist/") ? dist : source),
    ),
    run,
    validateSecrets: vi.fn(() => {
      return Promise.resolve();
    }),
    api: domainApi,
  };
}

function publicationConfiguration<E extends Environment = "staging">(
  environment: E = "staging" as E,
) {
  const { source, dist } = configuration(false, environment);
  const routes = [
    {
      pattern: new URL(dist.vars.APP_ORIGIN).hostname,
      custom_domain: true,
      zone_id: account,
    },
  ];
  source.env[environment].routes = structuredClone(routes);
  dist.routes = structuredClone(routes);
  return { source, dist };
}

describe("guarded native deployment", () => {
  it("rejects retired command and acknowledgment names without cloud access", async () => {
    expect(() => parseArgs(["rollback", "--env", "staging"])).toThrow();
    expect(() => parseArgs(["import", "--rails-quiesced"])).toThrow();
    const { source, dist } = configuration(true);
    const io = adapters(source, dist);
    await expect(
      execute("plan", { env: "staging", operation: "rollback" }, io),
    ).rejects.toThrow();
    expect(io.run).not.toHaveBeenCalled();
  });

  it.each(["import", "activate", "unpause", "workflows"])(
    "requires source quiescence before %s can reach cloud",
    async (action) => {
      const { source, dist } = configuration(action !== "import");
      const { options } = parseArgs([
        action,
        "--env",
        "staging",
        "--approve-cloud",
        "--account-id",
        account,
        "--approve-discord",
        "--verified-data",
        "--writers-stopped",
        "--dns-quiesced",
        "--file",
        "/private/operations.json",
        "--secrets-file",
        "/private/secrets.json",
      ]);
      const io = adapters(source, dist);
      await expect(execute(action, options, io)).rejects.toThrow();
      expect(io.run).not.toHaveBeenCalled();
    },
  );

  it.each(["approve-cloud", "account-id", "inflight-reviewed"])(
    "requires %s before maintenance can reach cloud",
    async (missing) => {
      const { source, dist } = configuration(true);
      const { action, options } = parseArgs([
        "maintenance",
        "--env",
        "staging",
        "--approve-cloud",
        "--account-id",
        account,
        "--inflight-reviewed",
      ]);
      Reflect.deleteProperty(options, missing);
      const io = adapters(source, dist);
      await expect(execute(action, options, io)).rejects.toThrow();
      expect(io.run).not.toHaveBeenCalled();
    },
  );

  it("plans exact native prepare without credentials, subprocesses or reading secret contents", async () => {
    const { source, dist } = configuration();
    const io = adapters(source, dist);
    const plan = await execute(
      "plan",
      { ...prepareOptions, operation: "prepare" },
      io,
    );
    expect(plan).toMatchObject({
      action: "prepare",
      environment: "staging",
      worker: "nfl-pickem-staging",
      databaseId,
      dryRun: true,
    });
    expect(io.run).not.toHaveBeenCalled();
    expect(io.validateSecrets).not.toHaveBeenCalled();
  });

  it("rejects implicit/local targets and stale built resource identities", () => {
    const { source, dist } = configuration();
    expect(() => makePlan("plan", { env: "local" }, source)).toThrow(
      "Explicit --env",
    );
    expect(() =>
      verifyDist(
        source,
        { ...dist, targetEnvironment: "production" },
        "staging",
      ),
    ).toThrow("Stale dist");
    dist.d1_databases[0].database_id = "22222222-2222-4222-8222-222222222222";
    expect(() => verifyDist(source, dist, "staging")).toThrow(
      "D1 database_id mismatch",
    );
  });

  it("rejects a stale asset routing policy that would bypass the HTTPS middleware", () => {
    const { source, dist } = publicationConfiguration();
    const assets = {
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    };
    const desired = { ...source, assets };
    const stale = {
      ...dist,
      assets: {
        ...assets,
        directory: "../client",
        run_worker_first: ["/api/*"],
      },
    };
    expect(() => makePlan("publish", prepareOptions, desired, stale)).toThrow();
  });

  it("refuses prepare when native schedules remain even if application sends are disabled", () => {
    const { source, dist } = configuration();
    source.env.staging.workflows[0].schedules = ["0 * * * *"];
    dist.workflows[0].schedules = ["0 * * * *"];
    expect(() => makePlan("prepare", prepareOptions, source, dist)).toThrow(
      "no native schedules",
    );
  });

  it("does not invoke cloud without explicit approval or enable Discord without separate approval", async () => {
    const { source, dist } = configuration();
    const io = adapters(source, dist);
    await expect(execute("prepare", prepareOptions, io)).rejects.toThrow(
      "--approve-cloud",
    );
    expect(io.run).not.toHaveBeenCalled();
    const active = configuration(true);
    const activeIo = adapters(active.source, active.dist);
    await expect(
      execute(
        "activate",
        {
          ...approved,
          ...prepareOptions,
          "verified-data": true,
          "source-quiesced": true,
        },
        activeIo,
      ),
    ).rejects.toThrow("--approve-discord");
    expect(activeIo.run).not.toHaveBeenCalled();
  });

  it("does not swallow cloud import errors or advance beyond them", async () => {
    const { source, dist } = configuration();
    let attemptedImport = false;
    const run = vi.fn((args: string[]) => {
      if (args.includes("--file")) {
        attemptedImport = true;
        return Promise.resolve({
          code: 1,
          stdout: "private provider diagnostic",
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(
          args[0] === "d1" ? [{ success: true, results: [] }] : [],
        ),
      });
    });
    await expect(
      execute(
        "import",
        { ...approved, file: "/private/business.sql", "source-quiesced": true },
        adapters(source, dist, run),
      ),
    ).rejects.toThrow("recreate the target");
    expect(attemptedImport).toBe(true);
  });

  it("plans Terraform ownership offline without provisioning, native commands or secret reads", async () => {
    const { source, dist } = configuration();
    const provisionInfrastructure = vi.fn(() => {
      return Promise.reject(new Error("Must remain offline"));
    });
    const io = { ...adapters(source, dist), provisionInfrastructure };
    const plan = await execute(
      "plan",
      { env: "staging", operation: "provision" },
      io,
    );
    expect(plan).toMatchObject({
      dryRun: true,
      steps: [],
      infrastructure: {
        owner: "terraform",
        stateEnvironment: "staging",
        stateDirectory: "~/.config/nfl-pickem/terraform/staging/",
        resources: [
          {
            address: "cloudflare_d1_database.app",
            type: "cloudflare_d1_database",
            name: "nfl-pickem-staging",
          },
          {
            address: "cloudflare_worker.app",
            type: "cloudflare_worker",
            name: "nfl-pickem-staging",
          },
        ],
        wranglerOwns: ["versions", "deployments", "bindings", "workflows"],
      },
    });
    expect(provisionInfrastructure).not.toHaveBeenCalled();
    expect(io.run).not.toHaveBeenCalled();
    expect(io.validateSecrets).not.toHaveBeenCalled();
  });

  it("requires explicit cloud approval before infrastructure provisioning", async () => {
    const { source, dist } = configuration();
    const provisionInfrastructure = vi.fn(() => {
      return Promise.reject(new Error("Unapproved mutation"));
    });
    const io = { ...adapters(source, dist), provisionInfrastructure };
    await expect(
      execute("provision", { env: "staging", "account-id": account }, io),
    ).rejects.toThrow("--approve-cloud");
    await expect(
      execute("provision", { ...approved, "approve-cloud": false }, io),
    ).rejects.toThrow("--approve-cloud");
    expect(provisionInfrastructure).not.toHaveBeenCalled();
    expect(io.run).not.toHaveBeenCalled();
  });

  it("keeps provisioning behind account identity and quiescence gates", async () => {
    const cases = [
      { source: { account_id: "b".repeat(32) } },
      { environment: { account_id: "b".repeat(32) } },
      { environment: { workers_dev: true } },
      { environment: { preview_urls: true } },
      {
        environment: {
          routes: [
            {
              pattern: "pickem-staging.bholzer.me",
              custom_domain: true,
              zone_id: account,
            },
          ],
        },
      },
      { vars: { DISCORD_SEND_ENABLED: "true" } },
      { vars: { SCHEDULES_ENABLED: "true" } },
      { environment: { triggers: { crons: ["0 * * * *"] } } },
      {
        environment: {
          workflows: [
            {
              binding: "JOBS",
              name: "nfl-pickem-staging-jobs",
              class_name: "PickemWorkflow",
              schedules: ["0 * * * *"],
            },
          ],
        },
      },
    ];
    for (const change of cases) {
      const { source, dist } = configuration();
      Object.assign(source, change.source);
      Object.assign(source.env.staging, change.environment);
      Object.assign(source.env.staging.vars, change.vars);
      const provisionInfrastructure = vi.fn(() => {
        return Promise.reject(new Error("Unsafe mutation"));
      });
      const io = { ...adapters(source, dist), provisionInfrastructure };
      await expect(execute("provision", approved, io)).rejects.toThrow();
      expect(provisionInfrastructure).not.toHaveBeenCalled();
      expect(io.run).not.toHaveBeenCalled();
    }
  });

  it("persists only the selected environment from verified infrastructure outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-provision-"));
    try {
      const sourcePath = join(directory, "wrangler.jsonc");
      const { source } = configuration();
      Reflect.deleteProperty(source.env.staging.d1_databases[0], "database_id");
      const production = configuration(false, "production").source.env
        .production;
      production.d1_databases[0].database_id =
        "22222222-2222-4222-8222-222222222222";
      Object.assign(source.env, { production });
      const original = structuredClone(source);
      await writeFile(sourcePath, JSON.stringify(source));
      const infrastructure = {
        databaseId,
        workerId: "worker-identity",
        statePath: "/private/terraform/staging/terraform.tfstate",
        changed: true,
      };
      const run = vi.fn(() => {
        return Promise.reject(new Error("Provision must not invoke Wrangler"));
      });
      const result = await execute(
        "provision",
        { ...approved, source: sourcePath },
        {
          run,
          provisionInfrastructure: () => Promise.resolve(infrastructure),
        },
      );
      original.env.staging.d1_databases[0].database_id = databaseId;
      expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(original);
      expect(result).toMatchObject({
        action: "provision",
        environment: "staging",
        ...infrastructure,
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles an already configured same-state database without rewriting source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-provision-"));
    try {
      const sourcePath = join(directory, "wrangler.jsonc");
      const { source } = configuration();
      const original = `// Preserve source comments on an idempotent rerun.\n${JSON.stringify(source)}\n`;
      await writeFile(sourcePath, original);
      const provisionInfrastructure = vi.fn(
        (options: { databaseId?: string }) => {
          if (options.databaseId !== databaseId) {
            return Promise.reject(
              new Error("Configured database does not match state"),
            );
          }
          return Promise.resolve({
            databaseId,
            workerId: "existing-worker",
            statePath: "/private/terraform/staging/terraform.tfstate",
            changed: false,
          });
        },
      );
      const result = await execute(
        "provision",
        { ...approved, source: sourcePath },
        { provisionInfrastructure },
      );
      expect(result).toMatchObject({
        databaseId,
        workerId: "existing-worker",
        changed: false,
      });
      expect(provisionInfrastructure).toHaveBeenCalledTimes(1);
      expect(await readFile(sourcePath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a configured source ID conflict without replacing the source database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-provision-"));
    try {
      const sourcePath = join(directory, "wrangler.jsonc");
      const { source } = configuration();
      const original = JSON.stringify(source);
      await writeFile(sourcePath, original);
      await expect(
        execute(
          "provision",
          { ...approved, source: sourcePath },
          {
            provisionInfrastructure: () =>
              Promise.resolve({
                databaseId: "22222222-2222-4222-8222-222222222222",
                workerId: "other-worker",
                statePath: "/private/terraform/staging/terraform.tfstate",
                changed: false,
              }),
          },
        ),
      ).rejects.toThrow("conflicts with configured source database");
      expect(await readFile(sourcePath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not persist malformed or cross-environment database outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-provision-"));
    try {
      const sourcePath = join(directory, "wrangler.jsonc");
      const { source } = configuration();
      Reflect.deleteProperty(source.env.staging.d1_databases[0], "database_id");
      Object.assign(source.env, configuration(false, "production").source.env);
      const original = JSON.stringify(source);
      await writeFile(sourcePath, original);
      for (const returnedId of ["not-a-uuid", databaseId]) {
        await expect(
          execute(
            "provision",
            { ...approved, source: sourcePath },
            {
              provisionInfrastructure: () =>
                Promise.resolve({
                  databaseId: returnedId,
                  workerId: "worker",
                  statePath: "/private/terraform/staging/terraform.tfstate",
                  changed: true,
                }),
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(sourcePath, "utf8")).toBe(original);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects source database IDs shared across environments", () => {
    const shared = configuration();
    Object.assign(shared.source.env, {
      production: {
        name: "nfl-pickem-production",
        d1_databases: [{ database_id: databaseId }],
      },
    });
    expect(() => verifyDist(shared.source, shared.dist, "staging")).toThrow(
      "shared across environments",
    );
  });

  it("rejects permissive secret files and never exposes malformed secret data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-secrets-"));
    try {
      const path = join(directory, "secrets.json");
      await writeFile(path, "super-private-not-json", { mode: 0o644 });
      await expect(validateSecrets(path)).rejects.toThrow("owner-only");
      await rm(path);
      await writeFile(path, "super-private-not-json", { mode: 0o600 });
      await expect(validateSecrets(path)).rejects.toThrow("contents withheld");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses schema migration until paused native versions are terminated", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const name of ["0001_business.sql", "0002_jobs.sql"]) {
        db.exec(
          await readFile(
            new URL(`../../migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
      }
      db.exec(
        "INSERT INTO job_runs(id,type,week,params,source,status,created_at,updated_at,delivery_scope) VALUES('old-version','deliver_hashes',1,'{\"runId\":\"old-version\",\"type\":\"deliver_hashes\",\"week\":1}','manual','errored','2026-09-01','2026-09-01','scope')",
      );
      const { source, dist } = configuration();
      let nativeStatus = "paused";
      const run = async (args: string[]) => {
        if (args[0] === "workflows" && args[1] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify([
              { name: dist.workflows[0].name, script_name: dist.name },
            ]),
          };
        }
        if (args[0] === "d1") {
          if (args[1] === "migrations") {
            db.exec(
              await readFile(
                new URL("../../migrations/0003_seasons.sql", import.meta.url),
                "utf8",
              ),
            );
            return { code: 0, stdout: "" };
          }
          return executeSql(db, args);
        }
        return {
          code: 0,
          stdout: JSON.stringify([{ id: "old-version", status: nativeStatus }]),
        };
      };
      await expect(
        execute("migrate", approved, adapters(source, dist, run)),
      ).rejects.toThrow();
      expect(
        db
          .prepare("PRAGMA table_info(submissions)")
          .all()
          .some((column) => column.name === "season"),
      ).toBe(false);
      expect(db.prepare("SELECT paused FROM job_settings").get()).toEqual({
        paused: 1,
      });
      nativeStatus = "terminated";
      await execute("migrate", approved, adapters(source, dist, run));
      expect(
        db
          .prepare("PRAGMA table_info(submissions)")
          .all()
          .some((column) => column.name === "season"),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps failed maintenance deployments fenced and freezes all native jobs with valid unscheduled config, retaining routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-maintenance-"));
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,0); CREATE TABLE job_runs(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT); INSERT INTO job_runs VALUES('native-cron','running','original'),('admin-created','sleeping','original'),('finished','complete','original');",
    );
    try {
      const { source, dist } = configuration(true);
      const sourcePath = join(directory, "wrangler.jsonc"),
        distPath = join(directory, "dist.json");
      await writeFile(sourcePath, JSON.stringify(source));
      await writeFile(distPath, JSON.stringify(dist));
      let failDeploy = true,
        pauseCompletes = false;
      const nativeStatus: Record<string, string> = {
        "native-cron": "running",
        "admin-created": "waiting",
        finished: "complete",
      };
      const assertMaintenanceDeployment = async () => {
        expect(
          db.prepare("SELECT paused FROM job_settings").get(),
        ).toMatchObject({ paused: 1 });
        for (const config of [
          (await persistedSource(sourcePath)).env.staging,
          await persistedDist(distPath),
        ]) {
          assert(config);
          expect(config.vars).toMatchObject({
            MAINTENANCE_MODE: "true",
            DISCORD_SEND_ENABLED: "false",
            SCHEDULES_ENABLED: "false",
          });
          expect(config.triggers?.crons).toEqual([]);
          // Wrangler rejects an explicitly empty Workflow schedules array.
          expect(config.workflows[0]).not.toHaveProperty("schedules");
          expect(config.routes).toEqual(dist.routes);
        }
      };
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === "workflows" && args[1] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify([
              { name: dist.workflows[0].name, script_name: dist.name },
            ]),
          };
        }
        if (args[0] === "d1") {
          return executeSql(db, args);
        }
        if (args[0] === "deploy") {
          await assertMaintenanceDeployment();
          if (failDeploy) {
            return { code: 1, stdout: "" };
          }
        }
        if (args.includes("pause")) {
          const id = args[4];
          assert(id);
          nativeStatus[id] = pauseCompletes ? "paused" : "waitingForPause";
        }
        return {
          code: 0,
          stdout: args.includes("list")
            ? JSON.stringify(
                Object.entries(nativeStatus).map(([id, status]) => ({
                  id,
                  status,
                })),
              )
            : "",
        };
      });
      const { action, options } = parseArgs([
        "maintenance",
        "--env",
        "staging",
        "--approve-cloud",
        "--account-id",
        account,
        "--inflight-reviewed",
        "--source",
        sourcePath,
        "--dist",
        distPath,
      ]);
      await expect(execute(action, options, { run })).rejects.toThrow();
      expect(db.prepare("SELECT paused FROM job_settings").get()).toMatchObject(
        { paused: 1 },
      );
      expect(
        db.prepare("SELECT status FROM job_runs WHERE id='native-cron'").get(),
      ).toMatchObject({ status: "running" });
      failDeploy = false;
      await expect(execute(action, options, { run })).rejects.toThrow();
      expect(db.prepare("SELECT paused FROM job_settings").get()).toMatchObject(
        { paused: 1 },
      );
      expect(
        db.prepare("SELECT status FROM job_runs WHERE id='native-cron'").get(),
      ).toMatchObject({ status: "running" });
      pauseCompletes = true;
      const result = await execute(action, options, { run });
      expect(result).toMatchObject({
        action: "maintenance",
        paused: ["native-cron", "admin-created"],
      });
      expect(
        db.prepare("SELECT id,status FROM job_runs ORDER BY id").all(),
      ).toEqual([
        { id: "admin-created", status: "paused" },
        { id: "finished", status: "complete" },
        { id: "native-cron", status: "paused" },
      ]);
      expect(
        db.prepare("SELECT updated_at FROM job_runs WHERE id='finished'").get(),
      ).toMatchObject({ updated_at: "original" });
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refuses to create a snapshot when native jobs are paused but the D1 delivery fence is open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-fence-"));
    try {
      const { source, dist } = configuration();
      source.env.staging.vars.MAINTENANCE_MODE = "true";
      dist.vars.MAINTENANCE_MODE = "true";
      const output = join(directory, "snapshot.sql");
      const run = vi.fn((args: string[]) =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify(
            args.includes("list")
              ? []
              : [{ success: true, results: [{ paused: 0, active: 0 }] }],
          ),
        }),
      );
      await expect(
        execute(
          "export",
          { ...approved, output, "writers-stopped": true },
          adapters(source, dist, run),
        ),
      ).rejects.toThrow("D1 delivery fence");
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refuses to export paused native work that has no D1 history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-history-"));
    try {
      const { source, dist } = configuration();
      source.env.staging.vars.MAINTENANCE_MODE = "true";
      dist.vars.MAINTENANCE_MODE = "true";
      const output = join(directory, "snapshot.sql");
      const run = (args: string[]) => {
        if (args[0] === "workflows" && args[1] === "list") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              { name: dist.workflows[0].name, script_name: dist.name },
            ]),
          });
        }
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify(
            args.includes("list")
              ? [{ id: "unrecorded-cron", status: "paused" }]
              : [{ success: true, results: [] }],
          ),
        });
      };
      await expect(
        execute("export", { ...approved, output }, adapters(source, dist, run)),
      ).rejects.toThrow("no D1 history");
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps failed deployments fenced and reports retryable delivery wakeups without resuming individually paused jobs", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,0); CREATE TABLE job_runs(id TEXT PRIMARY KEY,status TEXT,gate_paused INTEGER); INSERT INTO job_runs VALUES('maintenance-paused','paused',1),('finished','complete',1);",
    );
    try {
      const { source, dist } = configuration(true);
      let failDeploy = true,
        failWake = true;
      const notifications: string[] = [];
      const run = vi.fn((args: string[]) => {
        if (args[0] === "workflows" && args[1] === "list") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              { name: dist.workflows[0].name, script_name: dist.name },
            ]),
          });
        }
        if (args[0] === "d1") {
          return Promise.resolve(executeSql(db, args));
        }
        if (args[0] === "deploy") {
          expect(
            db.prepare("SELECT paused FROM job_settings").get(),
          ).toMatchObject({ paused: 1 });
          if (failDeploy) {
            return Promise.resolve({ code: 1, stdout: "" });
          }
          db.exec(
            "INSERT INTO job_runs VALUES('cron-one','running',1),('cron-two','running',1)",
          );
          return Promise.resolve({ code: 0, stdout: "" });
        }
        if (args.includes("send-event")) {
          const id = args[4];
          assert(id);
          if (id === "cron-two" && failWake) {
            return Promise.resolve({ code: 1, stdout: "" });
          }
          notifications.push(id);
          db.prepare("UPDATE job_runs SET gate_paused=0 WHERE id=?").run(id);
          return Promise.resolve({ code: 0, stdout: "" });
        }
        return Promise.reject(new Error("Unexpected native mutation"));
      });
      const { options } = parseArgs([
        "activate",
        "--env",
        "staging",
        "--approve-cloud",
        "--account-id",
        account,
        "--approve-discord",
        "--verified-data",
        "--source-quiesced",
        "--dns-quiesced",
        "--secrets-file",
        "/private/secrets.json",
      ]);
      const io = adapters(source, dist, run);
      await expect(execute("activate", options, io)).rejects.toThrow(
        "activate failed",
      );
      expect(db.prepare("SELECT paused FROM job_settings").get()).toMatchObject(
        { paused: 1 },
      );
      expect(notifications).toEqual([]);
      failDeploy = false;
      await expect(execute("activate", options, io)).rejects.toMatchObject({
        report: { notified: ["cron-one"], failed: ["cron-two"] },
      });
      expect(db.prepare("SELECT paused FROM job_settings").get()).toMatchObject(
        { paused: 0 },
      );
      failWake = false;
      await expect(execute("unpause", options, io)).resolves.toMatchObject({
        completed: true,
        wakeups: { notified: ["cron-two"], failed: [] },
      });
      expect(notifications).toEqual(["cron-one", "cron-two"]);
      expect(
        db
          .prepare(
            "SELECT status,gate_paused FROM job_runs WHERE id='maintenance-paused'",
          )
          .get(),
      ).toMatchObject({ status: "paused", gate_paused: 1 });
    } finally {
      db.close();
    }
  });

  it("fences and pauses old native work before importing despite quiet local flags", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,0); CREATE TABLE job_runs(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT); INSERT INTO job_runs VALUES('old-version','sleeping','old');",
    );
    const { source, dist } = configuration();
    let nativeStatus = "running",
      imported = false;
    const run = (args: string[]) => {
      if (args.includes("--file")) {
        expect(
          db.prepare("SELECT paused FROM job_settings").get(),
        ).toMatchObject({ paused: 1 });
        expect(nativeStatus).toBe("paused");
        imported = true;
        return Promise.resolve({ code: 0, stdout: "" });
      }
      if (args[0] === "d1") {
        return Promise.resolve(executeSql(db, args));
      }
      if (args[1] === "list") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            { name: "nfl-pickem-staging-jobs", script_name: dist.name },
          ]),
        });
      }
      if (args.includes("pause")) {
        nativeStatus = "paused";
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ id: "old-version", status: nativeStatus }]),
      });
    };
    try {
      await execute(
        "import",
        { ...approved, file: "/private/markers.sql", "source-quiesced": true },
        adapters(source, dist, run),
      );
      expect(imported).toBe(true);
      expect(db.prepare("SELECT status FROM job_runs").get()).toMatchObject({
        status: "paused",
      });
    } finally {
      db.close();
    }
  });
  it("never pauses or adopts a same-named Workflow owned by another Worker", async () => {
    const { source, dist } = configuration();
    let nativeStatus = "running",
      deployed = false;
    const run = (args: string[]) => {
      if (args[0] === "d1") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([{ success: true, results: [] }]),
        });
      }
      if (args[1] === "list") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            { name: dist.workflows[0].name, script_name: "unrelated-worker" },
          ]),
        });
      }
      if (args.includes("pause")) {
        nativeStatus = "paused";
      }
      if (args[0] === "deploy") {
        deployed = true;
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ id: "unrelated-job", status: nativeStatus }]),
      });
    };
    await expect(
      execute(
        "prepare",
        { ...approved, ...prepareOptions },
        adapters(source, dist, run),
      ),
    ).rejects.toThrow();
    expect(nativeStatus).toBe("running");
    expect(deployed).toBe(false);
  });

  it("refuses to lose a native cron paused before its D1 history existed", async () => {
    const run = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ success: true, results: [] }]),
      });
    await expect(
      synchronizePausedInstances(
        [{ id: "new-cron", status: "paused" }],
        { environment: "staging", sourcePath: "/source" },
        run,
        {},
      ),
    ).rejects.toThrow("no D1 history");
  });

  it("rejects domain takeover and DNS drift before deploying or releasing the fence", async () => {
    const { source, dist } = configuration(true);
    let deployed = false;
    const run = (args: string[]) => {
      if (args[0] === "deploy") {
        deployed = true;
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([
          { success: true, results: [{ paused: 1, active: 0 }] },
        ]),
      });
    };
    const options = {
      ...approved,
      ...prepareOptions,
      "approve-discord": true,
      "verified-data": true,
      "source-quiesced": true,
    };
    const io = adapters(source, dist, run);
    const wrongOwner = (method: string, path: string) =>
      Promise.resolve(
        path.includes("/workers/domains")
          ? { result: [{ ...ownedDomain, service: "another-worker" }] }
          : domainApi(method, path),
      );
    await expect(
      execute("activate", options, { ...io, api: wrongOwner }),
    ).rejects.toThrow("another Worker");
    const drift = (method: string, path: string) => {
      if (path.includes("dns_records")) {
        return Promise.resolve({
          result: [
            {
              name: ownedDomain.hostname,
              type: "A",
              ttl: 300,
              content: "192.0.2.99",
              proxied: false,
            },
          ],
        });
      }
      if (path.includes("/workers/domains")) {
        return Promise.resolve({ result: [] });
      }
      return domainApi(method, path);
    };
    await expect(
      execute("activate", options, { ...io, api: drift }),
    ).rejects.toThrow("Existing DNS records");
    await expect(
      execute("unpause", options, { ...io, api: drift }),
    ).rejects.toThrow("could not be verified");
    expect(deployed).toBe(false);
  });

  it("detaches the actual domain and checks absence before persisting an empty route list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pickem-detach-"));
    try {
      const { source, dist } = configuration(true);
      for (const config of [source.env.staging, dist]) {
        config.vars.MAINTENANCE_MODE = "true";
        config.vars.DISCORD_SEND_ENABLED = "false";
        config.vars.SCHEDULES_ENABLED = "false";
        delete config.workflows[0].schedules;
      }
      const sourcePath = join(directory, "source.json"),
        distPath = join(directory, "dist.json");
      await writeFile(sourcePath, JSON.stringify(source));
      await writeFile(distPath, JSON.stringify(dist));
      let attached = true,
        refuseDelete = true,
        deployed = false;
      const api = (method: string, path: string) => {
        if (method === "DELETE") {
          if (!refuseDelete) {
            attached = false;
          }
          return Promise.resolve({ success: true });
        }
        return Promise.resolve(
          path.includes("/workers/domains")
            ? { result: attached ? [ownedDomain] : [] }
            : domainApi(method, path),
        );
      };
      const run = (args: string[]) => {
        if (args[0] === "workflows" && args[1] === "list") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              { name: dist.workflows[0].name, script_name: dist.name },
            ]),
          });
        }
        expect(attached).toBe(false);
        deployed = true;
        return Promise.resolve({ code: 0, stdout: "" });
      };
      const options = {
        ...approved,
        source: sourcePath,
        dist: distPath,
        "snapshot-verified": true,
        "zone-id": account,
      };
      await expect(execute("detach", options, { run, api })).rejects.toThrow(
        "remains attached",
      );
      expect((await persistedSource(sourcePath)).env.staging?.routes).toEqual(
        source.env.staging.routes,
      );
      expect(deployed).toBe(false);
      refuseDelete = false;
      await execute("detach", options, { run, api });
      expect(attached).toBe(false);
      expect((await persistedSource(sourcePath)).env.staging?.routes).toEqual(
        [],
      );
      await execute("detach", options, { run, api });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("native pending Workflow creation", () => {
  const plan = {
    environment: "staging",
    sourcePath: "/source.jsonc",
    workflow: "nfl-pickem-staging-jobs",
  };
  const document = {
    version: 1,
    environment: "staging",
    workflows: [
      { id: "legacy-one", params: { runId: "legacy-one", season: 2025 } },
      { id: "legacy-two", params: { runId: "legacy-two", season: 2026 } },
      { id: "legacy-three", params: { runId: "legacy-three", season: 2026 } },
    ],
  };
  it("rejects an entire yearless plan before launching any work", async () => {
    const run = vi.fn();
    const yearless = {
      ...document,
      workflows: [
        document.workflows[0],
        { id: "yearless", params: { runId: "yearless", week: 2 } },
      ],
    };
    await expect(createWorkflows(yearless, plan, run)).rejects.toThrow(
      "requires an explicit season",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves explicit historical seasons in native trigger parameters", async () => {
    const run = vi.fn(() => Promise.resolve({ code: 0, stdout: "" }));
    await createWorkflows(document, plan, run);
    expect(run).toHaveBeenCalledWith(
      [
        "workflows",
        "trigger",
        plan.workflow,
        JSON.stringify({ runId: "legacy-one", season: 2025 }),
        "--id",
        "legacy-one",
        "--config",
        plan.sourcePath,
        "--env",
        plan.environment,
        "--json",
      ],
      {},
    );
  });
  it("returns confirmed existing IDs only after a separate successful native describe", async () => {
    const run = vi.fn((args: string[]) =>
      Promise.resolve(
        args.includes("describe")
          ? {
              code: 0,
              stdout: JSON.stringify({ id: args[4], status: "complete" }),
            }
          : { code: 1, stdout: "" },
      ),
    );
    const result = await createWorkflows(document, plan, run);
    expect(result).toEqual({
      created: [],
      existing: ["legacy-one", "legacy-two", "legacy-three"],
      failed: [],
      unattempted: [],
    });
  });
  it("reports partial failure without retrying or triggering unattempted jobs", async () => {
    const run = vi.fn((args: string[]) =>
      Promise.resolve({
        code: args.includes("legacy-one") ? 0 : 1,
        stdout: "",
      }),
    );
    await expect(createWorkflows(document, plan, run)).rejects.toMatchObject({
      report: {
        created: ["legacy-one"],
        existing: [],
        failed: ["legacy-two"],
        unattempted: ["legacy-three"],
      },
    });
  });
  it("enumerates native instances beyond the first page, rejecting provider failures", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      id: `job-${i}`,
      status: "complete",
    }));
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(first) })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ id: "last", status: "running" }]),
      });
    expect((await listInstances(plan, run)).at(-1)).toEqual({
      id: "last",
      status: "running",
    });
    await expect(
      listInstances(plan, () => Promise.resolve({ code: 1, stdout: "" })),
    ).rejects.toThrow("Cannot enumerate");
  });
});

describe("public staging without delivery activation", () => {
  it("plans publication offline without migration or messaging acknowledgments", async () => {
    const { source, dist } = publicationConfiguration();
    const io = { ...adapters(source, dist), api: vi.fn(domainApi) };
    const plan = await execute(
      "plan",
      { ...prepareOptions, operation: "publish" },
      io,
    );
    expect(plan).toMatchObject({
      action: "publish",
      environment: "staging",
      dryRun: true,
      domain: { hostname: ownedDomain.hostname, zoneId: account },
    });
    expect(io.run).not.toHaveBeenCalled();
    expect(io.api).not.toHaveBeenCalled();
    expect(io.validateSecrets).not.toHaveBeenCalled();
  });

  it("keeps failed and repeated public deployments fenced, attaching only the owned staging domain without waking jobs", async () => {
    const { source, dist } = publicationConfiguration();
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,0); CREATE TABLE job_runs(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT,gate_paused INTEGER); INSERT INTO job_runs VALUES('old-version','running','old',1),('finished','complete','original',0);",
    );
    let attached = false,
      failDeploy = true,
      deployments = 0,
      dnsInspected = false;
    let nativeStatus = "running";
    const api = (method: string, path: string) => {
      expect(method).toBe("GET");
      if (path.includes("/workers/domains")) {
        expect(
          new URL(`https://api.example${path}`).searchParams.get("hostname"),
        ).toBe(ownedDomain.hostname);
        return Promise.resolve({ result: attached ? [ownedDomain] : [] });
      }
      if (path.includes("dns_records")) {
        expect(attached).toBe(false);
        dnsInspected = true;
        return Promise.resolve({ result: [] });
      }
      return domainApi(method, path);
    };
    const run = (args: string[]) => {
      expect(dnsInspected).toBe(true);
      if (args[0] === "d1") {
        return Promise.resolve(executeSql(db, args));
      }
      if (args[0] === "workflows" && args[1] === "list") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            { name: dist.workflows[0].name, script_name: dist.name },
          ]),
        });
      }
      if (args[0] === "workflows" && args[2] === "list") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            { id: "old-version", status: nativeStatus },
            { id: "finished", status: "complete" },
          ]),
        });
      }
      if (args[0] === "workflows" && args[2] === "pause") {
        expect(
          db.prepare("SELECT paused FROM job_settings").get(),
        ).toMatchObject({ paused: 1 });
        expect(args[4]).toBe("old-version");
        nativeStatus = "paused";
        return Promise.resolve({ code: 0, stdout: "" });
      }
      if (args[0] === "deploy") {
        expect(
          db.prepare("SELECT paused FROM job_settings").get(),
        ).toMatchObject({ paused: 1 });
        expect(
          db
            .prepare("SELECT status FROM job_runs WHERE id='old-version'")
            .get(),
        ).toMatchObject({ status: "paused" });
        expect(nativeStatus).toBe("paused");
        if (failDeploy) {
          return Promise.resolve({ code: 1, stdout: "" });
        }
        attached = true;
        deployments++;
        // A pre-existing native job becoming active during deploy is fenced again.
        nativeStatus = "running";
        return Promise.resolve({ code: 0, stdout: "" });
      }
      return Promise.reject(
        new Error("Unexpected native mutation, migration or delivery wakeup"),
      );
    };
    try {
      const options = { ...approved, ...prepareOptions };
      const io = { ...adapters(source, dist, run), api };
      await expect(execute("publish", options, io)).rejects.toThrow();
      expect(attached).toBe(false);
      expect(nativeStatus).toBe("paused");
      expect(db.prepare("SELECT paused FROM job_settings").get()).toMatchObject(
        { paused: 1 },
      );
      failDeploy = false;
      await expect(execute("publish", options, io)).resolves.toMatchObject({
        action: "publish",
        completed: true,
      });
      await expect(execute("publish", options, io)).resolves.toMatchObject({
        action: "publish",
        completed: true,
      });
      expect(attached).toBe(true);
      expect(deployments).toBe(2);
      expect(nativeStatus).toBe("paused");
      expect(db.prepare("SELECT paused FROM job_settings").get()).toMatchObject(
        { paused: 1 },
      );
      expect(
        db
          .prepare(
            "SELECT status,gate_paused FROM job_runs WHERE id='old-version'",
          )
          .get(),
      ).toMatchObject({ status: "paused", gate_paused: 1 });
      expect(
        db
          .prepare("SELECT status,updated_at FROM job_runs WHERE id='finished'")
          .get(),
      ).toMatchObject({ status: "complete", updated_at: "original" });
    } finally {
      db.close();
    }
  });

  it.each([
    "foreign domain",
    "existing DNS",
    "wrong account",
    "foreign Workflow",
  ] as const)(
    "refuses %s without takeover or releasing the existing fence",
    async (conflict) => {
      const { source, dist } = publicationConfiguration();
      const db = new DatabaseSync(":memory:");
      db.exec(
        "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,1);",
      );
      const mutations: string[][] = [];
      const run = (args: string[]) => {
        if (args[0] === "workflows" && args[1] === "list") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              { name: dist.workflows[0].name, script_name: "another-worker" },
            ]),
          });
        }
        mutations.push(args);
        return Promise.reject(new Error("Unexpected mutation"));
      };
      const api = (method: string, path: string) => {
        expect(method).toBe("GET");
        if (path.includes("/workers/domains")) {
          return Promise.resolve({
            result:
              conflict === "existing DNS"
                ? []
                : [
                    {
                      ...ownedDomain,
                      service:
                        conflict === "foreign domain"
                          ? "another-worker"
                          : ownedDomain.service,
                    },
                  ],
          });
        }
        if (path.includes("dns_records")) {
          return Promise.resolve({
            result: [
              { name: ownedDomain.hostname, type: "A", content: "192.0.2.99" },
            ],
          });
        }
        if (conflict === "wrong account") {
          return Promise.resolve({
            result: {
              id: account,
              name: "bholzer.me",
              account: { id: "c".repeat(32) },
            },
          });
        }
        return domainApi(method, path);
      };
      try {
        await expect(
          execute(
            "publish",
            { ...approved, ...prepareOptions },
            { ...adapters(source, dist, run), api },
          ),
        ).rejects.toThrow();
        expect(mutations).toEqual([]);
        expect(
          db.prepare("SELECT paused FROM job_settings").get(),
        ).toMatchObject({ paused: 1 });
      } finally {
        db.close();
      }
    },
  );

  it("does not report publication success when the deployed domain association is missing", async () => {
    const { source, dist } = publicationConfiguration();
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,0); CREATE TABLE job_runs(id TEXT PRIMARY KEY,status TEXT);",
    );
    let deployed = false;
    const run = (args: string[]) => {
      if (args[0] === "workflows") {
        return Promise.resolve({ code: 0, stdout: "[]" });
      }
      if (args[0] === "deploy") {
        deployed = true;
        return Promise.resolve({ code: 0, stdout: "" });
      }
      return Promise.resolve(executeSql(db, args));
    };
    const api = (method: string, path: string) =>
      Promise.resolve(
        path.includes("/workers/domains") || path.includes("dns_records")
          ? { result: [] }
          : domainApi(method, path),
      );
    try {
      await expect(
        execute(
          "publish",
          { ...approved, ...prepareOptions },
          { ...adapters(source, dist, run), api },
        ),
      ).rejects.toThrow();
      expect(deployed).toBe(true);
      expect(db.prepare("SELECT paused FROM job_settings").get()).toMatchObject(
        { paused: 1 },
      );
    } finally {
      db.close();
    }
  });

  it("requires all publication approvals and private secrets before any remote call", async () => {
    for (const missing of [
      "approve-cloud",
      "account-id",
      "dns-quiesced",
      "writers-stopped",
      "secrets-file",
    ]) {
      const { source, dist } = publicationConfiguration();
      const options: Record<string, unknown> = {
        ...approved,
        ...prepareOptions,
      };
      Reflect.deleteProperty(options, missing);
      const io = { ...adapters(source, dist), api: vi.fn(domainApi) };
      await expect(execute("publish", options, io)).rejects.toThrow();
      expect(io.run).not.toHaveBeenCalled();
      expect(io.api).not.toHaveBeenCalled();
    }
    const { source, dist } = publicationConfiguration();
    const io = {
      ...adapters(source, dist),
      api: vi.fn(domainApi),
      validateSecrets: () => {
        return Promise.reject(new Error("Invalid private secrets"));
      },
    };
    await expect(
      execute("publish", { ...approved, ...prepareOptions }, io),
    ).rejects.toThrow();
    expect(io.run).not.toHaveBeenCalled();
    expect(io.api).not.toHaveBeenCalled();
  });

  it("rejects production, unsafe public configuration and stale builds before any remote call", async () => {
    interface Config {
      vars: Record<string, string>;
      workflows: [{ schedules?: string[] }];
      workers_dev: boolean;
      preview_urls: boolean;
      routes: { pattern: string; custom_domain: boolean; zone_id: string }[];
    }
    const changes: ((config: Config) => void)[] = [
      (config) => {
        config.vars.DISCORD_SEND_ENABLED = "true";
      },
      (config) => {
        config.vars.SCHEDULES_ENABLED = "true";
      },
      (config) => {
        config.workflows[0].schedules = ["0 * * * *"];
      },
      (config) => {
        Object.assign(config, { triggers: { crons: ["0 * * * *"] } });
      },
      (config) => {
        config.vars.MAINTENANCE_MODE = "true";
      },
      (config) => {
        config.vars.DISCORD_CLIENT_ID = "invalid";
      },
      (config) => {
        config.workers_dev = true;
      },
      (config) => {
        config.preview_urls = true;
      },
      (config) => {
        assert(config.routes[0]);
        config.routes.push({
          ...config.routes[0],
          pattern: "other.bholzer.me",
        });
      },
      (config) => {
        assert(config.routes[0]);
        config.routes[0].pattern = "pickem.bholzer.me";
      },
      (config) => {
        config.vars.APP_ORIGIN = "https://pickem.bholzer.me";
      },
      (config) => {
        config.vars.APP_ENV = "production";
      },
      (config) => {
        Object.assign(config, { account_id: "c".repeat(32) });
      },
    ];
    for (const change of changes) {
      const { source, dist } = publicationConfiguration();
      change(dist);
      Object.assign(source.env.staging, structuredClone(dist));
      const io = { ...adapters(source, dist), api: vi.fn(domainApi) };
      await expect(
        execute("publish", { ...approved, ...prepareOptions }, io),
      ).rejects.toThrow();
      expect(io.run).not.toHaveBeenCalled();
      expect(io.api).not.toHaveBeenCalled();
    }
    const production = publicationConfiguration("production");
    const stale = publicationConfiguration();
    stale.dist.vars.DISCORD_CLIENT_ID = "12345678901234570";
    const staleRoute = publicationConfiguration();
    Object.assign(staleRoute.dist, { route: "other.bholzer.me/*" });
    for (const { source, dist } of [production, stale, staleRoute]) {
      const io = { ...adapters(source, dist), api: vi.fn(domainApi) };
      await expect(
        execute(
          "publish",
          { ...approved, ...prepareOptions, env: dist.targetEnvironment },
          io,
        ),
      ).rejects.toThrow();
      expect(io.run).not.toHaveBeenCalled();
      expect(io.api).not.toHaveBeenCalled();
    }
  });
});

describe("existing-zone custom-domain boundaries", () => {
  it.each(["staging", "production"] as const)(
    "activates only the approved %s hostname and safely repeats an owned attachment",
    async (environment) => {
      const { source, dist } = configuration(true, environment);
      const db = new DatabaseSync(":memory:");
      db.exec(
        "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,0); CREATE TABLE job_runs(id TEXT PRIMARY KEY,status TEXT,gate_paused INTEGER);",
      );
      let attached = false,
        deployments = 0;
      const domain = {
        ...ownedDomain,
        hostname: new URL(dist.vars.APP_ORIGIN).hostname,
        service: dist.name,
      };
      const api = (method: string, path: string) => {
        expect(method).toBe("GET");
        if (path.includes("dns_records")) {
          expect(attached).toBe(false);
          return Promise.resolve({ result: [] });
        }
        if (path.includes("/workers/domains")) {
          return Promise.resolve({ result: attached ? [domain] : [] });
        }
        return domainApi(method, path);
      };
      const run = (args: string[]) => {
        if (args[0] === "workflows" && args[1] === "list") {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([
              { name: dist.workflows[0].name, script_name: dist.name },
            ]),
          });
        }
        if (args[0] === "deploy") {
          expect(
            db.prepare("SELECT paused FROM job_settings").get(),
          ).toMatchObject({ paused: 1 });
          attached = true;
          deployments++;
          return Promise.resolve({ code: 0, stdout: "" });
        }
        return Promise.resolve(executeSql(db, args));
      };
      try {
        const options = {
          ...approved,
          ...prepareOptions,
          env: environment,
          "approve-discord": true,
          "verified-data": true,
          "source-quiesced": true,
        };
        const io = { ...adapters(source, dist, run), api };
        await execute("activate", options, io);
        await execute("activate", options, io);
        expect(attached).toBe(true);
        expect(deployments).toBe(2);
        expect(
          db.prepare("SELECT paused FROM job_settings").get(),
        ).toMatchObject({ paused: 0 });
      } finally {
        db.close();
      }
    },
  );

  it.each(["staging", "production"] as const)(
    "rejects legacy, cross-environment and unrelated origins for %s before any remote call",
    async (environment) => {
      const invalidHosts = [
        "pickem.unboundops.com",
        "pickem-staging.unboundops.com",
        "other.bholzer.me",
        environment === "staging"
          ? "pickem.bholzer.me"
          : "pickem-staging.bholzer.me",
      ];
      for (const hostname of invalidHosts) {
        const { source, dist } = configuration(true, environment);
        for (const config of [source.env[environment], dist]) {
          config.vars.APP_ORIGIN = `https://${hostname}`;
          assert(config.routes[0]);
          config.routes[0].pattern = hostname;
        }
        const io = { ...adapters(source, dist), api: vi.fn(domainApi) };
        await expect(
          execute(
            "activate",
            {
              ...approved,
              ...prepareOptions,
              env: environment,
              "approve-discord": true,
              "verified-data": true,
              "source-quiesced": true,
            },
            io,
          ),
        ).rejects.toThrow();
        expect(io.run).not.toHaveBeenCalled();
        expect(io.api).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { id: account, name: "me", account: { id: account } },
    {
      id: account,
      name: "pickem-staging.bholzer.me",
      account: { id: account },
    },
    { id: account, name: "bholzer.me", account: { id: "c".repeat(32) } },
    { id: "c".repeat(32), name: "bholzer.me", account: { id: account } },
  ])(
    "rejects mismatched zone identity without touching a domain: %j",
    async (zone) => {
      const { source, dist } = configuration(true);
      const io = adapters(source, dist);
      const api = vi.fn(() => Promise.resolve({ result: zone }));
      await expect(
        execute(
          "unpause",
          {
            ...approved,
            "approve-discord": true,
            "verified-data": true,
            "source-quiesced": true,
          },
          { ...io, api },
        ),
      ).rejects.toThrow();
      expect(io.run).not.toHaveBeenCalled();
      expect(api).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["A", "AAAA", "CNAME", "TXT"])(
    "never overwrites an existing %s record or releases delivery",
    async (type) => {
      const { source, dist } = configuration(true);
      const db = new DatabaseSync(":memory:");
      db.exec(
        "CREATE TABLE job_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO job_settings VALUES(1,0); CREATE TABLE job_runs(id TEXT PRIMARY KEY,status TEXT);",
      );
      let deployed = false,
        inspectedRecords = false;
      const run = (args: string[]) => {
        if (args[0] === "deploy") {
          deployed = true;
        }
        return Promise.resolve(executeSql(db, args));
      };
      const api = (method: string, path: string) => {
        expect(method).toBe("GET");
        if (path.includes("dns_records")) {
          inspectedRecords = true;
          return Promise.resolve({
            result: [
              {
                name: ownedDomain.hostname,
                type,
                content: "unrelated existing value",
              },
            ],
          });
        }
        if (path.includes("/workers/domains")) {
          return Promise.resolve({ result: [] });
        }
        return domainApi(method, path);
      };
      try {
        await expect(
          execute(
            "activate",
            {
              ...approved,
              ...prepareOptions,
              "approve-discord": true,
              "verified-data": true,
              "source-quiesced": true,
            },
            { ...adapters(source, dist, run), api },
          ),
        ).rejects.toThrow();
        expect(inspectedRecords).toBe(true);
        expect(deployed).toBe(false);
        expect(
          db.prepare("SELECT paused FROM job_settings").get(),
        ).toMatchObject({ paused: 1 });
      } finally {
        db.close();
      }
    },
  );
});
