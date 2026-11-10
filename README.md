# teslog: your own Tesla dashboard, hosted free

A Teslify / TeslaMate-style dashboard that runs on **Cloudflare's free tier** and reads
your car through Tesla's official **Fleet API**. Once set up, it costs **$0/year**:

| | Cost |
|---|---|
| Cloudflare Workers + D1 database + cron + HTTPS (`*.workers.dev`) | Free tier |
| Tesla Fleet API (pay-per-use) | Covered by Tesla's $10/month individual-developer credit¹ |
| Custom domain (optional, only if Tesla rejects `workers.dev`) | ~$10/year |

¹ teslog paces its requests to stay inside a configurable budget (default **$9/month**).
A simulated month of commuting used about $8.50. Set a billing limit in Tesla's portal too.

## What you get

- **Live status:** battery ring with charge limit, range, driving (speed, power) or
  charging (kW, energy added, time to limit), climate, locks, sentry mode, software
  version, and location on a map.
- **Drive log** with distance, battery used, efficiency (Wh/mi), and average speed. Click
  a drive to see its route.
- **Charging log**, AC vs. DC fast, with energy, peak power, and cost at your rates.
- **Trends:** battery level over 24 h / 7 d / 30 d, distance per day, and 30-day totals.
- **API cost meter** and budget pacing.
- Password-protected and mobile-friendly, with light and dark themes.

## How it stays inside the free credit

The Fleet API charges for every request, and Teslify-style services pass that cost on.
teslog keeps request counts low:

| Car is… | teslog | Default |
|---|---|---|
| Asleep / offline | Cheap state check. **Never wakes the car.** | every 20 min |
| Driving | Full data | every 60 s |
| Charging | Full data | every 10 min |
| Parked, awake | Polls for 9 min, then stops for 30 min so the car can sleep | every 3 min |
| Spending ahead of budget | Stretches intervals up to 4× | |
| Budget reached | Hourly checks until the month resets | |

**Trade-off:** because the car is checked only every 20 minutes while asleep, short
trips can start and finish between two checks. teslog still catches them from the
odometer, so distance, battery used, and efficiency are recorded, but they show
**"no route"** and have no speed. In simulation that was about a third of drives,
mostly short errands. Drives already under way when first seen show their duration as
approximate (`~`). To get more detail, lower `POLL_ASLEEP`; each halving costs a few
dollars a month. See *Upgrade path* below for the full-detail option.

## Try the demo locally

Requires Node 20+.

```bash
npm install
npm run demo
```

Open http://localhost:8787. It seeds 30 days of simulated history, then runs a live
drive → Supercharger → drive home. The simulated car runs on US Pacific time.

## Deploy for your car (about 20 minutes, once)

1. **Cloudflare:** create a free account at https://dash.cloudflare.com, then:
   ```bash
   npm install
   npx wrangler login
   npx wrangler d1 create teslog          # copy the database_id into wrangler.toml
   npm run deploy                         # prints https://teslog.<you>.workers.dev
   ```
2. **Dashboard password:**
   ```bash
   npx wrangler secret put DASHBOARD_PASSWORD
   ```
3. **Key pair.** Tesla requires a public key hosted on your domain:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   npx wrangler secret put PUBLIC_KEY_PEM < public-key.pem
   ```
   teslog serves it at `/.well-known/appspecific/com.tesla.3p.public-key.pem`. Keep
   `private-key.pem` somewhere safe and **don't commit it** (`*.pem` is git-ignored).
   It's only needed for future features such as commands and streaming.
4. **Tesla developer app** at https://developer.tesla.com:
   - Allowed origin: `https://teslog.<you>.workers.dev`
   - Redirect URI: `https://teslog.<you>.workers.dev/auth/callback`
   - Scopes: *Vehicle Information* and *Vehicle Location*
   - Add billing details and set a **billing limit** (e.g. $10).
   ```bash
   npx wrangler secret put TESLA_CLIENT_ID
   npx wrangler secret put TESLA_CLIENT_SECRET
   ```
   If you're outside North America, set `TESLA_REGION` in `wrangler.toml` (`eu` or `cn`).
5. Open your workers.dev URL, sign in, and follow **Finish setup**: click *Register*,
   then *Connect* to approve access on tesla.com. Data appears the next time the car is
   awake.

If Tesla won't accept the `workers.dev` domain, add a domain to Cloudflare (about
$10/year through Cloudflare Registrar), attach it to the Worker under *Settings →
Domains & Routes*, and use it in steps 4–5.

## Settings

Change these in `wrangler.toml` under `[vars]`, then run `npm run deploy`:

| Variable | Default | |
|---|---|---|
| `MONTHLY_BUDGET_USD` | `9` | API spend target; pacing keeps you under it |
| `POLL_ASLEEP` / `POLL_DRIVING` / `POLL_CHARGING` / `POLL_ONLINE` | `1200` / `60` / `600` / `180` | seconds |
| `UNITS`, `TEMP_UNIT` | `mi`, `F` | `km`, `C` |
| `BATTERY_KWH` | `75` | usable pack size, for efficiency |
| `PRICE_HOME_KWH`, `PRICE_SUPERCHARGER_KWH` | `0.15`, `0.45` | for charging cost |
| `TESLA_VIN` | first car | pin one vehicle |

## How it works

```
cron (every minute) ─▶ poller: is a poll due? ─▶ Tesla Fleet API
                                    │
                                    ▼
                    recorder: snapshot → drives / charges ─▶ D1 (SQLite)
                                                               │
browser ─▶ Worker (login gate) ─▶ JSON API ◀───────────────────┘
                              └─▶ static dashboard (public/)
```

```
src/
  index.ts      routes, login gate, cron handler
  poller.ts     sleep-friendly, budget-paced polling
  recorder.ts   API response → snapshot; drive/charge detection (incl. missed drives)
  fleet.ts      Tesla OAuth + read-only Fleet API client
  store.ts      D1 queries          analytics.ts  efficiency, cost, period stats
  auth.ts       password + signed session cookie
  simulator.ts  simulated car with the Fleet API's interface (demo + tests)
public/         dashboard (vanilla JS, SVG charts, Leaflet map)
migrations/     D1 schema
```

`npm test` runs the test suite (including a simulated month checked against the $10
credit), and `npm run typecheck` checks types.

## Upgrade path: Fleet Telemetry (full detail, still about $0)

Instead of being polled, the car can **stream** changes to a server you run, at
$0.0001 per signal. That would capture every drive with its full route, in real time,
probably still inside the $10 credit. It needs a small always-on server that accepts
the car's TLS connection (Cloudflare Workers can't), a virtual key paired to the car,
and a signed configuration push. It's a sensible next project once the basics are running.
