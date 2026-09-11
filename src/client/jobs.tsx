import { useState, type ReactNode } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  JOB_TYPES,
  type JobRun,
  type JobsData,
  type JobType,
  type SeasonsData,
} from "../shared/contracts";
import { RequestError, useMutation, useResource } from "./api";
import {
  centralDate,
  ErrorNotice,
  PageHeading,
  periodQuery,
  ResourceView,
  useResolvedPeriod,
} from "./ui";

const JOB_LABELS: Record<JobType, string> = {
  deliver_submission_links: "Deliver submission links",
  deliver_standings: "Deliver standings",
  deliver_hashes: "Deliver hashes",
  schedule_hash_delivery: "Schedule hash delivery",
};
const ACTION_LABELS = {
  retry: "Retry",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  run_now: "Run now",
} as const;
type Action = keyof typeof ACTION_LABELS;
interface JobDetail {
  run: JobRun;
  deliveries: Array<{
    key: string;
    status: string;
    error: string | null;
    updatedAt: string;
  }>;
}

function Actions({
  pending,
  onAction,
  selected = false,
  run,
}: {
  pending: boolean;
  onAction: (action: Action) => void;
  selected?: boolean;
  run?: JobRun;
}) {
  const actions = (Object.keys(ACTION_LABELS) as Action[]).filter((action) => {
    if (!run) {
      return true;
    }
    if (action === "retry") {
      return ["errored", "creation_failed", "cancelled"].includes(run.status);
    }
    if (action === "pause") {
      return ["queued", "running", "sleeping"].includes(run.status);
    }
    if (action === "resume") {
      return run.status === "paused";
    }
    if (action === "run_now") {
      return (
        run.type === "schedule_hash_delivery" &&
        Boolean(run.plannedAt) &&
        ["sleeping", "paused"].includes(run.status)
      );
    }
    return !["complete", "cancelled", "superseded"].includes(run.status);
  });
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <button
          key={action}
          className={`button ${action === "cancel" ? "danger" : "secondary"}`}
          disabled={pending}
          onClick={() => {
            onAction(action);
          }}
        >
          {ACTION_LABELS[action]}
          {selected ? " selected" : ""}
        </button>
      ))}
    </div>
  );
}

function useJobManagement() {
  const [params, setParams] = useSearchParams();
  const query = new URLSearchParams();
  for (const name of ["type", "status", "before", "season"]) {
    const value = params.get(name);
    if (value) {
      query.set(name, value);
    }
  }
  const resource = useResource<JobsData>(
    `/api/admin/jobs${query.size ? `?${query}` : ""}`,
  );
  const mutation = useMutation();
  const [notice, setNotice] = useState<ReactNode>(null);
  const [selection, setSelection] = useState<{ query: string; ids: string[] }>({
    query: query.toString(),
    ids: [],
  });
  const selected = selection.query === query.toString() ? selection.ids : [];
  const [confirmation, setConfirmation] = useState<Action | null>(null);
  async function enqueue(type: JobType, season: number, week: string) {
    setNotice(null);
    const result = await mutation.mutate<{ run: JobRun }>(
      "/api/admin/jobs",
      "POST",
      { type, season, week: week === "" ? null : Number(week) },
    );
    if (result?.ok) {
      setNotice(
        `Created ${JOB_LABELS[result.data.run.type]} for ${result.data.run.season} season, ${result.data.run.week === null ? "the current week" : `Week ${result.data.run.week}`}.`,
      );
      resource.reload();
    } else if (
      result &&
      result.error instanceof RequestError &&
      result.error.body?.run
    ) {
      const run = result.error.body.run;
      setNotice(
        <>
          A failed job record was retained.{" "}
          <Link
            className="text-link break-all"
            to={`/admin/jobs/${encodeURIComponent(run.id)}`}
          >
            View job {run.id}
          </Link>
        </>,
      );
      resource.reload();
    }
  }
  async function bulk(action: Action) {
    setNotice(null);
    const result = await mutation.mutate<{ runs: JobRun[] }>(
      "/api/admin/jobs/actions",
      "POST",
      { ids: selected, action },
    );
    if (!result) {
      return;
    }
    setConfirmation(null);
    resource.reload();
    let runs: JobRun[] | undefined;
    if (result.ok) {
      runs = result.data.runs;
    } else if (result.error instanceof RequestError) {
      runs = result.error.body?.runs;
    }
    if (runs) {
      const processed = new Set(
        runs.map((run) =>
          action === "retry" || action === "run_now"
            ? (run.parentId ?? run.id)
            : run.id,
        ),
      );
      setNotice(
        <>
          {ACTION_LABELS[action]} results for {runs.length} job(s).{" "}
          {runs.map((run) => (
            <Link
              key={run.id}
              className="text-link ml-2 break-all"
              to={`/admin/jobs/${encodeURIComponent(run.id)}`}
            >
              View job {run.id}
            </Link>
          ))}
        </>,
      );
      setSelection((current) =>
        current.query === query.toString()
          ? { ...current, ids: current.ids.filter((id) => !processed.has(id)) }
          : current,
      );
    }
  }
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) {
      next.set(name, value);
    } else {
      next.delete(name);
    }
    next.delete("before");
    setConfirmation(null);
    setParams(next);
  }
  async function toggleDelivery(paused: boolean) {
    const result = await mutation.mutate<{ paused: boolean }>(
      "/api/admin/jobs/pause",
      "PUT",
      { paused: !paused },
    );
    if (result?.ok) {
      setNotice(
        result.data.paused
          ? "Dispatch and delivery paused."
          : "Dispatch and delivery resumed.",
      );
      resource.reload();
    }
  }
  function selectJobs(ids: string[]) {
    setSelection({ query: query.toString(), ids });
    setConfirmation(null);
  }
  function requestAction(action: Action) {
    if (action === "cancel") {
      setConfirmation(action);
    } else {
      void bulk(action);
    }
  }
  function clearFilters() {
    setParams({});
    setConfirmation(null);
  }
  return {
    params,
    setParams,
    resource,
    mutation,
    notice,
    selected,
    confirmation,
    setConfirmation,
    enqueue,
    bulk,
    filter,
    toggleDelivery,
    selectJobs,
    requestAction,
    clearFilters,
  };
}

