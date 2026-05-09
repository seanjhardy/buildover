const { app, BrowserWindow, shell, nativeImage } = require("electron");
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
      backgroundThrottling: false,
      webSecurity: false, // allows localhost API/WS calls without CORS overhead
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    shell.openExternal(url);
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
