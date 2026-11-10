export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MODE?: string; // "fleet" | "demo"
  TESLA_CLIENT_ID?: string;
  TESLA_CLIENT_SECRET?: string;
  TESLA_REDIRECT_URI?: string;
  TESLA_REGION?: string;
  TESLA_VIN?: string;
  DASHBOARD_PASSWORD?: string;
  PUBLIC_KEY_PEM?: string;
  [key: string]: unknown;
}

export const REGIONS: Record<string, string> = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  cn: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
};

export interface Config {
  mode: "fleet" | "demo";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  region: string;
  vin: string;
  // Polling intervals in seconds. The car is never woken.
  intervalDriving: number;
  intervalCharging: number;
  intervalOnline: number;
  intervalAsleep: number;
  idleBeforeSleepWindow: number;
  sleepWindow: number;
  // Fleet API is pay-per-use; Tesla gives individual developers a $10/month credit.
  monthlyBudgetUsd: number;
  costPerRequest: number;
  units: "mi" | "km";
  tempUnit: "F" | "C";
  batteryKwh: number;
  priceHomeKwh: number;
  priceSuperchargerKwh: number;
}

const num = (v: unknown, d: number) => (v === undefined || v === "" ? d : Number(v));
const str = (v: unknown, d: string) => (typeof v === "string" && v !== "" ? v : d);

export function loadConfig(env: Partial<Env> & Record<string, unknown>): Config {
  return {
    mode: str(env.MODE, "fleet") === "demo" ? "demo" : "fleet",
    clientId: str(env.TESLA_CLIENT_ID, ""),
    clientSecret: str(env.TESLA_CLIENT_SECRET, ""),
    redirectUri: str(env.TESLA_REDIRECT_URI, ""),
    region: str(env.TESLA_REGION, "na"),
    vin: str(env.TESLA_VIN, ""),
    // Defaults are sized to stay inside Tesla's $10/month developer credit.
    intervalDriving: num(env.POLL_DRIVING, 60),
    intervalCharging: num(env.POLL_CHARGING, 600),
    intervalOnline: num(env.POLL_ONLINE, 180),
    intervalAsleep: num(env.POLL_ASLEEP, 1200),
    idleBeforeSleepWindow: num(env.IDLE_BEFORE_SLEEP_WINDOW, 540),
    sleepWindow: num(env.SLEEP_WINDOW, 1800),
    monthlyBudgetUsd: num(env.MONTHLY_BUDGET_USD, 9),
    costPerRequest: num(env.COST_PER_REQUEST, 0.002),
    units: str(env.UNITS, "mi") === "km" ? "km" : "mi",
    tempUnit: str(env.TEMP_UNIT, "F") === "C" ? "C" : "F",
    batteryKwh: num(env.BATTERY_KWH, 75),
    priceHomeKwh: num(env.PRICE_HOME_KWH, 0.15),
    priceSuperchargerKwh: num(env.PRICE_SUPERCHARGER_KWH, 0.45),
  };
}

export function publicConfig(c: Config) {
  return {
    mode: c.mode, units: c.units, temp_unit: c.tempUnit, battery_kwh: c.batteryKwh,
    monthly_budget_usd: c.monthlyBudgetUsd, cost_per_request: c.costPerRequest,
  };
}
