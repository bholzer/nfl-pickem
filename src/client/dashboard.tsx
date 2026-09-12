import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  DashboardData,
  DashboardRecap,
  DashboardWeek,
  PickDetail,
} from "../shared/contracts";
import { useResource, useSession } from "./api";
import { loadDraft } from "./drafts";
import { PickOutcomeKey, SubmissionPickList } from "./submission-picks";
import {
  centralDate,
  centralDay,
  centralTime,
  ErrorNotice,
  PageHeading,
  PersonalStanding,
  ResourceView,
  useResolvedPeriod,
} from "./ui";

const liveStatuses: Record<string, true | undefined> = {
  STATUS_IN_PROGRESS: true,
  STATUS_HALFTIME: true,
  STATUS_END_PERIOD: true,
  STATUS_OVERTIME: true,
};

function futureKickoffs(data: DashboardWeek, now: number) {
  return data.scoreboard.games
    .filter((game) => game.status === "STATUS_SCHEDULED")
    .map((game) => Date.parse(game.date))
    .filter((time) => time > now);
}

function refreshDelay(data: DashboardData, now: number) {
  const current = data.current;
  if (!current) {
    return 300_000;
  }
  const interval = current.scoreboard.games.some(
    (game) => liveStatuses[game.status],
  )
    ? 60_000
    : 300_000;
  const next = Math.min(...futureKickoffs(current, now));
  return Math.min(interval, next - now);
}

