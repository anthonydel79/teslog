/** Derived metrics: per-drive efficiency, per-charge stats, period totals. */
import { Row, Store } from "./store";

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function enrichDrive(d: Row, batteryKwh: number, now = Date.now() / 1000): Row {
  const dist = d.end_odo != null && d.start_odo != null ? d.end_odo - d.start_odo : null;
  const dur = (d.end_ts ?? now) - d.start_ts;
  let energy: number | null = null;
  if (d.start_range && d.end_range != null && d.start_soc) {
    const fullRange = (d.start_range / d.start_soc) * 100;
    energy = Math.max(0, ((d.start_range - d.end_range) / fullRange) * batteryKwh);
  }
  return {
    ...d,
    distance: dist == null ? null : r2(dist),
    duration_s: Math.round(dur),
    avg_speed: dist && dur > 0 && !d.inferred && !d.start_estimated ? r1(dist / (dur / 3600)) : null,
    energy_kwh: energy == null ? null : r2(energy),
    wh_per_mi: energy && dist && dist > 0.5 ? Math.round((energy * 1000) / dist) : null,
    in_progress: d.end_ts == null,
  };
}

export function enrichCharge(c: Row, now = Date.now() / 1000): Row {
  const dur = (c.end_ts ?? now) - c.start_ts;
  return {
    ...c,
    duration_s: Math.round(dur),
    avg_power: c.energy_added && dur > 60 ? r1(c.energy_added / (dur / 3600)) : null,
    range_added: c.end_range != null && c.start_range != null ? r1(c.end_range - c.start_range) : null,
    in_progress: c.end_ts == null,
  };
}

/** tzOffsetMin: the viewer's offset from UTC in minutes (e.g. -480 for PST), for daily buckets. */
export async function stats(store: Store, days: number, batteryKwh: number, tzOffsetMin = 0, now = Date.now() / 1000) {
  const since = now - days * 86400;
  const drives = (await store.drives(100000, since)).map((d) => enrichDrive(d, batteryKwh, now));
  const charges = (await store.charges(100000, since)).map((c) => enrichCharge(c, now));
  const sum = (xs: Row[], f: (x: Row) => number) => xs.reduce((a, x) => a + (f(x) || 0), 0);

  const distance = sum(drives, (d) => d.distance);
  const energyUsed = sum(drives, (d) => d.energy_kwh);
  const effDist = sum(drives.filter((d) => d.energy_kwh != null), (d) => d.distance);
  const charged = sum(charges, (c) => c.energy_added);
  const cost = sum(charges, (c) => c.cost);
  const fastKwh = sum(charges.filter((c) => c.fast), (c) => c.energy_added);

  const dayKey = (ts: number) => new Date((ts + tzOffsetMin * 60) * 1000).toISOString().slice(0, 10);
  const daily = new Map<string, { date: string; distance: number; charged_kwh: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(now - i * 86400);
    daily.set(k, { date: k, distance: 0, charged_kwh: 0 });
  }
  for (const d of drives) { const e = daily.get(dayKey(d.start_ts)); if (e) e.distance = r2(e.distance + (d.distance ?? 0)); }
  for (const c of charges) { const e = daily.get(dayKey(c.start_ts)); if (e) e.charged_kwh = r2(e.charged_kwh + (c.energy_added ?? 0)); }

  return {
    days,
    distance: r1(distance),
    drive_count: drives.length,
    drive_hours: r1(sum(drives.filter((d) => !d.inferred), (d) => d.duration_s) / 3600),
    energy_used_kwh: r1(energyUsed),
    avg_wh_per_mi: effDist > 1 ? Math.round((energyUsed * 1000) / effDist) : null,
    charge_count: charges.length,
    charged_kwh: r1(charged),
    fast_charge_share: charged ? Math.round((fastKwh / charged) * 100) : null,
    charge_cost: r2(cost),
    cost_per_mi: distance > 1 ? Math.round((cost / distance) * 1000) / 1000 : null,
    daily: [...daily.values()],
  };
}
