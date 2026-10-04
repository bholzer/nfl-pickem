import type { Scoreboard, SeasonWeek } from "../../shared/contracts";
import type { Env } from "../env";
import { getScoreboardSnapshot, saveScoreboardSnapshot } from "../db";
import { fetchScoreboard } from "./espn";
import { scoreboardComplete } from "./scoring";

/**
 * Serves a frozen final board when one exists; otherwise reads ESPN live and
 * freezes the board once every game is final. Maintenance mode fences the write.
 */
export async function loadScoreboard(
  env: Pick<Env, "DB" | "MAINTENANCE_MODE">,
  period: SeasonWeek,
): Promise<Scoreboard> {
  const stored = await getScoreboardSnapshot(env.DB, period);
  if (stored) {
    return stored;
  }
  const scoreboard = await fetchScoreboard(period);
  if (scoreboardComplete(scoreboard) && env.MAINTENANCE_MODE !== "true") {
    await saveScoreboardSnapshot(env.DB, scoreboard);
  }
  return scoreboard;
}
