/**
 * Drive the bench app with a real chaosbringer crawl and `packages/jev-driver`.
 *
 *   npx tsx src/run-jev-driver.ts                    # the typed action space
 *   npx tsx src/run-jev-driver.ts --arm flat         # the docs/57 shape, for contrast
 *   npx tsx src/run-jev-driver.ts --steps 8 --select
 *
 * Two arms over one crawler, one app and one goal:
 *
 *   fanout  `packages/jev-driver` — one request per step carrying the
 *           operation question and every target head, with the geometry
 *           in the state as a fact.
 *   flat    `src/jev-driver.ts` — one `pick` over every candidate
 *           whatever its type, no operation, no geometry, and a
 *           confidence gate. This is the shape that existed before
 *           docs/61 and docs/62, kept here as the thing to beat.
 *
 * What the arms can differ on is narrow and worth saying up front: both
 * click the same way, so the difference shows up only where an operation
 * other than a click is the right move — a dropdown that has to be set,
 * a field that has to be emptied. On a board with no such step they
 * should agree, and a run where they agree is not a null result about
 * the action space; it is a board that never asked the question.
 */
import { ChaosCrawler } from "chaosbringer";
import { Jev, jevDriver, type DecisionLog } from "../../../packages/jev-driver/src/driver.js";
import { jevDriver as flatJevDriver } from "./jev-driver.js";
import { Jev as SharedJev } from "../../shared/jev.js";
import { serve } from "./serve.mjs";
import { createServer } from "node:http";

interface Args {
  arm: "fanout" | "flat";
  steps: number;
  select: boolean;
  routes: boolean;
  start: string;
  board: "spa" | "fields";
  goal: string;
}

function parseArgs(argv: string[]): Args {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    arm: (arg("arm") ?? "fanout") as Args["arm"],
    steps: Number(arg("steps") ?? 10),
    select: argv.includes("--select"),
    routes: argv.includes("--routes"),
    // The entry screen offers only nav links and decoys, so a crawl that
    // starts there never reaches a field and the typed action space
    // collapses to CLICK. `#/products` is one click from a cart.
    start: arg("start") ?? "",
    board: (arg("board") ?? "spa") as Args["board"],
    goal: arg("goal") ?? "",
  };
}

const DEFAULT_GOALS: Record<Args["board"], string> = {
  spa: "Place the order. The order is placed when the page says the order is confirmed.",
  fields:
    "Ship this order by express, to nowhere: the delivery address should be blank and the shipping method should be express.",
};

/**
 * A page whose initial HTML already holds one control of each kind.
 *
 * The `spa` board cannot exercise the action space, and it is worth
 * writing down why rather than quietly picking another: it routes by
 * hash, and the crawler's page identity ignores a fragment, so clicking
 * its nav returns to the default route and the candidate list never
 * changes. A crawl there never reaches a field, so `operation` collapses
 * to CLICK and the arms cannot differ. That is a property of the board
 * and the crawler's link handling, not a result about the action space.
 *
 * So this board asks the question in the first response: a field with
 * something in it (CLEAR), a field with nothing in it (TYPE_TEXT), a
 * dropdown that is not already on the wanted value (SELECT), and a
 * button (CLICK).
 */
const FIELDS_PAGE = `<!doctype html><title>delivery</title><body>
  <h1>Delivery</h1>
  <label for="address">Delivery address</label>
  <input id="address" name="address" type="text" value="1 Example Street">
  <label for="note">Delivery note</label>
  <input id="note" name="note" type="text" value="">
  <label for="shipping">Shipping method</label>
  <select id="shipping" name="shipping">
    <option value="standard" selected>Standard (5 days)</option>
    <option value="express">Express (next day)</option>
  </select>
  <button type="button" id="save">Save delivery details</button>
  <button type="button" id="reset">Start over</button>
  <p id="out">standard, to 1 Example Street</p>
  <script>
    const read = () => document.getElementById("out").textContent =
      document.getElementById("shipping").value + ", to " +
      (document.getElementById("address").value || "(nowhere)");
    for (const id of ["address", "note", "shipping"]) {
      document.getElementById(id).addEventListener("change", read);
      document.getElementById(id).addEventListener("input", read);
    }
  </script>
</body>`;

