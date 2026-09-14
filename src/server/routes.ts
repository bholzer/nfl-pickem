import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HonoRequest } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Picks, PublicReceipt, Scoreboard } from "../shared/contracts";
import { validSeason, validWeek } from "../shared/season";
import type { AppBindings } from "./env";
import { readSession, requireAdmin, requireCsrf, requireUser } from "./auth";
import {
  getSubmission,
  getSubmissionById,
  listSeasons,
  listUserSubmissions,
  listWeekSubmissions,
  saveSubmission,
} from "./db";
import { getFrozenReceipt, type FrozenReceipt } from "./receipts";
import { dashboard } from "./services/dashboard";
import { EspnError, fetchScoreboard, getSeasonContext } from "./services/espn";
import {
  calculateStandings,
  earliestGameTime,
  filterValidPicks,
  gamesStarted,
  publicStanding,
  showTiebreaker,
  submissionDetail,
} from "./services/scoring";
import { TokenConfigurationError } from "./tokens";

function parseWeek(raw: string | undefined, allowCurrent: false): number;
function parseWeek(
  raw: string | undefined,
  allowCurrent?: true,
): number | undefined;
function parseWeek(
  raw: string | undefined,
  allowCurrent = true,
): number | undefined {
  if (allowCurrent && (raw === undefined || raw === "current")) {
    return undefined;
  }
  if (!raw || !/^(?:[1-9]|1[0-8])$/.test(raw) || !validWeek(Number(raw))) {
    throw new HTTPException(400, {
      message: "Week must be an integer from 1 to 18",
    });
  }
  return Number(raw);
}

function parseSeason(raw: string | undefined, required: true): number;
function parseSeason(
  raw: string | undefined,
  required?: false,
): number | undefined;
function parseSeason(
  raw: string | undefined,
  required = false,
): number | undefined {
  if (raw === undefined && !required) {
    return undefined;
  }
  if (!raw || !/^\d{4}$/.test(raw) || !validSeason(Number(raw))) {
    throw new HTTPException(400, {
      message: "Season must be an integer from 1920 to 9999",
    });
  }
  return Number(raw);
}

function parseSubmissionId(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new HTTPException(400, { message: "Invalid submission ID" });
  }
  return Number(raw);
}

function validPicks(value: unknown): value is Picks {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.length <= 32 &&
    entries.every(
      ([game, team]: [string, unknown]) =>
        !!game &&
        game.length <= 128 &&
        typeof team === "string" &&
        !!team &&
        team.length <= 128,
    )
  );
}

function validTiebreaker(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type SubmissionInput =
  | { valid: true; picks: Picks; tiebreaker: number }
  | { valid: false; fields: Record<string, string> };

async function submissionInput(request: HonoRequest): Promise<SubmissionInput> {
  if (
    request.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new HTTPException(415, { message: "JSON content type required" });
  }
  let body: { picks?: unknown; tiebreaker?: unknown };
  try {
    const parsed = await request.json<unknown>();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    body = parsed;
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON object" });
  }
  return validateSubmission(body);
}

function validateSubmission(body: {
  picks?: unknown;
  tiebreaker?: unknown;
}): SubmissionInput {
  const fields: Record<string, string> = {};
  if (
    Object.keys(body).some((key) => key !== "picks" && key !== "tiebreaker")
  ) {
    fields.submission = "Only picks and tiebreaker are accepted";
  }
  const { picks, tiebreaker } = body;
  const picksValid = validPicks(picks);
  const tiebreakerValid = validTiebreaker(tiebreaker);
  if (!tiebreakerValid) {
    fields.tiebreaker = "Enter a nonnegative integer";
  }
  if (!picksValid) {
    fields.picks = "Choose at least one valid team";
  }
  if (picksValid && tiebreakerValid && Object.keys(fields).length === 0) {
    return { valid: true, picks, tiebreaker };
  }
  return { valid: false, fields };
}

function receiptBoardCovered(
  receipt: FrozenReceipt,
  scoreboard: Scoreboard,
): boolean {
  const currentGameIds = new Set(scoreboard.games.map((game) => game.id));
  return (
    currentGameIds.size > 0 &&
    receipt.gameIds.length > 0 &&
    receipt.gameIds.every((id) => currentGameIds.has(id))
  );
}

export const apiRoutes = new Hono<AppBindings>();
apiRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
apiRoutes.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof EspnError) {
    return c.json({ error: "Game data is temporarily unavailable" }, 502);
  }
  if (error instanceof TokenConfigurationError) {
    return c.json({ error: "Authentication is not configured" }, 503);
  }
  return c.json({ error: "Unable to complete the request" }, 500);
});

apiRoutes.get("/session", async (c) => {
  const session = await readSession(c);
  return c.json(session ?? { user: null, csrfToken: null });
});
apiRoutes.get("/receipts/:id", async (c) => {
  const id = c.req.param("id");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return c.json({ error: "Receipt not found" }, 404);
  }
  const receipt = await getFrozenReceipt(c.env.DB, id);
  if (!receipt?.originalMessageUrl) {
    return c.json({ error: "Receipt not found" }, 404);
  }
  const scoreboard = await fetchScoreboard(receipt);
  // A partial board cannot establish either winner eligibility or safe disclosure.
  if (!receiptBoardCovered(receipt, scoreboard)) {
    return c.json({ error: "Receipt not found" }, 404);
  }
  const standings = calculateStandings(
    await listWeekSubmissions(c.env.DB, receipt),
    scoreboard,
  );
  const winner = standings.some(
    (standing) =>
      standing.submissionId === receipt.submissionId && standing.winner,
  );
  if (!winner) {
    return c.json({ error: "Receipt not found" }, 404);
  }
  const result: PublicReceipt = {
    id: receipt.id,
    season: receipt.season,
    week: receipt.week,
    username: receipt.username,
    verificationHash: receipt.verificationHash,
    snapshotAt: receipt.snapshotAt,
    originalMessageUrl: receipt.originalMessageUrl,
    summary: receipt.summary,
  };
  return c.json(result);
});

