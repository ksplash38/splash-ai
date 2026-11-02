const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('splash', {
  getState: invoke('get-state'),
  saveConfig: invoke('save-config'),
  regenToken: invoke('regen-token'),
  ask: invoke('ask'),
  confirmReply: invoke('confirm-reply'),
  newConversation: invoke('new-conversation'),
  openConversation: invoke('open-conversation'),
  deleteConversation: invoke('delete-conversation'),
  deleteAllHistory: invoke('delete-all-history'),
  listNotes: invoke('list-notes'),
  deleteNotes: invoke('delete-notes'),
  addMemory: invoke('add-memory'),
  deleteMemory: invoke('delete-memory'),
  routerWake: invoke('router-wake'),
  routerStatus: invoke('router-status'),
  transcribe: invoke('transcribe'),
  naturalVoices: invoke('natural-voices'),
  tts: invoke('tts'),
  pairingInfo: invoke('pairing-info'),
  modelUrl: invoke('model-url'),
  openExternal: invoke('open-external'),
  openDataFolder: invoke('open-data-folder'),
  on: (ch, fn) => {
    const ok = ['confirm', 'step', 'fallback', 'trying', 'ptt', 'remote', 'history-changed', 'toast', 'model-progress', 'paired'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (_, data) => fn(data));
  },
});