function useDashboardRefresh(
  data: DashboardData | undefined,
  busy: boolean,
  reload: () => void,
) {
  const [now, setNow] = useState(Date.now);
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const pending = useRef(busy);
  const lastRequested = useRef(0);
  useEffect(() => {
    pending.current = busy;
  }, [busy]);
  const refresh = useCallback(() => {
    const time = Date.now();
    setNow(time);
    if (
      document.visibilityState === "hidden" ||
      pending.current ||
      time - lastRequested.current < 1_000
    ) {
      return;
    }
    pending.current = true;
    lastRequested.current = time;
    reload();
  }, [reload]);
  useEffect(() => {
    const onVisibility = () => {
      const active = document.visibilityState !== "hidden";
      setVisible(active);
      if (active) {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (!data || !visible) {
      return;
    }
    const timer = window.setTimeout(
      refresh,
      Math.max(1, refreshDelay(data, Date.now())),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [data, now, visible, refresh]);
  return { now: Math.max(now, Date.now()), refresh };
}

function pickTime(pick: PickDetail) {
  const time = Date.parse(pick.game?.date ?? "");
  return Number.isFinite(time) ? time : 0;
}

function oldestFirst(left: PickDetail, right: PickDetail) {
  return (
    pickTime(left) - pickTime(right) ||
    left.competitionId.localeCompare(right.competitionId)
  );
}

function pickGroup(pick: PickDetail, now: number) {
  const game = pick.game;
  if (!game) {
    return "other";
  }
  if (liveStatuses[game.status]) {
    return "live";
  }
  if (game.status === "STATUS_FINAL") {
    return "final";
  }
  if (game.status === "STATUS_SCHEDULED" && pickTime(pick) > now) {
    return "next";
  }
  return "other";
}

function groupPicks(picks: PickDetail[], now: number) {
  const groups: Record<"live" | "next" | "final" | "other", PickDetail[]> = {
    live: [],
    next: [],
    final: [],
    other: [],
  };
  for (const pick of picks) {
    groups[pickGroup(pick, now)].push(pick);
  }
  groups.live.sort(oldestFirst);
  groups.next.sort(oldestFirst);
  groups.other.sort(oldestFirst);
  groups.final.sort(
    (left, right) =>
      pickTime(right) - pickTime(left) ||
      left.competitionId.localeCompare(right.competitionId),
  );
  const nextTime = groups.next[0] ? pickTime(groups.next[0]) : null;
  groups.next = groups.next.filter((pick) => pickTime(pick) === nextTime);
  groups.final = groups.final.slice(0, 3);
  return groups;
}

function DashboardPicks({ data, now }: { data: DashboardWeek; now: number }) {
  const groups = groupPicks(data.picks, now);
  const sections = [
    { title: "Live now", picks: groups.live },
    { title: "Next kickoff", picks: groups.next },
    { title: "Recent finals", picks: groups.final },
    { title: "Other game statuses", picks: groups.other },
  ].filter((section) => section.picks.length > 0);
  return (
    <div className="space-y-6">
      {sections.length > 0 && <PickOutcomeKey />}
      {sections.map(({ title, picks }) => (
        <section key={title} aria-label={title}>
          <h2 className="mb-3 text-xl">{title}</h2>
          {title === "Other game statuses" && (
            <p className="muted mb-3">
              Delayed, changed, or unavailable game information. These picks are
              not marked live.
            </p>
          )}
          <SubmissionPickList picks={picks} compact showStatus />
        </section>
      ))}
      {data.submission && (
        <Link className="text-link" to={`/submissions/${data.submission.id}`}>
          View all your picks
        </Link>
      )}
    </div>
  );
}

function currentAction(data: DashboardWeek, now: number) {
  const eligible = futureKickoffs(data, now);
  const count = Math.min(eligible.length, data.action.eligibleGames);
  if (data.submission) {
    const boundaryPassed =
      data.action.deadline !== null && Date.parse(data.action.deadline) <= now;
    const locked =
      data.action.kind !== "review" ||
      data.locked ||
      boundaryPassed ||
      eligible.length !== data.scoreboard.games.length;
    return { kind: locked ? "locked" : "review", count } as const;
  }
  return { kind: count > 0 ? "make" : "closed", count } as const;
}

function actionCopy(kind: DashboardWeek["action"]["kind"], draft: boolean) {
  if (kind === "make") {
    return draft
      ? {
          status: "Draft saved on this device · Not submitted",
          label: "Continue picks",
        }
      : {
          status: "You haven't submitted picks for this week.",
          label: "Make picks",
        };
  }
  if (kind === "review") {
    return draft
      ? {
          status: "Submitted · Changes saved on this device, not submitted",
          label: "Continue editing",
        }
      : {
          status: "Submitted · You can still update your picks",
          label: "Review / edit picks",
        };
  }
  return {
    status:
      kind === "locked"
        ? "Submitted · Picks locked"
        : "Picks are closed for this week.",
    label: null,
  };
}

function DashboardAction({ data, now }: { data: DashboardWeek; now: number }) {
  const { user } = useSession();
  const action = currentAction(data, now);
  const draft = user ? loadDraft(user.id, data, now) : null;
  const copy = actionCopy(action.kind, Boolean(draft));
  const editable = action.kind === "make" || action.kind === "review";
  const deadline = Math.min(...futureKickoffs(data, now));
  const lateEntry =
    action.kind === "make" && action.count < data.scoreboard.games.length;
  return (
    <div
      className={
        editable
          ? "page-toolbar border-y border-[var(--line)] py-4"
          : "page-toolbar muted"
      }
    >
      <div className="space-y-1">
        <p className="font-medium">{copy.status}</p>
        {editable && Number.isFinite(deadline) && (
          <p className="muted">
            {action.kind === "review" ? "Updates close" : "Next deadline"}{" "}
            {centralDate.format(deadline)}
          </p>
        )}
        {lateEntry && (
          <p className="muted">
            Late entry: {action.count} remaining games available to pick.
          </p>
        )}
      </div>
      {copy.label && (
        <Link
          className="button primary"
          to={`/submissions/new?season=${data.scoreboard.season}&week=${data.scoreboard.week}`}
        >
          {copy.label}
        </Link>
      )}
    </div>
  );
}

function CurrentWeek({ data, now }: { data: DashboardWeek; now: number }) {
  const games = data.scoreboard.games;
  const completed = games.filter(
    (game) => game.status === "STATUS_FINAL",
  ).length;
  const complete = games.length > 0 && completed === games.length;
  return (
    <div className="space-y-6">
      <DashboardAction data={data} now={now} />
      {data.standing && (
        <PersonalStanding
          standing={data.standing}
          playerCount={data.playerCount}
          hasResults={completed > 0}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted">
          <strong className="text-[var(--ink)]">
            {complete ? "Final weekly result" : "Weekly result pending"}
          </strong>
          {" · "}
          {completed} of {games.length} games final
        </p>
        <Link
          className="text-link"
          to={`/standings?season=${data.scoreboard.season}&week=${data.scoreboard.week}`}
        >
          Full standings
        </Link>
      </div>
      {games.length === 0 && (
        <p className="muted">This week's schedule is not available yet.</p>
      )}
      <DashboardPicks data={data} now={now} />
    </div>
  );
}

function PreviousWeek({ recap }: { recap: DashboardRecap }) {
  return (
    <section
      className="space-y-3 border-t border-[var(--line)] pt-6"
      aria-label="Previous week"
    >
      <h2 className="text-xl">Week {recap.week} recap</h2>
      <p className="muted">
        {recap.season} season ·{" "}
        {recap.complete ? "Final result" : "Result pending"}
      </p>
      <p>
        {recap.hasResults
          ? `#${recap.standing.rank} of ${recap.playerCount} players · `
          : "Place pending · "}
        {recap.standing.correctPicks} correct · {recap.standing.remainingCount}{" "}
        picks left
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <Link className="text-link" to={`/submissions/${recap.submissionId}`}>
          Your week {recap.week} picks
        </Link>
        <Link
          className="text-link"
          to={`/standings?season=${recap.season}&week=${recap.week}`}
        >
          Week {recap.week} standings
        </Link>
      </div>
    </section>
  );
}

const phaseMessages = {
  preseason:
    "The regular season hasn't started. Your weekly picks will appear here when it begins.",
  regular: "The current week is not available yet.",
  postseason:
    "The regular season is complete. There are no new weekly picks during the postseason.",
  offseason:
    "It's the offseason. Your next weekly picks will appear when the regular season begins.",
};

function DashboardContent({
  data,
  now,
  error,
  refreshing,
  refresh,
}: {
  data: DashboardData;
  now: number;
  error: unknown;
  refreshing: boolean;
  refresh: () => void;
}) {
  const checkedAt = new Date(data.checkedAt);
  const checkedToday =
    now - checkedAt.getTime() < 86_400_000 &&
    centralDay.format(checkedAt) === centralDay.format(now);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted" role="status">
          <span className="sr-only">
            {refreshing ? "Checking for updates. " : ""}
          </span>
          Last checked{" "}
          <time dateTime={data.checkedAt} title={centralDate.format(checkedAt)}>
            {checkedToday
              ? centralTime.format(checkedAt)
              : centralDate.format(checkedAt)}
          </time>
        </p>
        <button
          className="button secondary"
          onClick={refresh}
          disabled={refreshing}
        >
          Refresh
        </button>
      </div>
      {Boolean(error) && (
        <div className="space-y-2">
          <p className="muted">
            Updates are unavailable. Showing the last checked results; they may
            be out of date.
          </p>
          <ErrorNotice error={error} />
        </div>
      )}
      {data.current ? (
        <CurrentWeek data={data.current} now={now} />
      ) : (
        <p className="muted">{phaseMessages[data.phase]}</p>
      )}
      {data.previous && <PreviousWeek recap={data.previous} />}
    </div>
  );
}

export function DashboardPage() {
  const resource = useResource<DashboardData>("/api/dashboard", {
    retainDataOnReload: true,
  });
  const data = resource.data;
  const period = data?.current?.scoreboard;
  const { now, refresh } = useDashboardRefresh(
    data,
    resource.loading || resource.refreshing,
    resource.reload,
  );
  useResolvedPeriod(period);
  return (
    <>
      <PageHeading
        title="Your week"
        season={data?.season}
        week={period?.week}
      />
      {!data ? (
        <ResourceView resource={resource}>{() => null}</ResourceView>
      ) : (
        <DashboardContent
          data={data}
          now={now}
          error={resource.error}
          refreshing={resource.refreshing}
          refresh={refresh}
        />
      )}
    </>
  );
}
