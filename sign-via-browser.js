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
 * Usage:
 *   node sign-via-browser.js                # headless, 90s solve budget
 *   node sign-via-browser.js --visible      # show the Chrome window
 *   node sign-via-browser.js --wait 120     # solve budget in seconds
 *
 * Exit codes:
 *   0  signed by this run (JSON on stdout with awarded + balance)
 *   1  already signed today, nothing to do
 *   2  still not signed when the budget ran out, or no button found
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
// so the plumbing (Chrome + CDP + button scan) can be tested without signing.
const skipPre = hasFlag("--skip-precheck");
// Headless still solves, it is just slower because Cap.js checks visibility,
// so give it room to finish instead of relaunching in a window.
const waitSec = Number(argValue('--wait', visible ? 90 : 60));
// How long to look for the button before giving up.
const clickSec = Number(argValue('--click', visible ? 45 : 30));
const port = Number(argValue("--port", 9336));

const scriptDir = __dirname;
const cfgPath = path.join(scriptDir, "config.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
const baseUrl = (cfg.baseUrl || "https://aimarket.hncig.cn:4090").replace(/\/+$/, "");
const profileDir = cfg.profileDir || path.join(scriptDir, "chrome-profile");
const token = cfg.token || "";

function log(o) { console.log(typeof o === "string" ? o : JSON.stringify(o)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const agent = new https.Agent({ rejectUnauthorized: false });

// Small GET against the platform API, same call signin.ps1 makes.
function apiGet(p) {
  return new Promise((resolve) => {
    if (!token) { resolve({ ok: false, why: "no-token-in-config" }); return; }
    const u = new URL(baseUrl + p);
    const req = https.request({
      agent,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "GET",
      headers: { Authorization: "Bearer " + token, "x-request-id": String(Date.now()) },
      timeout: 20000
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

// Match the button a human would click. The unsigned button reads
// "签到领 N 积分", the signed one "今日已签到"; compared via \u escapes so this
// file stays plain ASCII.
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
  "  let has = false; try { has = !!(localStorage.getItem('auth') || ''); } catch {}",
  "  return { buttons: btns.slice(0, 10), hasAuth: has, href: location.href.slice(0, 80), docTitle: (document.title || '').slice(0, 40) };",
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

  // Cheapest check first: if the day is already signed, no browser is needed.
  const before = await signState();
  if (before.ok && before.signed && !skipPre) { await cleanupSoon(1, { ok: true, already: true }, chromePath); }

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
  const evalJs = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (!r || !r.result || r.result.exceptionDetails) return null;
    const res = r.result.result;
    return (res && res.value !== undefined) ? res.value : null;
  };

  await call("Page.enable", {});
  await call("Page.navigate", { url: baseUrl + "/" });

  // The sign-in widget appears only once the SPA has loaded the user session,
  // so wait for the button instead of guessing a sleep length.
  const clickDeadline = Date.now() + clickSec * 1000;
  let clicked = false;
  while (Date.now() < clickDeadline) {
    await sleep(1500);
    const c = await evalJs(CLICK_SIGN);
    if (c && c.clicked) { clicked = true; break; }
    if (c && c.alreadyOnPage) {
      const s = await signState();
      if (s.ok && s.signed) { await cleanup(1, { ok: true, already: true }); }
    }
  }

  if (!clicked) {
    const diag = await evalJs(DIAG);
    await cleanup(2, Object.assign({ ok: false, error: "sign-button-not-found" }, diag || {}));
  }

  // Poll the server until the site's own captcha solve lands.
  const deadline = Date.now() + waitSec * 1000;
  let awarded = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    const s = await signState();
    if (s.ok && s.signed) { awarded = (s.award != null) ? Number(s.award) : null; break; }
  }

  // Last look: the solve may have finished while we were deciding to give up.
  if (awarded === null) {
    const s = await signState();
    if (s.ok && s.signed) awarded = (s.award != null) ? Number(s.award) : null;
  }

  if (awarded === null) { await cleanup(2, { ok: false, error: "still-unsigned-after-" + waitSec + "s" }); }

  await cleanup(0, { ok: true, already: false, awarded, balance: await balance() });
})().catch(e => {
  log({ ok: false, error: "unexpected", detail: String((e && e.stack) || e).slice(0, 400) });
  process.exit(3);
});

// Used before Chrome starts, where there is no socket to close.
async function cleanupSoon(code, payload, chromePath) {
  log(payload);
  process.exit(code);
}