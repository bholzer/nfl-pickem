import { useEffect, useState, type SubmitEvent } from "react";
import {
  Link,
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
import { RequestError, useMutation, useResource } from "./api";
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

export function PicksPage() {
  const [params] = useSearchParams();
  const week = params.get("week") ?? "current";
  const season = params.get("season");
  const resource = useResource<WeekData>(
    `/api/weeks/${encodeURIComponent(week)}${season ? `?season=${encodeURIComponent(season)}` : ""}`,
  );
  useResolvedPeriod(resource.data?.scoreboard);
  return (
    <>
      <PageHeading title="Make your picks" {...resource.data?.scoreboard} />
      <WeekPicker {...resource.data?.scoreboard} />
      <ResourceView resource={resource}>
        {(data) => (
          <PicksForm
            key={`${data.scoreboard.season}-${data.scoreboard.week}`}
            data={data}
          />
        )}
      </ResourceView>
    </>
  );
}
type Game = WeekData["scoreboard"]["games"][number];

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

function validatePicks(eligible: Game[], picks: Picks, tiebreaker: string) {
  if (eligible.length === 0 || eligible.some((game) => !picks[game.id])) {
    return "Choose a team for every game that has not started.";
  }
  if (
    tiebreaker.trim() === "" ||
    !Number.isSafeInteger(Number(tiebreaker)) ||
    Number(tiebreaker) < 0
  ) {
    return "Enter a whole, nonnegative Monday night point total.";
  }
  return null;
}

function usePicksForm(data: WeekData) {
  const [picks, setPicks] = useState<Picks>(data.submission?.picks ?? {});
  const [tiebreaker, setTiebreaker] = useState(
    data.submission ? String(data.submission.tiebreaker) : "",
  );
  const [validation, setValidation] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const mutation = useMutation();
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const started = (game: Game) =>
    game.status !== "STATUS_SCHEDULED" || new Date(game.date).getTime() <= now;
  const gamesLocked = data.locked || data.scoreboard.games.some(started);
  const locked =
    Boolean(data.submission && gamesLocked) ||
    (mutation.error instanceof RequestError && mutation.error.status === 409);
  const games = [...data.scoreboard.games].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validatePicks(
      games.filter((game) => !started(game)),
      picks,
      tiebreaker,
    );
    setValidation(error);
    if (error) {
      return;
    }
    const result = await mutation.mutate<{ submission: Submission }>(
      `/api/submissions/${data.scoreboard.week}?season=${data.scoreboard.season}`,
      "PUT",
      { picks, tiebreaker: Number(tiebreaker) },
    );
    if (result?.ok) {
      await navigate(
        `/submissions/${result.data.submission.id}?season=${result.data.submission.season}&week=${result.data.submission.week}`,
        { state: { saved: true } },
      );
    }
  }
  function selectTeam(gameId: string, teamId: string) {
    setPicks((current) => ({ ...current, [gameId]: teamId }));
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
      <p className="alert info">
        Picks lock at {centralDate.format(new Date(earliestGameTime))}.
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
}: {
  game: Game;
  selectedTeamId: string | undefined;
  disabled: boolean;
  started: boolean;
  onSelect: (gameId: string, teamId: string) => void;
}) {
  return (
    <fieldset disabled={disabled} className="p-3 sm:p-4">
      <legend className="sr-only">{game.name}</legend>
      <div className="muted mb-2 flex flex-wrap justify-between gap-2 text-xs">
        <time dateTime={game.date}>
          {centralDate.format(new Date(game.date))}
        </time>
        <span>{game.statusDetail || (started ? "Started" : "Upcoming")}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        {[game.awayTeam, game.homeTeam].map((team, index) => (
          <div key={team.id} className="contents">
            {index === 1 && <span className="muted">@</span>}
            <label
              className={`team-choice ${selectedTeamId === team.id ? "selected" : ""}`}
            >
              <input
                type="radio"
                name={`pick-${game.id}`}
                value={team.id}
                checked={selectedTeamId === team.id}
                onChange={() => {
                  onSelect(game.id, team.id);
                }}
                aria-label={`${team.name} for ${game.name}`}
              />
              <TeamDisplay team={team} />
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
  onChange,
}: {
  value: string;
  disabled: boolean;
  error: unknown;
  onChange: (value: string) => void;
}) {
  return (
    <div className="panel">
      <label htmlFor="tiebreaker" className="block font-semibold">
        Monday night tiebreaker
      </label>
      <p id="tiebreaker-help" className="muted my-2">
        Total combined points in Monday Night Football.
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
        aria-describedby="tiebreaker-help"
        aria-invalid={
          error instanceof RequestError && Boolean(error.fields.tiebreaker)
        }
      />
    </div>
  );
}

function PicksForm({ data }: { data: WeekData }) {
  const form = usePicksForm(data);
  const disabled = form.locked || form.mutation.pending;
  const submitLabel = data.submission ? "Update picks" : "Submit picks";
  if (!form.games.length) {
    return (
      <p className="panel">
        No games available for {data.scoreboard.season} season, Week{" "}
        {data.scoreboard.week}.
      </p>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        void form.submit(event);
      }}
      className="space-y-5"
      noValidate
    >
      <PicksLockNotice
        locked={form.locked}
        gamesLocked={form.gamesLocked}
        earliestGameTime={data.earliestGameTime}
      />
      {[...groupGamesByDay(form.games)].map(([day, dayGames]) => (
        <section key={day}>
          <h2 className="mb-3 text-lg font-semibold">{day}</h2>
          <div className="panel divide-y divide-gray-200 p-0 dark:divide-gray-800">
            {dayGames.map((game) => (
              <GamePick
                key={game.id}
                game={game}
                selectedTeamId={form.picks[game.id]}
                disabled={disabled || form.started(game)}
                started={form.started(game)}
                onSelect={form.selectTeam}
              />
            ))}
          </div>
        </section>
      ))}
      <TiebreakerField
        value={form.tiebreaker}
        disabled={disabled}
        error={form.mutation.error}
        onChange={form.setTiebreaker}
      />
      {form.validation && (
        <p role="alert" className="alert error">
          {form.validation}
        </p>
      )}
      <ErrorNotice error={form.mutation.error} />
      <button
        className="button primary w-full"
        disabled={disabled}
        type="submit"
      >
        {form.mutation.pending ? "Saving picks…" : submitLabel}
      </button>
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
      <SeasonPicker all />
      <Link
        className="button primary mb-5"
        to={`/submissions/new${periodQuery(params)}`}
      >
        Make picks
      </Link>
      <ResourceView resource={resource}>
        {({ submissions }) => {
          const visible = submissions.filter(
            (submission) => !season || submission.season === Number(season),
          );
          return visible.length ? (
            <ul className="panel divide-y divide-gray-200 p-0 dark:divide-gray-800">
              {visible.map((submission) => (
                <li
                  key={submission.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
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
  return (
    <>
      <PageHeading
        title={admin ? "Player picks" : "Your picks"}
        season={submission.season}
        week={submission.week}
      />
      <p className="muted mb-4">{submission.user.username ?? "Pool member"}</p>
      <dl className="panel mb-5 grid grid-cols-2 gap-4 text-center">
        <div>
          <dt className="muted">Correct picks</dt>
          <dd className="text-3xl font-bold text-green-700 dark:text-green-400">
            {detail.correctPicks}
          </dd>
        </div>
        <div>
          <dt className="muted">Tiebreaker</dt>
          <dd className="text-3xl font-bold">{submission.tiebreaker}</dd>
        </div>
      </dl>
      <ul className="panel mb-5 divide-y divide-gray-200 p-0 dark:divide-gray-800">
        {detail.picks.map((pick) => (
          <SubmissionPick key={pick.competitionId} pick={pick} />
        ))}
      </ul>
      <section className="panel mb-5">
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
      <div className="flex flex-wrap gap-3">
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
    </>
  );
}
function pickPresentation(pick: SubmissionDetail["picks"][number]) {
  let highlight = "";
  if (pick.correct) {
    highlight = "bg-green-50 dark:bg-green-900/30";
  } else if (pick.winningTeamId) {
    highlight = "bg-red-50 dark:bg-red-900/30";
  }
  const result = pick.correct ? "Correct" : "Incorrect";
  return { highlight, label: pick.winningTeamId ? result : "Pending" };
}

function SubmissionPick({ pick }: { pick: SubmissionDetail["picks"][number] }) {
  const game = pick.game;
  const selected =
    game &&
    [game.awayTeam, game.homeTeam].find(
      (team) => team.id === pick.selectedTeamId,
    );
  const presentation = pickPresentation(pick);
  return (
    <li className={`p-4 ${presentation.highlight}`}>
      <div className="mb-2 flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold">
          {game?.name ?? `Game ${pick.competitionId}`}
        </h2>
        <span className="text-sm">{presentation.label}</span>
      </div>
      {game && (
        <>
          <p className="muted mb-2 text-xs">
            {centralDate.format(new Date(game.date))} · {game.statusDetail}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <TeamDisplay team={game.awayTeam} />
            <span className="muted">@</span>
            <TeamDisplay team={game.homeTeam} />
          </div>
        </>
      )}
      <p className="mt-2 text-sm font-medium">
        Your pick: {selected?.name ?? pick.selectedTeamId}
      </p>
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

export function StandingsPage() {
  const [params] = useSearchParams();
  const resource = useResource<StandingsData>(
    `/api/standings${periodQuery(params)}`,
  );
  useResolvedPeriod(resource.data?.scoreboard);
  return (
    <>
      <PageHeading title="Standings" {...resource.data?.scoreboard} />
      <WeekPicker {...resource.data?.scoreboard} />
      <ResourceView resource={resource}>
        {(data) => {
          if (!data.standings.length) {
            return (
              <p className="panel">
                No submissions for {data.scoreboard.season} season, Week{" "}
                {data.scoreboard.week} yet.
              </p>
            );
          }
          const mondayTotal = mondayNightTotal(data.scoreboard.games);
          return (
            <>
              {data.showTiebreaker && (
                <p className="alert info mb-4">
                  Monday night actual total: {mondayTotal ?? "Not available"}
                </p>
              )}
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    {data.scoreboard.season} season, Week {data.scoreboard.week}{" "}
                    standings
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">Player</th>
                      <th scope="col">Correct</th>
                      <th scope="col">Remaining</th>
                      <th scope="col">Status</th>
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
                      <tr key={standing.user.id}>
                        <td>{standing.rank}</td>
                        <th scope="row">
                          {standing.user.username ?? "Pool member"}
                        </th>
                        <td className="font-bold">{standing.correctPicks}</td>
                        <td>{standing.remainingCount}</td>
                        <td>
                          <StandingStatus
                            standing={standing}
                            count={data.standings.length}
                          />
                        </td>
                        {data.showTiebreaker && (
                          <>
                            <td>{standing.tiebreaker}</td>
                            <td>
                              {standing.tiebreakerDiff ?? "Not available"}
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
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
      <WeekPicker {...resource.data?.scoreboard} />
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
