import { Fragment } from "react";
import type { Game, SubmissionDetail } from "../shared/contracts";
import { centralDate, TeamDisplay } from "./ui";

export function SubmissionPickList({
  picks,
  compact,
  showStatus = false,
}: {
  picks: SubmissionDetail["picks"];
  compact: boolean;
  showStatus?: boolean;
}) {
  return (
    <div className={compact ? "submission-compact" : undefined}>
      <ul className="panel submission-list">
        {picks.map((pick) => (
          <SubmissionPick
            key={pick.competitionId}
            pick={pick}
            compact={compact}
            showStatus={showStatus}
          />
        ))}
      </ul>
    </div>
  );
}

export function PickOutcomeKey() {
  return (
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

function SubmissionGameMeta({ game }: { game: Game }) {
  const statusDetail =
    game.status === "STATUS_SCHEDULED" ? "Scheduled" : game.statusDetail;
  return (
    <p className="submission-game-meta">
      <time dateTime={game.date}>
        {centralDate.format(new Date(game.date))}
      </time>
      <span>{statusDetail}</span>
    </p>
  );
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
  showStatus,
}: {
  pick: SubmissionDetail["picks"][number];
  compact: boolean;
  showStatus: boolean;
}) {
  const game = pick.game;
  const selected =
    game &&
    [game.awayTeam, game.homeTeam].find(
      (team) => team.id === pick.selectedTeamId,
    );
  const presentation = pickPresentation(pick);
  return (
    <li
      className={`submission-pick ${showStatus ? "submission-status-visible" : ""}`}
    >
      <div className="submission-pick-heading">
        <SubmissionPickMetadata
          pick={pick}
          compact={compact}
          showStatus={showStatus}
        />
        <SubmissionOutcome
          presentation={presentation}
          game={game}
          compact={compact}
        />
      </div>
      {game && (
        <SubmissionMatchup
          game={game}
          selectedTeamId={pick.selectedTeamId}
          compact={compact}
        />
      )}
      {!selected && (
        <p className="submission-pick-fallback mt-2 text-sm font-medium">
          Your pick: {pick.selectedTeamId}
        </p>
      )}
    </li>
  );
}

function SubmissionPickMetadata({
  pick,
  compact,
  showStatus,
}: {
  pick: SubmissionDetail["picks"][number];
  compact: boolean;
  showStatus: boolean;
}) {
  const game = pick.game;
  return (
    <div
      className={
        compact && game && !showStatus ? "sr-only" : "submission-visible-meta"
      }
    >
      <h2 className={game ? "sr-only" : "font-semibold"}>
        {game?.name ?? `Game ${pick.competitionId}`}
      </h2>
      {game && <SubmissionGameMeta game={game} />}
    </div>
  );
}

function SubmissionMatchup({
  game,
  selectedTeamId,
  compact,
}: {
  game: Game;
  selectedTeamId: string;
  compact: boolean;
}) {
  return (
    <div className="submission-matchup">
      {[game.awayTeam, game.homeTeam].map((team, index) => {
        const chosen = team.id === selectedTeamId;
        return (
          <Fragment key={team.id}>
            {compact && index === 1 && (
              <span className="muted submission-separator" aria-hidden="true">
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
                {chosen && <span className="submission-choice">Picked</span>}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
