const { contextBridge, ipcRenderer } = require("electron");

// Expose a safe, narrow notification API to the renderer via contextBridge.
// The renderer calls these as window.electronNotifications.updateBadge / .notify.
// All actual Electron/Node calls happen here in the privileged preload context.
contextBridge.exposeInMainWorld("electronNotifications", {
  updateBadge: (attentionCount: number, runningCount: number): Promise<void> => {
    return ipcRenderer.invoke("notification:update-badge", attentionCount, runningCount);
  },
  notify: (title: string, body: string): Promise<void> => {
    return ipcRenderer.invoke("notification:notify", title, body);
  },
});
