CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL, state TEXT, shift TEXT, speed REAL, power REAL,
  lat REAL, lon REAL, heading REAL,
  battery_level REAL, usable_battery_level REAL, range REAL, est_range REAL,
  charging_state TEXT, charger_power REAL, charge_energy_added REAL, charge_limit REAL,
  minutes_to_full REAL, charger_voltage REAL, charger_current REAL, fast_charger INTEGER,
  inside_temp REAL, outside_temp REAL, climate_on INTEGER, odometer REAL,
  locked INTEGER, sentry INTEGER, software TEXT
);
CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots(ts);

CREATE TABLE IF NOT EXISTS drives (
  id INTEGER PRIMARY KEY,
  start_ts REAL NOT NULL, end_ts REAL,
  start_odo REAL, end_odo REAL, start_soc REAL, end_soc REAL,
  start_range REAL, end_range REAL,
  start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
  max_speed REAL, max_power REAL,
  inferred INTEGER NOT NULL DEFAULT 0,        -- 1 = found from an odometer jump between polls
  start_estimated INTEGER NOT NULL DEFAULT 0  -- 1 = drive was already under way when first seen
);
CREATE INDEX IF NOT EXISTS drives_start ON drives(start_ts);

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY,
  start_ts REAL NOT NULL, end_ts REAL,
  start_soc REAL, end_soc REAL, start_range REAL, end_range REAL,
  energy_added REAL, max_power REAL, fast INTEGER,
  lat REAL, lon REAL, cost REAL
);
CREATE INDEX IF NOT EXISTS charges_start ON charges(start_ts);

CREATE TABLE IF NOT EXISTS api_usage (month TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
