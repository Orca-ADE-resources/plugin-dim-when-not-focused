// Code that runs inside Orca's Electron main process. src/orca-dim.mjs stringifies `mainInstall`
// and evaluates it through the Node inspector, so the function must be self-contained: no imports,
// no references to anything outside its own body. It returns plain JSON.
//
// What it leaves behind in the main process (until Orca quits or `uninstall` runs):
//   globalThis.__orcaDimUnfocused = { version, command(), status(), dispose() }
//   - injects the renderer code into every Orca UI window, and again after every reload
//   - keeps the settings in <userData>/dim-unfocused-panes.json
export function mainInstall(opts) {
  const KEY = '__orcaDimUnfocused';
  // eslint-disable-next-line no-undef -- `require` comes from the inspector command-line API when mainModule is unset
  const load = (id) => (process.mainModule ? process.mainModule.require(id) : require(id));
  const { app, BrowserWindow } = load('electron');
  const fs = load('node:fs');
  const path = load('node:path');

  let api = globalThis[KEY];
  if (api && (api.version !== opts.version || opts.force)) {
    try { api.dispose(); } catch { /* replaced below */ }
    api = undefined;
  }
  let fresh = false;
  if (!api) {
    if (opts.command === 'status' || opts.command === 'uninstall') return { installed: false, pid: process.pid };
    api = install();
    fresh = true;
  }
  if (opts.markerPath) api.setMarker(opts.markerPath);
  if (!opts.command) return api.status();
  // Toggle pressed before the mod was in this Orca session: the user saw no dimming, so turn it on.
  return api.command(fresh && opts.command === 'toggle' ? 'on' : opts.command, opts.args);

  function install() {
    // Keep in sync with DEFAULTS in src/renderer-dim.js.
    const DEFAULTS = {
      enabled: true,
      amount: 0.5,
      blurAmount: 0.5,
      color: 'auto',
      dimSplitPanes: true,
      dimWhenWindowBlurred: true,
      transitionMs: 120,
      zIndex: 30,
    };
    const configPath = path.join(app.getPath('userData'), 'dim-unfocused-panes.json');
    const clamp = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const sanitize = (c) => ({
      enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULTS.enabled,
      amount: Math.round(clamp(c.amount, 0.05, 0.95, DEFAULTS.amount) * 100) / 100,
      blurAmount: Math.round(clamp(c.blurAmount, 0.05, 0.95, DEFAULTS.blurAmount) * 100) / 100,
      color: typeof c.color === 'string' && c.color.length < 64 ? c.color : DEFAULTS.color,
      dimSplitPanes: typeof c.dimSplitPanes === 'boolean' ? c.dimSplitPanes : DEFAULTS.dimSplitPanes,
      dimWhenWindowBlurred: typeof c.dimWhenWindowBlurred === 'boolean' ? c.dimWhenWindowBlurred : DEFAULTS.dimWhenWindowBlurred,
      transitionMs: clamp(c.transitionMs, 0, 2000, DEFAULTS.transitionMs),
      zIndex: Math.round(clamp(c.zIndex, 1, 10000, DEFAULTS.zIndex)),
    });
    let config;
    try { config = sanitize(JSON.parse(fs.readFileSync(configPath, 'utf8'))); } catch { config = sanitize({}); }
    const save = () => {
      try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n'); } catch { /* keep running with in-memory config */ }
    };

    const isOrcaUi = (wc) => !wc.isDestroyed() && /\/renderer\/index\.html(?:[?#]|$)/.test(wc.getURL());
    const run = (wc, js) => wc.executeJavaScript(js, false).catch(() => undefined);
    const configureJs = (announce) =>
      `window.${KEY} ? (window.${KEY}.configure(${JSON.stringify(config)}, ${JSON.stringify(announce ?? null)}), true) : false`;
    // OS-level window focus comes from the BrowserWindow, not the page: the page also gets `blur`
    // when focus moves into a browser tab (<webview>) inside Orca, which is not "Orca unfocused".
    const windowFocusJs = (wc) => {
      const win = BrowserWindow.fromWebContents(wc);
      return `window.${KEY} && window.${KEY}.setWindowFocused(${win ? win.isFocused() : true})`;
    };
    const inject = (wc, announce) => {
      if (!isOrcaUi(wc)) return Promise.resolve(false);
      return run(wc, `${opts.rendererSource}\n;${windowFocusJs(wc)};\n${configureJs(announce)}`);
    };
    const broadcast = async (announce, skip) => {
      for (const wc of attached.keys()) {
        if (wc === skip || !isOrcaUi(wc)) continue;
        const ok = await run(wc, configureJs(announce));
        if (!ok) await inject(wc, announce);
      }
    };

    // The settings panel in the page reports changes as `console.debug(CHANNEL + json)`. Electron 35+
    // passes one event object with `.message`; older versions pass (event, level, message, ...).
    const CHANNEL = '__orcaDimUnfocused:set ';
    const onPanelChange = (wc, text) => {
      if (typeof text !== 'string' || !text.startsWith(CHANNEL)) return;
      let patch;
      try { patch = JSON.parse(text.slice(CHANNEL.length)); } catch { return; }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
      config = sanitize({ ...config, ...patch });
      save();
      broadcast(null, wc);
    };

    const attached = new Map(); // webContents -> { win, onLoad, onDestroyed, onFocusChange, onConsole }
    const attach = (win) => {
      const wc = win.webContents;
      if (attached.has(wc)) return;
      const onLoad = () => inject(wc);
      const onDestroyed = () => attached.delete(wc);
      const onFocusChange = () => { if (isOrcaUi(wc)) run(wc, windowFocusJs(wc)); };
      const onConsole = (event, _level, message) => onPanelChange(wc, typeof message === 'string' ? message : event?.message);
      wc.on('did-finish-load', onLoad);
      wc.once('destroyed', onDestroyed);
      wc.on('console-message', onConsole);
      win.on('focus', onFocusChange);
      win.on('blur', onFocusChange);
      attached.set(wc, { win, onLoad, onDestroyed, onFocusChange, onConsole });
      if (!wc.isLoading()) onLoad();
    };
    const onWindowCreated = (_event, win) => attach(win);
    app.on('browser-window-created', onWindowCreated);
    for (const win of BrowserWindow.getAllWindows()) attach(win);

    let markerPath = null;
    const removeMarker = () => {
      if (markerPath) try { fs.unlinkSync(markerPath); } catch { /* already gone */ }
    };
    app.on('will-quit', removeMarker);

    const pct = (v) => `${Math.round(v * 100)}%`;
    const describe = () =>
      `Dim unfocused panes: ${config.enabled ? `on · ${pct(config.amount)}` : 'off'}` +
      ` · Orca not focused: ${config.dimWhenWindowBlurred ? pct(config.blurAmount) : 'off'}`;
    // Stronger/Weaker move both strengths together, each kept in 10%..90%.
    const step = (value, delta) => Math.round(Math.min(0.9, Math.max(0.1, value + delta)) * 100) / 100;
    const stepBoth = (delta) => ({ amount: step(config.amount, delta), blurAmount: step(config.blurAmount, delta) });
    const openSettings = () => {
      const focused = BrowserWindow.getFocusedWindow();
      const wc = focused && attached.has(focused.webContents) ? focused.webContents : [...attached.keys()].find(isOrcaUi);
      if (wc) run(wc, `window.${KEY} && window.${KEY}.openSettings()`);
    };

    const self = {
      version: opts.version,
      status: () => ({ installed: true, version: opts.version, config, configPath, windows: attached.size, pid: process.pid }),
      setMarker(p) { markerPath = p; },
      command(name, args) {
        switch (name) {
          case 'toggle': config = { ...config, enabled: !config.enabled }; break;
          case 'on': config = { ...config, enabled: true }; break;
          case 'off': config = { ...config, enabled: false }; break;
          case 'toggle-window-blur': config = { ...config, enabled: true, dimWhenWindowBlurred: !config.dimWhenWindowBlurred }; break;
          case 'stronger': config = { ...config, enabled: true, ...stepBoth(0.1) }; break;
          case 'weaker': config = { ...config, enabled: true, ...stepBoth(-0.1) }; break;
          case 'set': config = sanitize({ ...config, ...(args || {}) }); break;
          case 'reset': config = sanitize({}); break;
          case 'settings': openSettings(); return self.status();
          case 'status': return self.status();
          case 'uninstall': self.dispose(); return { uninstalled: true };
          default: throw new Error(`unknown command: ${name}`);
        }
        save();
        broadcast(describe());
        return self.status();
      },
      dispose() {
        app.removeListener('browser-window-created', onWindowCreated);
        app.removeListener('will-quit', removeMarker);
        for (const [wc, h] of attached) {
          if (wc.isDestroyed()) continue;
          wc.removeListener('did-finish-load', h.onLoad);
          wc.removeListener('destroyed', h.onDestroyed);
          wc.removeListener('console-message', h.onConsole);
          if (!h.win.isDestroyed()) {
            h.win.removeListener('focus', h.onFocusChange);
            h.win.removeListener('blur', h.onFocusChange);
          }
          run(wc, `window.${KEY} && window.${KEY}.destroy()`);
        }
        attached.clear();
        removeMarker();
        if (globalThis[KEY] === self) delete globalThis[KEY];
      },
    };
    globalThis[KEY] = self;
    return self;
  }
}
