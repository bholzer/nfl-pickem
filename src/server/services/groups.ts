import type { Scoreboard } from "../../shared/contracts";

const centralTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});

export function centralCalendar(date: string): { day: string; hour: number } {
  const parts = centralTime.formatToParts(new Date(date));
  const day = parts.find((part) => part.type === "weekday");
  const hour = parts.find((part) => part.type === "hour");
  if (!day || !hour) {
    throw new Error("Central calendar fields are unavailable");
  }
  return { day: day.value, hour: Number(hour.value) };
}

function broadcastGroups(day: string, hour: number): string[] {
  if (day === "Thu") {
    return ["thursday"];
  }
  if (day === "Mon") {
    return ["monday"];
  }
  if (day !== "Sun") {
    return [];
  }
  if (hour < 14) {
    return ["sunday_early"];
  }
  // Rails intentionally includes the 17:00 hour in both broadcast windows.
  if (hour === 17) {
    return ["sunday_late", "sunday_night"];
  }
  return [hour < 17 ? "sunday_late" : "sunday_night"];
}

export function completedGroups(scoreboard: Scoreboard): string[] {
  const groups: Record<string, boolean> = {};
  for (const game of scoreboard.games) {
    const { day, hour } = centralCalendar(game.date);
    for (const name of broadcastGroups(day, hour)) {
      groups[name] = (groups[name] ?? true) && game.status === "STATUS_FINAL";
    }
  }
  return Object.keys(groups)
    .filter((name) => groups[name])
    .sort();
}