apiRoutes.use("*", requireUser);

apiRoutes.get("/dashboard", async (c) =>
  c.json(await dashboard(c.env.DB, c.var.user.id)),
);

apiRoutes.get("/seasons", async (c) => {
  const [stored, current] = await Promise.all([
    listSeasons(c.env.DB),
    getSeasonContext(),
  ]);
  return c.json({
    currentSeason: current.season,
    seasons: [...new Set([...stored, current.season])].sort((a, b) => b - a),
  });
});

apiRoutes.get("/weeks/:week", async (c) => {
  const scoreboard = await fetchScoreboard({
    season: parseSeason(c.req.query("season")),
    week: parseWeek(c.req.param("week")),
  });
  const submission = await getSubmission(c.env.DB, c.var.user.id, scoreboard);
  return c.json({
    scoreboard,
    submission,
    locked: gamesStarted(scoreboard),
    earliestGameTime: earliestGameTime(scoreboard),
  });
});

apiRoutes.put(
  "/submissions/:week",
  requireCsrf,
  bodyLimit({
    maxSize: 16384,
    onError: (c) => c.json({ error: "Submission is too large" }, 413),
  }),
  async (c) => {
    const week = parseWeek(c.req.param("week"), false);
    const season = parseSeason(c.req.query("season"), true);
    const input = await submissionInput(c.req);
    if (!input.valid) {
      return c.json({ error: "Invalid submission", fields: input.fields }, 422);
    }
    const { picks, tiebreaker } = input;
    const scoreboard = await fetchScoreboard({ season, week });
    // One validated snapshot controls both the global edit lock and late-entry filtering.
    const locked = gamesStarted(scoreboard);
    if (locked && (await getSubmission(c.env.DB, c.var.user.id, scoreboard))) {
      return c.json(
        { error: "Cannot edit picks after games have started" },
        409,
      );
    }
    const games = new Map(scoreboard.games.map((game) => [game.id, game]));
    if (
      Object.entries(picks).some(([id, team]) => {
        const game = games.get(id);
        return (
          !game || (team !== game.homeTeam.id && team !== game.awayTeam.id)
        );
      })
    ) {
      return c.json(
        {
          error: "Invalid submission",
          fields: {
            picks: "Each pick must select a team playing in that week's game",
          },
        },
        422,
      );
    }
    const filtered = filterValidPicks(picks, scoreboard);
    if (Object.keys(filtered).length === 0) {
      return c.json(
        {
          error: "Invalid submission",
          fields: {
            picks: "Choose at least one team in a game that has not started",
          },
        },
        422,
      );
    }
    const submission = await saveSubmission(c.env.DB, {
      userId: c.var.user.id,
      season,
      week,
      picks: filtered,
      tiebreaker,
      locked,
    });
    // Atomic conflict protection also handles two concurrent late first submissions.
    if (!submission) {
      return c.json(
        { error: "Cannot edit picks after games have started" },
        409,
      );
    }
    return c.json({ submission });
  },
);

apiRoutes.get("/submissions", async (c) =>
  c.json({ submissions: await listUserSubmissions(c.env.DB, c.var.user.id) }),
);

apiRoutes.get("/submissions/:id", async (c) => {
  const submission = await getSubmissionById(
    c.env.DB,
    parseSubmissionId(c.req.param("id")),
  );
  if (!submission || submission.userId !== c.var.user.id) {
    return c.json({ error: "Submission not found" }, 404);
  }
  const scoreboard = await fetchScoreboard(submission);
  return c.json(await submissionDetail(submission, scoreboard));
});

apiRoutes.get("/standings", async (c) => {
  const scoreboard = await fetchScoreboard({
    season: parseSeason(c.req.query("season")),
    week: parseWeek(c.req.query("week")),
  });
  const submissions = await listWeekSubmissions(c.env.DB, scoreboard);
  const standings = calculateStandings(submissions, scoreboard);
  const displayTiebreaker = showTiebreaker(standings, scoreboard);
  const publicStandings = standings.map((standing) =>
    publicStanding(standing, displayTiebreaker),
  );
  return c.json({
    scoreboard,
    standings: publicStandings,
    showTiebreaker: displayTiebreaker,
  });
});

apiRoutes.get("/admin/submissions", requireAdmin, async (c) => {
  const scoreboard = await fetchScoreboard({
    season: parseSeason(c.req.query("season")),
    week: parseWeek(c.req.query("week")),
  });
  const submissions = await Promise.all(
    (await listWeekSubmissions(c.env.DB, scoreboard)).map((submission) =>
      submissionDetail(submission, scoreboard),
    ),
  );
  submissions.sort(
    (a, b) =>
      b.correctPicks - a.correctPicks || a.submission.id - b.submission.id,
  );
  return c.json({ scoreboard, submissions });
});

apiRoutes.get("/admin/submissions/:id", requireAdmin, async (c) => {
  const submission = await getSubmissionById(
    c.env.DB,
    parseSubmissionId(c.req.param("id")),
  );
  if (!submission) {
    return c.json({ error: "Submission not found" }, 404);
  }
  return c.json(
    await submissionDetail(submission, await fetchScoreboard(submission)),
  );
});
