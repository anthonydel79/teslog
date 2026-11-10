/**
 * A simulated Tesla with the same interface as the Fleet API client, for demo mode
 * and tests. It commutes on weekdays, charges at home overnight, road-trips with a
 * Supercharger stop on Saturdays, and falls asleep when left alone. Its whole state
 * is JSON-serialisable so it can live in D1 between Worker invocations.
 */
import { VehicleSource, VehicleUnavailable } from "./fleet";

type LatLon = [number, number];
export const HOME: LatLon = [37.4419, -122.143];
const WORK: LatLon = [37.3352, -121.8911];
const LUNCH: LatLon = [37.329, -121.905];
const ERRAND: LatLon = [37.4275, -122.1697];
const TRIP: LatLon = [36.9741, -122.0308];
const SUPERCHARGER: LatLon = [36.981, -122.0263];
export const LOCAL_SUPERCHARGER: LatLon = [37.4045, -122.1102];
const RATED_FULL_MI = 310;
const WH_PER_MI = 265;

interface Activity {
  kind: "drive" | "charge";
  start: number;
  duration: number;
  route?: [LatLon, LatLon];
  fast?: boolean;
  target_soc?: number;
}

export interface SimState {
  ts: number; seed: number; tz_hours: number; battery_kwh: number;
  soc: number; odo: number; pos: LatLon; heading: number;
  energy_added: number; charge_power: number; speed: number; power: number;
  shift: string | null; charging_state: string; plugged: boolean; inside_temp: number;
  last_awake: number; last_data_poll: number; asleep: boolean;
  activities: Activity[]; planned_days: number[];
}

const lerp = (a: LatLon, b: LatLon, f: number): LatLon => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
const same = (a: LatLon, b: LatLon) => a[0] === b[0] && a[1] === b[1];

