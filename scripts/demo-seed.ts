/**
 * Generates 30 days of simulated history with the real polling policy and writes it
 * to .demo/seed.sql, which `npm run demo` loads into the local D1 database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { Poller, initialPollerState } from "../src/poller";
import { Recorder } from "../src/recorder";
import { SimCar, SimFleet } from "../src/simulator";
import { Store } from "../src/store";
import { SqliteD1 } from "./sqlite-d1";

const DAYS = 30;
const now = Date.now() / 1000;
const d1 = new SqliteD1();
const store = new Store(d1.asD1());
const cfg = loadConfig({ MODE: "demo", MONTHLY_BUDGET_USD: "1000" });
const car = SimCar.create(now - DAYS * 86400, { batteryKwh: cfg.batteryKwh });
let t = car.s.ts;
const poller = new Poller(cfg, new SimFleet(car, () => t), store, new Recorder(store, cfg.priceHomeKwh, cfg.priceSuperchargerKwh),
  initialPollerState());
while (t < now) t += await poller.tick(t);
poller.st.next_poll_at = 0;
await store.setMeta("poller", poller.st);
await store.setMeta("sim_car", car.s);

const lit = (v: unknown) => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const out: string[] = [];
for (const table of ["snapshots", "drives", "charges", "api_usage", "meta"]) {
  out.push(`DELETE FROM ${table};`);
  for (const row of d1.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
    const cols = Object.keys(row);
    out.push(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map((c) => lit(row[c])).join(",")});`);
  }
}
mkdirSync(".demo", { recursive: true });
writeFileSync(".demo/seed.sql", out.join("\n") + "\n");
const calls = await store.apiCalls(now);
console.log(`Seeded ${DAYS} days → .demo/seed.sql (${out.length} statements). ` +
  `Polling policy used ${calls} API requests so far this month.`);
