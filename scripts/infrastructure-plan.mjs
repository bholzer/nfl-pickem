const provider = "registry.terraform.io/cloudflare/cloudflare";
/** @type {Readonly<Record<string, string>>} */
const resources = {
  "cloudflare_d1_database.app": "cloudflare_d1_database",
  "cloudflare_worker.app": "cloudflare_worker",
};
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const workerIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

/** @typedef {{environment: string, accountId: string, name: string, databaseId?: string, workerId?: string}} InfrastructureTarget */
/** @typedef {{databaseId: string, workerId: string}} InfrastructureIds */

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
export function requireThat(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null;
}

/** @param {unknown} value */
function object(value) {
  return isObject(value) ? value : undefined;
}

/** @param {unknown} value @returns {value is unknown[]} */
function isArray(value) {
  return Array.isArray(value);
}

/** @param {string | undefined} text @returns {unknown} */
export function parse(text) {
  try {
    requireThat(
      typeof text === "string",
      "Invalid Terraform JSON; provider contents withheld",
    );
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid Terraform JSON; provider contents withheld");
  }
}

/** @param {unknown} outputs @param {InfrastructureTarget} target */
function outputIdentity(outputs, target) {
  requireThat(isObject(outputs), "Terraform outputs missing");
  const expected = {
    account_id: target.accountId,
    environment: target.environment,
    database_name: target.name,
    worker_name: target.name,
  };
  const keys = [...Object.keys(expected), "database_id", "worker_id"];
  requireThat(
    Object.keys(outputs).length === keys.length &&
      keys.every((key) => key in outputs),
    "Unexpected Terraform outputs",
  );
  for (const [key, value] of Object.entries(expected)) {
    const output = object(outputs[key]);
    requireThat(
      output?.value === value && output.sensitive === false,
      "Terraform output identity mismatch",
    );
  }
  const database = object(outputs.database_id);
  const worker = object(outputs.worker_id);
  requireThat(
    database?.sensitive === false && worker?.sensitive === false,
    "Unexpected sensitive Terraform outputs",
  );
  return { databaseId: database.value, workerId: worker.value };
}

/**
 * @overload
 * @param {unknown} outputs
 * @param {InfrastructureTarget} target
 * @param {true} requireIds
 * @returns {InfrastructureIds}
 */
/**
 * @overload
 * @param {unknown} outputs
 * @param {InfrastructureTarget} target
 * @param {boolean} requireIds
 * @returns {{databaseId: string | undefined, workerId: string | undefined}}
 */
/** @param {unknown} outputs @param {InfrastructureTarget} target @param {boolean} requireIds */
export function checkOutputs(outputs, target, requireIds) {
  const ids = outputIdentity(outputs, target);
  const databaseId = outputId(
    ids.databaseId,
    requireIds,
    uuid,
    "Terraform database output must be a UUID",
  );
  const workerId = outputId(
    ids.workerId,
    requireIds,
    workerIdPattern,
    "Terraform Worker output ID missing or invalid",
  );
  checkExistingId(
    databaseId,
    target.databaseId,
    "Configured D1 ID does not match Terraform state",
  );
  checkExistingId(
    workerId,
    target.workerId,
    "Terraform Worker output differs from existing state",
  );
  return { databaseId, workerId };
}

/** @param {unknown} value @param {boolean} required @param {RegExp} pattern @param {string} message */
function outputId(value, required, pattern, message) {
  if (value === undefined && !required) {
    return undefined;
  }
  requireThat(typeof value === "string" && pattern.test(value), message);
  return value;
}

/** @param {unknown} actual @param {string | undefined} expected @param {string} message */
function checkExistingId(actual, expected, message) {
  if (expected && actual !== undefined) {
    requireThat(actual === expected, message);
  }
}

/** @param {Record<string, unknown>} resource */
function checkResourceIdentity(resource) {
  requireThat(
    typeof resource.address === "string" &&
      Object.hasOwn(resources, resource.address) &&
      resources[resource.address] === resource.type &&
      resource.name === "app" &&
      resource.mode === "managed" &&
      resource.provider_name === provider &&
      !resource.module_address &&
      resource.index === undefined,
    "Terraform plan contains an unapproved resource",
  );
}

