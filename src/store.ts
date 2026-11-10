/** D1 persistence. Works with any object implementing the small D1 subset we use. */

export type Row = Record<string, any>;

export interface Snapshot {
  ts: number;
  state: string;
  shift?: string | null;
  speed?: number | null;
  power?: number | null;
  lat?: number | null;
  lon?: number | null;
  heading?: number | null;
  battery_level?: number | null;
  usable_battery_level?: number | null;
  range?: number | null;
  est_range?: number | null;
  charging_state?: string | null;
  charger_power?: number | null;
  charge_energy_added?: number | null;
  charge_limit?: number | null;
  minutes_to_full?: number | null;
  charger_voltage?: number | null;
  charger_current?: number | null;
  fast_charger?: number | null;
  inside_temp?: number | null;
  outside_temp?: number | null;
  climate_on?: number | null;
  odometer?: number | null;
  locked?: number | null;
  sentry?: number | null;
  software?: string | null;
}

export const SNAPSHOT_FIELDS = [
  "ts", "state", "shift", "speed", "power", "lat", "lon", "heading",
  "battery_level", "usable_battery_level", "range", "est_range",
  "charging_state", "charger_power", "charge_energy_added", "charge_limit",
  "minutes_to_full", "charger_voltage", "charger_current", "fast_charger",
  "inside_temp", "outside_temp", "climate_on", "odometer", "locked", "sentry", "software",
] as const;

type SessionTable = "drives" | "charges";

export function monthKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 7);
}

export class Store {
  constructor(private db: D1Database) {}

  private async all(sql: string, ...args: unknown[]): Promise<Row[]> {
    const r = await this.db.prepare(sql).bind(...args).all();
    return (r.results ?? []) as Row[];
  }

  private async first(sql: string, ...args: unknown[]): Promise<Row | null> {
    return ((await this.db.prepare(sql).bind(...args).first()) as Row | null) ?? null;
  }

  private async run(sql: string, ...args: unknown[]): Promise<number> {
    const r = await this.db.prepare(sql).bind(...args).run();
    return Number(r.meta?.last_row_id ?? 0);
  }

  // ---------- meta (small JSON values) ----------
  async getMeta<T = unknown>(key: string): Promise<T | null> {
    const r = await this.first("SELECT value FROM meta WHERE key = ?", key);
    return r ? (JSON.parse(r.value) as T) : null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, JSON.stringify(value));
  }

  async deleteMeta(key: string): Promise<void> {
    await this.run("DELETE FROM meta WHERE key = ?", key);
  }

  // ---------- API usage ----------
  async countApiCall(ts: number, n = 1): Promise<void> {
    await this.run("INSERT INTO api_usage(month, calls) VALUES(?, ?) " +
      "ON CONFLICT(month) DO UPDATE SET calls = calls + excluded.calls", monthKey(ts), n);
  }

  async apiCalls(ts: number): Promise<number> {
    const r = await this.first("SELECT calls FROM api_usage WHERE month = ?", monthKey(ts));
    return r ? Number(r.calls) : 0;
  }

  // ---------- writes ----------
  async insertSnapshot(s: Snapshot): Promise<void> {
    const cols = SNAPSHOT_FIELDS.filter((f) => (s as any)[f] !== undefined);
    await this.run(`INSERT INTO snapshots(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
      ...cols.map((c) => (s as any)[c]));
  }

  async openSession(table: SessionTable): Promise<Row | null> {
    return this.first(`SELECT * FROM ${table} WHERE end_ts IS NULL ORDER BY id DESC LIMIT 1`);
  }

  async insertRow(table: SessionTable, row: Row): Promise<number> {
    const cols = Object.keys(row);
    return this.run(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
      ...cols.map((c) => row[c] ?? null));
  }

  async updateRow(table: SessionTable, id: number, changes: Row): Promise<void> {
    const cols = Object.keys(changes);
    if (!cols.length) return;
    await this.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
      ...cols.map((c) => changes[c] ?? null), id);
  }

  // ---------- reads ----------
  latest() { return this.first("SELECT * FROM snapshots ORDER BY ts DESC LIMIT 1"); }

  latestWithData() {
    return this.first("SELECT * FROM snapshots WHERE battery_level IS NOT NULL ORDER BY ts DESC LIMIT 1");
  }

  async history(since: number, maxPoints = 600): Promise<Row[]> {
    const n = await this.first("SELECT COUNT(*) AS n FROM snapshots WHERE ts >= ?", since);
    const step = Math.max(1, Math.ceil(Number(n?.n ?? 0) / maxPoints));
    // Down-sample in SQL, but always keep charging points so charge bands stay visible.
    return this.all(
      "SELECT ts, state, battery_level, range, speed, power, charger_power, inside_temp, outside_temp " +
      "FROM snapshots WHERE ts >= ? AND (id % ? = 0 OR charger_power > 0 " +
      "OR id = (SELECT MAX(id) FROM snapshots)) ORDER BY ts", since, step);
  }

  async path(start: number, end: number | null): Promise<number[][]> {
    const rows = await this.all("SELECT lat, lon FROM snapshots WHERE ts >= ? AND ts <= ? AND lat IS NOT NULL ORDER BY ts",
      start, end ?? Date.now() / 1000);
    return rows.map((r) => [r.lat, r.lon]);
  }

  drives(limit = 50, since = 0) {
    return this.all("SELECT * FROM drives WHERE start_ts >= ? ORDER BY start_ts DESC LIMIT ?", since, limit);
  }

  drive(id: number) { return this.first("SELECT * FROM drives WHERE id = ?", id); }

  charges(limit = 50, since = 0) {
    return this.all("SELECT * FROM charges WHERE start_ts >= ? ORDER BY start_ts DESC LIMIT ?", since, limit);
  }
}
