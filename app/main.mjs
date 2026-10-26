import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHiveMind } from "../src/service.mjs";
import { subscribeHiveChanges } from "../src/core/store.ts";
import { createUpdater, launchInstaller } from "./updater.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.HIVE_MIND_SMOKE === "1";
const PORT = Number(process.env.HIVE_MIND_PORT ?? 8788);
if (SMOKE) {
  const profile = process.env.HIVE_MIND_SMOKE_PROFILE;
  if (!profile || !path.isAbsolute(profile))
    throw new Error("Desktop smoke requires an absolute dedicated HIVE_MIND_SMOKE_PROFILE.");
  await fs.mkdir(profile, { recursive: true });
  app.setPath("userData", profile);
}
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
  "/v1/brain",
  "/v1/brain/save",
  "/v1/brain/forget",
  "/v1/tasks/claim",
  "/v1/working-context",
  "/v1/changes",
  "/v1/visual-search",
  "/v1/presence/list",
]);

app.setName("Hive Mind");
let service;
let token;
let window;
let tray;
let updater;
let updateInterval;
let pendingInstaller;
let quitting = false;
let previewQueue = Promise.resolve();

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
  ipcMain.handle("hive:save-reference", async (event, id) => {
    if (!trusted(event) || typeof id !== "string" || !/^[\w.-]{1,128}$/u.test(id))
      throw new Error("Invalid reference.");
    const response = await fetch(`${service.origin}/v1/assets/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error("Reference is unavailable.");
    const mime = response.headers.get("content-type");
    const ext =
      { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mime] ??
      "bin";
    const filename = response.headers.get("x-hive-filename")
      ? decodeURIComponent(response.headers.get("x-hive-filename"))
      : `Reference.${ext}`;
    const picked = await dialog.showSaveDialog(window, { defaultPath: filename });
    if (picked.canceled) {
      await response.body?.cancel();
      return false;
    }
    await fs.writeFile(picked.filePath, Buffer.from(await response.arrayBuffer()));
    return true;
  });
  ipcMain.handle("hive:import-file", async (event, metadata) => {
    if (!trusted(event)) throw new Error("Operation not allowed.");
    const picked = await dialog.showOpenDialog(window, { properties: ["openFile"] });
    if (picked.canceled) return null;
    const file = picked.filePaths[0];
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
      throw new Error("Choose a reference file under 25 MiB.");
    return call("/v1/files", {
      ...metadata,
      filename: path.basename(file),
      base64: (await fs.readFile(file)).toString("base64"),
      source: { threadId: "desktop", provider: "Hive Mind", type: "user" },
    });
  });
  ipcMain.handle("hive:import-image", async (event, metadata) => {
    if (!trusted(event)) throw new Error("Operation not allowed.");
    const picked = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (picked.canceled) return null;
    const file = picked.filePaths[0];
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
      throw new Error("Choose an image under 10 MiB.");
    const bytes = await fs.readFile(file);
    const decoded = nativeImage.createFromBuffer(bytes);
    if (decoded.isEmpty()) throw new Error("This image could not be decoded.");
    const pixels = decoded.resize({ width: 8, height: 8, quality: "good" }).toBitmap();
    const values = [];
    for (let i = 0; i < pixels.length; i += 4) {
      const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
      values.push(
        rgb.reduce((n, v) => n + v, 0) / 3 / 127.5 - 1,
        Math.min(...rgb) / 127.5 - 1,
        Math.max(...rgb) / 127.5 - 1,
        pixels[i + 3] / 127.5 - 1,
      );
    }
    return call("/v1/assets", {
      ...metadata,
      descriptor: { algorithm: "hive-perceptual-v1", values },
      base64: bytes.toString("base64"),
      source: { threadId: "desktop", provider: "Hive Mind", type: "user" },
    });
  });
  ipcMain.handle("hive:asset-data", async (event, id) => {
    if (!trusted(event) || typeof id !== "string" || !/^[\w.-]{1,128}$/u.test(id))
      throw new Error("Invalid image reference.");
    const response = await fetch(`${service.origin}/v1/assets/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Image is unavailable (HTTP ${response.status}).`);
    const mime = response.headers.get("content-type");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime))
      throw new Error("Invalid image response.");
    return `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  });
  // Decode and downsize in the trusted host. The library never retains dozens
  // of full-size images in its renderer; originals remain available separately.
  ipcMain.handle("hive:asset-preview", (event, id) => {
    if (!trusted(event) || typeof id !== "string" || !/^[\w.-]{1,128}$/u.test(id))
      throw new Error("Invalid image reference.");
    const job = previewQueue.then(async () => {
      const metadata = await call("/v1/brain", { id });
      const record = metadata.value.records?.[0];
      if (!record || record.kind !== "asset" || record.data.media === "file") return null;
      // Very large originals remain retrievable, without decoding them merely
      // because a library card scrolled into view. Decode one preview at a time.
      if (record.data.width * record.data.height > 24_000_000) return null;
      const response = await fetch(`${service.origin}/v1/assets/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (
        !response.ok ||
        !/^image\/(png|jpeg|webp|gif)$/u.test(response.headers.get("content-type") ?? "")
      )
        throw new Error("No image preview available.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 10 * 1024 * 1024) throw new Error("Image exceeds the preview limit.");
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error("Image could not be decoded.");
      const size = image.getSize();
      const ratio = Math.min(1, 420 / Math.max(size.width, size.height));
      return `data:image/jpeg;base64,${image
        .resize({
          width: Math.max(1, Math.round(size.width * ratio)),
          height: Math.max(1, Math.round(size.height * ratio)),
        })
        .toJPEG(75)
        .toString("base64")}`;
    });
    previewQueue = job.catch(() => {});
    return job;
  });
  ipcMain.handle("hive:archive", async (event, action) => {
    if (!trusted(event)) throw new Error("Operation not allowed.");
    if (action === "export") {
      const selected = await dialog.showSaveDialog(window, {
        defaultPath: "Hive Mind backup.json",
        filters: [{ name: "Hive Mind backup", extensions: ["json"] }],
      });
      if (selected.canceled) return null;
      const archive = await call("/v1/archive/export", {});
      if (archive.status >= 400) throw new Error(archive.value.error);
      await fs.writeFile(selected.filePath, JSON.stringify(archive.value), { mode: 0o600 });
      return "Backup saved, including retained images.";
    }
    if (action !== "import") throw new Error("Unknown backup operation.");
    const selected = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "Hive Mind backup", extensions: ["json"] }],
    });
    if (selected.canceled) return null;
    const stat = await fs.stat(selected.filePaths[0]);
    if (stat.size > 64 * 1024 * 1024) throw new Error("Backup exceeds 64 MiB.");
    const result = await call(
      "/v1/archive/import",
      JSON.parse(await fs.readFile(selected.filePaths[0], "utf8")),
    );
    if (result.status >= 400) throw new Error(result.value.error);
    return "Backup restored.";
  });
  ipcMain.handle("hive:request", (event, route, body) => {
    if (!trusted(event) || !ROUTES.has(route)) throw new Error("Operation not allowed.");
    return call(route, body);
  });
  ipcMain.handle("hive:pick-folder", async (event) => {
    if (!trusted(event)) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    });
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
      ? {
          origin: service.origin,
          mcp: `${service.origin}/mcp`,
          file: connectionFile,
          login: app.getLoginItemSettings().openAtLogin,
        }
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
      offscreen: SMOKE,
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
  tray = new Tray(
    nativeImage
      .createFromPath(path.join(here, "../assets/icon.png"))
      .resize({ width: 16, height: 16 }),
  );
  refreshTray();
  tray.on("click", showWindow);
}

function refreshTray() {
  if (!tray) return;
  const state = updater?.state;
  const busy = state?.phase === "checking" || state?.phase === "downloading";
  const updateLabel =
    state?.phase === "ready"
      ? `Restart to update to ${state.nextVersion}`
      : state?.phase === "downloading"
        ? `Downloading update (${state.percent}%)`
        : state?.phase === "checking"
          ? "Checking for updates..."
          : state?.phase === "error"
            ? "Update check failed — retry"
            : "Check for updates";
  tray.setToolTip(`Hive Mind ${app.getVersion()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Hive Mind", click: showWindow },
      {
        label: updateLabel,
        enabled: Boolean(updater) && !busy,
        click: async () => {
          try {
            if (updater.state.phase === "ready") {
              pendingInstaller = await updater.prepareInstall();
              app.quit();
            } else {
              const checked = await updater.check();
              if (checked.phase === "current")
                void dialog.showMessageBox({ type: "info", message: "Hive Mind is up to date." });
              if (checked.phase === "error")
                dialog.showErrorBox("Update check failed", checked.error);
            }
          } catch (error) {
            dialog.showErrorBox("Update could not start", String(error.message ?? error));
          }
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

async function smoke() {
  // Headless self-check: load the real UI, wait for the graph, report what it drew.
  window.webContents.on("console-message", (event) =>
    console.log(`RENDERER ${event.level}: ${event.message}`),
  );
  await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  const report = await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const started = Date.now();
      const poll = () => window.__hiveReady ? resolve(window.__hiveReady) : Date.now() - started > 20000 ? resolve({ error: "timeout" }) : setTimeout(poll, 100);
      poll();
    })`,
  );
  if (!report.error) {
    report.workspace = await window.webContents.executeJavaScript(`(async () => {
      const receipt = (name) => Promise.race([new Promise(resolve => document.addEventListener(name, resolve, {once:true})), new Promise((_, reject) => setTimeout(() => reject(new Error(name + ' timed out')), 10000))]);
      let ready = receipt('hive:workspace-ready');
      document.getElementById('workspace').click(); await ready;
      const form = document.getElementById('workspace-editor');
      const inputs = form.querySelectorAll('input');
      inputs[0].value = 'Runtime smoke task'; inputs[1].value = 'Smoke Studio';
      form.querySelector('textarea').value = 'Continue the preferred lamp model';
      const saved = receipt('hive:record-saved'); form.requestSubmit(); await saved;
      ready = receipt('hive:workspace-ready');
      document.getElementById('workspace-kind').value = 'asset';
      document.getElementById('workspace-kind').dispatchEvent(new Event('change')); await ready;
      const first = document.querySelector('#workspace-list button');
      if (!first) throw new Error('Seeded reference missing');
      const opened = receipt('hive:record-opened'); first.click(); await opened;
      const images = [...document.querySelectorAll('#workspace-editor img')];
      await Promise.all(images.map(image => image.decode()));
      return { taskSaved: true, imageDecoded: images.some(image => image.naturalWidth > 0), dialogOpen: document.getElementById('workspace-dialog').open, referenceRows: document.querySelectorAll('#workspace-list button').length };
    })()`);
    if (!report.workspace.imageDecoded) report.error = "Retained image did not decode.";
  }
  if (!report.error) {
    report.visual = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('workspace-close').click();
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const wait = () => new Promise((resolve, reject) => { const started=Date.now();const check=()=>window.__hiveVisual?.orbs ? resolve() : Date.now()-started>10000 ? reject(new Error('3D scene did not paint')) : setTimeout(check,50);check(); });
      document.querySelector('[data-view-tab="mind"]').click(); await wait(); await frame();
      const before = window.__hiveVisual.camera.yaw;
      document.getElementById('mind-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await frame();
      if(window.__hiveVisual.camera.yaw===before)throw new Error('Camera did not orbit');
      const p=window.__hiveVisual.sample,r=document.getElementById('mind-canvas').getBoundingClientRect();
      document.getElementById('mind-canvas').dispatchEvent(new PointerEvent('pointerup',{clientX:r.left+p.x,clientY:r.top+p.y}));
      const sequence = await window.hive.request('/v1/changes',{});
      document.querySelector('[data-view-tab="organizer"]').click();
      document.getElementById('new-board-title').value='Visual smoke board';document.getElementById('board-create').requestSubmit();
      const boardSelect=document.getElementById('board-list').lastElementChild;boardSelect.click();
      document.getElementById('board-list').firstElementChild.click();
      const assignment=document.querySelector('.card-controls select');assignment.value=assignment.options[1].value;assignment.dispatchEvent(new Event('change'));
      document.querySelector('.card-controls button').click();
      await frame();
      const after=await window.hive.request('/v1/changes',{});
      if(sequence.value.sequence!==after.value.sequence)throw new Error('Visual organization changed canonical memory');
      return {...window.__hiveVisual,cards:document.querySelectorAll('.memory-card').length,boardSaved:document.querySelectorAll('#board-list .board-item').length===3,visualOnly:true};
    })()`);
    if (!report.visual.finite || !report.visual.boardSaved)
      report.error = "Visual memory verification failed.";
  }
  if (!report.error) {
    // Presence is ephemeral service state; report one chat and expect the live strip to show it.
    await call("/v1/presence", {
      chatId: "smoke-chat",
      provider: "smoke",
      title: "Smoke chat",
      status: "working",
      step: "editing files",
    });
    report.live = await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
          const strip = document.getElementById('live-chats');
          const text = strip.textContent;
          if (!strip.hidden && text.includes('Smoke chat') && text.includes('editing files')) resolve({ shown: true });
          else if (Date.now() - started > 8000) resolve({ shown: false, text });
          else setTimeout(poll, 100);
        };
        poll();
      })`,
    );
    if (!report.live.shown) report.error = "Live chat strip did not show a reported chat.";
  }
  if (process.env.HIVE_MIND_SMOKE_SHOT) {
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await fs.writeFile(
      process.env.HIVE_MIND_SMOKE_SHOT.replace(/\.png$/u, "-organizer.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    const reloaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    window.webContents.reload();
    await reloaded;
    const persisted = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const start=Date.now();const check=()=>window.__hiveVisual?.boards===1 && window.__hiveVisual?.pins===1 ? resolve(window.__hiveVisual) : Date.now()-start>10000 ? reject(new Error('Visual layout did not survive reload')) : setTimeout(check,50);check();
    })`);
    report.visual.persisted = persisted.boards === 1 && persisted.pins === 1;
    const hit = await window.webContents.executeJavaScript(
      `(() => { const r=document.getElementById('mind-canvas').getBoundingClientRect(), p=window.__hiveVisual.sample;return {x:Math.round(r.left+p.x),y:Math.round(r.top+p.y)}; })()`,
    );
    window.webContents.sendInputEvent({ type: "mouseMove", ...hit });
    window.webContents.sendInputEvent({ type: "mouseDown", ...hit, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...hit, button: "left", clickCount: 1 });
    report.visual.orbOpened = await window.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const start=Date.now();const check=()=>!document.getElementById('orb-inspector').hidden ? resolve(true) : Date.now()-start>3000 ? reject(new Error('Orb picking failed')) : requestAnimationFrame(check);check();})`,
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-view-tab=\"mind\"]').click();new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await fs.writeFile(
      process.env.HIVE_MIND_SMOKE_SHOT.replace(/\.png$/u, "-mind.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-view-tab=\"graph\"]').click();",
    );
    await call("/v1/sync", {});
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const graph = await window.webContents.executeJavaScript(
      "({painted:painted(), nan:state.nodes.filter(n=>!Number.isFinite(n.x)||!Number.isFinite(n.y)).length})",
    );
    report.painted = graph.painted;
    if (!graph.painted || graph.nan) report.error = "Graph did not render valid pixels.";
    await fs.writeFile(
      process.env.HIVE_MIND_SMOKE_SHOT,
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  console.log(`SMOKE ${JSON.stringify(report)}`);
  await service.close();
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
  subscribeHiveChanges(path.join(service.stateDirectory, "hive-mind.json"), () => {
    if (window && !window.isDestroyed()) window.webContents.send("hive:changed");
  });
  service.onStatusChange(() => {
    if (window && !window.isDestroyed()) window.webContents.send("hive:changed");
  });
  createWindow();
  if (SMOKE) {
    try {
      await smoke();
    } catch (error) {
      console.log(`SMOKE ${JSON.stringify({ error: String(error?.message ?? error) })}`);
      await service.close();
      app.exit(1);
    }
  } else {
    if (app.isPackaged && process.platform === "win32" && process.arch === "x64") {
      updater = createUpdater({
        version: app.getVersion(),
        directory: path.join(app.getPath("userData"), "updates"),
        onChange: refreshTray,
      });
      const firstCheck = setTimeout(() => void updater.check(), 10_000);
      firstCheck.unref();
      updateInterval = setInterval(() => void updater.check(), 6 * 60 * 60 * 1000);
      updateInterval.unref();
    }
    createTray();
  }
});

app.on("window-all-closed", () => {
  /* The tray keeps the service alive. */
});
app.on("before-quit", (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  clearInterval(updateInterval);
  void service
    .close()
    .then(async () => {
      if (pendingInstaller) await launchInstaller(pendingInstaller);
    })
    .catch((error) => {
      dialog.showErrorBox("Hive Mind could not finish closing", String(error.message ?? error));
      if (pendingInstaller) app.relaunch();
    })
    .finally(() => app.exit(0));
});
