// Print Bay desktop shell: runs the server in-process and shows the UI in a window.
// The server keeps listening on the LAN, so a phone browser works while this is open.
import { app, BrowserWindow, shell } from "electron";
import { start } from "../server/dist/index.js";

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
