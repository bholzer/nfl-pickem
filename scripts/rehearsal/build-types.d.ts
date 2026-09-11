import type { V4WorkerOptions } from "miniflare";

type Assets = NonNullable<V4WorkerOptions["assets"]>;

/** Shape of the local Wrangler output read by the rehearsal runtime. */
export interface CompiledBuild {
  targetEnvironment: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  assets: {
    directory: string;
    binding?: string;
    run_worker_first?: Assets["run_worker_first"];
    html_handling?:
      | "auto-trailing-slash"
      | "force-trailing-slash"
      | "drop-trailing-slash"
      | "none";
    not_found_handling?: "none" | "single-page-application" | "404-page";
  };
  d1_databases?: { binding: string }[];
  workflows?: { binding: string; class_name: string }[];
}
