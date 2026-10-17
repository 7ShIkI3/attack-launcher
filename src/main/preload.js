'use strict';
// Pont entre la page et le processus principal : uniquement des appels IPC nommés, aucun accès à Node.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('attack', {
  info: invoke('app:info'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  status: invoke('install:status'),
  install: invoke('install:run'),
  play: invoke('game:play'),
  pickFolder: invoke('dialog:pickFolder'),
  pickJava: invoke('dialog:pickJava'),
  openGameDir: invoke('shell:openGameDir'),
  openRepo: invoke('shell:openRepo'),
  onProgress: subscribe('install:progress'),
  onWindowState: subscribe('window:state'),
  window: {
    minimize: invoke('window:minimize'),
    maximize: invoke('window:maximize'),
    close: invoke('window:close'),
  },
});
