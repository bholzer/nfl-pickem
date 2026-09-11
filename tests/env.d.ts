import type * as WorkerModule from "../src/server/index";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as AppEnv } from "../src/server/env";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
