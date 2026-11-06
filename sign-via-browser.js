/*
 * sign-via-browser.js - fallback sign-in for aimarket.hncig.cn.
 *
 * Since 2026-11-01 the platform puts a Cap.js proof-of-work captcha on
 * POST /api/task-award/sign, so a bare API call comes back HTTP 400 code 40000.
 * Rather than reimplement the solver, this opens the real page in Chrome and
 * clicks the real sign-in button, so the site runs its own captcha flow.
 *
 * Success is decided by the sign-status API (queried here in Node with the
 * token from config.json), not by scraping the page: the WASM solve can outlast
 * any on-page toast, and only the server knows whether the award landed.
 *
 * Two things make this survive the platform moving its SSO callback between
 * https://aimarket.hncig.cn:4090 and the portless origin:
 *   1. the token from config.json is injected into the page (CDP, before any
 *      site script runs) instead of hoping that origin already holds a session;
 *   2. every candidate origin is tried in turn, so neither address has to be
 *      "the right one" in config.json.
 *
 * Usage:
 *   node sign-via-browser.js                 # headless, silent
 *   node sign-via-browser.js --visible       # show the Chrome window
 *   node sign-via-browser.js --wait 120      # solve budget per attempt (s)
 *   node sign-via-browser.js --click 25      # button-search budget per attempt (s)
 *   node sign-via-browser.js --skip-precheck # force the browser path (testing)
 *   node sign-via-browser.js --origin URL    # try one origin only
 *
 * stdout is always single-line ASCII JSON (non-ASCII escaped as \uXXXX) so it
 * cannot be corrupted by whatever codepage the caller decodes it with.
 *
 * Exit codes:
 *   0  signed by this run (awarded + balance included)
 *   1  already signed today, nothing to do
 *   2  not signed when the budgets ran out (see error/origin/diag fields)
 *   3  unexpected failure (chrome / CDP / config problems)
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const https = require("node:https");

const args = process.argv.slice(2);
function hasFlag(f) { return args.includes(f); }
function argValue(f, dflt) {
  const i = args.indexOf(f);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return dflt;
}

const visible = hasFlag("--visible");
// --skip-precheck forces the browser path even when the day is already signed,
// so the plumbing (Chrome + CDP + injection + button scan) can be tested
// without signing.
const skipPre = hasFlag("--skip-precheck");
// Headless click works, but on 11-02/04/05/06 Cap.js never solved in headless
// even with a 60s budget, while a visible window solved in 8-20s. So headless
// gets only a token budget: enough for the occasional easy solve, short enough
// that the window appears quickly when it really is needed.
const waitSec = Number(argValue('--wait', visible ? 90 : 15));
// How long to look for the button on one origin before trying the next.
const clickSec = Number(argValue('--click', visible ? 30 : 20));
const port = Number(argValue("--port", 9336));

const scriptDir = __dirname;
const cfgPath = path.join(scriptDir, "config.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
const baseUrl = (cfg.baseUrl || "https://aimarket.hncig.cn:4090").replace(/\/+$/, "");
const profileDir = cfg.profileDir || path.join(scriptDir, "chrome-profile");
const token = cfg.token || "";

// Keep stdout pure ASCII: log lines survive any console codepage.
function asciiJson(o) {
  return JSON.stringify(o).replace(/[\u0080-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
function log(o) { console.log(typeof o === "string" ? o : asciiJson(o)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Origins worth trying: whatever config says first, then its sibling. The
// platform is migrating from https://aimarket.hncig.cn:4090 to the portless
// origin and the SSO callback/session can end up on either one, so nothing
// here assumes a single address is alive.
function candidateOrigins() {
  const one = argValue("--origin", "");
  if (one) return [one.replace(/\/+$/, "")];
  const out = [baseUrl];
  try {
    const u = new URL(baseUrl);
    const root = u.protocol + "//" + u.hostname;
    if (u.port === "4090") out.push(root);
    else if (!u.port) out.push(root + ":4090");
  } catch {}
  return Array.from(new Set(out.filter(Boolean)));
}

const allOrigins = candidateOrigins();
// First origin that answers a real JSON envelope; reused for later calls.
let preferredOrigin = null;

const agent = new https.Agent({ rejectUnauthorized: false });

function apiGetOn(origin, p) {
  return new Promise((resolve) => {
    const u = new URL(origin + p);
    const req = https.request({
      agent,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "GET",
      headers: { Authorization: "Bearer " + token, "x-request-id": String(Date.now()) },
      timeout: 15000
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(buf);
          resolve({ ok: true, http: res.statusCode, code: j.code, data: j.data });
        } catch { resolve({ ok: false, why: "unparsable", http: res.statusCode }); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", (e) => resolve({ ok: false, why: String(e && e.message || e) }));
    req.end();
  });
}

// Small GET against the platform API, same call signin.ps1 makes. Tries the
// configured origin, then the sibling, so one address being retired (or the
// token being valid on the other one only) is not a failure.
async function apiGet(p) {
  if (!token) return { ok: false, why: "no-token-in-config" };
  const order = preferredOrigin
    ? [preferredOrigin].concat(allOrigins.filter(o => o !== preferredOrigin))
    : allOrigins;
  let last = { ok: false, why: "no-origin" };
  for (const origin of order) {
    last = await apiGetOn(origin, p);
    if (last.ok && typeof last.code === "number") { preferredOrigin = origin; return last; }
  }
  return last;
}

// Today's sign state, straight from the server.
async function signState() {
  const r = await apiGet("/api/task-award/sign-status");
  if (!r.ok || !r.data || r.code !== 20000) return { ok: false, why: r.why || "bad-response" };
  return { ok: true, signed: !!r.data.signedToday, award: (r.data.awarded != null ? r.data.awarded : r.data.signAward) };
}

async function balance() {
  const r = await apiGet("/api/user/info");
  if (r.ok && r.data && r.data.power != null) return r.data.power;
  return null;
}

// Run before any site script on every new document, so the SPA boots already
// holding our token. Shape seen in the wild: localStorage.auth =
// {"auth":{"token":"eyJ..."}}; a logged-out origin holds {"auth":{}}.
// The hostname guard matters: this hook fires on every navigation, including a
// bounce to the unified-portal IdP, and our bearer token must never be written
// into a third-party origin's storage.
function injectScript(tok, siteHost) {
  return [
    "(() => {",
    "  const T = " + JSON.stringify(tok) + ";",
    "  const H = " + JSON.stringify(siteHost) + ";",
    "  if (!T) return;",
    "  if (location.hostname !== H) return;",
    "  try {",
    "    let obj = {};",
    "    try { obj = JSON.parse(localStorage.getItem('auth') || '{}'); } catch (e) { obj = {}; }",
    "    if (!obj || typeof obj !== 'object') obj = {};",
    "    if (!obj.auth || typeof obj.auth !== 'object') obj.auth = {};",
    "    if (obj.auth.token !== T) { obj.auth.token = T; localStorage.setItem('auth', JSON.stringify(obj)); }",
    "  } catch (e) {}",
    "})()"
  ].join("\n");
}

// Match the button a human would click (by title/innerText). The unsigned one
// reads U+7B7E U+5230 U+9886 N U+79EF U+5206 ("sign in to earn N points") and the
// signed one U+4ECA U+65E5 U+5DF2 U+7B7E U+5230 ("already signed today"); the
// patterns below use \u escapes so this file stays plain ASCII.
const CLICK_SIGN = [
  "(() => {",
  "  const SIGN = /\\u7b7e\\u5230/;",
  "  const DONE = /\\u5df2\\u7b7e\\u5230/;",
  "  const btns = Array.from(document.querySelectorAll('button'));",
  "  for (const b of btns) {",
  "    const label = (b.getAttribute('title') || '') + ' ' + (b.innerText || '');",
  "    if (SIGN.test(label) && !DONE.test(label) && !b.disabled) { b.click(); return { clicked: true }; }",
  "    if (DONE.test(label)) return { clicked: false, alreadyOnPage: true };",
  "  }",
  "  return { clicked: false };",
  "})()"
].join("\n");

// What the page really shows, so a failed run explains itself in the log.
const DIAG = [
  "(() => {",
  "  const btns = Array.from(document.querySelectorAll('button')).map(b => ((b.getAttribute('title') || '') + '|' + (b.innerText || '').trim()).slice(0, 40));",
  "  let hasToken = false;",
  "  try { const a = JSON.parse(localStorage.getItem('auth') || '{}'); hasToken = !!(a && a.auth && a.auth.token); } catch (e) {}",
  "  return { buttons: btns.slice(0, 10), hasToken, href: location.href.slice(0, 90), docTitle: (document.title || '').slice(0, 40) };",
  "})()"
].join("\n");

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

async function waitJson(url, tries) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(300);
  }
  return null;
}

(async () => {
  if (!token) { log({ ok: false, error: "no-token-in-config" }); process.exit(3); }
  const chromePath = resolveChrome();
  if (!chromePath) { log({ ok: false, error: "chrome-not-found" }); process.exit(3); }
  const origins = candidateOrigins();

  // Cheapest check first: if the day is already signed, no browser is needed.
  const before = await signState();
  if (before.ok && before.signed && !skipPre) {
    log({ ok: true, already: true, awarded: before.award, balance: await balance() });
    process.exit(1);
  }

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
    await sleep(400);
    try { if (!exited) chrome.kill(); } catch {}
    log(payload);
    process.exit(code);
  };

  const targets = await waitJson("http://127.0.0.1:" + port + "/json/list", 60);
  if (!targets) { log({ ok: false, error: "cdp-unreachable", note: "the dedicated Chrome profile may be open elsewhere" }); try { chrome.kill(); } catch {} process.exit(3); }

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
    if (!r || !r.result || r.result.exceptionDetails) return null;
    const res = r.result.result;
    return (res && res.value !== undefined) ? res.value : null;
  };

  await call("Page.enable", {});
  // One host covers both origins here (they differ only by port), which is exactly
  // the set of sites we are willing to hand the token to.
  const siteHost = (() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })();
  await call("Page.addScriptToEvaluateOnNewDocument", { source: injectScript(token, siteHost) });

  // Find the button on one origin and click it. We deliberately do NOT wait for
  // the captcha here: Cap.js mostly refuses to solve in headless (every recent
  // day solved only once a window was shown), so burning the full budget per
  // origin just delays the visible attempt. First origin whose page is signed
  // in and whose button we can click wins.
  async function clickOn(origin) {
    await call("Page.navigate", { url: origin + "/" });
    const deadline = Date.now() + clickSec * 1000;
    let sawLogin = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const href = await evalJs("location.href", false);
      if (typeof href === "string" && /\/login/.test(href)) { sawLogin = true; continue; }
      const c = await evalJs(CLICK_SIGN);
      if (c && c.clicked) {
        log({ progress: "sign button clicked, waiting for the site captcha", origin });
        return { kind: "clicked", origin };
      }
      if (c && c.alreadyOnPage) {
        const s = await signState();
        if (s.ok && s.signed) return { kind: "signed", award: (s.award != null ? Number(s.award) : null), origin, via: "already" };
        return { kind: "page-signed-server-not", origin, diag: await evalJs(DIAG) };
      }
    }
    return { kind: sawLogin ? "redirected-to-login" : "no-sign-button", origin, diag: await evalJs(DIAG) };
  }

  const attempts = [];
  let clicked = null;
  for (const origin of origins) {
    const a = await clickOn(origin);
    attempts.push(a);
    if (a.kind === "signed") {
      // The page already showed "signed today" and the server agrees: nothing
      // was earned by this run, so report it as "already" (exit 1), never as a
      // fresh success.
      await cleanup(1, { ok: true, already: true, awarded: a.award, balance: await balance(), origin, via: "already", attempts });
    }
    if (a.kind === "clicked") { clicked = a; break; }
  }

  if (!clicked) {
    // Every origin bounced to /login even though a token was injected: the
    // server rejected that token, so this is a re-login problem, not a missing
    // button. Say so, otherwise the log reads like a page-layout change.
    await cleanup(2, {
      ok: false,
      error: attempts.length && attempts.every(a => a.kind === "redirected-to-login") ? "redirected-to-login" : "no-sign-button",
      hint: attempts.length && attempts.every(a => a.kind === "redirected-to-login")
        ? "token rejected by the server - run login-once.cmd and scan the WeCom QR code"
        : "no sign button on any origin - the page layout may have changed",
      tried: attempts.map(a => ({ origin: a.origin, kind: a.kind })),
      diag: (attempts[attempts.length - 1] || {}).diag || null
    });
  }

  // One shared budget for the captcha the site is now solving on our behalf.
  const stop = Date.now() + waitSec * 1000;
  let signed = null;
  while (Date.now() < stop) {
    await sleep(2500);
    const s = await signState();
    if (s.ok && s.signed) { signed = s; break; }
  }
  if (!signed) { const s = await signState(); if (s.ok && s.signed) signed = s; }

  if (!signed) {
    await cleanup(2, {
      ok: false,
      error: "captcha-not-solved-in-" + waitSec + "s",
      note: visible ? "shown a window and still unsigned" : "headless rarely solves this captcha; retry with --visible",
      origin: clicked.origin,
      tried: attempts.map(a => ({ origin: a.origin, kind: a.kind })),
      diag: await evalJs(DIAG)
    });
  }

  await cleanup(0, {
    ok: true, already: false,
    awarded: (signed.award != null ? Number(signed.award) : null),
    balance: await balance(),
    origin: clicked.origin, via: "clicked",
    attempts
  });
})().catch(e => {
  log({ ok: false, error: "unexpected", detail: String((e && e.stack) || e).slice(0, 400) });
  process.exit(3);
});
