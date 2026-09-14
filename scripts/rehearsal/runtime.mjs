import { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { createUpstreams, members } from "./upstreams.mjs";

/** @typedef {Awaited<ReturnType<Miniflare["getD1Database"]>>} RehearsalDatabase */
/**
 * @typedef {object} Rehearsal
 * @property {string} origin
 * @property {string} directory
 * @property {number} season
 * @property {number} historicalSeason
 * @property {{player: string, rival: string, admin: string, receipt: string, earlyWinnerReceipt: string}} links
 * @property {RehearsalDatabase} db
 * @property {ReturnType<typeof createUpstreams>} upstreams
 * @property {() => Promise<void>} close
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const receiptExamples = {
  receipt: {
    id: "00000000-0000-4000-8000-000000000101",
    week: 1,
    userId: members.player.id,
  },
  earlyWinnerReceipt: {
    id: "00000000-0000-4000-8000-000000000102",
    week: 3,
    userId: members.rival.id,
  },
};

/** @param {string} parent @param {string} path */
function inside(parent, path) {
  const result = resolve(parent, path);
  if (!result.startsWith(resolve(parent) + sep)) {
    throw new Error("Compiled runtime path escapes its build directory");
  }
  return result;
}

/**
 * @param {string} origin
 * @param {typeof members.player} member
 * @param {string} secret
 * @param {number} season
 */
function submissionLink(origin, member, secret, season) {
  /** @param {unknown} value */
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const message = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ user_id: member.discordId, username: member.username, season, week: 2, exp: Math.floor(Date.now() / 1000) + 86400 })}`;
  const signature = createHmac("sha256", secret)
    .update(message)
    .digest("base64url");
  return `${origin}/submissions/new?token=${message}.${signature}`;
}

async function loadBuild() {
  const buildRoot = join(root, "dist");
  const configPath = join(buildRoot, "server/wrangler.json");
  /** @type {import("./build-types").CompiledBuild} */
  let config;
  try {
    // The local compiler owns this JSON format; only explicitly selected fields
    // below may configure the runtime, never generated vars or credentials.
    /** @type {unknown} */
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    config = /** @type {import("./build-types").CompiledBuild} */ (parsed);
  } catch (cause) {
    throw new Error("Build the local application first: npm run build", {
      cause,
    });
  }
  if (config.targetEnvironment !== "local") {
    throw new Error("Rehearsal requires local build output; run npm run build");
  }
  const scriptPath = inside(
    buildRoot,
    resolve(dirname(configPath), config.main),
  );
  const assetDirectory = inside(
    buildRoot,
    resolve(dirname(configPath), config.assets.directory),
  );
  await Promise.all([
    access(scriptPath),
    access(join(assetDirectory, "index.html")),
  ]);
  const workflows = config.workflows;
  if (
    !config.d1_databases?.some((database) => database.binding === "DB") ||
    !workflows?.some((workflow) => workflow.binding === "JOBS")
  ) {
    throw new Error("Compiled Worker must declare DB and JOBS bindings");
  }
  return { config, workflows, scriptPath, assetDirectory };
}

/**
 * @param {Awaited<ReturnType<typeof loadBuild>>} build
 * @param {{directory: string, origin: string, port: number, sessionSecret: string,
 * linkSecret: string, upstreams: ReturnType<typeof createUpstreams>}} options
 */
function createRuntime(build, options) {
  const { config, workflows, scriptPath, assetDirectory } = build;
  const { directory, origin, port, sessionSecret, linkSecret, upstreams } =
    options;
  return new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port,
      cf: false,
      telemetry: { enabled: false },
      unsafeLocalExplorer: false,
      unsafeDevRegistryPath: join(directory, "registry"),
      resourcePersistencePath: join(directory, "state"),
      resourceTmpPath: join(directory, "tmp"),
      name: "nfl-pickem-rehearsal",
      modules: true,
      scriptPath,
      modulesRoot: dirname(scriptPath),
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      // Enumerate synthetic bindings: do not spread config.vars or process.env.
      bindings: {
        APP_ENV: "local",
        APP_ORIGIN: origin,
        MAINTENANCE_MODE: "false",
        SESSION_SECRET: sessionSecret,
        SUBMISSION_TOKEN_SECRET: linkSecret,
        DISCORD_BOT_TOKEN: "rehearsal-not-a-bot-token",
        DISCORD_CLIENT_ID: "",
        DISCORD_CLIENT_SECRET: "rehearsal-not-a-client-secret",
        DISCORD_CHANNEL_ID: "900000000000000999",
        DISCORD_ALLOWED_USER_IDS: "",
        DISCORD_ALLOWED_CHANNEL_IDS: "",
        DISCORD_SEND_ENABLED: "false",
        SCHEDULES_ENABLED: "false",
      },
      d1Databases: { DB: "rehearsal-business" },
      workflows: Object.fromEntries(
        workflows.map((workflow) => [
          workflow.binding,
          {
            name: `rehearsal-${workflow.binding.toLowerCase()}`,
            className: workflow.class_name,
          },
        ]),
      ),
      assets: {
        directory: assetDirectory,
        binding: config.assets.binding,
        // Preserve generated routing verbatim: missing /logout must fail smoke,
        // rather than be hidden by a test-only worker-first override.
        run_worker_first: config.assets.run_worker_first,
        routerConfig: { has_user_worker: true },
        assetConfig: {
          html_handling: config.assets.html_handling,
          not_found_handling: config.assets.not_found_handling,
        },
      },
      outboundService: upstreams.outbound,
    }),
  );
}

/** @param {RehearsalDatabase} db */
async function migrateDatabase(db) {
  const migrationDirectory = join(root, "migrations");
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  if (!migrations.length) {
    throw new Error("No D1 migrations found");
  }
  for (const name of migrations) {
    const sql = await readFile(join(migrationDirectory, name), "utf8");
    const statements = unstable_splitSqlQuery(sql);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}

/** @param {RehearsalDatabase} db @param {number} season */
async function seedDatabase(db, season) {
  const timestamp = new Date().toISOString();
  await db.batch(
    Object.values(members).map((member) =>
      db
        .prepare(
          "INSERT INTO users (id,discord_user_id,discord_username,admin,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          member.id,
          member.discordId,
          member.username,
          Number(member.admin),
          timestamp,
          timestamp,
        ),
    ),
  );
  const rows = [
    { userId: members.player.id, season, week: 1, home: true, tiebreaker: 40 },
    { userId: members.rival.id, season, week: 2, home: false, tiebreaker: 39 },
    { userId: members.rival.id, season, week: 3, home: false, tiebreaker: 39 },
    {
      userId: members.player.id,
      season: season - 1,
      week: 1,
      home: false,
      tiebreaker: 38,
    },
    {
      userId: members.rival.id,
      season: season - 1,
      week: 1,
      home: true,
      tiebreaker: 41,
    },
  ];
  await db.batch(
    rows.map((row) =>
      db
        .prepare(
          "INSERT INTO submissions (user_id,season,week,picks,tiebreaker,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(
          row.userId,
          row.season,
          row.week,
          JSON.stringify({
            [`rehearsal-${row.season}-${row.week}-1`]: row.home
              ? "home-1"
              : "away-1",
            [`rehearsal-${row.season}-${row.week}-2`]: "away-2",
          }),
          row.tiebreaker,
          timestamp,
          timestamp,
        ),
    ),
  );
}

/**
 * Synthetic publication references only: rehearsal never sends to Discord.
 * @param {RehearsalDatabase} db
 * @param {import("../../src/shared/contracts").SubmissionDetail} detail
 * @param {string} id
 */
async function seedReceipt(db, detail, id) {
  const { submission, summary, verificationHash, scoreboard } = detail;
  const timestamp = new Date().toISOString();
  const channelId = "900000000000000999";
  await db.batch([
    db
      .prepare(
        "INSERT INTO hash_publications(snapshot_key,id,season,week,channel_id,guild_id,snapshot_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        `rehearsal:${submission.season}:${submission.week}:hash`,
        id,
        submission.season,
        submission.week,
        channelId,
        "900000000000000001",
        timestamp,
      ),
    db
      .prepare(
        "INSERT INTO hash_receipts(id,publication_id,submission_id,username,summary,verification_hash,game_ids,part_index) VALUES(?,?,?,?,?,?,?,0)",
      )
      .bind(
        id,
        id,
        submission.id,
        submission.user.username,
        summary,
        verificationHash,
        JSON.stringify(scoreboard.games.map((game) => game.id)),
      ),
    db
      .prepare(
        "INSERT INTO hash_publication_parts(publication_id,part_index,channel_id,message_id,published_at) VALUES(?,0,?,?,?)",
      )
      .bind(id, channelId, `90000000000000000${submission.week}`, timestamp),
  ]);
}

/**
 * Obtain receipt bytes from the real local API, not a duplicate summary renderer.
 * @param {RehearsalDatabase} db
 * @param {Miniflare} runtime
 * @param {string} adminLink
 * @param {number} season
 */
async function seedReceipts(db, runtime, adminLink, season) {
  const signedIn = await runtime.dispatchFetch(adminLink, {
    redirect: "manual",
  });
  if (signedIn.status !== 302) {
    throw new Error(
      "Could not establish the synthetic receipt-seeding session",
    );
  }
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  // The saved receipt deliberately outlives a display-name change and contains
  // non-ASCII text, exercising exact UTF-8 downloads and external verification.
  await db
    .prepare("UPDATE users SET discord_username=? WHERE id=?")
    .bind("Rehearsal Player · Zoë 雪", members.player.id)
    .run();
  try {
    for (const example of Object.values(receiptExamples)) {
      const response = await runtime.dispatchFetch(
        `${new URL(adminLink).origin}/api/admin/submissions?season=${season}&week=${example.week}`,
        { headers: { Cookie: cookie } },
      );
      if (!response.ok) {
        throw new Error("Could not load synthetic receipt details");
      }
      const data =
        /** @type {{submissions: import("../../src/shared/contracts").SubmissionDetail[]}} */ (
          await response.json()
        );
      const detail = data.submissions.find(
        (entry) => entry.submission.userId === example.userId,
      );
      if (!detail) {
        throw new Error("Synthetic receipt submission is missing");
      }
      await seedReceipt(db, detail, example.id);
    }
  } finally {
    await db
      .prepare("UPDATE users SET discord_username=? WHERE id=?")
      .bind(members.player.username, members.player.id)
      .run();
  }
}

/** Starts actual Vite output with Miniflare's native D1, Workflows and asset router.
 * Never loads Wrangler dev vars, dotenv, Rails credentials, or existing local state.
 * The owner MUST await close() in finally (serve.mjs also handles SIGINT/SIGTERM).
 * @param {{port?: number}} [options]
 * @returns {Promise<Rehearsal>}
 */
export async function startRehearsal({ port = 5180 } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Rehearsal port must be between 1024 and 65535");
  }
  const build = await loadBuild();
  const directory = await mkdtemp(join(tmpdir(), "nfl-pickem-rehearsal-"));
  const origin = `http://127.0.0.1:${port}`;
  const sessionSecret = randomBytes(48).toString("base64url");
  const linkSecret = randomBytes(48).toString("base64url");
  const upstreams = createUpstreams();
  /** @type {Miniflare | undefined} */
  let runtime;
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (runtime) {
          await runtime.dispose();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })());
  try {
    runtime = createRuntime(build, {
      directory,
      origin,
      port,
      sessionSecret,
      linkSecret,
      upstreams,
    });
    await runtime.ready;
    const db = await runtime.getD1Database("DB");
    await migrateDatabase(db);
    const { season, historicalSeason } = upstreams;
    await seedDatabase(db, season);
    const links = {
      player: submissionLink(origin, members.player, linkSecret, season),
      rival: submissionLink(origin, members.rival, linkSecret, season),
      admin: submissionLink(origin, members.admin, linkSecret, season),
      receipt: `${origin}/receipts/${receiptExamples.receipt.id}`,
      earlyWinnerReceipt: `${origin}/receipts/${receiptExamples.earlyWinnerReceipt.id}`,
    };
    await seedReceipts(db, runtime, links.admin, season);
    return {
      origin,
      directory,
      season,
      historicalSeason,
      links,
      db,
      upstreams,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
