"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buffDesktop", {
  request: async (action, payload) => {
    const response = await ipcRenderer.invoke("buff-desktop:request", { action, payload });
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
  onChange: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("buff-desktop:change", listener);
    return () => ipcRenderer.removeListener("buff-desktop:change", listener);
  },
});
