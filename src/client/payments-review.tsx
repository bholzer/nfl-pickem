import { useState } from "react";
import type {
  PaymentApprovalInput,
  PaymentEntry,
  PaymentsData,
  SeasonsData,
} from "../shared/contracts";
import { useMutation, useResource } from "./api";
import {
  describeEntry,
  memberOptions,
  paidDate,
  sourceLabels,
  type PaymentWriter,
} from "./payments-shared";
import { ErrorNotice, OptionPicker, usd } from "./ui";

function senderName(entry: PaymentEntry) {
  return entry.venmoName ?? "an unknown Venmo user";
}

// The entry's own season stays available even before the season list loads.
function seasonOptions(entry: PaymentEntry, known: number[] | undefined) {
  const seasons = new Set([...(known ?? []), entry.season]);
  return [...seasons]
    .sort((a, b) => b - a)
    .map((year) => ({ value: String(year), label: `${year} season` }));
}

function QueueItem({
  entry,
  data,
  seasons,
  pending,
  onApprove,
  onIgnore,
}: {
  entry: PaymentEntry;
  data: PaymentsData;
  seasons: number[] | undefined;
  pending: boolean;
  onApprove: (input: PaymentApprovalInput) => void;
  onIgnore: () => void;
}) {
  const [userId, setUserId] = useState(
    entry.userId === null ? "" : String(entry.userId),
  );
  const [season, setSeason] = useState(String(entry.season));
  const description = describeEntry(entry, senderName(entry));
  const received = entry.direction === "in";
  return (
    <li className="review-item">
      <div className="review-heading">
        <p className="min-w-0 font-semibold">
          <span className="font-normal text-muted">
            {received ? "Received from " : "Paid to "}
          </span>
          {entry.venmoName ?? "Unknown Venmo user"}
        </p>
        <p className="shrink-0 font-semibold tabular-nums">
          {usd(entry.amountCents)}
        </p>
      </div>
      <p className="muted">
        {paidDate.format(new Date(entry.paidAt))} · {sourceLabels[entry.source]}
      </p>
      <p className="review-note">
        {entry.note ?? <span className="muted">No note</span>}
      </p>
      <div className="page-toolbar mb-0">
        <div className="period-select">
          <span>Player</span>
          <OptionPicker
            label={`Player for ${description}`}
            value={userId}
            disabled={pending}
            options={[
              { value: "", label: "Choose player" },
              ...memberOptions(data.users),
            ]}
            onChange={setUserId}
          />
        </div>
        <div className="period-select">
          <span>Season</span>
          <OptionPicker
            label={`Season for ${description}`}
            value={season}
            disabled={pending}
            options={seasonOptions(entry, seasons)}
            onChange={setSeason}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="button primary"
            disabled={pending || !userId}
            onClick={() => {
              onApprove({ userId: Number(userId), season: Number(season) });
            }}
          >
            Approve <span className="sr-only">{description}</span>
          </button>
          <button
            className="button secondary"
            disabled={pending}
            onClick={onIgnore}
          >
            Ignore <span className="sr-only">{description}</span>
          </button>
        </div>
      </div>
    </li>
  );
}

/** Imported payments the classifier could not file; the note decides them. */
export function ReviewQueue({
  data,
  write,
}: {
  data: PaymentsData;
  write: PaymentWriter;
}) {
  const review = useMutation();
  const seasons = useResource<SeasonsData>("/api/seasons");
  const queue = data.entries.filter((entry) => entry.status === "pending");
  const decide = (id: number, action: "approve" | "ignore", body?: unknown) =>
    void write(
      review,
      { path: `/api/admin/payments/${id}/${action}`, method: "POST", body },
      () => (action === "approve" ? "Payment approved." : "Payment ignored."),
    );
  return (
    <section className="space-y-3" aria-labelledby="payment-review">
      <h2 id="payment-review" className="font-semibold">
        Needs review ({queue.length})
      </h2>
      <ErrorNotice error={review.error} />
      {queue.length ? (
        <ul className="panel review-list" aria-label="Payments to review">
          {queue.map((entry) => (
            <QueueItem
              key={entry.id}
              entry={entry}
              data={data}
              seasons={seasons.data?.seasons}
              pending={review.pending}
              onApprove={(input) => {
                decide(entry.id, "approve", input);
              }}
              onIgnore={() => {
                decide(entry.id, "ignore");
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="muted">No imported payments need review.</p>
      )}
    </section>
  );
}
