/** Single-user password login with an HMAC-signed session cookie. */

const COOKIE = "teslog_session";
const MAX_AGE = 30 * 86400;
const enc = new TextEncoder();

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  // Compare HMACs so the comparison time doesn't depend on the password itself.
  return safeEqual(await hmac("teslog-pw", given), await hmac("teslog-pw", expected));
}

export async function sessionCookie(password: string, now = Date.now() / 1000): Promise<string> {
  const exp = Math.floor(now + MAX_AGE);
  const value = `${exp}.${await hmac(password, `session:${exp}`)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function isLoggedIn(req: Request, password: string, now = Date.now() / 1000): Promise<boolean> {
  const m = (req.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  return safeEqual(sig, await hmac(password, `session:${exp}`));
}

export const LOGIN_PAGE = (error = "") => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>teslog · sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: light-dark(#f4f4f2, #111110); color: light-dark(#0b0b0b, #f0efec); }
  form { background: light-dark(#fcfcfb, #1a1a19); border: 1px solid light-dark(#e3e2de, #2c2c2a);
    border-radius: 12px; padding: 28px; width: min(320px, 90vw); display: grid; gap: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid light-dark(#d5d4cf, #3a3a37);
    background: light-dark(#fff, #111110); color: inherit; }
  button { background: #2a78d6; border-color: #2a78d6; color: #fff; font-weight: 600; cursor: pointer; }
  .err { color: light-dark(#c62828, #f85149); font-size: 13px; }
</style></head>
<body><form method="post" action="/login">
  <h1>teslog</h1>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  ${error ? `<div class="err">${error}</div>` : ""}
  <button type="submit">Sign in</button>
</form></body></html>`;
