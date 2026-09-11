import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provisionInfrastructure,
  type InfrastructureAdapters,
  type TerraformRuntime,
} from "../../scripts/infrastructure.mjs";

const accountId = "a".repeat(32);
const databaseId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const name = "nfl-pickem-staging";
const approved = { environment: "staging", accountId, approveCloud: true };
const provider = "registry.terraform.io/cloudflare/cloudflare";

type Outputs = Record<
  | "account_id"
  | "environment"
  | "database_name"
  | "worker_name"
  | "database_id"
  | "worker_id",
  { sensitive: boolean; value: string | undefined }
>;
interface ResourceValues {
  account_id: string;
  name: string;
  id?: string;
  subdomain?: { enabled: boolean; previews_enabled: boolean };
}
interface Resource {
  address: string;
  mode: string;
  type: string;
  name: string;
  provider_name: string;
  values: ResourceValues;
}
interface Plan {
  planned_values: { root_module: { resources: Resource[] }; outputs: Outputs };
  resource_changes: (Resource & {
    change: {
      actions: string[];
      before: ResourceValues | null;
      after: ResourceValues;
    };
  })[];
}
interface RunnerOptions {
  existing?: boolean;
  alter?: (value: Plan) => void;
  failApply?: boolean;
  tamper?: boolean;
  existingOutputs?: Outputs;
}
interface Runner {
  adapters: InfrastructureAdapters;
  mutations: string[];
  operations: string[];
}

function outputs(known = true): Outputs {
  return {
    account_id: { sensitive: false, value: accountId },
    environment: { sensitive: false, value: "staging" },
    database_name: { sensitive: false, value: name },
    worker_name: { sensitive: false, value: name },
    database_id: { sensitive: false, value: known ? databaseId : undefined },
    worker_id: { sensitive: false, value: known ? workerId : undefined },
  };
}

function plan(existing = false) {
  const resources = ["cloudflare_d1_database", "cloudflare_worker"].map(
    (type) => ({
      address: `${type}.app`,
      mode: "managed",
      type,
      name: "app",
      provider_name: provider,
      values: {
        account_id: accountId,
        name,
        ...(existing
          ? { id: type === "cloudflare_worker" ? workerId : databaseId }
          : {}),
        ...(type === "cloudflare_worker"
          ? { subdomain: { enabled: false, previews_enabled: false } }
          : {}),
      },
    }),
  );
  return {
    format_version: "1.2",
    complete: true,
    errored: false,
    variables: {
      account_id: { value: accountId },
      environment: { value: "staging" },
    },
    planned_values: { root_module: { resources }, outputs: outputs(existing) },
    resource_changes: resources.map((resource) => ({
      ...resource,
      change: {
        actions: [existing ? "no-op" : "create"],
        before: existing ? resource.values : null,
        after: resource.values,
      },
    })),
  };
}

