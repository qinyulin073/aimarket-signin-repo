/*
 * sign-via-browser.js - click the real sign-in button in Chrome so the site's
 * own Cap.js captcha flow runs (WASM + fingerprint). Used as a fallback when
 * the direct API POST gets rejected with "请完成安全验证后重试".
 *
 * Usage:
 *   node sign-via-browser.js            # headless first
 *   node sign-via-browser.js --visible  # show a Chrome window
 *   node sign-via-browser.js --wait 60  # timeout in seconds (default 120)
 *
 * Exit codes:
 *   0  signed OK (prints JSON with awarded + balance)
 *   1  already signed today
 *   2  captcha failed / could not find the button
 *   3  unexpected failure
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
function hasFlag(f) { return args.includes(f); }
function argValue(f, dflt) {
  const i = args.indexOf(f);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return dflt;
}

const visible = hasFlag("--visible");
const waitSec = Number(argValue("--wait", 120));
const port = Number(argValue("--port", 9336));

const scriptDir = __dirname;
const cfgPath = path.join(scriptDir, "config.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
const baseUrl = (cfg.baseUrl || "https://aimarket.hncig.cn:4090").replace(/\/+$/, "");
const profileDir = cfg.profileDir || path.join(scriptDir, "chrome-profile");

function log(o) { console.log(typeof o === "string" ? o : JSON.stringify(o)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resolveChrome() {
  if (cfg.chromePath && fs.existsSync(cfg.chromePath)) return cfg.chromePath;
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return null;
}

async function waitJson(url, tries) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(400);
  }
  return null;
}

const FIND_BUTTON = `
(() => {
  // find the sign-in button by its title or text
  const btns = document.querySelectorAll('button[title]');
  for (const b of btns) {
    const t = b.getAttribute('title') || '';
    if (t.includes('签到领') || (t.includes('签到') && !t.includes('已签到'))) {
      if (!b.disabled) return { found: true, rect: b.getBoundingClientRect() };
    }
  }
  // fallback: look by innerText
  const all = document.querySelectorAll('button');
  for (const b of all) {
    const txt = (b.innerText || '').trim();
    if (txt.includes('签到领') && !b.disabled) return { found: true, rect: b.getBoundingClientRect() };
  }
  // check if already signed
  const signed = document.querySelector('button[title="今日已签到"]') ||
    Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').trim() === '已签到');
  if (signed) return { found: false, alreadySigned: true };
  return { found: false };
})()`;

const CLICK_BUTTON = `
(() => {
  const btns = document.querySelectorAll('button[title]');
  for (const b of btns) {
    const t = b.getAttribute('title') || '';
    if (t.includes('签到领') || (t.includes('签到') && !t.includes('已签到'))) {
      if (!b.disabled) { b.click(); return true; }
    }
  }
  const all = document.querySelectorAll('button');
  for (const b of all) {
    const txt = (b.innerText || '').trim();
    if (txt.includes('签到领') && !b.disabled) { b.click(); return true; }
  }
  return false;
})()`;

const CHECK_TOAST = `
(() => {
  const body = document.body ? document.body.innerText : '';
  const success = body.match(/签到成功[，,]\\s*获得\\s*(\\d+)\\s*积分/);
  if (success) return { signed: true, awarded: parseInt(success[1], 10) };
  const already = body.includes('今日已签到');
  if (already) return { signed: true, already: true };
  const err = body.match(/签到失败|验证失败/);
  if (err) return { error: err[0] };
  return null;
})()`;

const GET_AWARDED = `
(() => {
  // after clicking, the button may change to "已签到" — get the awarded amount from the toast
  const body = document.body ? document.body.innerText : '';
  const m = body.match(/签到成功[，,]\\s*获得\\s*(\\d+)\\s*积分/);
  return m ? parseInt(m[1], 10) : null;
})()`;

async function main() {
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
  if (!targets) { await cleanup(3, { ok: false, error: "cdp-unreachable" }); }

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

  // navigate to the main page
  await call("Page.navigate", { url: baseUrl + "/" });
  await sleep(3000);

  // wait for the sign-in button to appear
  const deadline = Date.now() + waitSec * 1000;
  let clicked = false;
  while (Date.now() < deadline) {
    const st = await evalJs(FIND_BUTTON, false);
    if (st && st.alreadySigned) { await cleanup(1, { ok: true, already: true }); }
    if (st && st.found) {
      const ok = await evalJs(CLICK_BUTTON, false);
      if (ok) { clicked = true; break; }
    }
    await sleep(1500);
  }

  if (!clicked) { await cleanup(2, { ok: false, error: "button-not-found-or-timeout" }); }

  // wait for the result (toast or button state change)
  let awarded = null;
  let already = false;
  const resultDeadline = Date.now() + 30000; // captcha can take a while
  while (Date.now() < resultDeadline) {
    await sleep(1500);
    const toast = await evalJs(CHECK_TOAST, false);
    if (toast) {
      if (toast.signed) {
        awarded = toast.awarded || null;
        already = !!toast.already;
        break;
      }
      if (toast.error) { await cleanup(2, { ok: false, error: toast.error }); }
    }
    // also check button state
    const st = await evalJs(FIND_BUTTON, false);
    if (st && st.alreadySigned) { already = true; break; }
  }

  if (!awarded && !already) {
    await cleanup(2, { ok: false, error: "no-result-within-timeout" });
  }

  // get current balance
  let balance = null;
  try {
    const tokenExpr = `(() => { const rx = /eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}/; let out = ''; try { const m = (localStorage.getItem('auth') || '').match(rx); if (m) out = m[0]; } catch {} if (!out) { try { const m = decodeURIComponent(document.cookie || '').match(rx); if (m) out = m[0]; } catch {} } return out; })()`;
    const token = await evalJs(tokenExpr, false);
    if (token) {
      const r = await fetch(baseUrl + "/api/user/info", { headers: { Authorization: "Bearer " + token } });
      if (r.ok) { const j = await r.json(); if (j.data && j.data.power != null) balance = j.data.power; }
    }
  } catch {}

  await cleanup(0, { ok: true, already, awarded, balance });
}

main().catch(e => {
  log({ ok: false, error: "unexpected", detail: String(e && e.stack || e).slice(0, 500) });
  process.exit(3);
});
