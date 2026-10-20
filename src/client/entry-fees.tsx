import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_ENTRY_FEE_CENTS,
  type SeasonEntryFees,
} from "../shared/contracts";
import { useMutation, useResource } from "./api";
import {
  ErrorNotice,
  PageHeading,
  ResourceView,
  SeasonPicker,
  usd,
} from "./ui";

type WeekFee = SeasonEntryFees["weeks"][number];

function dollars(cents: number) {
  return (cents / 100).toFixed(2);
}

function EntryFeeRow({
  fee,
  pending,
  onSave,
}: {
  fee: WeekFee;
  pending: boolean;
  onSave: (week: number, feeCents: number) => void;
}) {
  const [value, setValue] = useState(dollars(fee.feeCents));
  const formId = `entry-fee-week-${fee.week}`;
  return (
    <tr>
      <th scope="row">Week {fee.week}</th>
      <td>
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            // Dollars round to whole cents; the server rejects anything else.
            onSave(fee.week, Math.round(Number(value) * 100));
          }}
        >
          <label className="sr-only" htmlFor={`${formId}-amount`}>
            Week {fee.week} fee in dollars
          </label>
          <input
            id={`${formId}-amount`}
            className="input w-28"
            type="number"
            inputMode="decimal"
            min="0"
            max="1000"
            step="0.01"
            required
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </form>
      </td>
      <td>{fee.configured ? "Configured" : "Default"}</td>
      <td>
        <button
          type="submit"
          form={formId}
          className="button secondary"
          disabled={pending}
        >
          Save <span className="sr-only">Week {fee.week} fee</span>
        </button>
      </td>
    </tr>
  );
}

function EntryFeeTable({
  data,
  pending,
  onSave,
}: {
  data: SeasonEntryFees;
  pending: boolean;
  onSave: (week: number, feeCents: number) => void;
}) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Weekly entry fees"
    >
      <table className="standings-table">
        <caption className="sr-only">{data.season} season entry fees</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Fee</th>
            <th scope="col">Source</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.weeks.map((fee) => (
            // Remounting on the saved amount resets the input to the stored value.
            <EntryFeeRow
              key={`${fee.week}:${fee.feeCents}`}
              fee={fee}
              pending={pending}
              onSave={onSave}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EntryFeesPage() {
  const [params] = useSearchParams();
  const season = params.get("season");
  const resource = useResource<SeasonEntryFees>(
    `/api/admin/entry-fees${season ? `?${new URLSearchParams({ season })}` : ""}`,
  );
  const mutation = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  async function save(week: number, feeCents: number) {
    const target = resource.data?.season;
    if (target === undefined) {
      return;
    }
    setNotice(null);
    const result = await mutation.mutate<SeasonEntryFees>(
      "/api/admin/entry-fees",
      "PUT",
      { season: target, week, feeCents },
    );
    if (result?.ok) {
      setNotice(`Week ${week} entry fee set to ${usd(feeCents)}.`);
      resource.reload();
    }
  }
  return (
    <>
      <PageHeading
        title="Entry fees"
        subtitle="What each player pays to enter a week."
        season={resource.data?.season}
      />
      <div className="page-toolbar">
        <SeasonPicker season={resource.data?.season} />
      </div>
      <p className="muted mb-5">
        Weeks without a saved fee use the default of{" "}
        {usd(resource.data?.defaultFeeCents ?? DEFAULT_ENTRY_FEE_CENTS)}. A
        week&apos;s pot is the fee times its players, split evenly among that
        week&apos;s winners.
      </p>
      {notice && (
        <p role="status" className="alert success mb-4">
          {notice}
        </p>
      )}
      <ErrorNotice error={mutation.error} />
      <ResourceView resource={resource}>
        {(data) => (
          <EntryFeeTable
            data={data}
            pending={mutation.pending}
            onSave={(week, feeCents) => {
              void save(week, feeCents);
            }}
          />
        )}
      </ResourceView>
    </>
  );
}
