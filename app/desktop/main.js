// Print Bay desktop shell: runs the server in-process and shows the UI in a window.
// The server keeps listening on the LAN, so a phone browser works while this is open.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, shell } from "electron";

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
  try {
    const { start } = await loadServer();
    ({ url } = await start({ quiet: true }));
  } catch (err) {
    // Port taken: most likely the server is already running (npm start); use it.
    if (err.code !== "EADDRINUSE") throw err;
    url = `http://localhost:${process.env.PORT ?? 8765}`;
  }
  await createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => app.quit());
