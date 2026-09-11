import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import { qualityLimits } from "../eslint.config.mjs";
import manifest from "../package.json" with { type: "json" };

/** @typedef {"cognitive" | "cyclomatic" | "nesting" | "functionLines" | "parameters"} MetricName */
/** @typedef {{file: string, metric: MetricName, value: number, line: number, column: number, message: string}} Measurement */
/** @typedef {{file: string, lines: number, over100: number, over120: number, longestLine: number, measurements: Measurement[]}} FileMetric */

const root = fileURLToPath(new URL("../", import.meta.url));
/** @type {Record<string, {metric: MetricName, pattern: RegExp}>} */
const definitions = {
  complexity: { metric: "cyclomatic", pattern: /complexity of (\d+)/ },
  "sonarjs/cognitive-complexity": {
    metric: "cognitive",
    pattern: /Complexity from (\d+) to/,
  },
  "max-depth": { metric: "nesting", pattern: /too deeply \((\d+)\)/ },
  "max-lines-per-function": {
    metric: "functionLines",
    pattern: /too many lines \((\d+)\)/,
  },
  "max-params": {
    metric: "parameters",
    pattern: /too many parameters \((\d+)\)/,
  },
};

// Threshold zero exposes scores from the official implementations. Different
// rules locate method heads/type signatures differently; keep their locations.
const analyzer = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{ts,tsx,mjs}"],
      ignores: ["**/*.d.ts"],
      languageOptions: { parser: tseslint.parser },
      plugins: { sonarjs },
      rules: {
        complexity: ["warn", { max: 0, variant: "modified" }],
        "sonarjs/cognitive-complexity": ["warn", 0],
        "max-depth": ["warn", 0],
        "max-lines-per-function": [
          "warn",
          { max: 0, skipBlankLines: true, skipComments: true },
        ],
        "max-params": ["warn", 0],
      },
    },
  ],
});

/** @param {string} file @param {import("eslint").Linter.LintMessage} message @returns {Measurement} */
function measurement(file, message) {
  const definition = definitions[message.ruleId ?? ""];
  const value = definition?.pattern.exec(message.message)?.[1];
  if (!definition || value === undefined) {
    throw new Error(
      `Unrecognized metric at ${file}:${message.line}: ${message.message}`,
    );
  }
  return {
    file,
    metric: definition.metric,
    value: Number(value),
    line: message.line,
    column: message.column,
    message: message.message,
  };
}

/** @param {string} line */
function codePointLength(line) {
  const characters = line[Symbol.iterator]();
  let width = 0;
  while (!characters.next().done) {
    width += 1;
  }
  return width;
}

/** @param {import("eslint").ESLint.LintResult} result @returns {Promise<FileMetric>} */
async function inspectFile(result) {
  if (result.fatalErrorCount > 0) {
    throw new Error(
      `Cannot measure ${result.filePath}: ${JSON.stringify(result.messages)}`,
    );
  }
  const file = relative(root, result.filePath);
  const source = result.source ?? (await readFile(result.filePath, "utf8"));
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  const widths = lines.map(codePointLength);
  return {
    file,
    lines: lines.length,
    over100: widths.filter((width) => width > 100).length,
    over120: widths.filter((width) => width > 120).length,
    longestLine: Math.max(0, ...widths),
    measurements: result.messages.map((message) => measurement(file, message)),
  };
}

/** @param {number[]} values @param {number} limit */
function review(values, limit) {
  return {
    maximum: Math.max(0, ...values),
    overLimit: values.filter((value) => value > limit).length,
  };
}

/** @param {number[]} values @param {number} limit @param {number} [observations] */
function distribution(values, limit, observations = values.length) {
  if (observations < values.length) {
    throw new Error(
      "Metric scope counts disagree; inspect the rule outputs before comparing scores",
    );
  }
  values.sort((a, b) => a - b);
  const implicitZeros = observations - values.length;
  const index = Math.ceil(observations * 0.95) - 1 - implicitZeros;
  return { ...review(values, limit), p95: values[index] ?? 0 };
}

/** @param {FileMetric[]} files */
function summarize(files) {
  const measurements = files.flatMap((file) => file.measurements);
  /** @param {MetricName} metric */
  const values = (metric) =>
    measurements
      .filter((item) => item.metric === metric)
      .map((item) => item.value);
  const functions = measurements.filter(
    (item) =>
      item.metric === "cyclomatic" &&
      !/^Class (?:field initializer|static block)/.test(item.message),
  ).length;
  return {
    files: files.length,
    functions,
    physicalLines: files.reduce((sum, file) => sum + file.lines, 0),
    linesOver100: files.reduce((sum, file) => sum + file.over100, 0),
    linesOver120: files.reduce((sum, file) => sum + file.over120, 0),
    longestLine: Math.max(0, ...files.map((file) => file.longestLine)),
    cognitive: distribution(
      values("cognitive"),
      qualityLimits.cognitive,
      functions,
    ),
    cyclomatic: distribution(values("cyclomatic"), qualityLimits.cyclomatic),
    nesting: review(values("nesting"), qualityLimits.nesting),
    functionLines: review(values("functionLines"), qualityLimits.functionLines),
    parameters: review(values("parameters"), qualityLimits.parameters),
  };
}

/** @param {FileMetric[]} files */
function createReport(files) {
  const measurements = files.flatMap((file) => file.measurements);
  return {
    version: 1,
    toolchain: {
      eslint: ESLint.version,
      sonarjs: manifest.devDependencies["eslint-plugin-sonarjs"],
      typescriptEslint: manifest.devDependencies["typescript-eslint"],
    },
    limits: qualityLimits,
    semantics:
      "Official rule scores, not an AST approximation. Cyclomatic includes implicit class initializers/blocks; cognitive uses explicit functions and includes unreported zero scores. Length excludes blank/comment lines. Nesting counts blocks. Parameter review includes type signatures. p95 uses nearest rank. Declarations/generated files are excluded.",
    summary: {
      application: summarize(
        files.filter((file) => file.file.startsWith("src/")),
      ),
      operations: summarize(
        files.filter(
          (file) =>
            file.file.startsWith("scripts/") &&
            file.file !== "scripts/quality.mjs",
        ),
      ),
      qualityTool: summarize(
        files.filter((file) => file.file === "scripts/quality.mjs"),
      ),
      tests: summarize(files.filter((file) => file.file.startsWith("tests/"))),
    },
    hotspots: measurements
      .filter((item) => item.metric === "cognitive")
      .sort((a, b) => b.value - a.value)
      .slice(0, 15),
    measurements,
  };
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/quality.mjs");
  }
  const results = await analyzer.lintFiles(["src", "scripts", "tests"]);
  const report = createReport(await Promise.all(results.map(inspectFile)));
  const output = resolve(root, "tmp/quality/metrics.json");
  await mkdir(resolve(root, "tmp/quality"), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ ...report, measurements: undefined, output }, null, 2),
  );
}

await main();