export function JobsPage() {
  const jobs = useJobManagement();
  return (
    <>
      <PageHeading title="Job management" />
      <p className="muted mb-5">
        Manage background work and inspect delivery failures. Enqueuing a
        delivery job may send Discord messages when server delivery gates permit
        it.
      </p>
      <EnqueueJobForm
        pending={jobs.mutation.pending}
        onEnqueue={(type, season, week) => {
          void jobs.enqueue(type, season, week);
        }}
      />
      {jobs.notice && (
        <p role="status" className="alert success mb-4">
          {jobs.notice}
        </p>
      )}
      <ErrorNotice error={jobs.mutation.error} />
      <section className="mb-5">
        <h2 className="mb-3 text-lg font-semibold">Recent jobs</h2>
        <JobFilters
          params={jobs.params}
          onFilter={jobs.filter}
          onClear={jobs.clearFilters}
          onRefresh={jobs.resource.reload}
        />
        <ResourceView resource={jobs.resource}>
          {(data) => (
            <>
              <GlobalDeliveryControl
                paused={data.paused}
                pending={jobs.mutation.pending}
                onToggle={() => {
                  void jobs.toggleDelivery(data.paused);
                }}
              />
              {data.runs.length ? (
                <>
                  <JobRunsTable
                    runs={data.runs}
                    selected={jobs.selected}
                    onSelect={jobs.selectJobs}
                  />
                  {jobs.selected.length > 0 && (
                    <BulkJobActions
                      count={jobs.selected.length}
                      pending={jobs.mutation.pending}
                      confirmation={jobs.confirmation}
                      onAction={jobs.requestAction}
                      onConfirm={() => {
                        if (jobs.confirmation) {
                          void jobs.bulk(jobs.confirmation);
                        }
                      }}
                      onKeep={() => {
                        jobs.setConfirmation(null);
                      }}
                    />
                  )}
                </>
              ) : (
                <p className="panel">No jobs match these filters.</p>
              )}
              <JobsPagination
                params={jobs.params}
                setParams={jobs.setParams}
                runs={data.runs}
                hasMore={data.hasMore}
              />
              <RecurringSchedules schedules={data.schedules} />
            </>
          )}
        </ResourceView>
      </section>
    </>
  );
}

