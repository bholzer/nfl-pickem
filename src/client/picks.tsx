import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type FocusEvent,
  type SubmitEvent,
} from "react";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type {
  Picks,
  Scoreboard,
  StandingsData,
  Submission,
  SubmissionDetail,
  WeekData,
} from "../shared/contracts";
import { RequestError, useMutation, useResource, useSession } from "./api";
import {
  clearDraft,
  loadDraft,
  saveDraft,
  submissionRevision,
  type DraftEdits,
  type DraftSave,
} from "./drafts";
import {
  centralDate,
  centralDay,
  ErrorNotice,
  PageHeading,
  periodQuery,
  ResourceView,
  SeasonPicker,
  TeamDisplay,
  useResolvedPeriod,
  WeekPicker,
} from "./ui";

export function PicksPage({ landing }: { landing?: boolean }) {
  const [params] = useSearchParams();
  const { user } = useSession();
  const week = params.get("week") ?? "current";
  const season = params.get("season");
  const resource = useResource<WeekData>(
    `/api/weeks/${encodeURIComponent(week)}${season ? `?season=${encodeURIComponent(season)}` : ""}`,
  );
  const period = resource.data?.scoreboard;
  const redirect = landing && Boolean(resource.data?.submission);
  useResolvedPeriod(redirect ? undefined : period);
  if (redirect && period) {
    return (
      <Navigate
        replace
        to={`/standings?season=${period.season}&week=${period.week}`}
      />
    );
  }
  return (
    <>
      <PageHeading
        title="Make your picks"
        subtitle="Make your call. One choice per game."
        {...period}
      />
      <div className="page-toolbar">
        <WeekPicker {...period} />
      </div>
      <ResourceView resource={resource}>
        {(data) => (
          <PicksForm
            key={`${user?.id}-${data.scoreboard.season}-${data.scoreboard.week}-${submissionRevision(data)}`}
            data={data}
          />
        )}
      </ResourceView>
    </>
  );
}
type Game = WeekData["scoreboard"]["games"][number];
const gameTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function groupGamesByDay(games: Game[]) {
  const days = new Map<string, Game[]>();
  for (const game of games) {
    const day = centralDay.format(new Date(game.date));
    const group = days.get(day);
    if (group) {
      group.push(game);
    } else {
      days.set(day, [game]);
    }
  }
  return days;
}

interface PickValidation {
  message: string;
  target: string;
}

function validatePicks(
  eligible: Game[],
  picks: Picks,
  tiebreaker: string,
): PickValidation | null {
  const missing = eligible.find((game) => !picks[game.id]);
  if (missing) {
    return {
      message: `Choose a team for ${missing.name}.`,
      target: `pick-${missing.id}-away`,
    };
  }
  if (!eligible.length) {
    return {
      message: "All games have started. No picks can be submitted.",
      target: "pick-validation",
    };
  }
  if (
    tiebreaker.trim() === "" ||
    !Number.isSafeInteger(Number(tiebreaker)) ||
    Number(tiebreaker) < 0
  ) {
    return {
      message: "Enter a whole, nonnegative Monday night point total.",
      target: "tiebreaker",
    };
  }
  return null;
}

type DraftFeedback =
  | DraftSave
  | { status: "restored"; expiresAt: number }
  | { status: "expired"; expiresAt: null };

function useDraftEdits(data: WeekData, now: number, locked: boolean) {
  const { user } = useSession();
  const [initial] = useState(() =>
    user ? loadDraft(user.id, data, Date.now()) : null,
  );
  const [edits, setEdits] = useState<DraftEdits>(() => ({
    picks: { ...data.submission?.picks, ...initial?.picks },
    tiebreaker:
      initial?.tiebreaker ??
      (data.submission ? String(data.submission.tiebreaker) : ""),
  }));
  const [feedback, setFeedback] = useState<DraftFeedback>(() =>
    initial
      ? { status: "restored", expiresAt: initial.expiresAt }
      : { status: "empty", expiresAt: null },
  );
  const expiry = feedback.expiresAt;
  useEffect(() => {
    if (expiry === null || (!locked && now < expiry) || !user) {
      return;
    }
    clearDraft(user.id, data);
    setFeedback({ status: "expired", expiresAt: null });
  }, [data, expiry, locked, now, user]);

  function update(next: DraftEdits) {
    setEdits(next);
    setFeedback(
      user
        ? saveDraft(user.id, data, next, Date.now())
        : { status: "unavailable", expiresAt: null },
    );
  }
  function clear() {
    if (user) {
      clearDraft(user.id, data);
    }
    setFeedback({ status: "empty", expiresAt: null });
  }
  return { edits, feedback, update, clear };
}

