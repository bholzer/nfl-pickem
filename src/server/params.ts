import { HTTPException } from "hono/http-exception";
import { validSeason } from "../shared/season";

export function parseSeason(raw: string | undefined, required: true): number;
export function parseSeason(
  raw: string | undefined,
  required?: false,
): number | undefined;
export function parseSeason(
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
