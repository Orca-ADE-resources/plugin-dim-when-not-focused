// Orca plugin worker. Orca starts it on demand (a command, or one of the events in orca-plugin.json)
// and stops it after ~5 minutes idle, so the dimming itself lives in Orca's main process
// (see src/main-install.mjs); this worker only installs it there and forwards commands.
// The worker is forked by Orca's main process, so process.ppid is the process to install into.
import { isMarked, markerPathFor, readVersion, runInOrca, writeMarker } from './src/orca-dim.mjs';

export default async function activate(ctx) {
  const pid = process.ppid;
  const version = readVersion();
  const RETRY_AFTER_MS = 60_000;
  let installing = null;
  let lastFailure = 0;

  const exec = async (command, extra = {}) => {
    try {
      const result = await runInOrca({ pid, command, markerPath: markerPathFor(pid), ...extra });
      writeMarker(pid, version);
      return result;
    } catch (err) {
      ctx.log(`dim-unfocused-panes: ${err.message}`);
      throw err;
    }
  };

  // Called on every event; cheap once this Orca process has the current version. After a failure
  // (e.g. another debugger holds port 9229) wait a minute instead of retrying on every agent event.
  const ensureInstalled = () => {
    if (isMarked(pid, version) || Date.now() - lastFailure < RETRY_AFTER_MS) return Promise.resolve();
    installing ??= exec(undefined)
      .then((status) => ctx.log(`dim-unfocused-panes ${version} installed into Orca pid ${pid} (${status.windows} window)`))
      .catch(() => { lastFailure = Date.now(); })
      .finally(() => { installing = null; });
    return installing;
  };

  ctx.commands.register('settings', () => exec('settings'));
  ctx.commands.register('toggle', () => exec('toggle'));
  ctx.commands.register('stronger', () => exec('stronger'));
  ctx.commands.register('weaker', () => exec('weaker'));
  ctx.commands.register('toggle-window-blur', () => exec('toggle-window-blur'));
  ctx.commands.register('reapply', () => exec(undefined, { force: true }));
  ctx.events.on('agent.status.changed', ensureInstalled);
  ctx.events.on('worktree.created', ensureInstalled);

  // Do not hold up activation (Orca waits for "ready"); install right after.
  setTimeout(ensureInstalled, 0);
}

// Nothing to undo here: Orca also stops idle workers, and the dimming must outlive this process.
// Turn it off with the Toggle command; it is gone from the main process when Orca restarts.
export function deactivate() {}
