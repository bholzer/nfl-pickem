import { Link, useSearchParams } from "react-router-dom";
import type {
  SeasonData,
  SeasonPlayerTotals,
  SeasonWeekScore,
  SeasonWeekStatus,
} from "../shared/contracts";
import { useResource, useSession } from "./api";
import { PageHeading, ResourceView, SeasonPicker, StatStrip } from "./ui";

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
});
const average = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const phaseLabels: Record<SeasonData["phase"], string> = {
  upcoming: "Season hasn't started",
  in_progress: "Season in progress",
  complete: "Season complete",
};

const weekLabels: Record<SeasonWeekStatus, string> = {
  final: "Final",
  in_progress: "In progress",
  incomplete: "Incomplete",
  upcoming: "Upcoming",
};

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatStat(value: number | null, format: Intl.NumberFormat) {
  return value === null ? "—" : format.format(value);
}

function weekScore(entry: SeasonWeekScore | null) {
  return entry ? `${entry.correctPicks} (Wk ${entry.week})` : "—";
}

function SeasonOverview({
  data,
  userId,
}: {
  data: SeasonData;
  userId: number | undefined;
}) {
  const mine = data.players.find((player) => player.user.id === userId);
  const finalWeeks = data.weeks.filter(
    (week) => week.status === "final",
  ).length;
  const hasResults = mine !== undefined && mine.decidedPicks > 0;
  return (
    <>
      {mine ? (
        <StatStrip
          label="Your season at a glance"
          items={[
            {
              label: "Your place",
              value: hasResults ? `#${mine.rank}` : "—",
              note: hasResults
                ? `of ${plural(data.players.length, "player")}`
                : "Awaiting results",
            },
            { label: "Correct", value: mine.correctPicks },
            { label: "Weekly wins", value: mine.weeklyWins },
          ]}
        />
      ) : (
        <p className="muted">You haven't submitted picks this season.</p>
      )}
      <div className="standings-context">
        <strong>{phaseLabels[data.phase]}</strong>
        <span>
          {plural(finalWeeks, "week")} final
          {data.inProgressWeek !== null &&
            ` · Week ${data.inProgressWeek} in progress`}
        </span>
      </div>
    </>
  );
}

function SeasonRow({
  player,
  current,
}: {
  player: SeasonPlayerTotals;
  current: boolean;
}) {
  return (
    <tr data-current-user={current || undefined}>
      <td className="font-semibold">{player.rank}</td>
      <th scope="row">
        <span className="standing-player">
          <span className="min-w-0">
            {player.user.username ?? "Pool member"}
          </span>{" "}
          {current && <span className="you-badge">You</span>}
        </span>
      </th>
      <td className="font-bold">{player.correctPicks}</td>
      <td>{player.weeklyWins}</td>
      <td>{player.weeksPlayed}</td>
      <td>{formatStat(player.accuracy, percent)}</td>
      <td>{weekScore(player.bestWeek)}</td>
      <td>{weekScore(player.worstWeek)}</td>
      <td>{formatStat(player.averageCorrect, average)}</td>
    </tr>
  );
}

function SeasonTable({
  data,
  userId,
}: {
  data: SeasonData;
  userId: number | undefined;
}) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Season standings"
    >
      <table className="standings-table season-table">
        <caption className="sr-only">{data.season} season standings</caption>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Player</th>
            <th scope="col">Correct</th>
            <th scope="col">Wins</th>
            <th scope="col">Played</th>
            <th scope="col">Accuracy</th>
            <th scope="col">Best</th>
            <th scope="col">Worst</th>
            <th scope="col">Avg</th>
          </tr>
        </thead>
        <tbody>
          {data.players.map((player) => (
            <SeasonRow
              key={player.user.id}
              player={player}
              current={player.user.id === userId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeasonWeeks({ data }: { data: SeasonData }) {
  return (
    <section className="space-y-3" aria-labelledby="season-weeks">
      <h2 id="season-weeks" className="font-semibold">
        Weekly results
      </h2>
      <ul className="panel submission-list">
        {data.weeks.map((week) => (
          <li key={week.week} className="submission-list-row">
            <div>
              <h3 className="font-semibold">Week {week.week}</h3>
              <p className="muted">
                {weekLabels[week.status]} · {plural(week.playerCount, "player")}
              </p>
              {week.winners.length > 0 && (
                <p>
                  {week.winners.length === 1 ? "Winner" : "Winners"}:{" "}
                  {week.winners
                    .map((winner) => winner.username ?? "Pool member")
                    .join(", ")}
                </p>
              )}
            </div>
            <Link
              className="button secondary"
              to={`/standings?season=${data.season}&week=${week.week}`}
            >
              View standings{" "}
              <span className="sr-only">for Week {week.week}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SeasonView({ data }: { data: SeasonData }) {
  const { user } = useSession();
  if (!data.players.length) {
    return (
      <div className="panel empty-state">
        <h2>No picks this season yet</h2>
        <p>
          Nobody has submitted picks for the {data.season} season yet. Season
          totals will appear here once the pool starts picking.
        </p>
        <Link
          className="button primary"
          to={`/submissions/new?season=${data.season}`}
        >
          Make your picks
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <SeasonOverview data={data} userId={user?.id} />
      <SeasonTable data={data} userId={user?.id} />
      <SeasonWeeks data={data} />
    </div>
  );
}

export function SeasonPage() {
  const [params] = useSearchParams();
  const season = params.get("season");
  // Only the season is sent: season totals have no week, and the URL keeps the
  // week so other navigation retains its context.
  const resource = useResource<SeasonData>(
    `/api/season${season ? `?${new URLSearchParams({ season })}` : ""}`,
  );
  return (
    <>
      <PageHeading
        title="Season"
        subtitle="Every week of the pool, added up."
        season={resource.data?.season}
      />
      <div className="page-toolbar">
        <SeasonPicker season={resource.data?.season} />
      </div>
      <ResourceView resource={resource}>
        {(data) => <SeasonView data={data} />}
      </ResourceView>
    </>
  );
}
