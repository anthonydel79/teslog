/** Cloudflare Worker: dashboard + JSON API (fetch) and the polling loop (cron). */
import { enrichCharge, enrichDrive, stats } from "./analytics";
import { LOGIN_PAGE, clearCookie, isLoggedIn, passwordMatches, sessionCookie } from "./auth";
import { Config, Env, loadConfig, publicConfig } from "./config";
import { FleetClient, VehicleSource } from "./fleet";
import { Poller, PollerState, initialPollerState } from "./poller";
import { Recorder } from "./recorder";
import { HOME, LOCAL_SUPERCHARGER, SimCar, SimFleet, SimState, haversineMi } from "./simulator";
import { Store } from "./store";

const PUBKEY_PATH = "/.well-known/appspecific/com.tesla.3p.public-key.pem";

const json = (obj: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { Location: to, ...headers } });

/** Demo mode polls more eagerly so the dashboard visibly moves. */
function effectiveConfig(env: Env): Config {
  const cfg = loadConfig(env);
  if (cfg.mode !== "demo") return cfg;
  return { ...cfg, intervalDriving: 15, intervalCharging: 30, intervalOnline: 30, intervalAsleep: 60, monthlyBudgetUsd: 1e9 };
}

/** Run one poll if it is due (or if forced). Shared by cron, "Refresh now" and demo mode. */
export async function runPoll(env: Env, now: number, force = false): Promise<PollerState> {
  const cfg = effectiveConfig(env);
  const store = new Store(env.DB);
  const st = (await store.getMeta<PollerState>("poller")) ?? initialPollerState(cfg.vin);
  if (!force && now < st.next_poll_at) return st;

  let source: VehicleSource;
  let car: SimCar | null = null;
  if (cfg.mode === "demo") {
    const saved = await store.getMeta<SimState>("sim_car");
    car = saved ? new SimCar(saved) : SimCar.create(now - 60, { batteryKwh: cfg.batteryKwh });
    if (!(await store.getMeta("demo_live"))) {
      // Give a fresh demo something to watch: drive → Supercharge → drive home.
      car.advance(now);
      const start = now + 20;
      const firstLeg = Math.max(300, (haversineMi(car.s.pos, LOCAL_SUPERCHARGER) / 35) * 3600); // ~35 mph
      car.schedule({ kind: "drive", start, duration: firstLeg, route: [car.s.pos, LOCAL_SUPERCHARGER] });
      car.schedule({ kind: "charge", start: start + firstLeg + 20, duration: 1200, fast: true, target_soc: Math.min(95, car.s.soc + 35) });
      car.schedule({ kind: "drive", start: start + firstLeg + 1280, duration: 480, route: [LOCAL_SUPERCHARGER, HOME] });
      await store.setMeta("demo_live", true);
    }
    source = new SimFleet(car, () => now);
  } else {
    source = new FleetClient(cfg, store);
    if (!(await source.isAuthorized())) {
      st.phase = "waiting for Tesla login";
      await store.setMeta("poller", st);
      return st;
    }
  }
  const poller = new Poller(cfg, source, store, new Recorder(store, cfg.priceHomeKwh, cfg.priceSuperchargerKwh), st);
  await poller.tick(now);
  await store.setMeta("poller", poller.st);
  if (car) await store.setMeta("sim_car", car.s);
  return poller.st;
}

