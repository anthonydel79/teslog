/** Fleet API response → snapshot row; snapshots → drive and charge sessions. */
import { Row, Snapshot, Store } from "./store";

const DRIVING = new Set(["D", "R", "N"]);
const CHARGING = new Set(["Charging", "Starting"]);
const b = (v: unknown) => (v === undefined || v === null ? null : v ? 1 : 0);
const n = (v: unknown) => (v === undefined ? null : (v as number | null));

/** Flatten /vehicle_data. Distances stay in miles, temperatures in °C (API units). */
export function normalize(data: any, ts: number): Snapshot {
  const cs = data.charge_state ?? {}, cl = data.climate_state ?? {};
  const ds = data.drive_state ?? {}, vs = data.vehicle_state ?? {};
  const ttf = cs.time_to_full_charge;
  return {
    ts,
    state: data.state ?? "online",
    shift: ds.shift_state ?? null,
    speed: n(ds.speed), power: n(ds.power),
    lat: n(ds.latitude), lon: n(ds.longitude), heading: n(ds.heading),
    battery_level: n(cs.battery_level), usable_battery_level: n(cs.usable_battery_level),
    range: n(cs.battery_range), est_range: n(cs.est_battery_range),
    charging_state: cs.charging_state ?? null,
    charger_power: n(cs.charger_power), charge_energy_added: n(cs.charge_energy_added),
    charge_limit: n(cs.charge_limit_soc),
    minutes_to_full: ttf == null ? null : Math.round(ttf * 60),
    charger_voltage: n(cs.charger_voltage), charger_current: n(cs.charger_actual_current),
    fast_charger: b(cs.fast_charger_present),
    inside_temp: n(cl.inside_temp), outside_temp: n(cl.outside_temp), climate_on: b(cl.is_climate_on),
    odometer: n(vs.odometer), locked: b(vs.locked), sentry: b(vs.sentry_mode),
    software: vs.car_version ?? null,
  };
}

export const isDriving = (s: Partial<Snapshot>) => DRIVING.has(s.shift ?? "");
export const isCharging = (s: Partial<Snapshot>) => CHARGING.has(s.charging_state ?? "");

export class Recorder {
  private last: Row | null | undefined;
  private lastAnyTs: number | null | undefined;

  constructor(private store: Store, private priceHome = 0.15, private priceFast = 0.45) {}

  private async lastData(): Promise<Row | null> {
    if (this.last === undefined) this.last = await this.store.latestWithData();
    return this.last;
  }

  async ingest(s: Snapshot): Promise<void> {
    const prev = await this.lastData();
    if (this.lastAnyTs === undefined) this.lastAnyTs = (await this.store.latest())?.ts ?? null;
    const prevAnyTs = this.lastAnyTs ?? null;
    await this.store.insertSnapshot(s);
    this.lastAnyTs = s.ts;
    const hasData = s.battery_level != null;
    const ref: Row = hasData ? s : prev ?? s;
    if (hasData && prev) await this.inferMissedDrive(prev, s);
    await this.trackDrive(s, ref, prev, prevAnyTs);
    await this.trackCharge(s, ref);
    if (hasData) this.last = s;
  }

  /** Record that the car is asleep/offline, without paying for a data request. */
  ingestStateOnly(state: string, ts: number) {
    return this.ingest({ ts, state });
  }

  /**
   * Sparse polling can miss a short drive entirely: the car wakes, drives and sleeps
   * between two polls. The odometer gives it away, so log it (without a route).
   */
  private async inferMissedDrive(prev: Row, s: Snapshot) {
    if (prev.odometer == null || s.odometer == null) return;
    if (s.odometer - prev.odometer < 0.3 || isDriving(prev) || isDriving(s)) return;
    if (await this.store.openSession("drives")) return;
    await this.store.insertRow("drives", {
      start_ts: prev.ts, end_ts: s.ts, start_odo: prev.odometer, end_odo: s.odometer,
      start_soc: prev.battery_level, end_soc: s.battery_level,
      start_range: prev.range, end_range: s.range,
      start_lat: prev.lat, start_lon: prev.lon, end_lat: s.lat, end_lon: s.lon,
      max_speed: null, max_power: null, inferred: 1,
    });
  }

  private async trackDrive(s: Snapshot, ref: Row, prev: Row | null, prevAnyTs: number | null) {
    const open = await this.store.openSession("drives");
    if (isDriving(s)) {
      if (!open) {
        const p = prev ?? s;
        // If the car was last seen a while ago, the drive began somewhere in that gap:
        // take the midpoint and flag it, so duration and speed aren't presented as exact.
        const gap = prevAnyTs == null ? 0 : s.ts - prevAnyTs;
        const estimated = gap > 120;
        await this.store.insertRow("drives", {
          start_ts: estimated ? prevAnyTs! + gap / 2 : s.ts,
          start_estimated: estimated ? 1 : 0,
          start_odo: p.odometer ?? s.odometer, start_soc: p.battery_level ?? s.battery_level,
          start_range: p.range ?? s.range,
          start_lat: p.lat ?? s.lat, start_lon: p.lon ?? s.lon,
          max_speed: s.speed ?? 0, max_power: s.power ?? 0,
        });
      } else {
        await this.store.updateRow("drives", open.id, {
          max_speed: Math.max(open.max_speed ?? 0, s.speed ?? 0),
          max_power: Math.max(open.max_power ?? 0, s.power ?? 0),
        });
      }
    } else if (open) {
      await this.store.updateRow("drives", open.id, {
        end_ts: s.ts, end_odo: ref.odometer, end_soc: ref.battery_level, end_range: ref.range,
        end_lat: ref.lat, end_lon: ref.lon,
      });
    }
  }

  private async trackCharge(s: Snapshot, ref: Row) {
    const open = await this.store.openSession("charges");
    if (isCharging(s)) {
      if (!open) {
        await this.store.insertRow("charges", {
          start_ts: s.ts, start_soc: s.battery_level, start_range: s.range,
          energy_added: s.charge_energy_added ?? 0, max_power: s.charger_power ?? 0,
          fast: s.fast_charger ?? 0, lat: s.lat, lon: s.lon,
        });
      } else {
        await this.store.updateRow("charges", open.id, {
          energy_added: Math.max(open.energy_added ?? 0, s.charge_energy_added ?? 0),
          max_power: Math.max(open.max_power ?? 0, s.charger_power ?? 0),
          fast: Math.max(open.fast ?? 0, s.fast_charger ?? 0),
          end_soc: s.battery_level, end_range: s.range,
        });
      }
    } else if (open) {
      const energy = Math.max(open.energy_added ?? 0, ref.charge_energy_added ?? 0);
      const price = open.fast ? this.priceFast : this.priceHome;
      await this.store.updateRow("charges", open.id, {
        end_ts: s.ts,
        end_soc: ref.battery_level ?? open.end_soc, end_range: ref.range ?? open.end_range,
        energy_added: energy, cost: Math.round(energy * price * 100) / 100,
      });
    }
  }
}
