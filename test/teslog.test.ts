import { describe, expect, it } from "vitest";
import { enrichDrive, stats } from "../src/analytics";
import { isLoggedIn, passwordMatches, sessionCookie } from "../src/auth";
import { loadConfig } from "../src/config";
import { Poller, initialPollerState } from "../src/poller";
import { Recorder, normalize } from "../src/recorder";
import { SimCar, SimFleet } from "../src/simulator";
import { Snapshot, Store } from "../src/store";
import { SqliteD1 } from "../scripts/sqlite-d1";

const newStore = () => new Store(new SqliteD1().asD1());
const snap = (ts: number, kw: Partial<Snapshot> = {}): Snapshot => ({
  ts, state: "online", battery_level: 80, range: 248, odometer: 1000, shift: "P", charging_state: "Disconnected", ...kw,
});

describe("recorder", () => {
  it("flattens vehicle_data", () => {
    const s = normalize({
      state: "online",
      charge_state: { battery_level: 55, battery_range: 170.5, time_to_full_charge: 1.5, charging_state: "Charging", fast_charger_present: true },
      drive_state: { shift_state: "D", speed: 40, latitude: 1, longitude: 2 },
      vehicle_state: { odometer: 1234.5, locked: true },
    }, 10);
    expect(s).toMatchObject({ battery_level: 55, range: 170.5, minutes_to_full: 90, fast_charger: 1, shift: "D", lat: 1, locked: 1 });
  });

  it("opens and closes a drive", async () => {
    const store = newStore(), rec = new Recorder(store);
    await rec.ingest(snap(0));
    await rec.ingest(snap(60, { shift: "D", speed: 30 }));
    await rec.ingest(snap(120, { shift: "D", speed: 50, odometer: 1010, battery_level: 77, range: 238 }));
    expect(await store.openSession("drives")).not.toBeNull();
    await rec.ingest(snap(180, { odometer: 1010, battery_level: 77, range: 238 }));
    const d = enrichDrive((await store.drives())[0], 75, 200);
    expect(d).toMatchObject({ end_ts: 180, distance: 10, start_soc: 80, end_soc: 77, max_speed: 50, inferred: 0 });
    expect(d.wh_per_mi).toBe(242); // 10 rated mi of a 310 mi / 75 kWh pack
  });

  it("prices Supercharging at the Supercharger rate", async () => {
    const store = newStore(), rec = new Recorder(store, 0.1, 0.5);
    await rec.ingest(snap(0, { charging_state: "Charging", charge_energy_added: 0, charger_power: 150, fast_charger: 1 }));
    await rec.ingest(snap(600, { charging_state: "Charging", charge_energy_added: 20, charger_power: 120, fast_charger: 1 }));
    await rec.ingest(snap(700, { charging_state: "Complete", charge_energy_added: 20 }));
    expect((await store.charges())[0]).toMatchObject({ energy_added: 20, fast: 1, cost: 10 });
  });

  it("closes an open drive when the car is found asleep", async () => {
    const store = newStore(), rec = new Recorder(store);
    await rec.ingest(snap(0, { shift: "D" }));
    await rec.ingest(snap(60, { shift: "D", odometer: 1003 }));
    await rec.ingestStateOnly("asleep", 4000);
    expect((await store.drives())[0]).toMatchObject({ end_ts: 4000, end_odo: 1003 });
  });

  it("flags a drive that was already under way when first seen", async () => {
    const store = newStore(), rec = new Recorder(store);
    await rec.ingest(snap(0));
    await rec.ingestStateOnly("asleep", 600);
    await rec.ingest(snap(1800, { shift: "D", odometer: 1010 }));
    const d = (await store.drives())[0];
    expect(d).toMatchObject({ start_ts: 1200, start_estimated: 1, start_odo: 1000 });
    expect(enrichDrive(d, 75, 1900).avg_speed).toBeNull();
  });

  it("infers a drive that happened entirely between two polls", async () => {
    const store = newStore(), rec = new Recorder(store);
    await rec.ingest(snap(0));
    await rec.ingestStateOnly("asleep", 1800);
    await rec.ingest(snap(3600, { odometer: 1012, battery_level: 76, range: 236 }));
    const d = enrichDrive((await store.drives())[0], 75, 4000);
    expect(d).toMatchObject({ inferred: 1, distance: 12, start_soc: 80, end_soc: 76 });
  });
});

describe("poller", () => {
  it("lets the car sleep, catches drives, and fits the monthly credit", async () => {
    const store = newStore();
    const cfg = loadConfig({ MONTHLY_BUDGET_USD: "1000" });
    const start = Date.UTC(2026, 9, 1) / 1000; // a full 31-day month
    const car = SimCar.create(start);
    let t = start;
    const poller = new Poller(cfg, new SimFleet(car, () => t), store, new Recorder(store), initialPollerState());
    while (t < start + 31 * 86400) t += await poller.tick(t);

    const drives = await store.drives(10000);
    expect(drives.length).toBeGreaterThan(40);
    expect(poller.st.last_error).toBeNull();
    const calls = await store.apiCalls(start + 86400);
    // Tesla's $10/month developer credit covers ~5,000 requests at $0.002.
    expect(calls * cfg.costPerRequest).toBeLessThan(10);
  });

  it("slows down once the budget is reached", async () => {
    const store = newStore();
    const cfg = loadConfig({ MONTHLY_BUDGET_USD: "0.01" });
    const now = Date.now() / 1000;
    const poller = new Poller(cfg, new SimFleet(SimCar.create(now - 60), () => now), store, new Recorder(store), initialPollerState());
    await store.countApiCall(now, 6);
    expect(await poller.tick(now)).toBeGreaterThanOrEqual(3600);
    expect(poller.st.phase).toContain("budget reached");
  });
});

describe("analytics", () => {
  it("buckets days in the viewer's time zone", async () => {
    const store = newStore();
    const s = await stats(store, 7, 75, -480);
    expect(s.daily).toHaveLength(7);
    expect(s.distance).toBe(0);
  });
});

describe("auth", () => {
  it("accepts a valid session cookie and rejects tampering or expiry", async () => {
    const cookie = (await sessionCookie("pw", 1000)).split(";")[0];
    const req = (c: string) => new Request("https://x/", { headers: { Cookie: c } });
    expect(await isLoggedIn(req(cookie), "pw", 1001)).toBe(true);
    expect(await isLoggedIn(req(cookie), "other", 1001)).toBe(false);
    expect(await isLoggedIn(req(cookie.slice(0, -2) + "xx"), "pw", 1001)).toBe(false);
    expect(await isLoggedIn(req(cookie), "pw", 1000 + 31 * 86400)).toBe(false);
    expect(await passwordMatches("pw", "pw")).toBe(true);
    expect(await passwordMatches("pw", "pW")).toBe(false);
  });
});
