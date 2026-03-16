'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

const fingerprintProfile = {
  platform: 'Win32',
  vendor: 'Google Inc.',
  hardwareConcurrency: pick([4, 8, 8, 12]),
  deviceMemory: pick([4, 8, 8, 16]),
  language: pick(['en-US', 'de-DE', 'en-GB']),
  languages: pick([
    ['en-US', 'en'],
    ['de-DE', 'de', 'en-US', 'en'],
    ['en-GB', 'en']
  ]),
  timezone: pick(['Europe/Berlin', 'Europe/Amsterdam', 'Europe/Zurich']),
  webglVendor: 'Google Inc. (Intel)',
  webglRenderer: pick([
    'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (AMD, AMD Radeon Graphics Direct3D11 vs_5_0 ps_5_0)'
  ])
};

function injectFingerprintSpoofing() {
  const script = `(() => {
    const p = ${JSON.stringify(fingerprintProfile)};
    const define = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { get: () => value, configurable: true });
      } catch (_) {}
    };

    try {
      const navProto = Object.getPrototypeOf(navigator);
      define(navProto, 'platform', p.platform);
      define(navProto, 'vendor', p.vendor);
      define(navProto, 'hardwareConcurrency', p.hardwareConcurrency);
      define(navProto, 'deviceMemory', p.deviceMemory);
      define(navProto, 'language', p.language);
      define(navProto, 'languages', p.languages.slice());
      define(navProto, 'doNotTrack', '1');
      define(navigator, 'platform', p.platform);
      define(navigator, 'vendor', p.vendor);
      define(navigator, 'hardwareConcurrency', p.hardwareConcurrency);
      define(navigator, 'deviceMemory', p.deviceMemory);
      define(navigator, 'language', p.language);
      define(navigator, 'languages', p.languages.slice());
      define(navigator, 'doNotTrack', '1');
    } catch (_) {}

    try {
      const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function(...args) {
        const opts = originalResolvedOptions.apply(this, args);
        return { ...opts, timeZone: p.timezone };
      };
    } catch (_) {}

    try {
      const patchWebGL = (ctor) => {
        if (!ctor || !ctor.prototype || !ctor.prototype.getParameter) return;
        const original = ctor.prototype.getParameter;
        ctor.prototype.getParameter = function(param) {
          if (param === 37445) return p.webglVendor;
          if (param === 37446) return p.webglRenderer;
          return original.call(this, param);
        };
      };
      patchWebGL(window.WebGLRenderingContext);
      patchWebGL(window.WebGL2RenderingContext);
    } catch (_) {}

    try {
      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
          value: { runtime: {} },
          configurable: true
        });
      }
    } catch (_) {}
  })();`;

  const inject = () => {
    const root = document.documentElement;
    if (!root) return false;
    const el = document.createElement('script');
    el.textContent = script;
    root.prepend(el);
    el.remove();
    return true;
  };

  if (inject()) return;
  const observer = new MutationObserver(() => {
    if (inject()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

const protocol = window.location && window.location.protocol;
const isInternalPage = protocol === 'void:' || protocol === 'file:';

if (!isInternalPage) {
  injectFingerprintSpoofing();
}

// ─── Expose typed API to renderer ─────────────────────────────────────────────
// All IPC calls go through this bridge – renderer never has direct Node access.

if (!isInternalPage) {
  // Do not expose privileged APIs to arbitrary websites.
  // Internal pages (void:// and local UI) still get voidAPI.
  return;
}

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
