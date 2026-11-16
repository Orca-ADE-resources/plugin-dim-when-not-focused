// Runs inside Orca's renderer (page main world), injected by src/main-install.mjs.
// Draws a click-through layer of boxes over every tab group / terminal split pane that is not
// the focused one. Each box has the pane's own background colour, so text and lines fade into the
// background while the background itself stays put (what Quil's `unfocused_dim` looks like).
// Also owns the settings panel (Mod+Alt+,). Only CSSOM is used (no <style>, no inline style
// attribute), so the page CSP does not matter. Re-running this file replaces the previous instance.
(() => {
  const KEY = '__orcaDimUnfocused';
  const VERSION = '__VERSION__';
  if (window[KEY] && typeof window[KEY].destroy === 'function') window[KEY].destroy();

  // Orca DOM hooks (checked on Orca 1.4.222). Data attributes, not Tailwind classes.
  const SEL_GROUP_BODY = '[data-tab-group-body-id]'; // its parent is the whole group (tab strip + body)
  const SEL_PANE = '.pane[data-leaf-id]'; // one xterm leaf of a split terminal tab
  const SEL_FLOATING = '[data-floating-terminal-panel]';
  const SEL_TERMINAL_HOST = '[data-terminal-overlay-tab-id], [data-retained-pane-host]'; // terminals are drawn here, outside the group DOM
  const SEL_ACTIVE_PANE_TITLE = '.pane-title-bar[data-active-pane]';

  // Keep in sync with DEFAULTS in src/main-install.mjs (the main process owns the saved copy).
  const DEFAULTS = Object.freeze({
    enabled: true,
    amount: 0.5,
    blurAmount: 0.5,
    color: 'auto',
    dimSplitPanes: true,
    dimWhenWindowBlurred: true,
    transitionMs: 120,
    zIndex: 30,
  });
  let config = { ...DEFAULTS };
  // Set by the main process from BrowserWindow focus/blur. The page's own blur event also fires when
  // focus moves into a <webview> browser tab, so it is only the fallback (e.g. in test/fixture.html).
  let windowFocusedFromMain = null;
  const windowFocused = () => windowFocusedFromMain ?? document.hasFocus();

  const layer = document.createElement('div');
  layer.id = 'orca-dim-unfocused-layer';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: String(config.zIndex) });
  document.body.appendChild(layer);

  const boxes = new Map(); // element -> { box, dim, key }
  let focusedUnit = null; // a tab group element or the floating terminal panel
  let focusedPane = null; // a .pane element
  let previewBlur = false; // true while the "not focused" slider is dragged
  let raf = 0;
  let toastTimer = 0;
  let toast = null;

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 ? r : null;
  };
  const inside = (r, x, y) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  const shown = (el) => {
    if (!el || !el.isConnected || !rectOf(el)) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }
    return true;
  };

  function collectUnits() {
    const units = [];
    for (const body of document.querySelectorAll(SEL_GROUP_BODY)) {
      const group = body.parentElement;
      if (group && !units.includes(group) && shown(group)) units.push(group);
    }
    const floating = document.querySelector(SEL_FLOATING);
    if (floating && shown(floating)) units.push(floating);
    return units;
  }

  function unitAtPoint(x, y, units) {
    // The floating panel sits above the groups, so it wins when it covers the point.
    const floating = units.find((u) => u.matches(SEL_FLOATING) && inside(u.getBoundingClientRect(), x, y));
    return floating ?? units.find((u) => !u.matches(SEL_FLOATING) && inside(u.getBoundingClientRect(), x, y)) ?? null;
  }

  // Which unit an element belongs to. Group content is a DOM descendant of the group; terminals are
  // not (Orca draws them in overlay hosts on top of the group body), so map those by position.
  // Anything else (sidebars, portaled menus, dialogs, the settings panel) belongs to no unit.
  function unitForElement(el, units) {
    if (!(el instanceof Element)) return null;
    const direct = units.find((u) => u.contains(el));
    if (direct) return direct;
    const host = el.closest(SEL_TERMINAL_HOST);
    if (!host) return null;
    const anchor = el.closest(SEL_PANE) ?? host;
    const r = rectOf(el) ?? rectOf(anchor);
    if (!r) return null;
    return unitAtPoint(r.left + r.width / 2, r.top + r.height / 2, units);
  }

  function panesIn(unit) {
    const ur = unit.getBoundingClientRect();
    const floating = unit.matches(SEL_FLOATING);
    const out = [];
    for (const pane of document.querySelectorAll(SEL_PANE)) {
      if (!shown(pane)) continue;
      if (floating ? !unit.contains(pane) : pane.closest(SEL_FLOATING)) continue;
      const r = pane.getBoundingClientRect();
      if (inside(ur, r.left + r.width / 2, r.top + r.height / 2)) out.push(pane);
    }
    return out;
  }

  // Orca's own idea of the active split pane, used when focus is not inside a pane.
  function orcaActivePane(panes) {
    for (const title of document.querySelectorAll(SEL_ACTIVE_PANE_TITLE)) {
      const tr = rectOf(title);
      if (!tr) continue;
      const hit = panes.find((p) => inside(p.getBoundingClientRect(), tr.left + 1, tr.top + 1));
      if (hit) return hit;
    }
    return null;
  }

  function noteFocus(el) {
    if (!(el instanceof Element)) return;
    const units = collectUnits();
    const unit = unitForElement(el, units);
    if (!unit) return; // focus went to a sidebar/menu: keep the last focused pane bright
    focusedUnit = unit;
    const pane = el.closest(SEL_PANE);
    if (pane) focusedPane = pane;
    schedule();
  }

  // ---- background colour under a pane (color: 'auto') ----

  const bgCache = new WeakMap(); // element -> { color, at }
  function alphaOf(css) {
    if (!css || css === 'transparent') return 0;
    const m = css.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  }
  // First opaque background under the middle of the pane content: the xterm viewport for a
  // terminal, the editor background for Monaco, the group body otherwise. Re-read once a second.
  function backgroundOf(el) {
    const now = performance.now();
    const cached = bgCache.get(el);
    if (cached && now - cached.at < 1000) return cached.color;
    const r = el.getBoundingClientRect();
    let color = null;
    for (const node of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height * 0.6)) {
      if (panel && panel.contains(node)) continue;
      const bg = getComputedStyle(node).backgroundColor;
      if (alphaOf(bg) >= 0.9) { color = bg; break; }
    }
    color ??= 'var(--background, #000)';
    bgCache.set(el, { color, at: now });
    return color;
  }

  // ---- dimming ----

  function compute() {
    const units = collectUnits();
    if (focusedUnit && !units.includes(focusedUnit)) focusedUnit = null;
    if (!focusedUnit) focusedUnit = unitForElement(document.activeElement, units);
    if (focusedPane && !focusedPane.isConnected) focusedPane = null;

    // Orca window not focused (working in another app): every tab group and terminal goes dim.
    const dimAll = config.enabled && ((config.dimWhenWindowBlurred && !windowFocused()) || previewBlur);
    const targets = new Map(); // element -> overlay opacity, 0 = not dimmed
    for (const unit of units) {
      let level = 0;
      if (dimAll) level = config.blurAmount;
      else if (config.enabled && focusedUnit !== null && unit !== focusedUnit) level = config.amount;
      targets.set(unit, level);
    }
    if (config.enabled && config.dimSplitPanes && focusedUnit && !dimAll) {
      const panes = panesIn(focusedUnit);
      if (panes.length > 1) {
        const active = panes.includes(focusedPane) ? focusedPane : orcaActivePane(panes);
        if (active) for (const pane of panes) targets.set(pane, pane === active ? 0 : config.amount);
      }
    }
    render(targets);
  }

  function render(targets) {
    const transition = config.transitionMs > 0 ? `opacity ${config.transitionMs}ms ease` : 'none';
    for (const [el, level] of targets) {
      const r = el.getBoundingClientRect();
      const color = config.color === 'auto' ? backgroundOf(el) : config.color;
      let entry = boxes.get(el);
      if (!entry) {
        const box = document.createElement('div');
        Object.assign(box.style, { position: 'absolute', opacity: '0', pointerEvents: 'none' });
        layer.appendChild(box);
        entry = { box, dim: false, key: '' };
        boxes.set(el, entry);
      }
      const key = `${r.left}|${r.top}|${r.width}|${r.height}|${color}|${transition}`;
      if (entry.key !== key) {
        Object.assign(entry.box.style, {
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
          background: color,
          transition,
        });
        entry.key = key;
      }
      const opacity = level > 0 ? String(level) : '0';
      if (entry.box.style.opacity !== opacity) entry.box.style.opacity = opacity;
      entry.dim = level > 0;
    }
    for (const [el, entry] of boxes) {
      if (targets.has(el)) continue;
      boxes.delete(el);
      if (entry.box.style.opacity === '0' || !el.isConnected) {
        entry.box.remove();
      } else {
        entry.box.style.opacity = '0';
        setTimeout(() => entry.box.remove(), config.transitionMs + 50);
      }
    }
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; compute(); });
  }

  function showToast(text) {
    if (!text) return;
    if (!toast) {
      toast = document.createElement('div');
      Object.assign(toast.style, {
        position: 'absolute', zIndex: '1', left: '50%', bottom: '48px', transform: 'translateX(-50%)',
        padding: '6px 12px', borderRadius: '6px', font: '12px/1.4 system-ui, sans-serif',
        background: 'var(--popover, #222)', color: 'var(--popover-foreground, #eee)',
        border: '1px solid var(--border, #444)', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
        transition: 'opacity 150ms ease', opacity: '0', whiteSpace: 'nowrap',
      });
      layer.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toast) toast.style.opacity = '0'; }, 1400);
  }

  // ---- settings panel ----
  // Changes apply at once here and are sent to the main process (which saves them and updates
  // other windows) as a console line it listens for: the page has no IPC channel of ours.

  const CHANNEL = '__orcaDimUnfocused:set ';
  const isMac = /Mac/i.test(navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl';
  const ALT = isMac ? '⌥' : 'Alt';
  const PERCENT = { toInput: (c) => Math.round(c * 100), fromInput: (v) => v / 100, text: (c) => `${Math.round(c * 100)}%` };
  const MILLIS = { toInput: (c) => c, fromInput: (v) => v, text: (c) => `${c} ms` };
  let panel = null;
  let controls = null;
  let pendingPatch = {};
  let persistTimer = 0;
  let returnFocus = null;

  function flushPersist() {
    clearTimeout(persistTimer);
    if (Object.keys(pendingPatch).length === 0) return;
    const patch = pendingPatch;
    pendingPatch = {};
    console.debug(CHANNEL + JSON.stringify(patch));
  }

  function change(patch) {
    config = { ...config, ...patch };
    Object.assign(pendingPatch, patch);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 150);
    syncPanel();
    schedule();
  }

  const h = (tag, style, props) => {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    if (props) Object.assign(node, props);
    return node;
  };
  const accent = { accentColor: 'var(--primary, #4f8cff)' };

  function button(text, onClick, style) {
    const b = h('button', {
      background: 'transparent', color: 'inherit', border: '1px solid var(--border, #444)', borderRadius: '6px',
      padding: '2px 10px', font: 'inherit', cursor: 'pointer', ...style,
    }, { type: 'button', textContent: text });
    b.addEventListener('click', onClick);
    return b;
  }

  function toggleRow(label, key) {
    const row = h('label', { display: 'flex', alignItems: 'center', gap: '8px', margin: '7px 0', cursor: 'pointer' });
    const input = h('input', { ...accent, margin: '0' }, { type: 'checkbox' });
    input.addEventListener('change', () => change({ [key]: input.checked }));
    row.append(input, h('span', null, { textContent: label }));
    panel.append(row);
    return { row, input };
  }

  function sliderRow(label, key, min, max, step, format, { preview = false } = {}) {
    const row = h('div', { margin: '8px 0 10px' });
    const head = h('div', { display: 'flex', justifyContent: 'space-between', marginBottom: '3px' });
    const value = h('span', { opacity: '0.7', fontVariantNumeric: 'tabular-nums' });
    head.append(h('span', null, { textContent: label }), value);
    const input = h('input', { ...accent, width: '100%', margin: '0' }, { type: 'range', min, max, step });
    input.addEventListener('input', () => change({ [key]: format.fromInput(Number(input.value)) }));
    if (preview) {
      // Show the "Orca not focused" look while dragging, since the window is focused right now.
      const stop = () => { if (previewBlur) { previewBlur = false; schedule(); } };
      input.addEventListener('pointerdown', () => { previewBlur = true; schedule(); });
      input.addEventListener('pointerup', stop);
      input.addEventListener('pointercancel', stop);
      input.addEventListener('blur', stop);
    }
    row.append(head, input);
    panel.append(row);
    return { row, input, value, format };
  }

  function selectRow(label, key, options) {
    const row = h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', margin: '8px 0' });
    const select = h('select', {
      background: 'var(--popover, #1c1c1c)', color: 'inherit', border: '1px solid var(--border, #444)',
      borderRadius: '6px', padding: '2px 6px', font: 'inherit', maxWidth: '190px',
    });
    for (const [value, text] of options) select.append(h('option', null, { value, textContent: text }));
    select.addEventListener('change', () => change({ [key]: select.value }));
    row.append(h('span', null, { textContent: label }), select);
    panel.append(row);
    return { row, select };
  }

  function syncPanel() {
    if (!panel) return;
    const c = controls;
    c.enabled.input.checked = config.enabled;
    c.dimSplitPanes.input.checked = config.dimSplitPanes;
    c.dimWhenWindowBlurred.input.checked = config.dimWhenWindowBlurred;
    for (const key of ['amount', 'blurAmount', 'transitionMs']) {
      const s = c[key];
      const v = String(s.format.toInput(config[key]));
      if (s.input.value !== v) s.input.value = v;
      s.value.textContent = s.format.text(config[key]);
    }
    c.blurAmount.input.disabled = !config.dimWhenWindowBlurred;
    c.blurAmount.row.style.opacity = config.dimWhenWindowBlurred ? '1' : '0.45';
    const select = c.color.select;
    if (![...select.options].some((o) => o.value === config.color)) {
      select.append(h('option', null, { value: config.color, textContent: `Custom (${config.color})` }));
    }
    select.value = config.color;
  }

  function onPanelKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    e.stopPropagation(); // arrows/space on a slider should not reach Orca's own shortcuts
  }

  function openSettings() {
    if (panel) { closeSettings(); return; } // the command / Mod+Alt+, toggles the panel
    panel = h('div', {
      position: 'fixed', right: '16px', bottom: '40px', width: '320px', zIndex: '60', boxSizing: 'border-box',
      padding: '12px 14px 10px', borderRadius: '10px', background: 'var(--popover, #1c1c1c)',
      color: 'var(--popover-foreground, #e5e5e5)', border: '1px solid var(--border, #333)',
      boxShadow: '0 12px 40px rgba(0,0,0,.45)', fontSize: '12px', lineHeight: '1.45', userSelect: 'none',
    });
    panel.id = 'orca-dim-unfocused-settings';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Dim Unfocused Panes settings');
    panel.setAttribute('data-terminal-focus-release-surface', 'true');

    const header = h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' });
    const close = button('×', closeSettings, { border: 'none', fontSize: '16px', lineHeight: '1', padding: '2px 6px' });
    close.title = 'Close (Esc)';
    header.append(h('div', { fontWeight: '600', fontSize: '13px' }, { textContent: 'Dim Unfocused Panes' }), close);
    panel.append(header);

    controls = {};
    controls.enabled = toggleRow('Dim panes you are not working in', 'enabled');
    controls.amount = sliderRow('Unfocused pane', 'amount', 5, 90, 5, PERCENT);
    controls.dimSplitPanes = toggleRow('Also dim the other splits of a terminal', 'dimSplitPanes');
    controls.dimWhenWindowBlurred = toggleRow('Dim everything when Orca is not focused', 'dimWhenWindowBlurred');
    controls.blurAmount = sliderRow('Orca not focused (drag to preview)', 'blurAmount', 5, 90, 5, PERCENT, { preview: true });
    controls.color = selectRow('Fade toward', 'color', [['auto', 'Pane background'], ['#000', 'Black']]);
    controls.transitionMs = sliderRow('Fade time', 'transitionMs', 0, 400, 20, MILLIS);

    const footer = h('div', {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
      marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border, #333)',
    });
    footer.append(
      h('span', { opacity: '0.6', fontSize: '11px' }, { textContent: `${MOD}+${ALT}+D on/off · ${MOD}+${ALT}+= / - strength` }),
      button('Reset', () => change({ ...DEFAULTS })),
    );
    panel.append(footer);
    panel.addEventListener('keydown', onPanelKey);
    returnFocus = document.activeElement;
    document.body.appendChild(panel);
    syncPanel();
    controls.amount.input.focus();
  }

  function closeSettings() {
    if (!panel) return;
    flushPersist();
    const active = document.activeElement;
    const hadFocus = !active || active === document.body || panel.contains(active);
    panel.remove();
    panel = null;
    controls = null;
    previewBlur = false;
    // Give the keyboard back to the terminal/editor that had it before the panel opened.
    if (hadFocus && returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    schedule();
  }

  // ---- wiring ----

  const onFocusIn = (e) => noteFocus(e.target);
  const onPointerDown = (e) => noteFocus(e.target);
  const onLayoutChange = () => schedule();
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('focus', onLayoutChange);
  window.addEventListener('blur', onLayoutChange);
  window.addEventListener('resize', onLayoutChange);
  document.addEventListener('visibilitychange', onLayoutChange);
  const resizeObserver = new ResizeObserver(onLayoutChange);
  resizeObserver.observe(document.body);
  // Splits, tab switches and sidebar toggles move groups without resizing the window: re-check
  // a few times a second. Each pass is a handful of getBoundingClientRect calls.
  const poll = setInterval(() => { if (!document.hidden) schedule(); }, 300);

  function destroy() {
    closeSettings();
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('focus', onLayoutChange);
    window.removeEventListener('blur', onLayoutChange);
    window.removeEventListener('resize', onLayoutChange);
    document.removeEventListener('visibilitychange', onLayoutChange);
    resizeObserver.disconnect();
    clearInterval(poll);
    clearTimeout(toastTimer);
    cancelAnimationFrame(raf);
    layer.remove();
    boxes.clear();
    if (window[KEY] === api) delete window[KEY];
  }

  function configure(next, announce) {
    config = { ...config, ...(next || {}) };
    layer.style.zIndex = String(config.zIndex);
    syncPanel();
    showToast(announce);
    schedule();
  }

  function setWindowFocused(focused) {
    windowFocusedFromMain = Boolean(focused);
    schedule();
  }

  const api = {
    version: VERSION,
    configure,
    setWindowFocused,
    openSettings,
    closeSettings,
    destroy,
    debug: {
      state() {
        const label = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const id = el.querySelector?.(SEL_GROUP_BODY)?.getAttribute('data-tab-group-body-id')
            ?? el.getAttribute('data-leaf-id') ?? (el.matches(SEL_FLOATING) ? 'floating' : el.tagName);
          return `${String(id).slice(0, 8)}@${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
        };
        return {
          version: VERSION,
          config,
          windowFocused: windowFocused(),
          windowFocusedFromMain,
          settingsOpen: Boolean(panel),
          focusedUnit: label(focusedUnit),
          focusedPane: label(focusedPane),
          boxes: [...boxes].map(([el, e]) => ({ el: label(el), dim: e.dim, opacity: e.box.style.opacity, color: e.box.style.backgroundColor })),
        };
      },
      noteFocus,
    },
  };
  window[KEY] = api;
  schedule();
})();
