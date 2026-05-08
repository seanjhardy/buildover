// Electron main process — compiled to CommonJS (see electron/tsconfig.json).
// Uses require() / __dirname throughout; isolated from the root ESM project
// by electron/package.json which sets "type": "commonjs".

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

// ── Environment detection ────────────────────────────────────────────────────
// ELECTRON_IS_DEV=1 is set by the electron:dev npm script.
// In a packaged .app this env var is absent so isDev is false.
const isDev = process.env.ELECTRON_IS_DEV === "1";

// ── Ports ────────────────────────────────────────────────────────────────────
const CLIENT_PORT = 5173; // Vite dev server (dev mode only)
const SERVER_PORT = 8787; // Express + WebSocket server

// ── Express server child process (production only) ───────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverProcess: any = null;

function startExpressServer(): void {
  const appRoot = app.getAppPath();
  // esbuild compiles server/index.ts → dist-server/index.cjs (CJS bundle).
  // electron-builder copies dist-server/ into the .app bundle.
  const serverEntry = path.join(appRoot, "dist-server", "index.cjs");
  // Use the Node binary bundled with Electron.
  const nodeBin = process.execPath;

  serverProcess = spawn(nodeBin, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout?.on("data", (d: Buffer) => {
    console.log("[server]", d.toString().trim());
  });
  serverProcess.stderr?.on("data", (d: Buffer) => {
    console.error("[server:err]", d.toString().trim());
  });
  serverProcess.on("exit", (code: number) => {
    console.log("[server] exited with code", code);
  });
}

function stopExpressServer(): void {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// ── Window creation ──────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mainWindow: any = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "buildover",
    resizable: true,
    // show: false — render offscreen first to avoid a flash of white while
    // React boots, then reveal once ready-to-show fires.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Reveal once the page has painted.
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Open external links in the system browser instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(
    ({ url }: { url: string }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    },
  );

  if (isDev) {
    // Dev: load the Vite HMR dev server. wait-on in the npm script ensures
    // it's ready before Electron is launched.
    mainWindow.loadURL(`http://localhost:${CLIENT_PORT}`);
    mainWindow.webContents.openDevTools();
  } else {
    // Production: load the compiled Vite output from inside the bundle.
    const indexHtml = path.join(app.getAppPath(), "dist", "index.html");
    mainWindow.loadFile(indexHtml);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (!isDev) {
    startExpressServer();
  }
  createWindow();
});

// macOS: re-create the window when the Dock icon is clicked and no windows exist.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// macOS convention: keep the app alive in the Dock after the last window closes.
// On other platforms, quit normally.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Clean up the server process before quitting.
app.on("before-quit", () => {
  stopExpressServer();
});