function usePicksForm(data: WeekData) {
  const [validation, setValidation] = useState<PickValidation | null>(null);
  const [now, setNow] = useState(Date.now);
  const mutation = useMutation();
  const started = (game: Game) =>
    game.status !== "STATUS_SCHEDULED" || new Date(game.date).getTime() <= now;
  const gamesLocked = data.locked || data.scoreboard.games.some(started);
  const locked =
    Boolean(data.submission && gamesLocked) ||
    (mutation.error instanceof RequestError && mutation.error.status === 409);
  const draft = useDraftEdits(data, now, locked);
  const { picks, tiebreaker } = draft.edits;
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const games = useMemo(
    () =>
      [...data.scoreboard.games].sort(
        (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
      ),
    [data.scoreboard.games],
  );
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || mutation.pending) {
      return;
    }
    const error = validatePicks(
      games.filter(
        (game) =>
          game.status === "STATUS_SCHEDULED" &&
          Date.parse(game.date) > Date.now(),
      ),
      picks,
      tiebreaker,
    );
    setValidation(error);
    if (error) {
      const target = document.getElementById(error.target);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "center" });
      return;
    }
    const result = await mutation.mutate<{ submission: Submission }>(
      `/api/submissions/${data.scoreboard.week}?season=${data.scoreboard.season}`,
      "PUT",
      { picks, tiebreaker: Number(tiebreaker) },
    );
    if (result?.ok) {
      draft.clear();
      await navigate(
        `/submissions/${result.data.submission.id}?season=${result.data.submission.season}&week=${result.data.submission.week}`,
        { state: { saved: true } },
      );
    }
  }
  function selectTeam(gameId: string, teamId: string) {
    draft.update({ picks: { ...picks, [gameId]: teamId }, tiebreaker });
    setValidation(null);
  }
  function setTiebreaker(value: string) {
    draft.update({ picks, tiebreaker: value });
    setValidation(null);
  }
  return {
    picks,
    tiebreaker,
    setTiebreaker,
    validation,
    mutation,
    started,
    gamesLocked,
    locked,
    games,
    submit,
    selectTeam,
    draft: draft.feedback,
  };
}

function PicksLockNotice({
  locked,
  gamesLocked,
  earliestGameTime,
}: {
  locked: boolean;
  gamesLocked: boolean;
  earliestGameTime: WeekData["earliestGameTime"];
}) {
  if (locked) {
    return (
      <p className="alert warning">
        Your picks are locked because games have started. You can still view
        your selections.
      </p>
    );
  }
  if (gamesLocked) {
    return (
      <p className="alert warning">
        Late submission: only games that have not kicked off can be picked.
      </p>
    );
  }
  return (
    earliestGameTime && (
      <p className="pick-deadline">
        Picks close {centralDate.format(new Date(earliestGameTime))}
      </p>
    )
  );
}

