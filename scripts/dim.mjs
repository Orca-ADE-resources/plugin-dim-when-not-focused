#!/usr/bin/env node
// Drive the dim mod from a terminal, without the plugin system (dev loop, or a quick fix).
//   node scripts/dim.mjs [command] [key=value ...] [--pid <orca main pid>]
// Commands: install (default) | reapply | settings | toggle | on | off | stronger | weaker | toggle-window-blur
//           | set | reset | status | uninstall
//   node scripts/dim.mjs set amount=0.5 dimWhenWindowBlurred=true color=#000
import { findOrcaMainPids, markerPathFor, readVersion, runInOrca, writeMarker } from '../src/orca-dim.mjs';

const argv = process.argv.slice(2);
const pidFlag = argv.indexOf('--pid');
const explicitPid = pidFlag >= 0 ? Number(argv.splice(pidFlag, 2)[1]) : null;
const command = argv.find((a) => !a.includes('=')) ?? 'install';
const pairs = argv.filter((a) => a.includes('='));

const COMMANDS = new Set(['install', 'reapply', 'toggle', 'on', 'off', 'stronger', 'weaker', 'toggle-window-blur', 'settings', 'set', 'reset', 'status', 'uninstall']);
if (!COMMANDS.has(command)) {
  console.error(`unknown command "${command}". One of: ${[...COMMANDS].join(', ')}`);
  process.exit(2);
}

const parseValue = (v) => (v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
const args = Object.fromEntries(pairs.map((p) => { const i = p.indexOf('='); return [p.slice(0, i), parseValue(p.slice(i + 1))]; }));

const pids = explicitPid ? [explicitPid] : await findOrcaMainPids();
if (pids.length === 0) {
  console.error('Orca is not running.');
  process.exit(1);
}

let failed = false;
for (const pid of pids) {
  try {
    const result = await runInOrca({
      pid,
      command: command === 'install' || command === 'reapply' ? undefined : command,
      args,
      force: command === 'reapply',
      markerPath: markerPathFor(pid),
    });
    if (result?.installed !== false && command !== 'uninstall') writeMarker(pid, readVersion());
    console.log(`Orca pid ${pid}:`, JSON.stringify(result, null, 2));
  } catch (err) {
    failed = true;
    console.error(`Orca pid ${pid}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
