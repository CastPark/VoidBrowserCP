'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ─── Expose typed API to renderer ─────────────────────────────────────────────
// All IPC calls go through this bridge – renderer never has direct Node access.

contextBridge.exposeInMainWorld('voidAPI', {

  // ── Window Controls ──────────────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close:    () => ipcRenderer.send('window-close')
  },

  // ── Tabs ─────────────────────────────────────────────────────────────────
  tabs: {
    create:  (tabId, url)     => ipcRenderer.invoke('tab-create', { tabId, url }),
    switch:  (tabId)          => ipcRenderer.send('tab-switch', { tabId }),
    close:   (tabId)          => ipcRenderer.send('tab-close', { tabId })
  },

  // ── Navigation ────────────────────────────────────────────────────────────
  nav: {
    go:      (tabId, url)     => ipcRenderer.send('nav-go', { tabId, url }),
    back:    (tabId)          => ipcRenderer.send('nav-back', { tabId }),
    forward: (tabId)          => ipcRenderer.send('nav-forward', { tabId }),
    reload:  (tabId)          => ipcRenderer.send('nav-reload', { tabId }),
    stop:    (tabId)          => ipcRenderer.send('nav-stop', { tabId })
  },

  // ── Config ────────────────────────────────────────────────────────────────
  config: {
    get:     ()               => ipcRenderer.invoke('get-config'),
    set:     (updates)        => ipcRenderer.invoke('set-config', updates)
  },

  // ── Downloads ─────────────────────────────────────────────────────────────
  downloads: {
    getAll:             ()    => ipcRenderer.invoke('get-downloads'),
    cancel:             (id)  => ipcRenderer.send('download-cancel', { id }),
    openFolder:         ()    => ipcRenderer.send('open-downloads-folder'),
    selectPath:         ()    => ipcRenderer.invoke('select-download-path')
  },

  // ── Extensions ────────────────────────────────────────────────────────────
  extensions: {
    getAll:   ()              => ipcRenderer.invoke('get-extensions'),
    toggle:   (id, enabled)   => ipcRenderer.send('extension-toggle', { id, enabled }),
    remove:   (id)            => ipcRenderer.send('extension-remove', { id }),
    install:  (filePath)      => ipcRenderer.invoke('install-extension', { filePath }),
    openDialog: ()            => ipcRenderer.invoke('open-extension-dialog')
  },

  // ── Adblocker ─────────────────────────────────────────────────────────────
  adblock: {
    update:   ()              => ipcRenderer.invoke('adblock-update')
  },

  // ── Updates ───────────────────────────────────────────────────────────────
  updates: {
    getStatus: ()             => ipcRenderer.invoke('updates-get-status'),
    check:     ()             => ipcRenderer.invoke('updates-check'),
    install:   ()             => ipcRenderer.invoke('updates-install')
  },

  // ── UI Layout Sync ───────────────────────────────────────────────────────
  ui: {
    setToolbarHeight: (height) => ipcRenderer.send('toolbar-resize', { height })
  },

  // ── Events (main → renderer) ──────────────────────────────────────────────
  on: (channel, callback) => {
    const allowed = [
      'tab-updated', 'tab-loading', 'tab-title-updated', 'tab-favicon-updated',
      'nav-state-update', 'block-count-update', 'download-update', 'update-status',
      'open-new-tab'
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },

  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  }
});
