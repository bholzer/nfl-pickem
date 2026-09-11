import type { D1Database, Fetcher, Workflow } from "@cloudflare/workers-types";
import type { JobParams, User } from "../shared/contracts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS: Workflow<JobParams>;
  APP_ENV: "local" | "staging" | "production";
  APP_ORIGIN: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CHANNEL_ID: string;
  DISCORD_ALLOWED_USER_IDS: string;
  DISCORD_ALLOWED_CHANNEL_IDS: string;
  DISCORD_SEND_ENABLED: string;
  SCHEDULES_ENABLED: string;
  MAINTENANCE_MODE: string;
  SESSION_SECRET: string;
  SUBMISSION_TOKEN_SECRET: string;
}

interface Variables {
  user: User;
  csrfToken: string;
}

export type AppBindings = { Bindings: Env; Variables: Variables };
