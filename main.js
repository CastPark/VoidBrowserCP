'use strict';

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, dialog, protocol, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const Adblocker = require('./src/adblocker');
const Privacy = require('./src/privacy');
const Extensions = require('./src/extensions');
const Downloads = require('./src/downloads');
const AI = require('./src/ai');

// ─── Register void:// as a standard privileged scheme BEFORE app.ready ───────
// This must happen synchronously before app.whenReady() is called.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'void',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: false,
      stream: true
    }
  }
]);

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const FIXED_UPDATE_OWNER = 'CastPark';
const FIXED_UPDATE_REPO = 'VoidBrowserCP';
let config = {};
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

let updateStatus = {
  state: 'idle',
  message: 'Auto update is not configured.',
  version: null,
  progress: null,
  hasUpdate: false,
  downloaded: false
};
let updateCheckTimer = null;
let autoUpdaterInitialized = false;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = {
        ...getDefaultConfig(),
        ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      };
    } else {
      config = getDefaultConfig();
      saveConfig();
    }
  } catch (err) {
    console.error('[Config] Failed to load config, using defaults:', err.message);
    config = getDefaultConfig();
  }

  // Keep update source pinned to the project owner's repository.
  config.updates_github_owner = FIXED_UPDATE_OWNER;
  config.updates_github_repo = FIXED_UPDATE_REPO;
}

function getDefaultConfig() {
  return {
    adblock_enabled: true,
    adblock_online_update: true,
    search_engine: 'duckduckgo',
    homepage: 'void://newtab',
    download_path: app.getPath('downloads'),
    ai_enabled: false,
    ai_model: 'llama3',
    accent_color: '#0ea5e9',
    newtab_background_preset: 'aurora',
    newtab_background_image: '',
    cookie_whitelist: [],
    user_agent_randomize: true,
    updates_enabled: true,
    updates_auto_download: true,
    updates_github_owner: FIXED_UPDATE_OWNER,
    updates_github_repo: FIXED_UPDATE_REPO
  };
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[Config] Failed to save config:', err.message);
  }
}

// ─── Main Window ─────────────────────────────────────────────────────────────
let mainWindow = null;
let adblocker = null;
let privacy = null;
let extensions = null;
let downloads = null;
let ai = null;

// Track BrowserViews per tab: Map<tabId, BrowserView>
const tabViews = new Map();
const webContentsToTabId = new Map();
// Track blocked ad count per tab: Map<tabId, number>
const tabBlockCounts = new Map();
let activeTabId = null;
// Browser chrome height (titlebar + tabbar + toolbar). Updated from renderer.
let chromeHeight = 82;

function setUpdateStatus(next) {
  updateStatus = {
    ...updateStatus,
    ...next
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', updateStatus);
  }
}

function getUpdateFeedConfig() {
  const owner = String(FIXED_UPDATE_OWNER).trim();
  const repo = String(FIXED_UPDATE_REPO).trim();

  if (!owner || !repo) return null;

  return {
    provider: 'github',
    owner,
    repo,
    private: false,
    releaseType: 'release'
  };
}

