import { startRehearsal } from "./runtime.mjs";

if (process.argv.length !== 2) {
  throw new Error(
    "Usage: node scripts/rehearsal/serve.mjs (loopback port 5180 only)",
  );
}

/** @type {PromiseWithResolvers<void>} */
const { promise: stopped, resolve: stop } = Promise.withResolvers();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
/** @type {import("./runtime.mjs").Rehearsal | undefined} */
let rehearsal;
try {
  rehearsal = await startRehearsal();
  console.log(
    `Rehearsal ready at ${rehearsal.origin}; isolated synthetic D1; Discord sends disabled; outbound transport blocked.`,
  );
  console.log(`Player link: ${rehearsal.links.player}`);
  console.log(`Admin link: ${rehearsal.links.admin}`);
  console.log(
    "Stop with SIGINT/SIGTERM to remove temporary state. Never use a production credential here.",
  );
  await stopped;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (rehearsal) {
    await rehearsal.close();
    if (rehearsal.upstreams.forbidden.length) {
      console.error(
        "Blocked unexpected upstream requests:",
        rehearsal.upstreams.forbidden,
      );
      process.exitCode = 1;
    }
  }
}
