/*
 * renew-token.js - silently refresh the aimarket.hncig.cn login token (8h JWT)
 * using the enterprise-WeChat (企业微信) SSO session stored in a dedicated
 * Chrome profile. Uses only Node built-ins + Chrome DevTools Protocol.
 *
 * Usage:
 *   node renew-token.js                 # headless, silent refresh only
 *   node renew-token.js --visible --wait 1800
 *                                       # show a Chrome window; if the SSO session
 *                                       # is gone, the QR page appears so it can
 *                                       # be scanned again. Waits up to 30 min.
 *
 * Exit codes:
 *   0  refreshed (config.json updated)
 *   2  needs interactive login (QR scan required) / session expired
 *   3  unexpected failure (details printed to stdout)
 */
"use strict";

const { spawn } = require("node:child_process");
const os   = require("node:os");
const path = require("node:path");
const fs   = require("node:fs");

const args = process.argv.slice(2);
function hasFlag(f) { return args.includes(f); }
function argValue(f, dflt) {
  const i = args.indexOf(f);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return dflt;
}

const visible = hasFlag("--visible");
const waitSec = Number(argValue("--wait", visible ? 1800 : 30));
const port    = Number(argValue("--port", 9335));

const scriptDir = __dirname;
const cfgPath   = path.join(scriptDir, "config.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
const baseUrl    = (cfg.baseUrl || "https://aimarket.hncig.cn:4090").replace(/\/+$/, "");
const profileDir = cfg.profileDir || path.join(scriptDir, "chrome-profile");

function log(o) { console.log(typeof o === "string" ? o : JSON.stringify(o)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resolveChrome() {
  if (cfg.chromePath && fs.existsSync(cfg.chromePath)) return cfg.chromePath;
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return null;
}

function jwtExpSec(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = p + "=".repeat((4 - (p.length % 4)) % 4);
    const j = JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
    return Number(j.exp) || 0;
  } catch { return 0; }
}

async function waitJson(url, tries) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(400);
  }
  return null;
}

const TOKEN_EXPR = [
  "(() => {",
  "  const rx = /eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}/;",
  "  let out = '';",
  "  try { const m = (localStorage.getItem('auth') || '').match(rx); if (m) out = m[0]; } catch {}",
  "  if (!out) { try { const m = decodeURIComponent(document.cookie || '').match(rx); if (m) out = m[0]; } catch {} }",
  "  return out;",
  "})()"
].join("\n");