export function haversineMi(a: LatLon, b: LatLon): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export class SimCar {
  s: SimState;

  constructor(state: SimState) { this.s = state; }

  static create(startTs: number, opts: { batteryKwh?: number; tzHours?: number; seed?: number } = {}): SimCar {
    return new SimCar({
      ts: startTs, seed: opts.seed ?? 7, tz_hours: opts.tzHours ?? -8, battery_kwh: opts.batteryKwh ?? 75,
      soc: 72, odo: 18234, pos: HOME, heading: 0, energy_added: 0, charge_power: 0, speed: 0, power: 0,
      shift: null, charging_state: "Disconnected", plugged: false, inside_temp: 21,
      last_awake: startTs, last_data_poll: startTs, asleep: false, activities: [], planned_days: [],
    });
  }

  // mulberry32: small seeded RNG whose state is a single number
  private rand(): number {
    let t = (this.s.seed = (this.s.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private uniform(a: number, b: number) { return a + (b - a) * this.rand(); }

  private local(ts: number) { return new Date((ts + this.s.tz_hours * 3600) * 1000); }
  private localHour(ts: number) { return this.local(ts).getUTCHours(); }

  private planDay(dayStart: number) {
    const key = Math.round(dayStart / 86400);
    if (this.s.planned_days.includes(key)) return;
    this.s.planned_days.push(key);
    this.s.planned_days = this.s.planned_days.slice(-5);
    const wd = this.local(dayStart + 43200).getUTCDay(); // 0 = Sunday
    const j = () => this.uniform(-600, 600);
    const acts: Activity[] = [];
    const drive = (start: number, duration: number, from: LatLon, to: LatLon) =>
      acts.push({ kind: "drive", start, duration, route: [from, to] });
    if (wd >= 1 && wd <= 5) {
      drive(dayStart + 7.75 * 3600 + j(), 1500 + j() / 2, HOME, WORK);
      if (this.rand() < 0.5) {
        const t = dayStart + 12.25 * 3600 + j();
        drive(t, 540, WORK, LUNCH);
        drive(t + 3000, 560, LUNCH, WORK);
      }
      drive(dayStart + 17.5 * 3600 + j(), 1800 + j() / 2, WORK, HOME);
      if (this.rand() < 0.35) {
        const t = dayStart + 19 * 3600 + j();
        drive(t, 600, HOME, ERRAND);
        drive(t + 2400, 620, ERRAND, HOME);
      }
    } else if (wd === 6) {
      const t = dayStart + 10 * 3600 + j();
      drive(t, 3600, HOME, SUPERCHARGER);
      acts.push({ kind: "charge", start: t + 3700, duration: 1800, fast: true, target_soc: 85 });
      drive(t + 5700, 600, SUPERCHARGER, TRIP);
      drive(t + 5 * 3600, 3800, TRIP, HOME);
    }
    acts.push({ kind: "charge", start: dayStart + 22 * 3600, duration: 10 * 3600, target_soc: 80 });
    this.s.activities.push(...acts);
    this.s.activities.sort((a, b) => a.start - b.start);
  }

  /** Insert an activity, displacing planned ones that overlap it. */
  schedule(a: Activity) {
    const end = a.start + a.duration;
    this.s.activities = this.s.activities.filter((x) => x.start >= end || x.start + x.duration <= a.start);
    this.s.activities.push(a);
    this.s.activities.sort((x, y) => x.start - y.start);
  }

  private chargeWanted(a: Activity) {
    const atHome = same(this.s.pos, HOME);
    return this.s.soc < (a.target_soc ?? 80) && (a.fast ? !atHome : atHome);
  }

  private current(ts: number): Activity | null {
    for (const a of this.s.activities) {
      if (a.start <= ts && ts < a.start + a.duration) {
        if (a.kind === "charge" && !this.chargeWanted(a)) continue;
        return a;
      }
    }
    return null;
  }

  advance(toTs: number) {
    while (this.s.ts < toTs) {
      const dt = Math.min(30, toTs - this.s.ts);
      const l = this.local(this.s.ts);
      const sinceMidnight = l.getUTCHours() * 3600 + l.getUTCMinutes() * 60 + l.getUTCSeconds();
      this.planDay(this.s.ts - sinceMidnight);
      this.planDay(this.s.ts - sinceMidnight + 86400);
      this.step(dt);
      this.s.ts += dt;
    }
    this.s.activities = this.s.activities.filter((a) => a.start + a.duration > this.s.ts - 3600);
  }

  private outsideTemp(ts: number) { return 14 + 6 * Math.sin(((this.localHour(ts) - 9) / 24) * 2 * Math.PI); }

  private step(dt: number) {
    const s = this.s, a = this.current(s.ts);
    s.inside_temp += (this.outsideTemp(s.ts) + 3 - s.inside_temp) * 0.002 * (dt / 30);
    if (a?.kind === "drive" && a.route) {
      s.asleep = false; s.last_awake = s.ts; this.unplug();
      const [src, dst] = a.route;
      const frac = Math.min(1, (s.ts + dt - a.start) / a.duration);
      let next = lerp(src, dst, frac);
      const wob = 0.0006 * Math.sin(frac * 9);
      next = [next[0] + wob, next[1] - wob];
      const mi = haversineMi(s.pos, next);
      s.heading = Math.round(((Math.atan2(next[1] - s.pos[1], next[0] - s.pos[0]) * 180) / Math.PI + 360) % 360);
      s.pos = frac >= 1 ? dst : next;
      s.odo += mi;
      s.soc = Math.max(3, s.soc - ((mi * WH_PER_MI * this.uniform(0.9, 1.15)) / 1000 / s.battery_kwh) * 100);
      const avgMph = haversineMi(src, dst) / (a.duration / 3600);
      s.speed = frac >= 1 ? 0 : Math.max(3, avgMph * this.uniform(0.6, 1.5));
      s.power = Math.round(s.speed * 0.45 + this.uniform(-8, 20));
      s.shift = frac >= 1 ? "P" : "D";
      s.inside_temp += (21 - s.inside_temp) * 0.2;
    } else if (a?.kind === "charge") {
      s.asleep = false; s.last_awake = s.ts;
      s.speed = 0; s.power = 0; s.shift = "P";
      if (!s.plugged) { s.plugged = true; s.energy_added = 0; }
      const kw = a.fast ? Math.max(40, 170 - 1.6 * Math.max(0, s.soc - 20)) : s.soc < 79 ? 7.6 : 3;
      s.charge_power = kw;
      const add = (kw * dt) / 3600;
      s.energy_added += add;
      s.soc = Math.min(100, s.soc + (add / s.battery_kwh) * 100 * 0.93);
      s.charging_state = s.soc < (a.target_soc ?? 80) ? "Charging" : "Complete";
    } else {
      s.speed = 0; s.power = 0; s.charge_power = 0;
      s.shift = s.asleep ? null : "P";
      if (s.charging_state === "Charging") s.charging_state = s.plugged ? "Complete" : "Disconnected";
      const h = this.localHour(s.ts);
      if (s.plugged && !(same(s.pos, HOME) && (h >= 22 || h <= 6))) this.unplug();
      if (!s.asleep && s.ts - Math.max(s.last_awake, s.last_data_poll) > 600) s.asleep = true;
      s.soc -= (0.25 / 86400) * dt; // ~0.25 %/day phantom drain
    }
  }

  private unplug() { this.s.plugged = false; this.s.charge_power = 0; this.s.charging_state = "Disconnected"; }

  get state() { return this.s.asleep ? "asleep" : "online"; }

  vehicleData() {
    const s = this.s, lvl = Math.round(s.soc), range = Math.round((s.soc / 100) * RATED_FULL_MI * 100) / 100;
    const minsLeft = s.charging_state === "Charging" && s.charge_power
      ? (((80 - s.soc) / 100) * s.battery_kwh / s.charge_power) * 60 : 0;
    return {
      state: "online", display_name: "Demo Model 3", vin: "DEMO0000000000000",
      charge_state: {
        battery_level: lvl, usable_battery_level: Math.max(0, lvl - 1),
        battery_range: range, est_battery_range: Math.round(range * 86) / 100,
        charging_state: s.charging_state, charger_power: Math.round(s.charge_power),
        charge_energy_added: Math.round(s.energy_added * 100) / 100, charge_limit_soc: 80,
        time_to_full_charge: Math.round((Math.max(0, minsLeft) / 60) * 100) / 100,
        charger_voltage: s.charge_power ? (s.charge_power > 20 ? 390 : 240) : 0,
        charger_actual_current: s.charge_power ? Math.round((s.charge_power * 1000) / 240) : 0,
        fast_charger_present: s.charge_power > 20,
      },
      climate_state: {
        inside_temp: Math.round(s.inside_temp * 10) / 10,
        outside_temp: Math.round(this.outsideTemp(s.ts) * 10) / 10, is_climate_on: s.shift === "D",
      },
      drive_state: {
        shift_state: s.shift, speed: s.shift === "D" ? Math.round(s.speed) : null, power: s.power,
        latitude: Math.round(s.pos[0] * 1e6) / 1e6, longitude: Math.round(s.pos[1] * 1e6) / 1e6, heading: s.heading,
      },
      vehicle_state: { odometer: Math.round(s.odo * 100) / 100, locked: s.shift !== "D", sentry_mode: false, car_version: "2026.38.4 demo" },
      vehicle_config: { car_type: "model3" },
    };
  }
}

/** Drop-in for FleetClient, backed by SimCar and an injectable clock. */
export class SimFleet implements VehicleSource {
  constructor(public car: SimCar, public clock: () => number = () => Date.now() / 1000) {}
  async isAuthorized() { return true; }
  async vehicles() { return [await this.vehicle("DEMO0000000000000")]; }
  async vehicle(_vin: string) {
    this.car.advance(this.clock());
    return { vin: "DEMO0000000000000", display_name: "Demo Model 3", state: this.car.state };
  }
  async vehicleData(_vin: string) {
    this.car.advance(this.clock());
    if (this.car.s.asleep) throw new VehicleUnavailable(408, "vehicle unavailable: asleep");
    this.car.s.last_data_poll = this.car.s.ts;
    return this.car.vehicleData();
  }
}
