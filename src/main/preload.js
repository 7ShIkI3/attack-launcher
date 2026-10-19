'use strict';
// Pont entre la page et le processus principal : uniquement des appels IPC nommés, aucun accès à Node.
// Aucun jeton ne transite par ce pont : la page ne voit que les pseudos, skins et codes à afficher.
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
  openLogs: invoke('game:openLogs'),
  pickFolder: invoke('dialog:pickFolder'),
  pickJava: invoke('dialog:pickJava'),
  openGameDir: invoke('shell:openGameDir'),
  openRepo: invoke('shell:openRepo'),
  openAzureHelp: invoke('shell:openAzureHelp'),
  accounts: {
    list: invoke('accounts:list'),
    login: invoke('accounts:login'),
    cancel: invoke('accounts:cancel'),
    openVerification: invoke('accounts:openVerification'),
    copyCode: invoke('accounts:copyCode'),
    select: invoke('accounts:select'),
    remove: invoke('accounts:remove'),
    addOffline: invoke('accounts:addOffline'),
  },
  skins: {
    pick: invoke('skins:pick'),
    discard: invoke('skins:discard'),
    apply: invoke('skins:apply'),
    reset: invoke('skins:reset'),
    refresh: invoke('skins:refresh'),
  },
  update: {
    state: invoke('update:state'),
    install: invoke('update:install'),
    openReleases: invoke('update:openReleases'),
  },
  onProgress: subscribe('install:progress'),
  onAuthEvent: subscribe('auth:event'),
  onAccountsChanged: subscribe('accounts:changed'),
  onUpdateState: subscribe('update:state'),
  onWindowState: subscribe('window:state'),
  window: {
    minimize: invoke('window:minimize'),
    maximize: invoke('window:maximize'),
    close: invoke('window:close'),
  },
});
