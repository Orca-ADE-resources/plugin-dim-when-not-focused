#!/usr/bin/env node
// Runs src/renderer-dim.js against test/fixture.html in headless Edge/Chrome and checks which
// boxes are dimmed after each focus change. No Orca needed.
//   node test/run-fixture-test.mjs [--screenshot <out.png>]
// Set BROWSER=<path to msedge.exe/chrome.exe> to pick the browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotFlag = process.argv.indexOf('--screenshot');
const screenshotPath = shotFlag >= 0 ? path.resolve(process.argv[shotFlag + 1]) : null;

const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browserPath = candidates.find((p) => fs.existsSync(p));
if (!browserPath) throw new Error('no Chromium browser found; set BROWSER');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-dim-test-'));
const browser = spawn(browserPath, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--window-size=1200,800', pathToFileURL(path.join(ROOT, 'test', 'fixture.html')).href,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
try {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); }
  }
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = targets.find((t) => t.type === 'page' && t.url.endsWith('fixture.html'));
    if (!page) await sleep(100);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return res.result.result.value;
  };
  const frames = () => evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');

  const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer-dim.js'), 'utf8').replace('__VERSION__', 'test');
  await evaluate(source);
  await evaluate('window.__orcaDimUnfocused.configure({ amount: 0.4, transitionMs: 0 })');
  // In Orca the main process reports BrowserWindow focus; headless focus is unreliable, so set it.
  await evaluate('window.__orcaDimUnfocused.setWindowFocused(true)');

  // Returns { A, B, L1, L2 } -> box opacity ('0', '0.4') or null when there is no box.
  const dimState = async () => {
    await frames();
    return evaluate(`(() => {
      const s = window.__orcaDimUnfocused.debug.state();
      const out = { A: null, B: null, L1: null, L2: null };
      for (const b of s.boxes) out[b.el.split('@')[0]] = b.opacity;
      return out;
    })()`);
  };
  const focus = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).focus(), true`);
  const pointer = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), true`);

  const check = async (name, expected) => {
    const actual = await dimState();
    const ok = Object.entries(expected).every(([k, v]) => actual[k] === v);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  };

  await check('nothing focused yet: nothing dimmed', { A: '0', B: '0', L1: null, L2: null });
  await focus('#editorA');
  await check('editor in group A focused: group B dimmed', { A: '0', B: '0.4', L1: null, L2: null });
  await focus('#xt2');
  await check('terminal split 2 focused: group A and split 1 dimmed', { A: '0.4', B: '0', L1: '0.4', L2: '0' });
  if (screenshotPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshotPath, Buffer.from(shot.result.data, 'base64'));
    console.log(`screenshot: ${screenshotPath}`);
  }
  await focus('#search');
  await check('sidebar focused: last pane stays bright', { A: '0.4', B: '0', L1: '0.4', L2: '0' });
  await pointer('#tabA');
  await check('click on group A tab strip: group B dimmed, split boxes gone', { A: '0', B: '0.4', L1: null, L2: null });
  await focus('#xt1');
  await check('terminal split 1 focused: split 2 dimmed', { A: '0.4', B: '0', L1: '0', L2: '0.4' });
  await evaluate("window.__orcaDimUnfocused.configure({ dimSplitPanes: false })");
  await check('dimSplitPanes off: only group A dimmed', { A: '0.4', B: '0', L1: null, L2: null });
  await evaluate("window.__orcaDimUnfocused.configure({ dimSplitPanes: true, enabled: false })");
  await check('disabled: nothing dimmed', { A: '0', B: '0', L1: null, L2: null });
  await evaluate("window.__orcaDimUnfocused.configure({ enabled: true, amount: 0.6 })");
  await check('amount 0.6 applies', { A: '0.6', B: '0', L1: '0', L2: '0.6' });
  const colors = await evaluate(`Object.fromEntries(window.__orcaDimUnfocused.debug.state().boxes.map((b) => [b.el.split('@')[0], b.color]))`);
  const colorOk = colors.A === 'rgb(17, 17, 17)' && colors.L2 === 'rgb(40, 42, 54)';
  if (!colorOk) failures++;
  console.log(`${colorOk ? 'PASS' : 'FAIL'}  each box takes its own pane background (${JSON.stringify(colors)})`);
  await evaluate('window.__orcaDimUnfocused.configure({ blurAmount: 0.7 })');
  await evaluate('window.__orcaDimUnfocused.setWindowFocused(false)');
  await check('Orca window unfocused: every group dimmed with blurAmount', { A: '0.7', B: '0.7', L1: null, L2: null });
  if (screenshotPath) {
    const blurredShot = screenshotPath.replace(/\.png$/i, '-window-blurred.png');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(blurredShot, Buffer.from(shot.result.data, 'base64'));
    console.log(`screenshot: ${blurredShot}`);
  }
  await focus('#editorA'); // focus moving inside an unfocused window changes nothing visible
  await check('unfocused window, inner focus moves: still all dimmed', { A: '0.7', B: '0.7', L1: null, L2: null });
  await evaluate('window.__orcaDimUnfocused.configure({ dimWhenWindowBlurred: false })');
  await check('dimWhenWindowBlurred off: only non-focused group dimmed', { A: '0', B: '0.6', L1: null, L2: null });
  await evaluate('window.__orcaDimUnfocused.configure({ dimWhenWindowBlurred: true })');
  await focus('#xt1');
  await evaluate('window.__orcaDimUnfocused.setWindowFocused(true)');
  await check('Orca window focused again: back to per-pane dimming', { A: '0.6', B: '0', L1: '0', L2: '0.6' });

  // Settings panel: controls apply at once and report the change on the console channel.
  await evaluate(`window.__sent = []; { const o = console.debug; console.debug = (...a) => { window.__sent.push(a.join(' ')); o.apply(console, a); }; } true`);
  await evaluate('window.__orcaDimUnfocused.openSettings(), true');
  const panelOpen = await evaluate("!!document.getElementById('orca-dim-unfocused-settings')");
  if (!panelOpen) failures++;
  console.log(`${panelOpen ? 'PASS' : 'FAIL'}  settings panel opens`);
  if (screenshotPath) {
    const panelShot = screenshotPath.replace(/\.png$/i, '-settings.png');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(panelShot, Buffer.from(shot.result.data, 'base64'));
    console.log(`screenshot: ${panelShot}`);
  }
  await evaluate(`(() => {
    const ranges = document.querySelectorAll('#orca-dim-unfocused-settings input[type=range]');
    ranges[0].value = '30'; ranges[0].dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await check('panel: unfocused slider to 30% applies at once', { A: '0.3', B: '0', L1: '0', L2: '0.3' });
  await sleep(300);
  const sent = await evaluate('window.__sent');
  const sentOk = sent.some((s) => s.startsWith('__orcaDimUnfocused:set ') && JSON.parse(s.slice(23)).amount === 0.3);
  if (!sentOk) failures++;
  console.log(`${sentOk ? 'PASS' : 'FAIL'}  panel reports the change to the main process (${JSON.stringify(sent)})`);
  await evaluate(`(() => {
    const boxes = document.querySelectorAll('#orca-dim-unfocused-settings input[type=checkbox]');
    boxes[1].click(); // "Also dim the other splits"
    return true;
  })()`);
  await check('panel: split checkbox off removes split dimming', { A: '0.3', B: '0', L1: null, L2: null });
  await evaluate(`window.__orcaDimUnfocused.configure({ amount: 0.8 }), document.querySelector('#orca-dim-unfocused-settings input[type=range]').value`)
    .then((v) => { const ok = v === '80'; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  panel follows changes made by commands (slider=${v})`); });
  await evaluate(`document.getElementById('orca-dim-unfocused-settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  const panelClosed = await evaluate("!document.getElementById('orca-dim-unfocused-settings')");
  if (!panelClosed) failures++;
  console.log(`${panelClosed ? 'PASS' : 'FAIL'}  Escape closes the panel`);
  const backTo = await evaluate('document.activeElement && document.activeElement.id');
  if (backTo !== 'xt1') failures++;
  console.log(`${backTo === 'xt1' ? 'PASS' : 'FAIL'}  closing the panel gives focus back to the terminal (${backTo})`);

  await evaluate(source); // re-injecting replaces the old instance
  const layers = await evaluate("document.querySelectorAll('#orca-dim-unfocused-layer').length");
  if (layers !== 1) failures++;
  console.log(`${layers === 1 ? 'PASS' : 'FAIL'}  re-inject keeps one layer (found ${layers})`);
  await evaluate('window.__orcaDimUnfocused.destroy()');
  const left = await evaluate("[document.querySelectorAll('#orca-dim-unfocused-layer').length, typeof window.__orcaDimUnfocused]");
  const clean = left[0] === 0 && left[1] === 'undefined';
  if (!clean) failures++;
  console.log(`${clean ? 'PASS' : 'FAIL'}  destroy removes layer and global (${JSON.stringify(left)})`);
  ws.close();
} finally {
  browser.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