function EnqueueJobForm({
  pending,
  onEnqueue,
}: {
  pending: boolean;
  onEnqueue: (type: JobType, season: number, week: string) => void;
}) {
  const [type, setType] = useState<JobType>("deliver_submission_links");
  const [params] = useSearchParams();
  const [week, setWeek] = useState(params.get("week") ?? "");
  const seasons = useResource<SeasonsData>("/api/seasons");
  const [selectedSeason, setSeason] = useState(params.get("season") ?? "");
  const season = selectedSeason || String(seasons.data?.currentSeason ?? "");
  return (
    <section className="panel mb-5">
      <h2 className="mb-3 text-lg font-semibold">Enqueue a job</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (season) {
            onEnqueue(type, Number(season), week);
          }
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          Job type
          <select
            className="input"
            value={type}
            onChange={(event) => {
              const selectedType = JOB_TYPES.find(
                (value) => value === event.target.value,
              );
              if (selectedType) {
                setType(selectedType);
              }
            }}
          >
            {JOB_TYPES.map((value) => (
              <option key={value} value={value}>
                {JOB_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Job season
          <select
            className="input w-auto"
            required
            value={season}
            disabled={seasons.loading}
            onChange={(event) => {
              setSeason(event.target.value);
            }}
          >
            {!seasons.data && <option value="">Loading seasons…</option>}
            {seasons.data?.seasons.map((year) => (
              <option key={year} value={year}>
                {year} season
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Job week
          <input
            className="input w-32"
            type="number"
            min="1"
            max="18"
            step="1"
            placeholder="Current"
            value={week}
            onChange={(event) => {
              setWeek(event.target.value);
            }}
          />
        </label>
        <button
          type="submit"
          className="button primary"
          disabled={pending || !seasons.data}
        >
          Enqueue job
        </button>
      </form>
      <ErrorNotice error={seasons.error} retry={seasons.reload} />
      <p className="muted mt-2 text-xs">
        Leave week blank only for the current regular-season week within the
        selected season.
      </p>
    </section>
  );
}

function JobFilters({
  params,
  onFilter,
  onClear,
  onRefresh,
}: {
  params: URLSearchParams;
  onFilter: (name: string, value: string) => void;
  onClear: () => void;
  onRefresh: () => void;
}) {
  const seasons = useResource<SeasonsData>("/api/seasons");
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        Filter season
        <select
          className="input w-auto"
          value={params.get("season") ?? ""}
          onChange={(event) => {
            onFilter("season", event.target.value);
          }}
        >
          <option value="">All seasons</option>
          {seasons.data?.seasons.map((year) => (
            <option key={year} value={year}>
              {year} season
            </option>
          ))}
        </select>
      </label>
      <ErrorNotice error={seasons.error} retry={seasons.reload} />
      <label className="flex flex-col gap-1">
        Filter job type
        <select
          className="input"
          value={params.get("type") ?? ""}
          onChange={(event) => {
            onFilter("type", event.target.value);
          }}
        >
          <option value="">All job types</option>
          {JOB_TYPES.map((value) => (
            <option key={value} value={value}>
              {JOB_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const status = new FormData(event.currentTarget).get("status");
          onFilter("status", typeof status === "string" ? status.trim() : "");
        }}
      >
        <label className="flex flex-col gap-1">
          Filter status
          <input
            key={params.get("status")}
            className="input w-44"
            name="status"
            defaultValue={params.get("status") ?? ""}
            placeholder="e.g. errored"
          />
        </label>
        <button className="button secondary" type="submit">
          Apply status
        </button>
      </form>
      <button className="button secondary" onClick={onClear}>
        Clear filters
      </button>
      <button className="button secondary" onClick={onRefresh}>
        Refresh jobs
      </button>
    </div>
  );
}

function GlobalDeliveryControl({
  paused,
  pending,
  onToggle,
}: {
  paused: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="panel mb-4 flex flex-wrap items-center justify-between gap-3">
      <p role="status">
        Global dispatch and delivery:{" "}
        <strong>{paused ? "Paused" : "Active"}</strong>
      </p>
      <button
        className="button secondary"
        disabled={pending}
        onClick={onToggle}
      >
        {paused ? "Resume all delivery" : "Pause all delivery"}
      </button>
    </div>
  );
}

function JobRunsTable({
  runs,
  selected,
  onSelect,
}: {
  runs: JobRun[];
  selected: string[];
  onSelect: (ids: string[]) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">Recent job runs</caption>
        <thead>
          <tr>
            <th scope="col">
              <label className="check-label">
                <input
                  type="checkbox"
                  aria-label="Select all visible jobs"
                  checked={
                    runs.length > 0 &&
                    runs.every((run) => selected.includes(run.id))
                  }
                  onChange={(event) => {
                    onSelect(
                      event.target.checked ? runs.map((run) => run.id) : [],
                    );
                  }}
                />
              </label>
            </th>
            <th scope="col">Job</th>
            <th scope="col">Season</th>
            <th scope="col">Week</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col">Error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <label className="check-label">
                  <input
                    type="checkbox"
                    aria-label={`Select job ${run.id}`}
                    checked={selected.includes(run.id)}
                    onChange={(event) => {
                      onSelect(
                        event.target.checked
                          ? [...selected, run.id]
                          : selected.filter((id) => id !== run.id),
                      );
                    }}
                  />
                </label>
              </td>
              <th scope="row">
                <Link
                  className="text-link"
                  to={`/admin/jobs/${encodeURIComponent(run.id)}?season=${run.season}${run.week === null ? "" : `&week=${run.week}`}`}
                >
                  {JOB_LABELS[run.type]}
                  <span className="block text-xs font-normal break-all">
                    {run.id}
                  </span>
                </Link>
              </th>
              <td>{run.season}</td>
              <td>{run.week ?? "Current"}</td>
              <td>
                <span className="badge">{run.status}</span>
              </td>
              <td>{centralDate.format(new Date(run.createdAt))}</td>
              <td className="max-w-xs break-words whitespace-normal">
                {run.error ?? "None"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BulkJobActions({
  count,
  pending,
  confirmation,
  onAction,
  onConfirm,
  onKeep,
}: {
  count: number;
  pending: boolean;
  confirmation: Action | null;
  onAction: (action: Action) => void;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="panel mt-3">
      <p className="mb-3">
        {count} job(s) selected. Invalid state transitions are rejected by the
        server.
      </p>
      <Actions pending={pending} selected onAction={onAction} />
      {confirmation && (
        <div role="alert" className="alert warning mt-3">
          <p>
            Cancel the selected jobs? Work already delivered cannot be undone.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="button danger"
              disabled={pending}
              onClick={onConfirm}
            >
              Confirm cancellation
            </button>
            <button className="button secondary" onClick={onKeep}>
              Keep jobs
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function JobsPagination({
  params,
  setParams,
  runs,
  hasMore,
}: {
  params: URLSearchParams;
  setParams: ReturnType<typeof useSearchParams>[1];
  runs: JobRun[];
  hasMore: boolean;
}) {
  const oldestRun = runs.at(-1);
  return (
    <div className="mt-4 flex gap-3">
      {params.has("before") && (
        <button
          className="button secondary"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete("before");
            setParams(next);
          }}
        >
          Newest jobs
        </button>
      )}
      {hasMore && oldestRun && (
        <button
          className="button secondary"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("before", oldestRun.id);
            setParams(next);
          }}
        >
          Older jobs
        </button>
      )}
    </div>
  );
}

function RecurringSchedules({
  schedules,
}: {
  schedules: JobsData["schedules"];
}) {
  return (
    <section className="panel mt-5">
      <h2 className="mb-3 text-lg font-semibold">Recurring schedules</h2>
      <p className="muted mb-3">
        Cron expressions use UTC. Execution also requires the server’s schedule
        and delivery gates to be enabled.
      </p>
      {schedules.length ? (
        <ul className="space-y-3">
          {schedules.map((schedule, index) => (
            <li
              key={`${schedule.type}-${index}`}
              className="flex flex-wrap justify-between gap-2"
            >
              <span>{JOB_LABELS[schedule.type]}</span>
              <code>{schedule.cron}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>No recurring schedules configured.</p>
      )}
    </section>
  );
}

export function JobDetailPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const resource = useResource<JobDetail>(
    `/api/admin/jobs/${encodeURIComponent(id)}`,
  );
  useResolvedPeriod(resource.data?.run);
  const mutation = useMutation();
  const [confirmation, setConfirmation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  async function action(value: Action) {
    const result = await mutation.mutate<{ run: JobRun }>(
      `/api/admin/jobs/${encodeURIComponent(id)}/action`,
      "POST",
      { action: value },
    );
    if (!result) {
      return;
    }
    setConfirmation(false);
    let run: JobRun | undefined;
    if (result.ok) {
      run = result.data.run;
    } else if (result.error instanceof RequestError) {
      run = result.error.body?.run;
    }
    if (run && run.id !== id) {
      await navigate(
        `/admin/jobs/${encodeURIComponent(run.id)}?season=${run.season}${run.week === null ? "" : `&week=${run.week}`}`,
      );
    } else {
      if (result.ok) {
        setNotice(`Job is now ${result.data.run.status}.`);
      }
      resource.reload();
    }
  }
  return (
    <>
      <PageHeading title="Job details" season={resource.data?.run.season} />
      <div className="mb-5 flex flex-wrap gap-3">
        <Link
          className="button secondary"
          to={`/admin/jobs${periodQuery(params)}`}
        >
          Back to jobs
        </Link>
        <button className="button secondary" onClick={resource.reload}>
          Refresh job
        </button>
      </div>
      {notice && (
        <p role="status" className="alert success mb-4">
          {notice}
        </p>
      )}
      <ErrorNotice error={mutation.error} />
      <ResourceView resource={resource}>
        {({ run, deliveries }) => (
          <>
            <JobRunDetails run={run}>
              <div className="mt-5">
                <Actions
                  pending={mutation.pending}
                  run={run}
                  onAction={(value) => {
                    if (value === "cancel") {
                      setConfirmation(true);
                    } else {
                      void action(value);
                    }
                  }}
                />
              </div>
              {confirmation && (
                <div role="alert" className="alert warning mt-3">
                  <p>
                    Cancel this job? Work already delivered cannot be undone.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="button danger"
                      disabled={mutation.pending}
                      onClick={() => {
                        void action("cancel");
                      }}
                    >
                      Confirm cancellation
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => {
                        setConfirmation(false);
                      }}
                    >
                      Keep job
                    </button>
                  </div>
                </div>
              )}
            </JobRunDetails>
            <DeliveryRecords run={run} deliveries={deliveries} />
          </>
        )}
      </ResourceView>
    </>
  );
}

function JobRunDetails({
  run,
  children,
}: {
  run: JobRun;
  children: ReactNode;
}) {
  const plannedAt = run.plannedAt ?? run.params.notBefore;
  return (
    <section className="panel mb-5">
      <h2 className="mb-4 text-lg font-semibold">{JOB_LABELS[run.type]}</h2>
      <dl className="detail-grid">
        <dt>Run ID</dt>
        <dd className="font-mono text-sm break-all">{run.id}</dd>
        <dt>Status</dt>
        <dd>{run.status}</dd>
        <dt>Season</dt>
        <dd>{run.season}</dd>
        <dt>Week</dt>
        <dd>{run.week ?? "Current at execution"}</dd>
        <dt>Source</dt>
        <dd>{run.source}</dd>
        <dt>Parent run</dt>
        <dd>
          {run.parentId ? (
            <Link
              className="text-link"
              to={`/admin/jobs/${encodeURIComponent(run.parentId)}?season=${run.season}${run.week === null ? "" : `&week=${run.week}`}`}
            >
              {run.parentId}
            </Link>
          ) : (
            "None"
          )}
        </dd>
        <dt>Parameters</dt>
        <dd>
          <pre className="text-sm break-all whitespace-pre-wrap">
            {JSON.stringify(run.params, null, 2)}
          </pre>
        </dd>
        <dt>Created</dt>
        <dd>{centralDate.format(new Date(run.createdAt))}</dd>
        <dt>Updated</dt>
        <dd>{centralDate.format(new Date(run.updatedAt))}</dd>
        <dt>Started</dt>
        <dd>
          {run.startedAt
            ? centralDate.format(new Date(run.startedAt))
            : "Not started"}
        </dd>
        <dt>Finished</dt>
        <dd>
          {run.finishedAt
            ? centralDate.format(new Date(run.finishedAt))
            : "Not finished"}
        </dd>
        <dt>Planned execution</dt>
        <dd>
          {plannedAt
            ? centralDate.format(new Date(plannedAt))
            : "Not scheduled"}
        </dd>
        <dt>Error</dt>
        <dd className="break-words whitespace-pre-wrap">
          {run.error ?? "None"}
        </dd>
      </dl>
      {children}
    </section>
  );
}

function DeliveryRecords({ run, deliveries }: JobDetail) {
  return (
    <>
      <h2 className="mb-3 text-lg font-semibold">Delivery records</h2>
      {deliveries.length ? (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Delivery records for job {run.id}
            </caption>
            <thead>
              <tr>
                <th scope="col">Delivery key</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.key}>
                  <th scope="row" className="break-all">
                    {delivery.key}
                  </th>
                  <td>{delivery.status}</td>
                  <td>{centralDate.format(new Date(delivery.updatedAt))}</td>
                  <td className="break-words whitespace-pre-wrap">
                    {delivery.error ?? "None"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="panel">No delivery records yet.</p>
      )}
    </>
  );
}
