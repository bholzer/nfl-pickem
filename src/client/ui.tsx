import * as Select from "@radix-ui/react-select";
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  PublicStanding,
  SeasonsData,
  SeasonWeek,
  Team,
} from "../shared/contracts";
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
export const centralTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function PersonalStanding({
  standing,
  playerCount,
  hasResults,
}: {
  standing: Pick<PublicStanding, "rank" | "correctPicks" | "remainingCount">;
  playerCount: number;
  hasResults: boolean;
}) {
  return (
    <section className="standings-overview" aria-label="Your week at a glance">
      <div className="stat-card">
        <span className="stat-label">Your place</span>
        <strong className="stat-value">
          {hasResults ? `#${standing.rank}` : "—"}
        </strong>
        <span className="muted">
          {hasResults ? `of ${playerCount} players` : "Awaiting results"}
        </span>
      </div>
      <div className="stat-card">
        <span className="stat-label">Correct</span>
        <strong className="stat-value">{standing.correctPicks}</strong>
      </div>
      <div className="stat-card">
        <span className="stat-label">Picks left</span>
        <strong className="stat-value">{standing.remainingCount}</strong>
      </div>
    </section>
  );
}

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
      <div role="status" className="loading-state">
        <span className="loading-mark" aria-hidden="true" />
        <span>Loading…</span>
      </div>
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
  subtitle,
}: {
  title: string;
  season?: number;
  week?: number;
  subtitle?: string;
}) {
  return (
    <header className="page-heading">
      {(season !== undefined || week !== undefined) && (
        <p className="page-eyebrow">
          {season !== undefined && <span>{season} season</span>}
          {season !== undefined && week !== undefined && (
            <span aria-hidden="true" className="eyebrow-divider" />
          )}
          {week !== undefined && (
            <span>Week {String(week).padStart(2, "0")}</span>
          )}
        </p>
      )}
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
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

export function OptionPicker({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  // Radix reserves an empty value; prefixing keeps "Current" and "All" selectable.
  return (
    <Select.Root
      value={`option:${value}`}
      onValueChange={(next) => {
        onChange(next.slice(7));
      }}
      disabled={disabled}
    >
      <Select.Trigger
        id={id}
        className="input option-trigger"
        aria-label={label}
      >
        <Select.Value />
        <Select.Icon asChild>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Content
        className="option-menu"
        position="popper"
        sideOffset={6}
        collisionPadding={12}
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
        }}
      >
        <Select.Viewport className="option-viewport">
          {options.map((option) => (
            <Select.Item
              key={option.value}
              value={`option:${option.value}`}
              className="option-item"
            >
              <Select.ItemText>{option.label}</Select.ItemText>
              <Select.ItemIndicator className="option-check">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="m4 10 4 4 8-8" />
                </svg>
              </Select.ItemIndicator>
            </Select.Item>
          ))}
        </Select.Viewport>
      </Select.Content>
    </Select.Root>
  );
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
        <div className="period-select">
          <span>Season</span>
          <OptionPicker
            label="Season"
            value={String(
              params.get("season") ?? season ?? (all ? "" : data.currentSeason),
            )}
            onChange={(value) => {
              const next = new URLSearchParams(params);
              if (value) {
                next.set("season", value);
              } else {
                next.delete("season");
              }
              setParams(next);
            }}
            options={[
              ...(all ? [{ value: "", label: "All seasons" }] : []),
              ...data.seasons.map((year) => ({
                value: String(year),
                label: `${year} season`,
              })),
            ]}
          />
        </div>
      )}
    </ResourceView>
  );
}

export function WeekPicker({ season, week }: Partial<SeasonWeek>) {
  const [params, setParams] = useSearchParams();
  const value = params.get("week") ?? (week === undefined ? "" : String(week));
  const weeks = Array.from({ length: 18 }, (_, index) => index + 1);
  return (
    <div className="period-controls">
      <SeasonPicker season={season} />
      <div className="period-select">
        <span>Week</span>
        <OptionPicker
          label="Week"
          value={value}
          onChange={(nextWeek) => {
            const next = new URLSearchParams(params);
            if (nextWeek) {
              next.set("week", nextWeek);
            } else {
              next.delete("week");
            }
            setParams(next);
          }}
          options={[
            { value: "", label: "Current week" },
            ...weeks.map((item) => ({
              value: String(item),
              label: `Week ${item}`,
            })),
          ]}
        />
      </div>
    </div>
  );
}
export function TeamDisplay({
  team,
  fullName = false,
  showScore = true,
}: {
  team: Team;
  fullName?: boolean;
  showScore?: boolean;
}) {
  return (
    <span className="team-display">
      {team.logo && (
        <img className="team-logo" src={team.logo} alt="" loading="lazy" />
      )}
      <span className="team-name" title={team.name}>
        {fullName ? team.name : team.abbreviation}
      </span>
      {showScore && team.score !== null && (
        <strong className="team-score">{team.score}</strong>
      )}
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
    <div className="theme-picker">
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
      <OptionPicker
        label="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { value: "auto", label: "System theme" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
    </div>
  );
}
