// Updates from GitHub Releases (orderedlist/print-bay): each release carries latest-mac.yml
// and the .zip, and electron-updater reads them from there. It checks at launch and every
// few hours and downloads in the background. Nothing pops up: the server passes the state
// on to Settings, which shows it with a Restart to update button. Only the packaged,
// signed app updates.
import { app } from "electron";
import updater from "electron-updater";

const { autoUpdater } = updater;
const EVERY = 4 * 60 * 60 * 1000;

/**
 * The updater as the server sees it (StartOptions.updates in app/server/src/index.ts).
 * state: idle (not checked yet), checking, current, downloading, ready, error.
 */
export function createUpdater() {
  let status = { version: app.getVersion(), state: "idle", available: null, percent: null, error: null, checkedAt: null };
  const listeners = new Set();
  const set = (patch) => {
    status = { ...status, ...patch };
    for (const fn of listeners) fn(status);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => set({ state: "checking", error: null }));
  autoUpdater.on("update-not-available", () => set({ state: "current", checkedAt: Date.now() }));
  autoUpdater.on("update-available", ({ version }) => set({ state: "downloading", available: version, percent: 0, checkedAt: Date.now() }));
  autoUpdater.on("download-progress", ({ percent }) => set({ percent: Math.round(percent) }));
  autoUpdater.on("update-downloaded", ({ version }) => set({ state: "ready", available: version, percent: null }));
  autoUpdater.on("error", (err) => {
    if (status.state === "ready") return; // a later failed check leaves the downloaded update ready
    set({ state: "error", error: String(err?.message ?? err).split("\n")[0].slice(0, 200), checkedAt: Date.now() });
  });

  const check = () => {
    if (status.state === "checking" || status.state === "downloading" || status.state === "ready") return;
    autoUpdater.checkForUpdates().catch(() => {}); // the "error" event reports it
  };

  return {
    status: () => status,
    onChange: (fn) => listeners.add(fn),
    check,
    install: () => { if (status.state === "ready") autoUpdater.quitAndInstall(); },
    start: () => { check(); setInterval(check, EVERY).unref?.(); },
  };
}