async function summary(env: Env, now: number) {
  const cfg = effectiveConfig(env);
  const store = new Store(env.DB);
  const st = (await store.getMeta<PollerState>("poller")) ?? initialPollerState();
  const calls = await store.apiCalls(now);
  const cost = calls * cfg.costPerRequest;
  const [openDrive, openCharge] = await Promise.all([store.openSession("drives"), store.openSession("charges")]);
  return {
    config: { ...publicConfig(cfg) },
    meta: { display_name: (await store.getMeta<string>("display_name")) ?? "My Tesla" },
    authorized: cfg.mode === "demo" || (await store.getMeta("tokens")) !== null,
    partner_registered: cfg.mode === "demo" || (await store.getMeta("partner_registered")) !== null,
    public_key_configured: cfg.mode === "demo" || !!env.PUBLIC_KEY_PEM,
    latest: await store.latest(),
    latest_data: await store.latestWithData(),
    poller: {
      phase: st.phase, last_error: st.last_error,
      next_poll_in: st.next_poll_at ? Math.max(0, Math.round(st.next_poll_at - now)) : null,
      api_calls_month: calls, api_cost_month: Math.round(cost * 100) / 100,
      budget: cfg.monthlyBudgetUsd, throttled: st.phase.includes("budget"),
    },
    open_drive: openDrive ? enrichDrive(openDrive, cfg.batteryKwh, now) : null,
    open_charge: openCharge ? enrichCharge(openCharge, now) : null,
    server_time: now,
  };
}

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const now = Date.now() / 1000;
  const cfg = effectiveConfig(env);

  // ---------- public routes ----------
  if (p === PUBKEY_PATH) {
    return env.PUBLIC_KEY_PEM
      ? new Response(env.PUBLIC_KEY_PEM, { headers: { "Content-Type": "application/x-pem-file" } })
      : new Response("public key not configured", { status: 404 });
  }

  const password = env.DASHBOARD_PASSWORD ?? "";
  if (!password && cfg.mode !== "demo") {
    return html("<p style='font-family:system-ui;padding:24px'>Set a dashboard password first: " +
      "<code>npx wrangler secret put DASHBOARD_PASSWORD</code></p>", 503);
  }
  if (p === "/login") {
    if (req.method === "POST") {
      const form = await req.formData();
      if (password && (await passwordMatches(String(form.get("password") ?? ""), password)))
        return redirect("/", { "Set-Cookie": await sessionCookie(password, now) });
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      return html(LOGIN_PAGE("Wrong password."), 401);
    }
    return html(LOGIN_PAGE());
  }
  if (p === "/logout") return redirect("/login", { "Set-Cookie": clearCookie });

  if (password && !(await isLoggedIn(req, password, now))) {
    return p.startsWith("/api/") ? json({ error: "login required" }, 401) : redirect("/login");
  }

  // ---------- authenticated routes ----------
  const store = new Store(env.DB);
  const q = url.searchParams;
  const redirectUri = env.TESLA_REDIRECT_URI || `${url.origin}/auth/callback`;

  if (p === "/api/summary") {
    if (cfg.mode === "demo") await runPoll(env, now); // dev servers don't fire cron
    return json(await summary(env, now));
  }
  if (p === "/api/history") {
    const hours = Math.min(Number(q.get("hours") ?? 24), 24 * 90);
    return json(await store.history(now - hours * 3600));
  }
  if (p === "/api/drives") {
    const rows = await store.drives(Number(q.get("limit") ?? 50));
    return json(rows.map((d) => enrichDrive(d, cfg.batteryKwh, now)));
  }
  const m = p.match(/^\/api\/drives\/(\d+)$/);
  if (m) {
    const d = await store.drive(Number(m[1]));
    if (!d) return json({ error: "not found" }, 404);
    return json({ ...enrichDrive(d, cfg.batteryKwh, now), path: d.inferred ? [] : await store.path(d.start_ts, d.end_ts) });
  }
  if (p === "/api/charges") {
    const rows = await store.charges(Number(q.get("limit") ?? 50));
    return json(rows.map((c) => enrichCharge(c, now)));
  }
  if (p === "/api/stats") {
    const days = Math.min(Number(q.get("days") ?? 30), 365);
    return json(await stats(store, days, cfg.batteryKwh, Number(q.get("tz") ?? 0), now));
  }
  if (p === "/api/poll" && req.method === "POST") {
    await runPoll(env, now, true);
    return json({ ok: true });
  }
  if (p === "/api/setup/register" && req.method === "POST") {
    if (cfg.mode === "demo") return json({ error: "not available in demo mode" }, 400);
    const result = await new FleetClient(cfg, store).registerPartner(url.hostname);
    await store.setMeta("partner_registered", { domain: url.hostname, ts: now });
    return json({ ok: true, result });
  }
  if (p === "/auth/login") {
    if (cfg.mode === "demo") return json({ error: "demo mode" }, 400);
    return redirect(await new FleetClient(cfg, store).authorizeUrl(redirectUri));
  }
  if (p === "/auth/callback") {
    if (q.get("error")) return json({ error: q.get("error"), detail: q.get("error_description") }, 400);
    await new FleetClient(cfg, store).handleCallback(q.get("code") ?? "", q.get("state") ?? "", redirectUri);
    ctx.waitUntil(runPoll(env, now, true));
    return redirect("/");
  }
  if (p === "/auth/disconnect" && req.method === "POST") {
    await new FleetClient(cfg, store).logout();
    return json({ ok: true });
  }
  if (p.startsWith("/api/") || p.startsWith("/auth/")) return json({ error: "not found" }, 404);
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPoll(env, Date.now() / 1000));
  },
} satisfies ExportedHandler<Env>;
