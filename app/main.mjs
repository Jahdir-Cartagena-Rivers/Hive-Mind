import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHiveMind } from "../src/service.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.HIVE_MIND_SMOKE === "1";
const PORT = Number(process.env.HIVE_MIND_PORT ?? 8788);
// Only these service operations are reachable from the interface.
const ROUTES = new Set([
  "/v1/status",
  "/v1/graph",
  "/v1/memory",
  "/v1/search",
  "/v1/remember",
  "/v1/edit",
  "/v1/forget",
  "/v1/configure",
  "/v1/sync",
  "/v1/import",
]);

app.setName("Hive Mind");
let service;
let token;
let window;
let tray;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());

/** The token lives beside the app's data; the connection file lets local clients (J1 Code, agents) find the service. */
async function loadToken(userData) {
  const file = path.join(userData, "service-token");
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    const created = randomBytes(32).toString("hex");
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(file, created, { mode: 0o600 });
    return created;
  }
}
const connectionFile =
  process.env.HIVE_MIND_CONNECTION_FILE ?? path.join(os.homedir(), ".hive-mind", "connection.json");
async function writeConnection() {
  await fs.mkdir(path.dirname(connectionFile), { recursive: true });
  await fs.writeFile(
    connectionFile,
    JSON.stringify({ origin: service.origin, mcp: `${service.origin}/mcp`, token }, null, 2),
    { mode: 0o600 },
  );
}

async function call(route, body) {
  const response = await fetch(`${service.origin}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: await response.json() };
}

function trusted(event) {
  return event.senderFrame?.url.startsWith("file:") && event.senderFrame.url.includes("/app/ui/");
}

function registerIpc() {
  ipcMain.handle("hive:request", (event, route, body) => {
    if (!trusted(event) || !ROUTES.has(route)) throw new Error("Operation not allowed.");
    return call(route, body);
  });
  ipcMain.handle("hive:pick-folder", async (event) => {
    if (!trusted(event)) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("hive:open-vault", async (event) => {
    if (!trusted(event)) return false;
    const vault = (await call("/v1/status")).value.config?.vault;
    if (!vault) return false;
    return (await shell.openPath(vault)) === "";
  });
  ipcMain.handle("hive:connection", (event) =>
    trusted(event)
      ? { origin: service.origin, mcp: `${service.origin}/mcp`, file: connectionFile, login: app.getLoginItemSettings().openAtLogin }
      : null,
  );
  ipcMain.handle("hive:copy-token", (event) => {
    if (!trusted(event)) return false;
    clipboard.writeText(token);
    // Don't leave the credential on the clipboard.
    setTimeout(() => {
      if (clipboard.readText() === token) clipboard.clear();
    }, 30_000).unref();
    return true;
  });
  ipcMain.handle("hive:login-item", (event, enabled) => {
    if (trusted(event)) app.setLoginItemSettings({ openAtLogin: enabled === true });
    return app.getLoginItemSettings().openAtLogin;
  });
}

function showWindow() {
  if (!window) createWindow();
  window.show();
  window.focus();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: !SMOKE,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#0e1117",
    title: "Hive Mind",
    icon: path.join(here, "../assets/icon.png"),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !SMOKE,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // The service keeps running for connected clients; closing the window sends the app to the tray.
  window.on("close", (event) => {
    if (quitting || SMOKE) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    window = undefined;
  });
  void window.loadFile(path.join(here, "ui/index.html"));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(here, "../assets/icon.png")).resize({ width: 16, height: 16 }));
  tray.setToolTip("Hive Mind");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Hive Mind", click: showWindow },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
}

async function smoke() {
  // Headless self-check: load the real UI, wait for the graph, report what it drew.
  window.webContents.on("console-message", (event) => console.log(`RENDERER ${event.level}: ${event.message}`));
  await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  const report = await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const started = Date.now();
      const poll = () => window.__hiveReady ? resolve(window.__hiveReady) : Date.now() - started > 20000 ? resolve({ error: "timeout" }) : setTimeout(poll, 100);
      poll();
    })`,
  );
  if (process.env.HIVE_MIND_SMOKE_SHOT)
    await fs.writeFile(process.env.HIVE_MIND_SMOKE_SHOT, (await window.webContents.capturePage()).toPNG());
  console.log(`SMOKE ${JSON.stringify(report)}`);
  app.exit(report.error ? 1 : 0);
}

app.whenReady().then(async () => {
  try {
    const userData = app.getPath("userData");
    token = await loadToken(userData);
    service = await startHiveMind({
      stateDirectory: process.env.HIVE_MIND_STATE_DIR ?? path.join(userData, "data"),
      token,
      port: PORT,
    });
    await writeConnection();
  } catch (error) {
    dialog.showErrorBox("Hive Mind could not start", String(error.message ?? error));
    app.exit(1);
    return;
  }
  registerIpc();
  createWindow();
  if (SMOKE) await smoke();
  else createTray();
});

app.on("window-all-closed", () => {
  /* The tray keeps the service alive. */
});
app.on("before-quit", (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  void service.close().finally(() => app.exit(0));
});
