export type Environment = "staging" | "production";
export interface DatabaseBinding {
  binding: string;
  database_name: string;
  database_id?: string;
  [key: string]: unknown;
}
export interface WorkflowBinding {
  binding: string;
  name: string;
  schedules?: unknown[];
  [key: string]: unknown;
}
interface Route {
  pattern: string;
  custom_domain?: boolean;
  zone_id?: string;
}
export interface Configuration {
  name: string;
  account_id?: string;
  targetEnvironment?: string;
  vars: Record<string, string> & {
    APP_ENV: string;
    APP_ORIGIN: string;
    DISCORD_ALLOWED_CHANNEL_IDS: string;
    DISCORD_CHANNEL_ID: string;
  };
  d1_databases: [DatabaseBinding];
  workflows: [WorkflowBinding];
  routes?: Route[];
  route?: unknown;
  workers_dev?: boolean;
  preview_urls?: boolean;
  triggers?: { crons?: unknown[] };
  assets?: Record<string, unknown>;
  env?: Record<string, Configuration>;
  [key: string]: unknown;
}
export interface SourceConfiguration extends Configuration {
  env: Record<string, Configuration>;
}
// Loaded configuration is not trusted until environmentConfig/verifyDist checks it.
export interface RawConfiguration {
  name?: string;
  vars?: Configuration["vars"];
  d1_databases?: DatabaseBinding[];
  workflows?: WorkflowBinding[];
  [key: string]: unknown;
}
export interface RawSource {
  env?: Record<string, RawConfiguration>;
  vars?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface D1Plan {
  environment: string;
  sourcePath: string;
}
export interface Options {
  env?: string;
  source?: string;
  dist?: string;
  operation?: string;
  file?: string;
  output?: string;
  "account-id"?: string;
  "zone-id"?: string;
  "secrets-file"?: string;
  "approve-cloud"?: boolean;
  "approve-discord"?: boolean;
  "source-quiesced"?: boolean;
  "verified-data"?: boolean;
  "inflight-reviewed"?: boolean;
  "writers-stopped"?: boolean;
  "snapshot-verified"?: boolean;
  "dns-quiesced"?: boolean;
}
export interface Runtime {
  input?: string;
  accountId?: string;
}
// Adapters intentionally may omit stdout on commands that return only an exit code.
export interface CommandResult {
  code: number | null;
  stdout?: string;
}
export type Run = (args: string[], runtime?: Runtime) => Promise<CommandResult>;
export type Api = (
  method: string,
  path: string,
  runtime: Runtime,
) => Promise<unknown>;
interface Domain {
  hostname: string;
  zoneId: string;
}
export interface DomainRecord {
  id: unknown;
  hostname: string;
  zone_id: string;
  service: string;
  environment: string;
}
export interface DomainInventory {
  result: DomainRecord[];
  result_info?: { total_pages?: number };
}
export interface ZoneResponse {
  result?: { id?: string; account?: { id?: string }; name?: string };
}
export interface WorkflowPlan {
  environment: string;
  sourcePath: string;
  workflow: string;
}
export interface Plan extends WorkflowPlan {
  action: string;
  worker: string;
  database: string;
  databaseId: string | null;
  steps: string[][];
  transitions: string[];
  distPath: string;
  domain?: Domain;
  infrastructure?: {
    owner: string;
    configurationPath: string;
    stateEnvironment: string;
    stateDirectory: string;
    resources: { address: string; type: string; name: string }[];
    wranglerOwns: string[];
  };
}
export interface Instance {
  id: string;
  status: string;
}
export interface WorkflowEntry {
  id: string;
  params: Record<string, unknown> & { runId: string; season: number };
}
export interface WorkflowReport {
  created: string[];
  existing: string[];
  failed: string[];
  unattempted: string[];
}
export interface WakeupReport {
  notified: string[];
  failed: string[];
}
export interface Adapters {
  load?: (path: string) => Promise<unknown>;
  run?: Run;
  api?: Api;
  validateSecrets?: (path: string) => Promise<void>;
  provisionInfrastructure?: (options: {
    environment: string;
    accountId: string;
    approveCloud: boolean;
    databaseId?: string;
  }) => Promise<{
    databaseId: string;
    workerId?: string;
    changed?: boolean;
    statePath?: string;
  }>;
}