function registerAutoUpdaterListeners() {
  if (autoUpdaterInitialized) return;
  autoUpdaterInitialized = true;

  autoUpdater.on('checking-for-update', () => {
    setUpdateStatus({
      state: 'checking',
      message: 'Checking GitHub releases for updates…',
      progress: null,
      hasUpdate: false,
      downloaded: false
    });
  });

  autoUpdater.on('update-available', (info) => {
    setUpdateStatus({
      state: 'available',
      message: config.updates_auto_download === false
        ? `Update ${info.version} is available.`
        : `Update ${info.version} found. Downloading now…`,
      version: info.version,
      hasUpdate: true,
      downloaded: false
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    setUpdateStatus({
      state: 'idle',
      message: info && info.version
        ? `You are up to date on ${info.version}.`
        : 'No updates available.',
      version: info && info.version ? info.version : app.getVersion(),
      progress: null,
      hasUpdate: false,
      downloaded: false
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    setUpdateStatus({
      state: 'downloading',
      message: `Downloading update… ${Math.round(progress.percent || 0)}%`,
      progress: Math.round(progress.percent || 0),
      hasUpdate: true,
      downloaded: false
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setUpdateStatus({
      state: 'downloaded',
      message: `Update ${info.version} is ready to install.`,
      version: info.version,
      progress: 100,
      hasUpdate: true,
      downloaded: true
    });
  });

  autoUpdater.on('error', (error) => {
    setUpdateStatus({
      state: 'error',
      message: error ? error.message : 'Update check failed.',
      progress: null,
      downloaded: false
    });
  });
}

async function checkForUpdates(reason = 'manual') {
  if (!app.isPackaged) {
    setUpdateStatus({
      state: 'disabled',
      message: 'Auto update works only in installed builds.',
      progress: null,
      downloaded: false
    });
    return { success: false, error: 'app-not-packaged' };
  }

  if (config.updates_enabled === false) {
    setUpdateStatus({
      state: 'disabled',
      message: 'Auto update is disabled in settings.',
      progress: null,
      downloaded: false
    });
    return { success: false, error: 'updates-disabled' };
  }

  const feedConfig = getUpdateFeedConfig();
  if (!feedConfig) {
    setUpdateStatus({
      state: 'disabled',
      message: 'Set your GitHub owner and repo in Settings > General > Updates.',
      progress: null,
      downloaded: false
    });
    return { success: false, error: 'github-feed-not-configured' };
  }

  autoUpdater.autoDownload = config.updates_auto_download !== false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL(feedConfig);
  await autoUpdater.checkForUpdates();

  return { success: true, reason };
}

function setupAutoUpdater() {
  registerAutoUpdaterListeners();

  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }

  if (config.updates_enabled === false) {
    setUpdateStatus({
      state: 'disabled',
      message: 'Auto update is disabled in settings.',
      progress: null,
      downloaded: false
    });
    return;
  }

  if (!getUpdateFeedConfig()) {
    setUpdateStatus({
      state: 'disabled',
      message: 'Set your GitHub owner and repo in Settings > General > Updates.',
      progress: null,
      downloaded: false
    });
    return;
  }

  if (!app.isPackaged) {
    setUpdateStatus({
      state: 'disabled',
      message: 'Auto update is ready, but it only runs in the installed build.',
      progress: null,
      downloaded: false
    });
    return;
  }

  checkForUpdates('startup').catch((err) => {
    setUpdateStatus({
      state: 'error',
      message: err.message,
      progress: null,
      downloaded: false
    });
  });

  updateCheckTimer = setInterval(() => {
    checkForUpdates('scheduled').catch((err) => {
      setUpdateStatus({
        state: 'error',
        message: err.message,
        progress: null,
        downloaded: false
      });
    });
  }, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
  loadConfig();

  // ── Register void:// protocol handler (Electron 25+ API) ──
  protocol.handle('void', (request) => {
    const parsed = new URL(request.url);
    const host = parsed.hostname;
    const pathname = parsed.pathname || '/';
    let filePath = null;

    // Serve new tab page and its static assets
    if (host === 'newtab') {
      if (pathname === '/' || pathname === '') {
        filePath = path.join(__dirname, 'ui', 'newtab.html');
      } else if (pathname === '/newtab.css') {
        filePath = path.join(__dirname, 'ui', 'newtab.css');
      } else if (pathname === '/newtab.js') {
        filePath = path.join(__dirname, 'ui', 'newtab.js');
      }
    }

    // Serve settings page
    if (host === 'settings' && (pathname === '/' || pathname === '')) {
      filePath = path.join(__dirname, 'ui', 'settings.html');
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return new Response('<h1>Not Found</h1>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Explicitly allow geolocation permissions for the New Tab weather widget.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'geolocation') {
      callback(true);
      return;
    }
    callback(false);
  });

  // ── Privacy: randomize user agent ──
  privacy = new Privacy(config);
  privacy.applyUserAgent(session.defaultSession);

  // ── Adblocker ──
  adblocker = new Adblocker(config, path.join(__dirname, 'assets', 'blocklist.txt'));
  await adblocker.initialize();
  adblocker.attachToSession(session.defaultSession, (webContentsId) => {
    const tabId = webContentsToTabId.get(webContentsId);
    if (typeof tabId !== 'number') return;
    const current = tabBlockCounts.get(tabId) || 0;
    tabBlockCounts.set(tabId, current + 1);
    if (mainWindow && activeTabId === tabId) {
      mainWindow.webContents.send('block-count-update', tabBlockCounts.get(tabId));
    }
  });

  // ── Extensions ──
  extensions = new Extensions(config, path.join(__dirname, 'extensions'));

  // ── Downloads ──
  downloads = new Downloads(config);
  downloads.attach(session.defaultSession);

  // ── AI module intentionally not initialized; UI features removed.

  // ── Create window ──
  createMainWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,           // Custom titlebar
    transparent: false,
    backgroundColor: '#0d0d0d',
    // Windows 11: native rounded corners + Mica material
    roundedCorners: true,
    backgroundMaterial: 'acrylic',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#141414',
      symbolColor: '#e2e8f0',
      height: 0
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: false,    // We use BrowserView instead
      sandbox: false,       // Required for preload with contextIsolation
      spellcheck: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'browser.html'));

  // Remove default menu
  mainWindow.setMenuBarVisibility(false);

  // Handle window close: clear cookies except whitelist
  mainWindow.on('close', async () => {
    await clearCookiesOnExit();
    // Destroy all BrowserViews
    for (const [, view] of tabViews) {
      try { mainWindow.removeBrowserView(view); } catch (_) {}
    }
    tabViews.clear();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Relay resize events so the active BrowserView gets resized
  mainWindow.on('resize', () => {
    if (activeTabId !== null) {
      resizeActiveView();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // Attach downloads listener to main window webContents for UI relay
    downloads.setUICallback((data) => {
      if (mainWindow) mainWindow.webContents.send('download-update', data);
    });
    mainWindow.webContents.send('update-status', updateStatus);
  });
}

// ─── Cookie Cleanup ───────────────────────────────────────────────────────────
async function clearCookiesOnExit() {
  try {
    const whitelist = config.cookie_whitelist || [];
    const cookies = await session.defaultSession.cookies.get({});
    for (const cookie of cookies) {
      const domain = cookie.domain.replace(/^\./, '');
      if (!whitelist.some(w => domain.includes(w))) {
        const url = `http${cookie.secure ? 's' : ''}://${domain}${cookie.path}`;
        await session.defaultSession.cookies.remove(url, cookie.name).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Privacy] Cookie cleanup error:', err.message);
  }
}

// ─── BrowserView helpers ─────────────────────────────────────────────────────
function getViewBounds() {
  if (!mainWindow) return { x: 0, y: chromeHeight, width: 1280, height: 800 - chromeHeight };
  const [w, h] = mainWindow.getContentSize();
  return { x: 0, y: chromeHeight, width: w, height: Math.max(0, h - chromeHeight) };
}

function resizeActiveView() {
  if (activeTabId === null) return;
  const view = tabViews.get(activeTabId);
  if (view) {
    view.setBounds(getViewBounds());
  }
}

function createBrowserView(tabId, url) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      spellcheck: true,
      // Required for YouTube/Twitch/Streaming sites
      allowRunningInsecureContent: false,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  view.setBackgroundColor('#0d0d0d');
  tabViews.set(tabId, view);
  webContentsToTabId.set(view.webContents.id, tabId);
  tabBlockCounts.set(tabId, 0);

  // ── Navigation event relays ──
  view.webContents.on('did-start-navigation', (event, navigationUrl, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;

    tabBlockCounts.set(tabId, 0);

    if (mainWindow) {
      mainWindow.webContents.send('tab-loading', { tabId, loading: true });
      if (activeTabId === tabId) {
        mainWindow.webContents.send('block-count-update', 0);
      }
    }
  });

  view.webContents.on('did-finish-load', () => {
    const url = view.webContents.getURL();
    const title = view.webContents.getTitle();
    const canGoBack = view.webContents.canGoBack();
    const canGoForward = view.webContents.canGoForward();
    if (mainWindow) {
      mainWindow.webContents.send('tab-updated', { tabId, url, title, loading: false, canGoBack, canGoForward });
    }
  });

  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !mainWindow) return;
    mainWindow.webContents.send('tab-updated', {
      tabId,
      url: validatedURL || view.webContents.getURL(),
      title: view.webContents.getTitle(),
      loading: false,
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward()
    });
  });

  view.webContents.on('page-title-updated', (event, title) => {
    if (mainWindow) {
      mainWindow.webContents.send('tab-title-updated', { tabId, title });
    }
  });

  view.webContents.on('page-favicon-updated', (event, favicons) => {
    if (mainWindow && favicons.length > 0) {
      mainWindow.webContents.send('tab-favicon-updated', { tabId, favicon: favicons[0] });
    }
  });

  view.webContents.on('did-navigate', (event, url) => {
    if (mainWindow && activeTabId === tabId) {
      const canGoBack = view.webContents.canGoBack();
      const canGoForward = view.webContents.canGoForward();
      mainWindow.webContents.send('nav-state-update', { url, canGoBack, canGoForward });
    }
  });

  view.webContents.on('did-navigate-in-page', (event, url) => {
    if (mainWindow && activeTabId === tabId) {
      const canGoBack = view.webContents.canGoBack();
      const canGoForward = view.webContents.canGoForward();
      mainWindow.webContents.send('nav-state-update', { url, canGoBack, canGoForward });
    }
  });

  // Open external links in same tab (handle target="_blank" etc.)
  view.webContents.setWindowOpenHandler(({ url }) => {
    // Send to renderer to open in new tab
    if (mainWindow) {
      mainWindow.webContents.send('open-new-tab', { url });
    }
    return { action: 'deny' };
  });

  // Handle certificate errors (just log, don't silently pass)
  view.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
    console.warn('[Security] Certificate error for', url, ':', error);
    callback(false); // Reject invalid certs
  });

  // navigate to url
  const resolvedUrl = resolveUrl(url);
  view.webContents.loadURL(resolvedUrl).catch(err => {
    console.error('[Navigation] Load error:', err.message);
  });

  return view;
}

// ─── URL resolver ─────────────────────────────────────────────────────────────
function resolveUrl(input) {
  if (!input || input.trim() === '') return 'void://newtab';
  input = input.trim();
  if (input === 'void://newtab' || input === 'void://settings') return input;
  if (input.startsWith('void://')) return input;
  // Already a valid URL
  if (/^https?:\/\//i.test(input)) return input;
  if (/^file:\/\//i.test(input)) return input;
  // Domain-like without protocol
  if (/^[\w-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(input)) return 'https://' + input;
  // Localhost
  if (/^localhost(:\d+)?(\/.*)?$/.test(input)) return 'http://' + input;
  // IP address
  if (/^\d{1,3}(\.\d{1,3}){3}/.test(input)) return 'http://' + input;
  // Search query
  const engines = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    google: 'https://www.google.com/search?q=',
    bing: 'https://www.bing.com/search?q=',
    brave: 'https://search.brave.com/search?q='
  };
  const engine = engines[config.search_engine] || engines.duckduckgo;
  return engine + encodeURIComponent(input);
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow && mainWindow.close());

// Tab: create
ipcMain.handle('tab-create', (event, { tabId, url }) => {
  const view = createBrowserView(tabId, url || config.homepage || 'void://newtab');
  return { tabId, url: view.webContents.getURL() };
});

// Tab: switch
ipcMain.on('tab-switch', (event, { tabId }) => {
  if (!mainWindow) return;

  // Hide all views
  for (const [id, view] of tabViews) {
    if (id !== tabId) {
      try { mainWindow.removeBrowserView(view); } catch (_) {}
    }
  }

  const view = tabViews.get(tabId);
  if (!view) return;

  activeTabId = tabId;
  mainWindow.setBrowserView(view);
  view.setBounds(getViewBounds());

  const url = view.webContents.getURL();
  const canGoBack = view.webContents.canGoBack();
  const canGoForward = view.webContents.canGoForward();
  mainWindow.webContents.send('nav-state-update', { url, canGoBack, canGoForward });
  mainWindow.webContents.send('block-count-update', tabBlockCounts.get(tabId) || 0);
});

// Tab: close
ipcMain.on('tab-close', (event, { tabId }) => {
  const view = tabViews.get(tabId);
  if (!view) return;
  webContentsToTabId.delete(view.webContents.id);
  try { mainWindow && mainWindow.removeBrowserView(view); } catch (_) {}
  view.webContents.destroy();
  tabViews.delete(tabId);
  tabBlockCounts.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
});

// Navigation
ipcMain.on('nav-go', (event, { tabId, url }) => {
  const view = tabViews.get(tabId);
  if (!view) return;
  const resolved = resolveUrl(url);
  view.webContents.loadURL(resolved).catch(err => {
    console.error('[Navigation]', err.message);
  });
});

ipcMain.on('nav-back', (event, { tabId }) => {
  const view = tabViews.get(tabId);
  if (view && view.webContents.canGoBack()) view.webContents.goBack();
});

ipcMain.on('nav-forward', (event, { tabId }) => {
  const view = tabViews.get(tabId);
  if (view && view.webContents.canGoForward()) view.webContents.goForward();
});

ipcMain.on('nav-reload', (event, { tabId }) => {
  const view = tabViews.get(tabId);
  if (view) view.webContents.reload();
});

ipcMain.on('nav-stop', (event, { tabId }) => {
  const view = tabViews.get(tabId);
  if (view) view.webContents.stop();
});

// Config
ipcMain.handle('get-config', () => {
  return { ...config };
});

ipcMain.handle('set-config', (event, updates) => {
  // Owner/repo are fixed for safety and should not be user-editable.
  const { updates_github_owner, updates_github_repo, ...safeUpdates } = updates || {};
  config = {
    ...config,
    ...safeUpdates,
    updates_github_owner: FIXED_UPDATE_OWNER,
    updates_github_repo: FIXED_UPDATE_REPO
  };
  saveConfig();
  // Apply relevant changes immediately
  if (updates.adblock_enabled !== undefined) {
    adblocker.setEnabled(updates.adblock_enabled);
  }
  if (
    updates.updates_enabled !== undefined ||
    updates.updates_auto_download !== undefined ||
    updates.updates_github_owner !== undefined ||
    updates.updates_github_repo !== undefined
  ) {
    setupAutoUpdater();
  }
  return { success: true };
});

// Downloads
ipcMain.handle('get-downloads', () => {
  return downloads.getDownloads();
});

ipcMain.on('download-cancel', (event, { id }) => {
  downloads.cancel(id);
});

ipcMain.on('open-downloads-folder', () => {
  shell.openPath(config.download_path || app.getPath('downloads'));
});

// Extensions
ipcMain.handle('get-extensions', () => {
  return extensions.getAll();
});

ipcMain.on('extension-toggle', (event, { id, enabled }) => {
  extensions.toggle(id, enabled);
});

ipcMain.on('extension-remove', (event, { id }) => {
  extensions.remove(id);
});

// Install .crx via drag & drop
ipcMain.handle('install-extension', async (event, { filePath }) => {
  try {
    const result = await extensions.install(filePath);
    return { success: true, extension: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open file dialog for extension install
ipcMain.handle('open-extension-dialog', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Install Extension',
    filters: [{ name: 'Chrome Extension', extensions: ['crx', 'zip'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Download path selector
ipcMain.handle('select-download-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Download Folder',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Adblocker: force update lists
ipcMain.handle('adblock-update', async () => {
  try {
    await adblocker.updateLists();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('updates-get-status', () => {
  return { ...updateStatus };
});

ipcMain.handle('updates-check', async () => {
  try {
    return await checkForUpdates('manual');
  } catch (err) {
    setUpdateStatus({
      state: 'error',
      message: err.message,
      progress: null,
      downloaded: false
    });
    return { success: false, error: err.message };
  }
});

ipcMain.handle('updates-install', () => {
  if (!app.isPackaged) {
    setUpdateStatus({
      state: 'disabled',
      message: 'Install update works only in the installed app build.',
      progress: null,
      downloaded: false
    });
    return { success: false, error: 'app-not-packaged' };
  }

  if (updateStatus.state !== 'downloaded') {
    setUpdateStatus({
      state: updateStatus.state,
      message: 'No downloaded update yet. Click Check now first.',
      progress: updateStatus.progress,
      downloaded: false
    });
    return { success: false, error: 'update-not-ready' };
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });

  return { success: true };
});

// Resize relay (when toolbar height changes)
ipcMain.on('toolbar-resize', (event, { height }) => {
  if (typeof height === 'number' && Number.isFinite(height)) {
    // Keep bounds sane and prevent accidental negative view heights.
    chromeHeight = Math.max(60, Math.min(220, Math.round(height)));
  }
  if (activeTabId === null) return;
  const view = tabViews.get(activeTabId);
  if (!view || !mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  view.setBounds({ x: 0, y: chromeHeight, width: w, height: Math.max(0, h - chromeHeight) });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