function GamePick({
  game,
  selectedTeamId,
  disabled,
  started,
  onSelect,
  invalid,
}: {
  game: Game;
  selectedTeamId: string | undefined;
  disabled: boolean;
  started: boolean;
  onSelect: (gameId: string, teamId: string) => void;
  invalid: boolean;
}) {
  return (
    <fieldset
      disabled={disabled}
      className={`game-pick ${started ? "locked" : ""}`}
    >
      <legend className="sr-only">{game.name}</legend>
      <div className="game-meta">
        <time
          dateTime={game.date}
          title={centralDate.format(new Date(game.date))}
        >
          {gameTime.format(new Date(game.date))}
        </time>
        <span>
          {started
            ? `Locked · ${game.statusDetail || "Started"}`
            : game.statusDetail || "Upcoming"}
        </span>
      </div>
      <div className="game-teams">
        {[game.awayTeam, game.homeTeam].map((team, index) => (
          <div key={team.id} className="contents">
            {index === 1 && (
              <span className="muted">{game.neutralSite ? "vs" : "@"}</span>
            )}
            <label
              className={`team-choice ${index === 0 ? "team-away" : "team-home"} ${selectedTeamId === team.id ? "selected" : ""}`}
            >
              <input
                id={`pick-${game.id}-${index === 0 ? "away" : "home"}`}
                type="radio"
                name={`pick-${game.id}`}
                value={team.id}
                checked={selectedTeamId === team.id}
                onChange={() => {
                  onSelect(game.id, team.id);
                }}
                aria-label={`${team.name} for ${game.name}`}
                aria-invalid={invalid}
                aria-describedby={invalid ? "pick-validation" : undefined}
              />
              <TeamDisplay team={team} fullName showScore={started} />
            </label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function TiebreakerField({
  value,
  disabled,
  error,
  invalid,
  onChange,
}: {
  value: string;
  disabled: boolean;
  error: unknown;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="panel">
      <label htmlFor="tiebreaker" className="block font-semibold">
        Monday night tiebreaker
      </label>
      <p id="tiebreaker-help" className="muted my-2">
        Total combined points in Monday Night Football. Used only to settle a
        tie in the final results.
      </p>
      <input
        id="tiebreaker"
        className="input w-32"
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        required
        disabled={disabled}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        aria-describedby={
          invalid ? "tiebreaker-help pick-validation" : "tiebreaker-help"
        }
        aria-invalid={
          invalid ||
          (error instanceof RequestError && Boolean(error.fields.tiebreaker))
        }
      />
    </div>
  );
}

function DraftStatus({ draft }: { draft: DraftFeedback }) {
  const messages = {
    empty: "Picks are only entered when you submit.",
    saved: "Draft saved on this device. Not submitted yet.",
    restored: "Draft restored from this device. Review and submit.",
    unavailable:
      "Draft could not be saved on this device. Keep this page open until you submit.",
    expired: "The saved draft expired. Review the games still open.",
  };
  return (
    <p className="draft-status" role="status">
      {messages[draft.status]}
    </p>
  );
}

function SubmissionDock({
  locked,
  pending,
  draft,
  data,
  selected,
  total,
}: {
  locked: boolean;
  pending: boolean;
  draft: DraftFeedback;
  data: WeekData;
  selected: number;
  total: number;
}) {
  const submitLabel = data.submission ? "Update picks" : "Submit picks";
  return (
    <div className="submission-dock">
      <div className="submission-dock-status">
        <PicksProgress locked={locked} selected={selected} total={total} />
        {!locked && <DraftStatus draft={draft} />}
      </div>
      {locked ? (
        <Link
          className="button secondary"
          to={`/standings?season=${data.scoreboard.season}&week=${data.scoreboard.week}`}
        >
          View standings
        </Link>
      ) : (
        <button
          className="button primary"
          disabled={pending || !total}
          type="submit"
        >
          {pending ? "Saving picks…" : submitLabel}
        </button>
      )}
    </div>
  );
}

function PicksProgress({
  locked,
  selected,
  total,
}: {
  locked: boolean;
  selected: number;
  total: number;
}) {
  return (
    <div className="picks-progress">
      <strong>
        {locked ? "Picks locked · " : ""}
        {selected} of {total} {locked ? "games picked" : "picks ready"}
      </strong>
      <progress
        aria-label="Pick progress"
        value={selected}
        max={Math.max(total, 1)}
      />
    </div>
  );
}

function revealFocusedPick(event: FocusEvent<HTMLFormElement>) {
  const field = event.target;
  if (
    !(field instanceof HTMLInputElement) ||
    !field.matches(":focus-visible")
  ) {
    return;
  }
  const dock = event.currentTarget.querySelector(".submission-dock");
  if (
    dock &&
    field.getBoundingClientRect().bottom > dock.getBoundingClientRect().top
  ) {
    field.scrollIntoView({ block: "center" });
  }
}

function PicksForm({ data }: { data: WeekData }) {
  const form = usePicksForm(data);
  const disabled = form.locked || form.mutation.pending;
  const eligible = form.games.filter((game) => !form.started(game));
  const progressGames = form.locked ? form.games : eligible;
  const selected = progressGames.filter((game) => form.picks[game.id]).length;
  const groups = useMemo(() => groupGamesByDay(form.games), [form.games]);
  if (!form.games.length) {
    return (
      <div className="panel empty-state">
        <h2>No games on the board yet</h2>
        <p>
          Check back for {data.scoreboard.season} season, Week{" "}
          {data.scoreboard.week}.
        </p>
      </div>
    );
  }
  return (
    <form
      onFocusCapture={revealFocusedPick}
      onSubmit={(event) => {
        void form.submit(event);
      }}
      className="picks-form"
      noValidate
    >
      <div className="picks-intro">
        <PicksLockNotice
          locked={form.locked}
          gamesLocked={form.gamesLocked}
          earliestGameTime={data.earliestGameTime}
        />
      </div>
      <div className="picks-grid">
        {[...groups].map(([day, dayGames]) => (
          <section key={day} className="game-group">
            <h2 className="game-group-heading">
              {day}
              <span>
                {dayGames.length} {dayGames.length === 1 ? "game" : "games"}
              </span>
            </h2>
            <div className="panel p-0">
              {dayGames.map((game) => (
                <GamePick
                  key={game.id}
                  game={game}
                  selectedTeamId={form.picks[game.id]}
                  disabled={disabled || form.started(game)}
                  started={form.started(game)}
                  onSelect={form.selectTeam}
                  invalid={form.validation?.target === `pick-${game.id}-away`}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <TiebreakerField
        value={form.tiebreaker}
        disabled={disabled || !eligible.length}
        error={form.mutation.error}
        invalid={form.validation?.target === "tiebreaker"}
        onChange={form.setTiebreaker}
      />
      <div id="pick-validation" tabIndex={-1}>
        {form.validation && (
          <p role="alert" className="alert error">
            {form.validation.message}
          </p>
        )}
      </div>
      <ErrorNotice error={form.mutation.error} />
      <SubmissionDock
        locked={form.locked}
        pending={form.mutation.pending}
        draft={form.draft}
        data={data}
        selected={selected}
        total={progressGames.length}
      />
    </form>
  );
}

export function HistoryPage() {
  const [params] = useSearchParams();
  const season = params.get("season");
  const resource = useResource<{ submissions: Submission[] }>(
    "/api/submissions",
  );
  return (
    <>
      <PageHeading title="My submissions" />
      <div className="page-toolbar">
        <SeasonPicker all />
        <Link
          className="button primary"
          to={`/submissions/new${periodQuery(params)}`}
        >
          Make picks
        </Link>
      </div>
      <ResourceView resource={resource}>
        {({ submissions }) => {
          const visible = submissions.filter(
            (submission) => !season || submission.season === Number(season),
          );
          return visible.length ? (
            <ul className="panel submission-list">
              {visible.map((submission) => (
                <li key={submission.id} className="submission-list-row">
                  <div>
                    <h2 className="font-semibold">
                      {submission.season} season · Week {submission.week}
                    </h2>
                    <p className="muted">
                      {centralDate.format(new Date(submission.createdAt))} ·
                      Tiebreaker: {submission.tiebreaker}
                    </p>
                  </div>
                  <Link
                    className="button secondary"
                    to={`/submissions/${submission.id}?season=${submission.season}&week=${submission.week}`}
                  >
                    View {submission.season} Week {submission.week}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel">No submissions for this selection.</p>
          );
        }}
      </ResourceView>
    </>
  );
}

export function SubmissionPage({ admin = false }: { admin?: boolean }) {
  const { id = "" } = useParams();
  const resource = useResource<SubmissionDetail>(
    `/api/${admin ? "admin/" : ""}submissions/${encodeURIComponent(id)}`,
  );
  useResolvedPeriod(resource.data?.submission);
  return (
    <ResourceView resource={resource}>
      {(detail) => <SubmissionView detail={detail} admin={admin} />}
    </ResourceView>
  );
}
function SubmissionView({
  detail,
  admin,
}: {
  detail: SubmissionDetail;
  admin: boolean;
}) {
  const { submission } = detail;
  const [view, setView] = useState<"compact" | "detailed">(() => {
    try {
      return localStorage.getItem("submission-view") === "detailed"
        ? "detailed"
        : "compact";
    } catch {
      return "compact";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("submission-view", view);
    } catch {
      /* The view switch still works when browser storage is unavailable. */
    }
  }, [view]);
  const compact = view === "compact";
  return (
    <div className={`submission-detail ${compact ? "submission-compact" : ""}`}>
      <PageHeading
        title={admin ? "Player picks" : "Your picks"}
        season={submission.season}
        week={submission.week}
      />
      <p className="muted submission-player">
        {submission.user.username ?? "Pool member"}
      </p>
      <dl className="panel submission-summary">
        <div className="stat-card">
          <dt className="stat-label">Correct picks</dt>
          <dd className="stat-value">{detail.correctPicks}</dd>
        </div>
        <div className="stat-card">
          <dt className="stat-label">Tiebreaker</dt>
          <dd className="stat-value">{submission.tiebreaker}</dd>
        </div>
      </dl>
      <div className="submission-view-toolbar">
        <p className="muted">{detail.picks.length} picks</p>
        <div
          className="submission-view-switch"
          role="group"
          aria-label="Pick display"
        >
          <button
            type="button"
            className="button secondary"
            aria-pressed={compact}
            onClick={() => {
              setView("compact");
            }}
          >
            Compact
          </button>
          <button
            type="button"
            className="button secondary"
            aria-pressed={!compact}
            onClick={() => {
              setView("detailed");
            }}
          >
            Detailed
          </button>
        </div>
      </div>
      {compact && (
        <div
          className="submission-result-key"
          role="group"
          aria-label="Pick outcomes"
        >
          {pickOutcomeOptions.map((presentation) => (
            <SubmissionOutcome
              key={presentation.result}
              presentation={presentation}
              game={null}
              compact={false}
            />
          ))}
        </div>
      )}
      <ul className="panel submission-list">
        {detail.picks.map((pick) => (
          <SubmissionPick
            key={pick.competitionId}
            pick={pick}
            compact={compact}
          />
        ))}
      </ul>
      <section className="panel submission-verification">
        <h2 className="mb-3 text-lg font-semibold">Submission verification</h2>
        <p className="muted mb-3">
          Compare this SHA-256 hash with the published submission hashes.
        </p>
        <code className="block text-xs break-all sm:text-sm">
          {detail.verificationHash}
        </code>
        <h3 className="mt-4 mb-2 font-semibold">Summary</h3>
        <pre className="text-sm break-words whitespace-pre-wrap">
          {detail.summary}
        </pre>
      </section>
      <div className="page-toolbar">
        {admin ? (
          <Link
            className="button primary"
            to={`/admin/submissions?season=${submission.season}&week=${submission.week}`}
          >
            Back to all submissions
          </Link>
        ) : (
          <>
            <Link
              className="button primary"
              to={`/submissions/new?season=${submission.season}&week=${submission.week}`}
            >
              Edit picks
            </Link>
            <Link
              className="button secondary"
              to={`/submissions?season=${submission.season}&week=${submission.week}`}
            >
              All my submissions
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

const pickPresentations = {
  correct: {
    result: "correct",
    label: "Correct",
    iconPath: "m6.5 10 2.5 2.5 4.5-5",
  },
  incorrect: {
    result: "incorrect",
    label: "Incorrect",
    iconPath: "m7 7 6 6m0-6-6 6",
  },
  pending: {
    result: "pending",
    label: "Pending",
    iconPath: "M10 6v4l2.5 1.5",
  },
} as const;
const pickOutcomeOptions = Object.values(pickPresentations);

function pickPresentation(pick: SubmissionDetail["picks"][number]) {
  if (!pick.winningTeamId) {
    return pickPresentations.pending;
  }
  return pick.correct ? pickPresentations.correct : pickPresentations.incorrect;
}

function SubmissionOutcome({
  presentation,
  game,
  compact,
}: {
  presentation: ReturnType<typeof pickPresentation>;
  game: SubmissionDetail["picks"][number]["game"];
  compact: boolean;
}) {
  return (
    <div
      className="submission-outcome"
      title={
        compact && game
          ? `${presentation.label} · ${game.statusDetail}`
          : presentation.label
      }
    >
      <span className="submission-result" data-result={presentation.result}>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="7.5" />
          <path d={presentation.iconPath} />
        </svg>
        <span className={compact ? "sr-only sm:not-sr-only" : undefined}>
          {presentation.label}
        </span>
      </span>
    </div>
  );
}

function SubmissionPick({
  pick,
  compact,
}: {
  pick: SubmissionDetail["picks"][number];
  compact: boolean;
}) {
  const game = pick.game;
  const selected =
    game &&
    [game.awayTeam, game.homeTeam].find(
      (team) => team.id === pick.selectedTeamId,
    );
  const presentation = pickPresentation(pick);
  return (
    <li className="submission-pick">
      <div className="submission-pick-heading">
        <div className={compact && game ? "sr-only" : undefined}>
          <h2 className={game ? "sr-only" : "font-semibold"}>
            {game?.name ?? `Game ${pick.competitionId}`}
          </h2>
          {game && (
            <p className="submission-game-meta">
              <time dateTime={game.date}>
                {centralDate.format(new Date(game.date))}
              </time>
              <span>{game.statusDetail}</span>
            </p>
          )}
        </div>
        <SubmissionOutcome
          presentation={presentation}
          game={game}
          compact={compact}
        />
      </div>
      {game && (
        <div className="submission-matchup">
          {[game.awayTeam, game.homeTeam].map((team, index) => {
            const chosen = team.id === pick.selectedTeamId;
            return (
              <Fragment key={team.id}>
                {compact && index === 1 && (
                  <span
                    className="muted submission-separator"
                    aria-hidden="true"
                  >
                    {game.neutralSite ? "vs" : "@"}
                  </span>
                )}
                <div className="submission-team" data-picked={chosen}>
                  <TeamDisplay
                    team={team}
                    fullName={!compact}
                    showScore={game.status !== "STATUS_SCHEDULED"}
                  />
                  <span className="submission-team-context">
                    <span className={compact ? "sr-only" : undefined}>
                      {index === 0 ? "Away" : "Home"}
                    </span>
                    {chosen && (
                      <span className="submission-choice">Picked</span>
                    )}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
      {!selected && (
        <p className="submission-pick-fallback mt-2 text-sm font-medium">
          Your pick: {pick.selectedTeamId}
        </p>
      )}
    </li>
  );
}

function mondayNightTotal(games: Game[]) {
  const mondayGames = games.filter((game) =>
    centralDay.format(new Date(game.date)).startsWith("Monday"),
  );
  if (!mondayGames.length) {
    return null;
  }
  let total = 0;
  for (const game of mondayGames) {
    const { score: home } = game.homeTeam;
    const { score: away } = game.awayTeam;
    if (home === null || away === null) {
      return null;
    }
    total += home + away;
  }
  return total;
}

function StandingStatus({
  standing,
  count,
}: {
  standing: StandingsData["standings"][number];
  count: number;
}) {
  const winner = standing.winner && count > 1;
  let label = standing.contender ? "Contender" : "Eliminated";
  if (winner) {
    label = "Winner";
  }
  return <span className={`badge ${winner ? "success" : ""}`}>{label}</span>;
}

function StandingsOverview({
  data,
  userId,
}: {
  data: StandingsData;
  userId: number | undefined;
}) {
  const mine = data.standings.find((standing) => standing.user.id === userId);
  const completed = data.scoreboard.games.filter(
    (game) => game.status === "STATUS_FINAL",
  ).length;
  const total = data.scoreboard.games.length;
  const complete = total > 0 && completed === total;
  let phase = "Awaiting results";
  if (complete) {
    phase = "Final results";
  } else if (
    data.scoreboard.games.some((game) => game.status !== "STATUS_SCHEDULED")
  ) {
    phase = "Week in progress";
  }
  return (
    <>
      {mine ? (
        <section
          className="standings-overview"
          aria-label="Your week at a glance"
        >
          <div className="stat-card">
            <span className="stat-label">Your place</span>
            <strong className="stat-value">#{mine.rank}</strong>
            <span className="muted">of {data.standings.length} players</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Correct</span>
            <strong className="stat-value">{mine.correctPicks}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Picks left</span>
            <strong className="stat-value">{mine.remainingCount}</strong>
          </div>
        </section>
      ) : (
        <p className="muted">You haven't submitted picks for this week.</p>
      )}
      <div className="standings-context">
        <strong>{phase}</strong>
        <span>
          {completed} of {total} games complete
        </span>
      </div>
    </>
  );
}

function StandingRow({
  standing,
  data,
  current,
}: {
  standing: StandingsData["standings"][number];
  data: StandingsData;
  current: boolean;
}) {
  return (
    <tr data-current-user={current || undefined}>
      <td className="font-semibold">{standing.rank}</td>
      <th scope="row">
        <span className="standing-player">
          <span className="min-w-0">
            {standing.user.username ?? "Pool member"}
          </span>{" "}
          {current && <span className="you-badge">You</span>}
        </span>
        <div className="mt-1">
          <StandingStatus standing={standing} count={data.standings.length} />
        </div>
      </th>
      <td className="font-bold">{standing.correctPicks}</td>
      <td>{standing.remainingCount}</td>
      {data.showTiebreaker && (
        <>
          <td>{standing.tiebreaker ?? "—"}</td>
          <td>{standing.tiebreakerDiff ?? "Not available"}</td>
        </>
      )}
    </tr>
  );
}

function StandingsView({ data }: { data: StandingsData }) {
  const { user } = useSession();
  if (!data.standings.length) {
    return (
      <div className="panel empty-state">
        <h2>No submissions yet</h2>
        <p>
          No submissions for {data.scoreboard.season} season, Week{" "}
          {data.scoreboard.week} yet. Once picks are entered, the pool will
          appear here.
        </p>
        <Link
          className="button primary"
          to={`/submissions/new?season=${data.scoreboard.season}&week=${data.scoreboard.week}`}
        >
          Make your picks
        </Link>
      </div>
    );
  }
  const mondayTotal = mondayNightTotal(data.scoreboard.games);
  return (
    <div className="space-y-5">
      <StandingsOverview data={data} userId={user?.id} />
      {data.showTiebreaker && (
        <p className="alert info">
          Monday night actual total: {mondayTotal ?? "Not available"}
        </p>
      )}
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Weekly standings"
      >
        <table className="standings-table">
          <caption className="sr-only">
            {data.scoreboard.season} season, Week {data.scoreboard.week}{" "}
            standings
          </caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Player</th>
              <th scope="col">Correct</th>
              <th scope="col">
                <span className="sm:hidden">Left</span>
                <span className="hidden sm:inline">Remaining</span>
              </th>
              {data.showTiebreaker && (
                <>
                  <th scope="col">Tiebreaker</th>
                  <th scope="col">Off by</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {data.standings.map((standing) => (
              <StandingRow
                key={standing.user.id}
                standing={standing}
                data={data}
                current={standing.user.id === user?.id}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function StandingsPage() {
  const [params] = useSearchParams();
  const resource = useResource<StandingsData>(
    `/api/standings${periodQuery(params)}`,
  );
  useResolvedPeriod(resource.data?.scoreboard);
  return (
    <>
      <PageHeading
        title="Standings"
        subtitle="The weekly picture, one result at a time."
        {...resource.data?.scoreboard}
      />
      <div className="page-toolbar">
        <WeekPicker {...resource.data?.scoreboard} />
      </div>
      <ResourceView resource={resource}>
        {(data) => <StandingsView data={data} />}
      </ResourceView>
    </>
  );
}
export function AdminSubmissions() {
  const [params] = useSearchParams();
  const resource = useResource<{
    scoreboard: Scoreboard;
    submissions: SubmissionDetail[];
  }>(`/api/admin/submissions${periodQuery(params)}`);
  useResolvedPeriod(resource.data?.scoreboard);
  return (
    <>
      <PageHeading title="All submissions" {...resource.data?.scoreboard} />
      <div className="page-toolbar">
        <WeekPicker {...resource.data?.scoreboard} />
      </div>
      <ResourceView resource={resource}>
        {(data) =>
          data.submissions.length ? (
            <div className="table-scroll">
              <table>
                <caption className="sr-only">
                  All submissions for {data.scoreboard.season} season, Week{" "}
                  {data.scoreboard.week}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Player</th>
                    <th scope="col">Correct</th>
                    <th scope="col">Tiebreaker</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.submissions.map((detail) => (
                    <tr key={detail.submission.id}>
                      <th scope="row">
                        {detail.submission.user.username ?? "Pool member"}
                      </th>
                      <td>{detail.correctPicks}</td>
                      <td>{detail.submission.tiebreaker}</td>
                      <td>
                        {centralDate.format(
                          new Date(detail.submission.createdAt),
                        )}
                      </td>
                      <td>
                        <Link
                          className="button secondary"
                          to={`/admin/submissions/${detail.submission.id}?season=${detail.submission.season}&week=${detail.submission.week}`}
                        >
                          View{" "}
                          <span className="sr-only">
                            {detail.submission.user.username}
                          </span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="panel">
              No submissions for {data.scoreboard.season} season, Week{" "}
              {data.scoreboard.week}.
            </p>
          )
        }
      </ResourceView>
    </>
  );
}
