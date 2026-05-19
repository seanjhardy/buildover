const { app, BrowserWindow, shell, nativeImage, ipcMain, Notification, systemPreferences } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const PROJECT_DIR = path.resolve(__dirname, "..");
const NPM = "/opt/homebrew/bin/npm";
const ENV = {
  ...process.env,
  PATH: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: require("os").homedir(),
};

let mainWindow: any = null;
let serverProcess: any = null;
let clientProcess: any = null;

// Check if a port is already accepting connections
function isPortUp(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}`, (res: any) => {
      res.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

// Poll until port is up, then resolve
function waitForPort(port: number): Promise<void> {
  return new Promise(resolve => {
    function check() {
      isPortUp(port).then(up => up ? resolve() : setTimeout(check, 1000));
    }
    check();
  });
}

async function startServers(): Promise<void> {
  const [serverUp, clientUp] = await Promise.all([
    isPortUp(8787),
    isPortUp(5173),
  ]);
  if (!serverUp) {
    serverProcess = spawn(NPM, ["run", "dev:server"], {
      cwd: PROJECT_DIR, env: ENV, stdio: "ignore",
    });
  }
  if (!clientUp) {
    clientProcess = spawn(NPM, ["run", "dev:client"], {
      cwd: PROJECT_DIR, env: ENV, stdio: "ignore",
    });
  }
  await waitForPort(5173);
}

function createWindow(): void {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "buildover",
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required so preload can use require("electron")
      backgroundThrottling: false,
      webSecurity: false, // allows localhost API/WS calls without CORS overhead
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    // WebLinksAddon's default handler calls window.open() with no URL first
    // (about:blank); only forward real http(s) links to the OS browser.
    if (url && url !== "about:blank" && /^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.loadURL("http://localhost:5173");
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  const icon = nativeImage.createFromPath(
    path.join(PROJECT_DIR, "build", "icon_1024.png")
  );
  if (app.dock) app.dock.setIcon(icon);

  await startServers();
  createWindow();

  // ── Dock badge ─────────────────────────────────────────────────────────────
  // Payload: (attentionCount, runningCount)
  // Badge format: "N •" for both, "N" for attention only, "•" for running only, "" for none.
  ipcMain.handle(
    "notification:update-badge",
    (_event: any, attentionCount: number, runningCount: number) => {
      if (!app.dock) return;
      if (attentionCount > 0 && runningCount > 0) {
        app.dock.setBadge(`${attentionCount} •`);
      } else if (attentionCount > 0) {
        app.dock.setBadge(`${attentionCount}`);
      } else if (runningCount > 0) {
        app.dock.setBadge("•");
      } else {
        app.dock.setBadge("");
      }
    },
  );

  ipcMain.handle("shell:open-external", (_event: any, url: string) => {
    if (typeof url === "string" && /^https?:/i.test(url)) {
      shell.openExternal(url);
    }
  });

  // ── System permissions ──────────────────────────────────────────────────────
  ipcMain.handle("permissions:check", () => {
    return {
      microphone: systemPreferences.getMediaAccessStatus("microphone") as string,
    };
  });

  ipcMain.handle("permissions:open-settings", async (_event: any, type: string) => {
    const urls: Record<string, string> = {
      notifications: "x-apple.systempreferences:com.apple.preference.notifications",
      microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    };
    const url = urls[type];
    if (url) await shell.openExternal(url);
  });

  // ── Native notification ─────────────────────────────────────────────────────
  // Only fires when the main window is NOT focused — user is already watching otherwise.
  ipcMain.handle(
    "notification:notify",
    (_event: any, title: string, body: string) => {
      if (mainWindow?.isFocused()) return;
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, silent: true });
      n.show();
    },
  );
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (mainWindow) mainWindow.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  serverProcess?.kill();
  clientProcess?.kill();
});
