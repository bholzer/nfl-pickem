import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkOutputs,
  inspectPlan,
  parse,
  requireThat,
  uuid,
} from "./infrastructure-plan.mjs";

/** @typedef {{environment: string, accountId: string, approveCloud: boolean, databaseId?: string}} InfrastructureOptions */
/** @typedef {import('./infrastructure-plan.mjs').InfrastructureTarget} InfrastructureTarget */
/** @typedef {{databaseId: string, workerId: string, changed: boolean, statePath: string}} InfrastructureResult */
/** @typedef {{cwd: string, env: NodeJS.ProcessEnv & {TF_DATA_DIR: string}}} TerraformRuntime */
/** @typedef {{code: number | null, stdout?: string, stderr?: string}} TerraformCommandResult */
/** @typedef {(args: string[], runtime: TerraformRuntime) => Promise<TerraformCommandResult | null | undefined>} TerraformRunner */
/** @typedef {{homeDirectory?: string, run?: TerraformRunner}} InfrastructureAdapters */
/** @typedef {(args: string[], codes?: number[]) => Promise<TerraformCommandResult>} TerraformInvoker */

const configuration = fileURLToPath(
  new URL("../infrastructure/cloudflare/", import.meta.url),
);

/** @param {string[]} args @param {TerraformRuntime} runtime @returns {Promise<TerraformCommandResult>} */
function runTerraform(args, runtime) {
  return new Promise((resolve, reject) => {
    // Only the synchronous spawn inherits this mask; do not change it across awaits.
    const mask = process.umask(0o077);
    let child;
    try {
      child = spawn("terraform", args, {
        ...runtime,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        error instanceof Error ? error : new Error("Terraform spawn failed"),
      );
      return;
    } finally {
      process.umask(mask);
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on(
      "data",
      /** @param {string} chunk */ (chunk) => {
        stdout += chunk;
      },
    );
    child.stderr.on(
      "data",
      /** @param {string} chunk */ (chunk) => {
        stderr += chunk;
      },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** @param {unknown} error @param {string} code */
function hasErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function ownerId() {
  requireThat(
    process.getuid,
    "Terraform requires a platform with file ownership checks",
  );
  return process.getuid();
}

/** @param {string} path @param {boolean} privateMode */
async function directory(path, privateMode = true) {
  try {
    await mkdir(path, { mode: privateMode ? 0o700 : 0o755 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
  const info = await lstat(path);
  requireThat(
    info.isDirectory() && !info.isSymbolicLink() && info.uid === ownerId(),
    "Terraform directory must be an owned, non-symlink directory",
  );
  requireThat(
    !privateMode || (info.mode & 0o077) === 0,
    "Terraform directory must be owner-only",
  );
}

/** @param {string} path @param {boolean} optional */
async function privateFile(path, optional = false) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (optional && hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  requireThat(
    info.isFile() && info.uid === ownerId() && (info.mode & 0o077) === 0,
    "Terraform files must be owned, owner-only regular files",
  );
}

/** @param {Omit<InfrastructureOptions, "approveCloud"> & {approveCloud: unknown}} options @returns {InfrastructureTarget} */
function provisioningTarget({
  environment,
  accountId,
  approveCloud,
  databaseId,
}) {
  requireThat(
    ["staging", "production"].includes(environment),
    "Explicit staging or production environment required",
  );
  // This is also a runtime approval boundary for callers outside TypeScript.
  requireThat(approveCloud === true, "Provisioning requires --approve-cloud");
  requireThat(
    typeof accountId === "string" && /^[0-9a-f]{32}$/.test(accountId),
    "Explicit Cloudflare account ID required",
  );
  requireThat(
    databaseId === undefined || databaseId === "" || uuid.test(databaseId),
    "Configured D1 ID must be a UUID",
  );
  return {
    environment,
    accountId,
    databaseId: databaseId || undefined,
    name: `nfl-pickem-${environment}`,
  };
}

/** @param {string} home @param {string} environment */
async function prepareState(home, environment) {
  const configHome = join(home, ".config");
  await directory(configHome, false);
  const appHome = join(configHome, "nfl-pickem");
  await directory(appHome);
  const terraformHome = join(appHome, "terraform");
  await directory(terraformHome);
  const stateDirectory = join(terraformHome, environment);
  await directory(stateDirectory);
  const statePath = join(stateDirectory, "terraform.tfstate");
  await privateFile(statePath, true);
  await privateFile(`${statePath}.backup`, true);
  const dataDirectory = join(stateDirectory, "data");
  await directory(dataDirectory);
  const lock = join(stateDirectory, "provision.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Terraform provisioning is locked; inspect the prior operation before removing its local lock",
    );
  }
  return { stateDirectory, statePath, dataDirectory, lock };
}

/** @param {{home: string, work: string, dataDirectory: string, target: InfrastructureTarget}} context @returns {Promise<TerraformRuntime>} */
async function terraformRuntime({ home, work, dataDirectory, target }) {
  const cliConfigPath = join(work, "terraform.rc");
  await writeFile(cliConfigPath, "disable_checkpoint = true\n", {
    mode: 0o600,
    flag: "wx",
  });
  // Do not inherit TF_CLI_ARGS, TF_VAR_*, workspace, logging or provider auth overrides.
  return {
    cwd: configuration,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: work,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      TF_DATA_DIR: dataDirectory,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      TF_WORKSPACE: "default",
      TF_VAR_environment: target.environment,
      TF_VAR_account_id: target.accountId,
      CHECKPOINT_DISABLE: "1",
      TF_CLI_CONFIG_FILE: cliConfigPath,
    },
  };
}

/** @param {{run: TerraformRunner, runtime: TerraformRuntime, work: string, retainDiagnostics: boolean}} context @returns {TerraformInvoker} */
function terraformInvoker(context) {
  return async (args, codes = [0]) => {
    let result;
    try {
      result = await context.run(args, context.runtime);
    } catch {
      throw new Error(
        `Terraform ${args[0]} failed; diagnostics withheld; inspect private state before retrying`,
      );
    }
    if (!result || result.code === null || !codes.includes(result.code)) {
      const diagnosticPath = join(context.work, "terraform-error.json");
      await writeFile(
        diagnosticPath,
        JSON.stringify({ command: args[0], ...result }),
        { mode: 0o600, flag: "wx" },
      );
      context.retainDiagnostics = true;
      throw new Error(
        `Terraform ${args[0]} failed; diagnostics withheld from output and saved privately at ${diagnosticPath}; inspect state before retrying`,
      );
    }
    return result;
  };
}

/** @param {TerraformInvoker} invoke @param {InfrastructureTarget} target @param {string} statePath */
async function initializeState(invoke, target, statePath) {
  await invoke([
    "init",
    "-input=false",
    "-no-color",
    "-reconfigure",
    "-lockfile=readonly",
    `-backend-config=path=${statePath}`,
  ]);
  const existing = parse((await invoke(["output", "-json"])).stdout);
  requireThat(
    typeof existing === "object" && existing !== null,
    "Terraform outputs missing",
  );
  if (Object.keys(existing).length) {
    Object.assign(target, checkOutputs(existing, target, true));
  } else {
    requireThat(
      !target.databaseId,
      "Configured D1 ID has no matching Terraform state; automatic adoption is forbidden",
    );
  }
}

/** @param {TerraformInvoker} invoke @param {InfrastructureTarget} target @param {string} planPath */
async function reviewPlan(invoke, target, planPath) {
  const planned = await invoke(
    [
      "plan",
      "-input=false",
      "-no-color",
      "-lock-timeout=0s",
      "-detailed-exitcode",
      `-out=${planPath}`,
    ],
    [0, 2],
  );
  await privateFile(planPath);
  const digest = createHash("sha256")
    .update(await readFile(planPath))
    .digest("hex");
  const plan = parse((await invoke(["show", "-json", planPath])).stdout);
  const changed = inspectPlan(plan, target);
  requireThat(
    (planned.code === 2) === changed,
    "Terraform plan exit status does not match reviewed changes",
  );
  await privateFile(planPath);
  requireThat(
    createHash("sha256")
      .update(await readFile(planPath))
      .digest("hex") === digest,
    "Reviewed Terraform plan changed before apply",
  );
  return changed;
}

/**
 * @param {InfrastructureOptions} options
 * @param {InfrastructureAdapters} adapters
 * @returns {Promise<InfrastructureResult>}
 */
export async function provisionInfrastructure(options, adapters = {}) {
  const target = provisioningTarget(options);
  const home = adapters.homeDirectory ?? homedir();
  const { stateDirectory, statePath, dataDirectory, lock } = await prepareState(
    home,
    target.environment,
  );
  /** @type {string | undefined} */
  let work;
  /** @type {{run: TerraformRunner, runtime: TerraformRuntime, work: string, retainDiagnostics: boolean} | undefined} */
  let execution;
  try {
    work = await mkdtemp(join(stateDirectory, "plan-"));
    const planPath = join(work, "approved.tfplan");
    await writeFile(planPath, "", { mode: 0o600, flag: "wx" });
    const runtime = await terraformRuntime({
      home,
      work,
      dataDirectory,
      target,
    });
    execution = {
      run: adapters.run ?? runTerraform,
      runtime,
      work,
      retainDiagnostics: false,
    };
    const invoke = terraformInvoker(execution);
    await initializeState(invoke, target, statePath);
    const changed = await reviewPlan(invoke, target, planPath);
    if (changed) {
      await invoke([
        "apply",
        "-input=false",
        "-no-color",
        "-lock-timeout=0s",
        planPath,
      ]);
    }
    const outputs = checkOutputs(
      parse((await invoke(["output", "-json"])).stdout),
      target,
      true,
    );
    await privateFile(statePath);
    await privateFile(`${statePath}.backup`, true);
    return { ...outputs, changed, statePath };
  } finally {
    if (work && !execution?.retainDiagnostics) {
      await rm(work, { recursive: true, force: true });
    }
    await rm(lock, { recursive: true });
  }
}
