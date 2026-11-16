// Print Bay desktop shell: runs the server in-process and shows the UI in a window.
// The server keeps listening on the LAN, so a phone browser works while this is open.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";

// The environment as launched, before the server adds to it (PRINT_BAY_DATA above all):
// a restart starts from this, so it reads the library location afresh.
const LAUNCH_ENV = { ...process.env };

/** Start a fresh copy and quit. app.relaunch() goes through LaunchServices, which drops the environment. */
function restart() {
  spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore", env: LAUNCH_ENV }).unref();
  app.exit(0);
}

// Packaged, the server and everything it runs come from Contents/Resources/printbay (see
// bundle.mjs), and the app's own binary stands in for `node` (scripts/check).
// From a checkout, it's the repo itself.
async function loadServer() {
  if (!app.isPackaged) return import("../server/dist/index.js");
  const root = path.join(process.resourcesPath, "printbay");
  process.env.PRINT_BAY_ROOT = root;
  process.env.PRINT_BAY_NODE = process.execPath;
  process.env.PRINT_BAY_PACKAGED = "1";
  // Finder gives apps a bare PATH; add Homebrew's so OpenSCAD, git and friends turn up
  process.env.PATH = [...new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"])].filter(Boolean).join(":");
  return import(pathToFileURL(path.join(root, "app/server/dist/index.js")).href);
}

let url;

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,
    backgroundColor: "#0a0a0b",
    title: "Print Bay",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 27, y: 35 }, // in the left panel (10px in), level with the brand
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links out (model sources) open in the default browser, not the app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  // styles.css makes room for the traffic lights under this class
  win.webContents.on("dom-ready", () =>
    win.webContents.executeJavaScript("document.documentElement.classList.add('desktop-mac')"));
  await win.loadURL(url);
}

app.whenReady().then(async () => {
  // packaged, the icon comes from the bundle (electron-builder's mac.icon); run from a checkout, set it here
  if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(fileURLToPath(new URL("icon.png", import.meta.url)));
  const { start } = await loadServer();
  const serverOptions = {
    quiet: true,
    restart,
    pickFolder: async () => {
      const options = { title: "Choose a library folder", properties: ["openDirectory", "createDirectory"] };
      const win = BrowserWindow.getFocusedWindow();
      const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
  };
  // A restart's old copy may still be letting go of the port, so retry briefly. Still taken
  // after that: most likely the server is already running (npm start), so use it.
  for (let tries = 6; ; tries--) {
    try { ({ url } = await start(serverOptions)); break; } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
      if (tries <= 1) { url = `http://localhost:${process.env.PORT ?? 8765}`; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => app.quit());