/** @param {unknown} resource @param {unknown} values @param {InfrastructureTarget} target */
function checkResource(resource, values, target) {
  requireThat(
    isObject(resource),
    "Terraform plan contains an unapproved resource",
  );
  checkResourceIdentity(resource);
  requireThat(
    isObject(values) &&
      values.account_id === target.accountId &&
      values.name === target.name,
    "Terraform resource account/name mismatch",
  );
  if (resource.type === "cloudflare_worker") {
    const subdomain = object(values.subdomain);
    requireThat(
      subdomain?.enabled === false && subdomain.previews_enabled === false,
      "Terraform Worker public access must remain disabled",
    );
    if (target.workerId) {
      requireThat(
        values.id === target.workerId,
        "Terraform Worker ID differs from existing state",
      );
    }
  }
  if (resource.type === "cloudflare_d1_database" && target.databaseId) {
    requireThat(
      values.id === target.databaseId,
      "Configured D1 ID does not match planned database",
    );
  }
}

/** @param {unknown} value */
function hasEntries(value) {
  return Boolean(
    typeof value === "string" ? value.length : object(value)?.length,
  );
}

/** @param {unknown} root @param {InfrastructureTarget} target @param {boolean} exact */
function checkTree(root, target, exact) {
  requireThat(
    isObject(root) &&
      !hasEntries(root.child_modules) &&
      isArray(root.resources),
    "Unexpected Terraform resource tree",
  );
  /** @type {Set<unknown>} */
  const seen = new Set();
  for (const resource of root.resources) {
    const entry = object(resource);
    requireThat(entry, "Terraform plan contains an unapproved resource");
    requireThat(!seen.has(entry.address), "Duplicate Terraform resource");
    seen.add(entry.address);
    checkResource(entry, entry.values, target);
  }
  requireThat(
    !exact || seen.size === 2,
    "Terraform plan must contain exactly the approved D1 and Worker",
  );
}

/** @param {Record<string, unknown>} plan @param {InfrastructureTarget} target */
function checkPlanIdentity(plan, target) {
  requireThat(
    plan.errored !== true &&
      plan.complete !== false &&
      !hasEntries(plan.deferred_changes),
    "Terraform plan is incomplete",
  );
  const variables = object(plan.variables);
  requireThat(
    variables &&
      object(variables.account_id)?.value === target.accountId &&
      object(variables.environment)?.value === target.environment &&
      Object.keys(variables).length === 2,
    "Terraform plan variable identity mismatch",
  );
  checkPlanTrees(plan, target);
}

/** @param {Record<string, unknown>} plan @param {InfrastructureTarget} target */
function checkPlanTrees(plan, target) {
  const planned = object(plan.planned_values);
  checkTree(planned?.root_module, target, true);
  checkOutputs(planned?.outputs, target, false);
  const priorValues = object(object(plan.prior_state)?.values);
  const priorRoot = object(priorValues?.root_module);
  if (
    hasEntries(priorRoot?.resources) ||
    hasEntries(priorRoot?.child_modules)
  ) {
    checkTree(priorRoot, target, false);
  }
}

/** @param {Record<string, unknown>} resource @param {InfrastructureTarget} target */
function inspectChange(resource, target) {
  const change = object(resource.change);
  checkResource(resource, change?.after, target);
  requireThat(change, "Terraform resource account/name mismatch");
  requireThat(
    !resource.previous_address && !change.importing && !change.generated_config,
    "Terraform adoption or moves are not approved",
  );
  const actions = change.actions;
  requireThat(
    isArray(actions) &&
      actions.length === 1 &&
      (actions[0] === "create" || actions[0] === "no-op"),
    "Terraform permits only create or no-op; updates/deletes/replacements are refused",
  );
  if (actions[0] === "create") {
    requireThat(
      change.before === null,
      "Terraform creation must not replace existing state",
    );
    return true;
  }
  return false;
}

/** @param {unknown} plan @param {InfrastructureTarget} target */
export function inspectPlan(plan, target) {
  requireThat(isObject(plan), "Terraform plan is incomplete");
  checkPlanIdentity(plan, target);
  requireThat(
    isArray(plan.resource_changes) && plan.resource_changes.length === 2,
    "Terraform plan must describe exactly two resources",
  );
  /** @type {Set<unknown>} */
  const seen = new Set();
  let changed = false;
  for (const resource of plan.resource_changes) {
    const entry = object(resource);
    requireThat(entry, "Terraform plan contains an unapproved resource");
    requireThat(!seen.has(entry.address), "Duplicate Terraform change");
    seen.add(entry.address);
    const created = inspectChange(entry, target);
    changed = created || changed;
  }
  return changed;
}
