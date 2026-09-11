import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { SeasonsData, SeasonWeek, Team } from "../shared/contracts";
import { errorMessage, RequestError, useResource } from "./api";

export const centralDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
export const centralDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "long",
  month: "long",
  day: "numeric",
});

export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) {
    return null;
  }
  return (
    <div role="alert" className="alert error">
      <p>
        {error instanceof RequestError && error.status === 403
          ? "Access denied. "
          : ""}
        {errorMessage(error)}
      </p>
      {error instanceof RequestError &&
        Object.keys(error.fields).length > 0 && (
          <ul className="mt-2 list-inside list-disc">
            {Object.entries(error.fields).map(([field, message]) => (
              <li key={field}>
                {field}: {message}
              </li>
            ))}
          </ul>
        )}
      {retry && (
        <button className="button secondary mt-3" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function ResourceView<T>({
  resource,
  children,
}: {
  resource: { loading: boolean; error?: unknown; data?: T; reload: () => void };
  children: (data: T) => ReactNode;
}) {
  if (resource.loading) {
    return (
      <p role="status" className="panel">
        Loading…
      </p>
    );
  }
  if (resource.error) {
    return <ErrorNotice error={resource.error} retry={resource.reload} />;
  }
  if (resource.data === undefined) {
    return null;
  }
  return children(resource.data);
}
export function PageHeading({
  title,
  season,
  week,
}: {
  title: string;
  season?: number;
  week?: number;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-center gap-3">
      <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
      {season !== undefined && <span className="badge">{season} season</span>}
      {week !== undefined && <span className="badge">Week {week}</span>}
    </header>
  );
}
export function periodQuery(params: URLSearchParams) {
  const query = new URLSearchParams();
  for (const name of ["season", "week"]) {
    const value = params.get(name);
    if (value) {
      query.set(name, value);
    }
  }
  return query.size ? `?${query}` : "";
}

export function useResolvedPeriod(
  period: { season: number; week: number | null } | undefined,
) {
  const [params, setParams] = useSearchParams();
  const season = period?.season;
  const week = period?.week === null ? null : period?.week?.toString();
  useEffect(() => {
    if (season === undefined || week === undefined) {
      return;
    }
    if (
      params.get("season") === String(season) &&
      params.get("week") === week
    ) {
      return;
    }
    const next = new URLSearchParams(params);
    next.set("season", String(season));
    if (week === null) {
      next.delete("week");
    } else {
      next.set("week", week);
    }
    setParams(next, { replace: true });
  }, [params, setParams, season, week]);
}

export function SeasonPicker({
  season,
  all = false,
}: {
  season?: number;
  all?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const resource = useResource<SeasonsData>("/api/seasons");
  return (
    <ResourceView resource={resource}>
      {(data) => (
        <label className="mb-5 flex items-center gap-3 font-medium">
          Season
          <select
            className="input w-auto"
            value={
              params.get("season") ?? season ?? (all ? "" : data.currentSeason)
            }
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value) {
                next.set("season", event.target.value);
              } else {
                next.delete("season");
              }
              setParams(next);
            }}
          >
            {all && <option value="">All seasons</option>}
            {data.seasons.map((year) => (
              <option key={year} value={year}>
                {year} season
              </option>
            ))}
          </select>
        </label>
      )}
    </ResourceView>
  );
}

export function WeekPicker({ season, week }: Partial<SeasonWeek>) {
  const [params, setParams] = useSearchParams();
  const value = params.get("week") ?? (week === undefined ? "" : String(week));
  const weeks = Array.from({ length: 18 }, (_, index) => index + 1);
  return (
    <div className="flex flex-wrap gap-x-5">
      <SeasonPicker season={season} />
      <label className="mb-5 flex items-center gap-3 font-medium">
        Week
        <select
          className="input w-auto"
          value={value}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            if (event.target.value) {
              next.set("week", event.target.value);
            } else {
              next.delete("week");
            }
            setParams(next);
          }}
        >
          <option value="">Current week</option>
          {weeks.map((item) => (
            <option key={item} value={item}>
              Week {item}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function TeamDisplay({ team }: { team: Team }) {
  return (
    <span className="inline-flex items-center gap-2">
      {team.logo && (
        <img
          className="h-6 w-6 object-contain"
          src={team.logo}
          alt=""
          loading="lazy"
        />
      )}
      <span title={team.name}>{team.abbreviation}</span>
      {team.score !== null && <strong>{team.score}</strong>}
    </span>
  );
}
export function ThemePicker() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("theme");
      return saved === "light" || saved === "dark" ? saved : "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "auto" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* Theme still works when browser storage is unavailable. */
    }
    return () => {
      media.removeEventListener("change", apply);
    };
  }, [theme]);
  return (
    <label className="flex items-center gap-2 text-sm">
      <svg
        aria-hidden="true"
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M20.4 15.4A9 9 0 018.6 3.6 9 9 0 1020.4 15.4Z" />
      </svg>
      <span className="sr-only">Theme</span>
      <select
        className="input w-auto"
        value={theme}
        onChange={(event) => {
          setTheme(event.target.value);
        }}
      >
        <option value="auto">System theme</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
