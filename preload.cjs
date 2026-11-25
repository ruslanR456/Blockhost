const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('blockhost', Object.freeze({
  getVersions: () => ipcRenderer.invoke('blockhost:versions'),
  getProfiles: () => ipcRenderer.invoke('blockhost:profiles:list'),
  createProfile: profile => ipcRenderer.invoke('blockhost:profiles:create', profile),
  deleteProfile: id => ipcRenderer.invoke('blockhost:profiles:delete', id),
  installServer: id => ipcRenderer.invoke('blockhost:server:install', id),
  startServer: id => ipcRenderer.invoke('blockhost:server:start', id),
  stopServer: id => ipcRenderer.invoke('blockhost:server:stop', id),
  openServerFolder: id => ipcRenderer.invoke('blockhost:server:open-folder', id),
  getSystemInfo: () => ipcRenderer.invoke('blockhost:system-info'),
  getRuntimeStatus: () => ipcRenderer.invoke('blockhost:runtime-status'),
  getPlayers: id => ipcRenderer.invoke('blockhost:players:get', id),
  runPlayerAction: (id, action, player) => ipcRenderer.invoke('blockhost:players:action', id, action, player),
  listServerFiles: (id, relativePath) => ipcRenderer.invoke('blockhost:files:list', id, relativePath),
  readServerFile: (id, relativePath) => ipcRenderer.invoke('blockhost:files:read', id, relativePath),
  writeServerFile: (id, relativePath, content) => ipcRenderer.invoke('blockhost:files:write', id, relativePath, content),
  deleteServerFile: (id, relativePath) => ipcRenderer.invoke('blockhost:files:delete', id, relativePath),
  addMods: id => ipcRenderer.invoke('blockhost:mods:add', id),
  openExternal: url => ipcRenderer.invoke('blockhost:open-external', url),
  onInstallProgress: listener => subscribe('blockhost:install-progress', listener),
  onServerOutput: listener => subscribe('blockhost:server-output', listener),
  onServerStatus: listener => subscribe('blockhost:server-status', listener),
  onPlayerList: listener => subscribe('blockhost:player-list', listener)
}));