async function board(args: Args): Promise<{ url: string; close: () => void }> {
  if (args.board === "fields") {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(FIELDS_PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    return { url: `http://127.0.0.1:${addr.port}/`, close: () => server.close() };
  }
  const srv = (await serve()) as { server: { close(): void }; url: string };
  const query = [args.select ? "select=1" : "", args.routes ? "routes=1" : ""]
    .filter(Boolean)
    .join("&");
  return {
    url: `${srv.url}${query ? `?${query}` : ""}${args.start}`,
    close: () => srv.server.close(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { url: baseUrl, close } = await board(args);
  const goal = args.goal || DEFAULT_GOALS[args.board];

  const logs: DecisionLog[] = [];
  let driver;
  let jevCalls = () => 0;
  let jevMs = () => 0;

  if (args.arm === "fanout") {
    const jev = new Jev({ timeoutMs: 20_000 });
    jevCalls = () => jev.calls;
    jevMs = () => jev.totalMs;
    driver = jevDriver({
      jev,
      goal,
      onDecision: (log) => logs.push(log),
    });
  } else {
    const jev = new SharedJev();
    jevCalls = () => jev.calls;
    jevMs = () => jev.totalMs;
    driver = flatJevDriver({ jev, goal });
  }

  const crawler = new ChaosCrawler({
    baseUrl,
    maxPages: 1,
    maxActionsPerPage: args.steps,
    headless: true,
    timeout: 8000,
    logLevel: "error",
    // Structurally compatible by construction -- `packages/jev-driver`
    // declares the crawler's types rather than importing them, so that
    // it installs against any version in its peer range.
    driver: driver as unknown as Parameters<typeof ChaosCrawler>[0]["driver"],
  });

  const started = Date.now();
  const report = await crawler.start();
  const wallMs = Date.now() - started;
  close();

  const actions = report.actions ?? [];
  const byType = new Map<string, number>();
  for (const a of actions) byType.set(a.type, (byType.get(a.type) ?? 0) + 1);

  console.log(`\narm         ${args.arm}`);
  console.log(`board       ${baseUrl}`);
  console.log(`goal        ${goal}`);
  console.log(`steps       ${actions.length} of ${args.steps} allowed`);
  console.log(`requests    ${jevCalls()}`);
  console.log(`model ms    ${jevMs()}  (wall ${wallMs})`);
  console.log(`failed      ${actions.filter((a) => !a.success).length}`);
  console.log(
    `actions     ${[...byType].map(([t, n]) => `${t}=${n}`).join(" ") || "(none)"}`,
  );
  console.log(`page errors ${report.pages[0]?.errors.length ?? 0}`);

  if (logs.length > 0) {
    console.log("\nstep  offered                          decision");
    for (const l of logs) {
      const d = l.decision;
      const what = d
        ? `${d.operation} ${d.target?.candidate.description ?? d.targetKey ?? ""} ` +
          `conf=${fmt(d.operationConfidence)}/${fmt(d.targetConfidence)} ` +
          `stuck=${fmt(d.stuck)} unread=${d.unusedHeads.length}`
        : "(unreadable)";
      console.log(
        `${String(l.stepIndex).padStart(4)}  ${l.offered.join(",").padEnd(32)} ${what}` +
          (l.obstructed > 0 ? `  [${l.obstructed} obstructed, still offered]` : "") +
          (l.enrichFailed > 0 ? `  [${l.enrichFailed} unreadable]` : ""),
      );
    }
  }

  // Deliberately not reported: whether the goal was reached. The crawler
  // owns the page and closes it, and a fresh visit would read a reset
  // app rather than what the crawl left -- docs/62 §6.6 is the reason to
  // care, an arm that replayed to the goal and ended `ordered: no`. What
  // is above is what the crawl did, not what it achieved.
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "-";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