(async () => {
  const chromePath = resolveChrome();
  if (!chromePath) { log({ ok: false, error: "chrome-not-found" }); process.exit(3); }

  fs.mkdirSync(profileDir, { recursive: true });

  const launchArgs = [
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profileDir,
    "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--disable-extensions",
    "--window-size=1200,900",
    "about:blank"
  ];
  if (!visible) launchArgs.unshift("--headless=new");

  const chrome = spawn(chromePath, launchArgs, { stdio: "ignore" });
  let exited = false;
  let ws = null;
  chrome.on("exit", () => { exited = true; });

  const cleanup = async (code, payload) => {
    try { if (ws && ws.readyState === 1) { await call("Browser.close", {}).catch(() => {}); ws.close(); } } catch {}
    await sleep(800);
    try { if (!exited) chrome.kill(); } catch {}
    log(payload);
    process.exit(code);
  };

  const targets = await waitJson("http://127.0.0.1:" + port + "/json/list", 50);
  if (!targets) { await cleanup(3, { ok: false, error: "cdp-unreachable", note: "profile may already be in use by another Chrome window" }); }

  const page = targets.find(t => t.type === "page") || targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("ws-timeout")), 10000);
      ws.onopen = () => { clearTimeout(to); res(); };
      ws.onerror = () => { clearTimeout(to); rej(new Error("ws-error")); };
    });
  } catch (e) { await cleanup(3, { ok: false, error: "cdp-ws-failed", detail: String(e && e.message) }); }

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const call = (method, params) => new Promise((res) => {
    const id = nextId++;
    const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __timeout: true }); } }, 30000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    try { ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(t); res({ __timeout: true }); }
  });
  const evalJs = async (expression, awaitPromise = true) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (!r || !r.result) return null;
    if (r.result.exceptionDetails) return null;
    const res = r.result.result;
    if (!res) return null;
    return res.value !== undefined ? res.value : null;
  };

  await call("Page.enable", {});
  await call("Network.enable", {});

  // restore SSO cookies saved by a previous (interactive) login, so the
  // enterprise-WeChat session survives even if the cookies are session-scoped
  const ssoCookieFile = path.join(scriptDir, "sso-cookies.json");
  if (fs.existsSync(ssoCookieFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ssoCookieFile, "utf8"));
      if (Array.isArray(saved) && saved.length) {
        await call("Network.setCookies", { cookies: saved });
      }
    } catch {}
  }

  // 1) land on the site so relative fetches work
  await call("Page.navigate", { url: baseUrl + "/" });
  let oldToken = "";
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    const href = await evalJs("location.href", false);
    if (typeof href === "string" && href.startsWith(baseUrl)) {
      oldToken = (await evalJs(TOKEN_EXPR)) || "";
      break;
    }
  }

  // 2) kick off the unified (enterprise WeChat) SSO entry
  let startRaw = await evalJs(
    "fetch('/api/auth/unified/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'})" +
    ".then(r=>r.text()).catch(e=>'ERR:'+e.message)"
  );
  let authUrl = "";
  try { authUrl = JSON.parse(startRaw).data.authorizationUrl; } catch {}
  if (!authUrl) { await cleanup(3, { ok: false, error: "sso-start-failed", detail: String(startRaw).slice(0, 200) }); }

  // 3) go through the IdP; if the session is alive it bounces straight back with ?code=
  await call("Page.navigate", { url: authUrl });

  const deadline = Date.now() + waitSec * 1000;
  let sawQrPage = false;
  let newToken = "";
  while (Date.now() < deadline) {
    await sleep(1200);
    const href = await evalJs("location.href", false);
    if (typeof href === "string" && /info\.hncig\.cn/.test(href)) {
      const txt = await evalJs("(document.body && document.body.innerText || '').slice(0,200)", false);
      if (typeof txt === "string" && (/扫码登录/.test(txt) || /企业微信/.test(txt))) sawQrPage = true;
      if (sawQrPage && !visible) { break; }
      continue;
    }
    if (typeof href === "string" && href.startsWith(baseUrl)) {
      const t = (await evalJs(TOKEN_EXPR)) || "";
      if (t && t !== oldToken && jwtExpSec(t) * 1000 > Date.now() + 60 * 1000) { newToken = t; break; }
      if (t && t === oldToken && jwtExpSec(t) * 1000 > Date.now() + 5 * 60 * 1000) { newToken = t; break; }
    }
  }

  if (!newToken) {
    await cleanup(2, { ok: false, needRelogin: true, sawQrPage,
      hint: "SSO session expired - scan the QR code with WeCom to sign in again" });
  }

  cfg.token = newToken;
  cfg.setAt = new Date().toISOString();
  cfg.profileDir = profileDir;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

  // remember the SSO cookies (incl. session cookies) for future silent renewals
  try {
    const all = await call("Network.getAllCookies", {});
    const cookies = ((all.result && all.result.cookies) || [])
      .filter(c => /(^|\.)hncig\.cn$/.test(c.domain || ""));
    if (cookies.length) fs.writeFileSync(ssoCookieFile, JSON.stringify(cookies, null, 2), "utf8");
  } catch {}

  const exp = jwtExpSec(newToken) * 1000;
  await cleanup(0, { ok: true, changed: newToken !== oldToken,
    expiresAt: exp ? new Date(exp).toISOString() : null });
})().catch(async (e) => {
  log({ ok: false, error: "unexpected", detail: String(e && e.stack || e).slice(0, 500) });
  process.exit(3);
});