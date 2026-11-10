/**
 * Adaptive, sleep-friendly, budget-paced polling.
 *
 *  - Never wake the car. Asleep/offline: a cheap state check, then back off.
 *  - Driving: poll often. Charging: poll occasionally.
 *  - Parked and awake: poll briefly, then stop requesting data for a "sleep window"
 *    so the car can fall asleep (polling keeps it awake, costing battery and money).
 *  - Pace spending across the month so it stays inside the budget, and slow to
 *    hourly checks if the budget is ever reached.
 */
import { Config } from "./config";
import { FleetError, VehicleSource, VehicleUnavailable } from "./fleet";
import { Recorder, isCharging, isDriving, normalize } from "./recorder";
import { Store } from "./store";

export interface PollerState {
  vin: string;
  idle_since: number | null;
  sleep_window_until: number;
  was_active: boolean;
  next_poll_at: number;
  last_poll_at: number | null;
  phase: string;
  last_error: string | null;
}

export const initialPollerState = (vin = ""): PollerState => ({
  vin, idle_since: null, sleep_window_until: 0, was_active: false,
  next_poll_at: 0, last_poll_at: null, phase: "starting", last_error: null,
});

export function monthProgress(ts: number): number {
  const d = new Date(ts * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return (ts * 1000 - start) / (end - start);
}

export class Poller {
  constructor(private cfg: Config, private client: VehicleSource, private store: Store,
              private recorder: Recorder, public st: PollerState) {}

  async spend(now: number) {
    return (await this.store.apiCalls(now)) * this.cfg.costPerRequest;
  }

  /** >1 means spending faster than the budget allows for this point in the month. */
  async pace(now: number) {
    const allowed = this.cfg.monthlyBudgetUsd * Math.max(monthProgress(now), 1 / 30);
    return (await this.spend(now)) / allowed;
  }

  /** Poll once. Returns seconds until the next poll is due. */
  async tick(now: number): Promise<number> {
    let delay: number;
    try {
      delay = await this.poll(now);
      this.st.last_error = null;
    } catch (e) {
      const status = e instanceof FleetError ? e.status : 0;
      this.st.last_error = e instanceof Error ? e.message : String(e);
      this.st.phase = "error";
      this.st.was_active = false;
      delay = status === 401 || status === 403 ? 1800 : 300;
    }
    const pace = await this.pace(now);
    if ((await this.spend(now)) >= this.cfg.monthlyBudgetUsd) {
      delay = Math.max(delay, 3600);
      this.st.phase += " · budget reached";
    } else if (pace > 1) {
      delay *= Math.min(4, pace);
      this.st.phase += " · pacing budget";
    }
    this.st.last_poll_at = now;
    this.st.next_poll_at = now + delay;
    return delay;
  }

  private async poll(now: number): Promise<number> {
    const c = this.cfg, st = this.st;
    if (!st.vin) {
      const list = await this.client.vehicles();
      await this.store.countApiCall(now);
      if (!list.length) throw new FleetError(404, "No vehicles on this account.");
      st.vin = list[0].vin;
      await this.store.setMeta("display_name", list[0].display_name || "My Tesla");
    }

    // While the car is known to be awake, skip the state check and go straight to
    // vehicle_data (a 408 tells us it fell asleep). Halves requests while active.
    let state = "online";
    if (!st.was_active) {
      const v = await this.client.vehicle(st.vin);
      await this.store.countApiCall(now);
      state = v.state ?? "unknown";
    }
    st.was_active = false;

    if (state !== "online") {
      await this.recorder.ingestStateOnly(state, now);
      st.idle_since = null;
      st.sleep_window_until = 0;
      st.phase = state;
      return c.intervalAsleep;
    }
    if (now < st.sleep_window_until) {
      st.phase = "letting car sleep";
      return Math.min(c.intervalAsleep, st.sleep_window_until - now);
    }

    let data: any;
    try {
      data = await this.client.vehicleData(st.vin);
    } catch (e) {
      if (!(e instanceof VehicleUnavailable)) throw e;
      await this.store.countApiCall(now);
      await this.recorder.ingestStateOnly("asleep", now);
      st.phase = "asleep";
      return c.intervalAsleep;
    }
    await this.store.countApiCall(now);

    const snap = normalize(data, now);
    await this.recorder.ingest(snap);
    if (data.display_name) await this.store.setMeta("display_name", data.display_name);

    st.was_active = true;
    if (isDriving(snap)) { st.idle_since = null; st.phase = "driving"; return c.intervalDriving; }
    if (isCharging(snap)) { st.idle_since = null; st.phase = "charging"; return c.intervalCharging; }

    st.phase = "parked, awake";
    st.idle_since ??= now;
    if (now - st.idle_since >= c.idleBeforeSleepWindow) {
      st.sleep_window_until = now + c.sleepWindow;
      st.idle_since = null;
      st.was_active = false;
      st.phase = "letting car sleep";
      return c.intervalAsleep;
    }
    return c.intervalOnline;
  }
}
