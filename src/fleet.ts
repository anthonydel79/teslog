/**
 * Minimal Tesla Fleet API client (read-only) with OAuth tokens kept in D1.
 * Docs: https://developer.tesla.com/docs/fleet-api
 */
import { Config, REGIONS } from "./config";
import { Store } from "./store";

export const AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
export const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
export const SCOPES = "openid offline_access vehicle_device_data vehicle_location";
const DATA_ENDPOINTS = "charge_state;climate_state;drive_state;location_data;vehicle_state;vehicle_config";

export class FleetError extends Error {
  constructor(public status: number, public body: string) {
    super(`Fleet API HTTP ${status}: ${body.slice(0, 300)}`);
  }
}
/** 408: the car is asleep or offline. teslog never wakes it. */
export class VehicleUnavailable extends FleetError {}

export interface VehicleSource {
  isAuthorized(): Promise<boolean>;
  vehicles(): Promise<any[]>;
  vehicle(vin: string): Promise<any>;
  vehicleData(vin: string): Promise<any>;
}

interface Tokens { access_token: string; refresh_token: string; expires_at: number }

async function request(method: string, url: string, opts: { token?: string; form?: Record<string, string>; json?: unknown } = {}) {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.form) { body = new URLSearchParams(opts.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  else if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers["Content-Type"] = "application/json"; }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new (res.status === 408 ? VehicleUnavailable : FleetError)(res.status, text);
  return text ? JSON.parse(text) : {};
}

export class FleetClient implements VehicleSource {
  constructor(private cfg: Config, private store: Store) {}

  get baseUrl() { return REGIONS[this.cfg.region] ?? REGIONS.na; }

  // ---------- OAuth ----------
  async authorizeUrl(redirectUri: string): Promise<string> {
    const state = crypto.randomUUID();
    await this.store.setMeta("oauth_state", { state, ts: Date.now() / 1000 });
    const q = new URLSearchParams({
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: redirectUri,
      scope: SCOPES, state, prompt_missing_scopes: "true",
    });
    return `${AUTHORIZE_URL}?${q}`;
  }

  async handleCallback(code: string, state: string, redirectUri: string): Promise<void> {
    const pending = await this.store.getMeta<{ state: string; ts: number }>("oauth_state");
    await this.store.deleteMeta("oauth_state");
    if (!pending || pending.state !== state || Date.now() / 1000 - pending.ts > 600)
      throw new Error("OAuth state mismatch or expired. Start the login again.");
    const tok = await request("POST", TOKEN_URL, { form: {
      grant_type: "authorization_code", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
      code, audience: this.baseUrl, redirect_uri: redirectUri,
    } });
    await this.saveTokens(tok);
  }

  private async saveTokens(tok: any, previousRefresh?: string) {
    const t: Tokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? previousRefresh,
      expires_at: Date.now() / 1000 + Number(tok.expires_in ?? 28800) - 120,
    };
    await this.store.setMeta("tokens", t);
    return t;
  }

  async isAuthorized() { return (await this.store.getMeta("tokens")) !== null; }

  async logout() { await this.store.deleteMeta("tokens"); }

  private async accessToken(): Promise<string> {
    let t = await this.store.getMeta<Tokens>("tokens");
    if (!t) throw new FleetError(401, "Not connected. Use 'Connect Tesla account' on the dashboard.");
    if (Date.now() / 1000 >= t.expires_at) {
      // Refresh tokens rotate: always keep the newest one.
      const fresh = await request("POST", TOKEN_URL, { form: {
        grant_type: "refresh_token", client_id: this.cfg.clientId, refresh_token: t.refresh_token,
      } });
      t = await this.saveTokens(fresh, t.refresh_token);
    }
    return t.access_token;
  }

  // ---------- data ----------
  private async get(path: string) {
    return request("GET", this.baseUrl + path, { token: await this.accessToken() });
  }

  async vehicles() { return (await this.get("/api/1/vehicles")).response ?? []; }

  /** Cheap state lookup (online / asleep / offline). Does not wake the car. */
  async vehicle(vin: string) { return (await this.get(`/api/1/vehicles/${vin}`)).response ?? {}; }

  async vehicleData(vin: string) {
    const q = encodeURIComponent(DATA_ENDPOINTS).replace(/%3B/g, ";");
    return (await this.get(`/api/1/vehicles/${vin}/vehicle_data?endpoints=${q}`)).response ?? {};
  }

  /** One-time: register the app's domain with this Fleet API region. */
  async registerPartner(domain: string) {
    const tok = await request("POST", TOKEN_URL, { form: {
      grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
      scope: SCOPES, audience: this.baseUrl,
    } });
    return request("POST", `${this.baseUrl}/api/1/partner_accounts`, { token: tok.access_token, json: { domain } });
  }
}
