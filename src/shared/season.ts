export function validSeason(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1920 &&
    value <= 9999
  );
}

export function validWeek(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 18
  );
}

/** Calendar fallback for archived records and scheduled-event timestamps. */
export function seasonForDate(date: Date): number {
  return date.getUTCFullYear() - (date.getUTCMonth() < 2 ? 1 : 0);
}
