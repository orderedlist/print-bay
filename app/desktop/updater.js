// Updates from GitHub Releases (orderedlist/print-bay): electron-builder publishes each
// release with latest-mac.yml and the .zip, and electron-updater reads them from there.
// It checks at launch and every few hours, downloads in the background, and asks before
// restarting. Only the packaged, signed app updates; run from a checkout it does nothing.
import { app, dialog, BrowserWindow } from "electron";
import updater from "electron-updater";

const { autoUpdater } = updater;
const EVERY = 4 * 60 * 60 * 1000;

let asked = false; // a "Check for Updates…" click reports the outcome; background checks stay quiet
let downloaded = null; // the version waiting to install

function show(options) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

export function startUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("update-not-available", () => {
    if (asked) show({ type: "info", message: "Print Bay is up to date", detail: `Version ${app.getVersion()}` });
    asked = false;
  });
  autoUpdater.on("update-available", ({ version }) => {
    if (asked) show({ type: "info", message: `Downloading Print Bay ${version}`, detail: "It'll ask to restart when it's ready." });
    asked = false;
  });
  autoUpdater.on("error", (err) => {
    if (asked) show({ type: "warning", message: "Couldn't check for updates", detail: err.message });
    asked = false;
  });
  autoUpdater.on("update-downloaded", ({ version }) => {
    asked = false;
    if (downloaded === version) return; // a later check found the same one
    downloaded = version;
    offerRestart();
  });

  check();
  setInterval(check, EVERY).unref?.();
}

async function offerRestart() {
  const { response } = await show({
    type: "info",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Print Bay ${downloaded} is ready`,
    detail: "Restart to update, or it installs the next time you quit.",
  });
  if (response === 0) autoUpdater.quitAndInstall();
}

function check() {
  if (downloaded) return; // one waiting already; it installs on quit
  autoUpdater.checkForUpdates().catch(() => {}); // the "error" event reports it
}

/** The app menu's Check for Updates… item. */
export function checkForUpdatesNow() {
  if (!app.isPackaged) {
    show({ type: "info", message: "Updates only work in the packaged app" });
    return;
  }
  if (downloaded) return offerRestart(); // downloaded and put off once: ask again
  asked = true;
  check();
}
