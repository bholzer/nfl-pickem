import { Link, useSearchParams } from "react-router-dom";
import type {
  SeasonData,
  SeasonPlayerTotals,
  SeasonWeekScore,
  SeasonWeekStatus,
} from "../shared/contracts";
import { useResource, useSession } from "./api";
import { PageHeading, ResourceView, SeasonPicker, StatStrip, usd } from "./ui";

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
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

// Correct over decided shows the accuracy denominator; 0/0 is still a real
// fraction, so it never collapses to a dash.
function correctOfDecided(
  totals: Pick<SeasonPlayerTotals, "correctPicks" | "decidedPicks">,
) {
  return `${totals.correctPicks}/${totals.decidedPicks}`;
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
            { label: "Correct", value: correctOfDecided(mine) },
            { label: "Weekly wins", value: mine.weeklyWins },
            { label: "P/L", value: usd(mine.netCents, true) },
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

// Every figure after Correct, in table column order. The table and the phone
// roster both read from here so the two renderings never disagree.
function seasonStats(player: SeasonPlayerTotals) {
  return [
    { label: "Wins", value: String(player.weeklyWins) },
    { label: "P/L", value: usd(player.netCents, true) },
    { label: "Played", value: String(player.weeksPlayed) },
    { label: "Accuracy", value: formatStat(player.accuracy, percent) },
    { label: "Best", value: weekScore(player.bestWeek) },
    { label: "Worst", value: weekScore(player.worstWeek) },
    { label: "Avg", value: formatStat(player.averageCorrect, average) },
  ];
}

function PlayerName({
  player,
  current,
}: {
  player: SeasonPlayerTotals;
  current: boolean;
}) {
  return (
    <span className="standing-player">
      <span className="min-w-0">{player.user.username ?? "Pool member"}</span>{" "}
      {current && <span className="you-badge">You</span>}
    </span>
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
        <PlayerName player={player} current={current} />
      </th>
      <td className="font-bold">{correctOfDecided(player)}</td>
      {seasonStats(player).map((stat) => (
        <td key={stat.label}>{stat.value}</td>
      ))}
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
      className="table-scroll season-table-region"
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
            <th scope="col">P/L</th>
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

function SeasonRosterItem({
  player,
  current,
}: {
  player: SeasonPlayerTotals;
  current: boolean;
}) {
  return (
    <li className="season-roster-item" data-current-user={current || undefined}>
      <div className="season-roster-heading">
        <span className="season-roster-rank font-semibold">{player.rank}</span>
        <PlayerName player={player} current={current} />
        <span className="season-roster-correct font-bold">
          <span className="sr-only">Correct </span>
          {correctOfDecided(player)}
        </span>
      </div>
      <dl className="season-roster-stats">
        {seasonStats(player).map((stat) => (
          <div key={stat.label}>
            <dt className="stat-label">{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

// Phones get this divided roster instead of the ten-column table. Both render;
// the stylesheet displays one per viewport, which also keeps the hidden one out
// of the accessibility tree.
function SeasonRoster({
  data,
  userId,
}: {
  data: SeasonData;
  userId: number | undefined;
}) {
  return (
    <ol className="panel season-roster" aria-label="Season standings">
      {data.players.map((player) => (
        <SeasonRosterItem
          key={player.user.id}
          player={player}
          current={player.user.id === userId}
        />
      ))}
    </ol>
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
                {week.status !== "upcoming" && ` · Pot ${usd(week.potCents)}`}
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
      <SeasonRoster data={data} userId={user?.id} />
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