async function fixture(
  callback: (io: Runner, homeDirectory: string) => Promise<void>,
  options: RunnerOptions = {},
) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "pickem-terraform-"));
  try {
    await callback(runner(homeDirectory, options), homeDirectory);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

function runner(homeDirectory: string, options: RunnerOptions = {}): Runner {
  let exists = options.existing ?? false;
  const mutations: string[] = [];
  const operations: string[] = [];

  async function createPlan(args: string[]) {
    const output = args.find((arg) => arg.startsWith("-out="));
    assert(output, "Plan output path required");
    await writeFile(output.slice(5), "reviewed-plan", { mode: 0o600 });
    return { code: exists ? 0 : 2, stdout: "" };
  }

  async function showPlan(args: string[]) {
    const value = plan(exists);
    options.alter?.(value);
    if (options.tamper) {
      const planPath = args[2];
      assert(planPath, "Saved plan path required");
      await writeFile(planPath, "different-plan");
    }
    return { code: 0, stdout: JSON.stringify(value) };
  }

  async function applyPlan(args: string[], runtime: TerraformRuntime) {
    // The simulated cloud refuses a replanning apply or any bytes not reviewed above.
    const planPath = args.at(-1);
    assert(planPath, "Saved plan path required");
    if ((await readFile(planPath, "utf8")) !== "reviewed-plan") {
      throw new Error("unreviewed mutation");
    }
    mutations.push("D1 and Worker");
    if (options.failApply) {
      return {
        code: 1,
        stdout: "secret-provider-response",
        stderr: "secret-token",
      };
    }
    exists = true;
    const statePath = join(runtime.env.TF_DATA_DIR, "..", "terraform.tfstate");
    await writeFile(statePath, JSON.stringify({ outputs: outputs() }), {
      mode: 0o600,
    });
    return { code: 0, stdout: "" };
  }

  const run = async (args: string[], runtime: TerraformRuntime) => {
    const operation = args[0];
    assert(operation, "Terraform operation required");
    operations.push(operation);
    switch (operation) {
      case "init":
        return { code: 0, stdout: "" };
      case "output":
        return {
          code: 0,
          stdout: JSON.stringify(
            exists ? (options.existingOutputs ?? outputs()) : {},
          ),
        };
      case "plan":
        return createPlan(args);
      case "show":
        return showPlan(args);
      case "apply":
        return applyPlan(args, runtime);
      default:
        throw new Error("Unexpected Terraform operation");
    }
  };
  return { adapters: { homeDirectory, run }, mutations, operations };
}

function resourceChange(plan: Plan, index: number) {
  const change = plan.resource_changes[index];
  assert(change, "Expected fixture resource");
  return change;
}

describe("bounded Terraform provisioning", () => {
  it("creates only reviewed infrastructure and preserves private state on an idempotent rerun", async () => {
    await fixture(async ({ adapters, mutations }, home) => {
      const first = await provisionInfrastructure(approved, adapters);
      expect(first).toEqual({
        databaseId,
        workerId,
        changed: true,
        statePath: join(
          home,
          ".config/nfl-pickem/terraform/staging/terraform.tfstate",
        ),
      });
      expect((await stat(first.statePath)).mode & 0o077).toBe(0);
      expect((await stat(join(first.statePath, ".."))).mode & 0o077).toBe(0);
      const before = await readFile(first.statePath, "utf8");
      const second = await provisionInfrastructure(
        { ...approved, databaseId },
        adapters,
      );
      expect(second.changed).toBe(false);
      expect(mutations).toEqual(["D1 and Worker"]);
      expect(await readFile(first.statePath, "utf8")).toBe(before);
    });
  });

  it.each([
    [
      "wrong account",
      (p: Plan) => {
        resourceChange(p, 0).change.after.account_id = "b".repeat(32);
      },
    ],
    [
      "wrong name",
      (p: Plan) => {
        resourceChange(p, 1).change.after.name = "nfl-pickem-production";
      },
    ],
    [
      "extra resource",
      (p: Plan) => {
        p.resource_changes.push({
          ...resourceChange(p, 0),
          address: "cloudflare_d1_database.other",
        });
      },
    ],
    [
      "deletion",
      (p: Plan) => {
        resourceChange(p, 0).change.actions = ["delete"];
      },
    ],
    [
      "update",
      (p: Plan) => {
        resourceChange(p, 0).change.actions = ["update"];
      },
    ],
    [
      "replacement",
      (p: Plan) => {
        resourceChange(p, 0).change.actions = ["delete", "create"];
      },
    ],
    [
      "public preview",
      (p: Plan) => {
        const subdomain = resourceChange(p, 1).change.after.subdomain;
        assert(subdomain, "Expected Worker subdomain settings");
        subdomain.previews_enabled = true;
      },
    ],
    [
      "output environment",
      (p: Plan) => {
        p.planned_values.outputs.environment.value = "production";
      },
    ],
  ])("refuses %s without any cloud mutation", async (_label, alter) => {
    await fixture(
      async ({ adapters, mutations }) => {
        await expect(
          provisionInfrastructure(approved, adapters),
        ).rejects.toThrow();
        expect(mutations).toEqual([]);
      },
      { alter },
    );
  });

  it("refuses a configured D1 without matching existing state before planning", async () => {
    await fixture(async ({ adapters, operations, mutations }) => {
      await expect(
        provisionInfrastructure({ ...approved, databaseId }, adapters),
      ).rejects.toThrow("no matching Terraform state");
      expect(operations).not.toContain("plan");
      expect(mutations).toEqual([]);
    });
    await fixture(
      async ({ adapters, operations, mutations }) => {
        await expect(
          provisionInfrastructure(
            { ...approved, databaseId: "33333333-3333-4333-8333-333333333333" },
            adapters,
          ),
        ).rejects.toThrow("does not match Terraform state");
        expect(operations).not.toContain("plan");
        expect(mutations).toEqual([]);
      },
      { existing: true },
    );
  });

  it("refuses existing state from another account before planning", async () => {
    const existingOutputs = outputs();
    existingOutputs.account_id.value = "b".repeat(32);
    await fixture(
      async ({ adapters, operations }) => {
        await expect(
          provisionInfrastructure({ ...approved, databaseId }, adapters),
        ).rejects.toThrow("identity mismatch");
        expect(operations).not.toContain("plan");
      },
      { existing: true, existingOutputs },
    );
  });

  it("refuses plan bytes changed after inspection rather than applying unreviewed content", async () => {
    await fixture(
      async ({ adapters, mutations }) => {
        await expect(
          provisionInfrastructure(approved, adapters),
        ).rejects.toThrow("plan changed");
        expect(mutations).toEqual([]);
      },
      { tamper: true },
    );
  });

  it("withholds provider diagnostics and never retries ambiguous creation", async () => {
    await fixture(
      async ({ adapters, mutations, operations }, home) => {
        let message = "";
        try {
          await provisionInfrastructure(approved, adapters);
        } catch (error) {
          assert(error instanceof Error);
          message = error.message;
        }
        expect(message).toContain("Terraform apply failed");
        expect(message).not.toContain("secret");
        expect(mutations).toEqual(["D1 and Worker"]);
        expect(operations.at(-1)).toBe("apply");
        const stateDirectory = join(
          home,
          ".config/nfl-pickem/terraform/staging",
        );
        const planDirectory = (await readdir(stateDirectory)).find((name) =>
          name.startsWith("plan-"),
        );
        if (!planDirectory) {
          throw new Error("Failed operation diagnostics were not retained");
        }
        expect(
          (
            await stat(
              join(stateDirectory, planDirectory, "terraform-error.json"),
            )
          ).mode & 0o077,
        ).toBe(0);
      },
      { failApply: true },
    );
  });

  it("rejects approval or environment errors before running Terraform", async () => {
    await fixture(async ({ adapters, operations }) => {
      await expect(
        provisionInfrastructure({ ...approved, approveCloud: false }, adapters),
      ).rejects.toThrow("--approve-cloud");
      await expect(
        provisionInfrastructure(
          { ...approved, environment: "../production" },
          adapters,
        ),
      ).rejects.toThrow("Explicit");
      expect(operations).toEqual([]);
    });
  });

  it("refuses non-private existing state instead of silently using it", async () => {
    await fixture(async ({ adapters, mutations }) => {
      const first = await provisionInfrastructure(approved, adapters);
      await chmod(first.statePath, 0o644);
      await expect(
        provisionInfrastructure({ ...approved, databaseId }, adapters),
      ).rejects.toThrow("owner-only");
      expect(mutations).toEqual(["D1 and Worker"]);
    });
  });
});
