'use strict';

/**
 * browser.js – the entire renderer-side logic for VoidBrowser.
 * Handles tabs, navigation, command bar, AI sidebar, downloads, extensions.
 */

// ─── State ─────────────────────────────────────────────────────────────────
const api = window.voidAPI;

let config = {};
let tabs = [];        // [{ id, title, url, favicon, loading, active }]
let activeTabId = null;
let tabIdCounter = 0;
let dragSrcTabId = null;  // for drag-and-drop reorder
let baseChromeHeight = 82;
let isAdblockMenuOpen = false;
let isExtensionsMenuOpen = false;

// ─── Init ──────────────────────────────────────────────────────────────────
async function init() {
  config = await api.config.get();
  bindWindowControls();
  bindNavButtons();
  bindTabBar();
  bindAdblockMenu();
  bindExtensionsMenu();
  bindAddressBar();
  bindCommandBar();
  bindDownloads();
  bindKeyboard();
  registerIPCListeners();
  renderExtensions();
  syncChromeHeight();
  window.addEventListener('resize', syncChromeHeight);
  // Re-sync after initial layout/paint to avoid first-frame clipping.
  setTimeout(syncChromeHeight, 50);
  setTimeout(syncChromeHeight, 200);
  // Open the first tab
  await createTab(config.homepage || 'void://newtab');
}

function syncChromeHeight() {
  const titlebar = document.getElementById('titlebar');
  const toolbar = document.getElementById('toolbar');
  if (!titlebar || !toolbar) return;
  const total = titlebar.offsetHeight + toolbar.offsetHeight;
  if (Number.isFinite(total) && total > 0) {
    baseChromeHeight = total;
    applyChromeInsetForMenus();
  }
}

function applyChromeInsetForMenus() {
  const extra = (isAdblockMenuOpen || isExtensionsMenuOpen) ? 230 : 0;
  api.ui.setToolbarHeight(baseChromeHeight + extra);
}

function closeOverlayMenus() {
  const adblock = document.getElementById('adblock-popover');
  const ext = document.getElementById('extensions-popover');
  const adblockBtn = document.getElementById('adblock-badge');
  const extBtn = document.getElementById('btn-extensions');

  if (adblock) adblock.classList.add('hidden');
  if (ext) ext.classList.add('hidden');

  isAdblockMenuOpen = false;
  isExtensionsMenuOpen = false;

  if (adblockBtn) {
    adblockBtn.classList.remove('active');
    adblockBtn.setAttribute('aria-expanded', 'false');
  }

  if (extBtn) {
    extBtn.classList.remove('active');
    extBtn.setAttribute('aria-expanded', 'false');
  }

  applyChromeInsetForMenus();
}

// ─── Window Controls ───────────────────────────────────────────────────────
function bindWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', () => api.window.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => api.window.maximize());
  document.getElementById('btn-close').addEventListener('click', () => api.window.close());
}

// ─── Navigation ────────────────────────────────────────────────────────────
function bindNavButtons() {
  document.getElementById('btn-back').addEventListener('click', () => {
    if (activeTabId !== null) api.nav.back(activeTabId);
  });
  document.getElementById('btn-forward').addEventListener('click', () => {
    if (activeTabId !== null) api.nav.forward(activeTabId);
  });
  document.getElementById('btn-reload').addEventListener('click', () => {
    if (activeTabId === null) return;
    const tab = getTab(activeTabId);
    if (tab && tab.loading) {
      api.nav.stop(activeTabId);
    } else {
      api.nav.reload(activeTabId);
    }
  });
}

function bindAdblockMenu() {
  const badge = document.getElementById('adblock-badge');
  const popover = document.getElementById('adblock-popover');
  const enabledToggle = document.getElementById('adblock-enabled-toggle');
  const autoUpdateToggle = document.getElementById('adblock-update-toggle');
  const countEl = document.getElementById('adblock-popover-count');
  const refreshBtn = document.getElementById('btn-adblock-refresh');
  const settingsBtn = document.getElementById('btn-adblock-settings');

  function syncAdblockMenu() {
    const blockedCount = document.getElementById('block-count').textContent || '0';
    enabledToggle.checked = config.adblock_enabled !== false;
    autoUpdateToggle.checked = config.adblock_online_update !== false;
    countEl.textContent = `${blockedCount} blocked`;
  }

  badge.addEventListener('click', (event) => {
    event.stopPropagation();
    syncAdblockMenu();
    const willOpen = popover.classList.contains('hidden');
    closeOverlayMenus();
    popover.classList.toggle('hidden', !willOpen);
    badge.classList.toggle('active', willOpen);
    badge.setAttribute('aria-expanded', String(willOpen));
    isAdblockMenuOpen = willOpen;
    applyChromeInsetForMenus();
  });

  popover.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  document.addEventListener('click', () => closeOverlayMenus());

  enabledToggle.addEventListener('change', async () => {
    config.adblock_enabled = enabledToggle.checked;
    await api.config.set({ adblock_enabled: config.adblock_enabled });
    syncAdblockMenu();
  });

  autoUpdateToggle.addEventListener('change', async () => {
    config.adblock_online_update = autoUpdateToggle.checked;
    await api.config.set({ adblock_online_update: config.adblock_online_update });
    syncAdblockMenu();
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Updating…';
    const result = await api.adblock.update();
    refreshBtn.textContent = result.success ? 'Updated' : 'Failed';
    setTimeout(() => {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Update lists';
    }, 1800);
  });

  settingsBtn.addEventListener('click', () => {
    closeOverlayMenus();
    createTab('void://settings');
  });

  syncAdblockMenu();
}

function bindExtensionsMenu() {
  const btn = document.getElementById('btn-extensions');
  const popover = document.getElementById('extensions-popover');
  const settingsBtn = document.getElementById('btn-extensions-settings');

  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const willOpen = popover.classList.contains('hidden');
    closeOverlayMenus();

    if (!willOpen) return;

    await renderExtensions();
    popover.classList.remove('hidden');
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
    isExtensionsMenuOpen = true;
    applyChromeInsetForMenus();
  });

  popover.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  settingsBtn.addEventListener('click', () => {
    closeOverlayMenus();
    createTab('void://settings');
  });
}

// ─── Address Bar ────────────────────────────────────────────────────────────
function bindAddressBar() {
  const bar = document.getElementById('addressbar');

  bar.addEventListener('focus', () => bar.select());

  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateTo(bar.value);
      bar.blur();
    }
    if (e.key === 'Escape') {
      bar.blur();
      restoreAddressBar();
    }
  });
}

function navigateTo(input) {
  if (activeTabId === null) return;
  api.nav.go(activeTabId, input);
}

function updateAddressBar(url) {
  const bar = document.getElementById('addressbar');
  const lockIcon = document.getElementById('lock-icon');
  const siteFavicon = document.getElementById('site-favicon');

  if (document.activeElement !== bar) {
    bar.value = url === 'void://newtab' ? '' : url;
  }

  // Show/hide lock icon
  if (url.startsWith('https://') || url.startsWith('void://')) {
    lockIcon.classList.add('visible');
  } else {
    lockIcon.classList.remove('visible');
  }

  // Show favicon
  const tab = getTab(activeTabId);
  siteFavicon.innerHTML = '';
  if (tab && tab.favicon) {
    const img = document.createElement('img');
    img.src = tab.favicon;
    img.width = 14;
    img.height = 14;
    img.addEventListener('error', () => { siteFavicon.innerHTML = ''; });
    siteFavicon.appendChild(img);
  }
}

function restoreAddressBar() {
  const tab = getTab(activeTabId);
  const bar = document.getElementById('addressbar');
  if (tab) {
    bar.value = tab.url === 'void://newtab' ? '' : tab.url;
  }
}

// ─── Tab System ─────────────────────────────────────────────────────────────
function bindTabBar() {
  document.getElementById('btn-new-tab').addEventListener('click', () => {
    createTab('void://newtab');
  });
}

async function createTab(url) {
  tabIdCounter++;
  const tabId = tabIdCounter;

  const tab = {
    id: tabId,
    title: 'New Tab',
    url: url || 'void://newtab',
    favicon: null,
    loading: false,
    active: false
  };
  tabs.push(tab);

  // Tell main process to create the BrowserView
  await api.tabs.create(tabId, url);

  // Switch to this tab
  switchToTab(tabId);
  renderTabs();
  return tab;
}

function switchToTab(tabId) {
  tabs.forEach(t => { t.active = t.id === tabId; });
  activeTabId = tabId;
  api.tabs.switch(tabId);
  renderTabs();

  // Update address bar
  const tab = getTab(tabId);
  if (tab) {
    updateAddressBar(tab.url);
    updateReloadButton(tab.loading);
  }

  // Reset block count display
  document.getElementById('block-count').textContent = '0';
}

function closeTab(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  api.tabs.close(tabId);
  tabs.splice(idx, 1);

  // If no tabs left, open a new one
  if (tabs.length === 0) {
    createTab('void://newtab');
    return;
  }

  // If we closed the active tab, switch to the nearest one
  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    switchToTab(tabs[newIdx].id);
  }

  renderTabs();
}

function renderTabs() {
  const container = document.getElementById('tabs-container');
  container.innerHTML = '';

  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.active ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', tab.active);
    el.draggable = true;

    // Favicon or spinner
    if (tab.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'tab-spinner';
      el.appendChild(spinner);
    } else if (tab.favicon) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = tab.favicon;
      img.alt = '';
      img.addEventListener('error', () => { img.replaceWith(makeFaviconPlaceholder()); });
      el.appendChild(img);
    } else {
      el.appendChild(makeFaviconPlaceholder());
    }

    // Title
    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title || 'Loading…';
    el.appendChild(titleEl);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '×';
    closeBtn.title = 'Close tab';
    closeBtn.setAttribute('aria-label', 'Close tab');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    // Switch on click
    el.addEventListener('click', () => switchToTab(tab.id));

    // Middle-click to close
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
    });

    // Drag & drop reorder
    el.addEventListener('dragstart', (e) => {
      dragSrcTabId = tab.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (dragSrcTabId !== null && dragSrcTabId !== tab.id) {
        reorderTabs(dragSrcTabId, tab.id);
      }
      dragSrcTabId = null;
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('drag-over');
      dragSrcTabId = null;
    });

    container.appendChild(el);
  });
}

function makeFaviconPlaceholder() {
  const div = document.createElement('div');
  div.className = 'tab-favicon-placeholder';
  return div;
}

function reorderTabs(srcId, targetId) {
  const srcIdx = tabs.findIndex(t => t.id === srcId);
  const tgtIdx = tabs.findIndex(t => t.id === targetId);
  if (srcIdx === -1 || tgtIdx === -1) return;
  const [moved] = tabs.splice(srcIdx, 1);
  tabs.splice(tgtIdx, 0, moved);
  renderTabs();
}

function getTab(id) {
  return tabs.find(t => t.id === id) || null;
}

// ─── Command Bar ───────────────────────────────────────────────────────────
function bindCommandBar() {
  const overlay  = document.getElementById('command-bar-overlay');
  const input    = document.getElementById('command-input');
  const suggestEl = document.getElementById('command-suggestions');
  let suggestionFocus = -1;

  function openCommandBar(prefill) {
    overlay.classList.remove('hidden');
    input.value = prefill || '';
    input.focus();
    renderSuggestions('');
  }

  function closeCommandBar() {
    overlay.classList.add('hidden');
    input.value = '';
    suggestEl.innerHTML = '';
    suggestionFocus = -1;
  }

  // Expose so keyboard shortcut can use it
  window._openCommandBar = openCommandBar;

  input.addEventListener('input', () => {
    renderSuggestions(input.value);
    suggestionFocus = -1;
  });

  input.addEventListener('keydown', (e) => {
    const items = suggestEl.querySelectorAll('.cmd-suggestion');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suggestionFocus = Math.min(suggestionFocus + 1, items.length - 1);
      highlightSuggestion(items, suggestionFocus);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      suggestionFocus = Math.max(suggestionFocus - 1, -1);
      highlightSuggestion(items, suggestionFocus);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestionFocus >= 0 && items[suggestionFocus]) {
        items[suggestionFocus].click();
      } else {
        handleCommandSubmit(input.value);
      }
    } else if (e.key === 'Escape') {
      closeCommandBar();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommandBar();
  });

  function highlightSuggestion(items, idx) {
    items.forEach((el, i) => el.classList.toggle('focused', i === idx));
  }

  function handleCommandSubmit(value) {
    const trimmed = value.trim();
    closeCommandBar();
    if (!trimmed) return;
    navigateTo(trimmed);
  }

  function renderSuggestions(val) {
    suggestEl.innerHTML = '';
    if (!val.trim()) {
      const defaults = [
        { icon: '🏠', title: 'New Tab', sub: 'void://newtab', action: () => createTab('void://newtab') },
        { icon: '⚙️', title: 'Settings', sub: 'void://settings', action: () => navigateTo('void://settings') }
      ];
      defaults.forEach(d => suggestEl.appendChild(makeSuggestionEl(d.icon, d.title, d.sub, d.action)));
      return;
    }

    // URL suggestion
    if (/^https?:\/\//i.test(val) || /^[\w-]+\.\w/i.test(val)) {
      const url = /^https?:\/\//i.test(val) ? val : 'https://' + val;
      suggestEl.appendChild(makeSuggestionWithSVG(
        '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 6h10M6 1C4.5 3 4 5 4 6s.5 3 2 5M6 1c1.5 2 2 4 2 5s-.5 3-2 5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
        'Navigate to ' + url, url,
        () => { closeCommandBar(); navigateTo(url); }
      ));
    }

    // Search suggestion
    const searchEngineNames = { duckduckgo: 'DuckDuckGo', google: 'Google', bing: 'Bing', brave: 'Brave' };
    const engineName = searchEngineNames[config.search_engine] || 'DuckDuckGo';
    suggestEl.appendChild(makeSuggestionWithSVG(
      '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="8" y1="8" x2="11" y2="11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
      `Search ${engineName}: "${val}"`, 'Web search',
      () => { closeCommandBar(); navigateTo(val); }
    ));

  }

  function makeSuggestionEl(iconText, title, sub, action) {
    const el = document.createElement('div');
    el.className = 'cmd-suggestion';
    el.innerHTML = `
      <div class="cmd-suggestion-icon">${iconText}</div>
      <div class="cmd-suggestion-text">
        <div class="cmd-suggestion-title">${escapeHtml(title)}</div>
        <div class="cmd-suggestion-sub">${escapeHtml(sub)}</div>
      </div>`;
    el.addEventListener('click', action);
    return el;
  }

  function makeSuggestionWithSVG(svgHtml, title, sub, action) {
    const el = document.createElement('div');
    el.className = 'cmd-suggestion';
    el.innerHTML = `
      <div class="cmd-suggestion-icon">${svgHtml}</div>
      <div class="cmd-suggestion-text">
        <div class="cmd-suggestion-title">${escapeHtml(title)}</div>
        <div class="cmd-suggestion-sub">${escapeHtml(sub)}</div>
      </div>`;
    el.addEventListener('click', action);
    return el;
  }
}

// ─── Downloads ─────────────────────────────────────────────────────────────
function bindDownloads() {
  document.getElementById('btn-downloads-close').addEventListener('click', () => {
    document.getElementById('download-bar').classList.add('hidden');
  });
  document.getElementById('btn-downloads-folder').addEventListener('click', () => {
    api.downloads.openFolder();
  });
}

function renderDownloads(list) {
  const bar = document.getElementById('download-bar');
  const listEl = document.getElementById('download-list');

  if (!list || list.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  listEl.innerHTML = '';

  list.forEach(dl => {
    const pct = dl.totalBytes > 0 ? Math.round((dl.receivedBytes / dl.totalBytes) * 100) : 0;
    const speed = dl.speed > 0 ? formatSize(dl.speed) + '/s' : '';
    const stateLabel = dl.state === 'completed' ? '✓' : (dl.state === 'interrupted' ? '✗' : `${pct}%`);

    const item = document.createElement('div');
    item.className = 'download-item' + (dl.state === 'completed' ? ' completed' : '');
    item.innerHTML = `
      <span class="download-name" title="${escapeHtml(dl.savePath)}">${escapeHtml(dl.filename)}</span>
      <div class="download-progress-wrap">
        <div class="download-progress-bar" style="width:${pct}%"></div>
      </div>
      <span class="download-meta">${speed || stateLabel}</span>`;
    listEl.appendChild(item);
  });
}

// ─── Extensions ────────────────────────────────────────────────────────────
async function renderExtensions() {
  const menuList = document.getElementById('extensions-menu-list');
  const countBadge = document.getElementById('extensions-count');
  const countLabel = document.getElementById('extensions-popover-count');
  if (!menuList || !countBadge || !countLabel) return;

  menuList.innerHTML = '';
  const exts = await api.extensions.getAll();

  const enabled = exts.filter(e => e.enabled);
  countLabel.textContent = `${enabled.length} active`;

  if (enabled.length > 0) {
    countBadge.classList.remove('hidden');
    countBadge.textContent = String(enabled.length);
  } else {
    countBadge.classList.add('hidden');
  }

  if (enabled.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ext-menu-empty';
    empty.textContent = 'No active extensions';
    menuList.appendChild(empty);
    return;
  }

  enabled.forEach(ext => {
    const row = document.createElement('div');
    row.className = 'ext-menu-item';
    row.title = ext.name;

    const iconWrap = document.createElement('span');
    iconWrap.className = 'ext-menu-icon';

    if (ext.iconPath) {
      const img = document.createElement('img');
      img.src = 'file://' + ext.iconPath;
      img.alt = ext.name;
      img.addEventListener('error', () => { iconWrap.textContent = ext.name[0] || '?'; });
      iconWrap.appendChild(img);
    } else {
      iconWrap.textContent = ext.name[0] || '?';
    }

    const name = document.createElement('span');
    name.className = 'ext-menu-name';
    name.textContent = ext.name;

    row.appendChild(iconWrap);
    row.appendChild(name);
    menuList.appendChild(row);
  });
}

// ─── IPC Event listeners ────────────────────────────────────────────────────
function registerIPCListeners() {
  api.on('tab-updated', ({ tabId, url, title, loading, canGoBack, canGoForward }) => {
    const tab = getTab(tabId);
    if (!tab) return;
    tab.url = url;
    tab.title = title || 'Loading…';
    tab.loading = loading;
    renderTabs();
    if (activeTabId === tabId) {
      updateAddressBar(url);
      updateNavButtons(canGoBack, canGoForward);
      updateReloadButton(loading);
    }
  });

  api.on('tab-loading', ({ tabId, loading }) => {
    const tab = getTab(tabId);
    if (!tab) return;
    tab.loading = loading;
    renderTabs();
    if (activeTabId === tabId) {
      updateReloadButton(loading);
    }
  });

  api.on('tab-title-updated', ({ tabId, title }) => {
    const tab = getTab(tabId);
    if (tab) { tab.title = title; renderTabs(); }
  });

  api.on('tab-favicon-updated', ({ tabId, favicon }) => {
    const tab = getTab(tabId);
    if (tab) {
      tab.favicon = favicon;
      renderTabs();
      if (activeTabId === tabId) {
        updateAddressBar(tab.url);
      }
    }
  });

  api.on('nav-state-update', ({ url, canGoBack, canGoForward }) => {
    updateAddressBar(url);
    updateNavButtons(canGoBack, canGoForward);
  });

  api.on('block-count-update', (count) => {
    document.getElementById('block-count').textContent = count;
    const popoverCount = document.getElementById('adblock-popover-count');
    if (popoverCount) {
      popoverCount.textContent = `${count} blocked`;
    }
  });

  api.on('download-update', (list) => {
    renderDownloads(list);
  });

  api.on('open-new-tab', ({ url }) => {
    createTab(url);
  });
}

// ─── Nav button state ──────────────────────────────────────────────────────
function updateNavButtons(canGoBack, canGoForward) {
  document.getElementById('btn-back').disabled = !canGoBack;
  document.getElementById('btn-forward').disabled = !canGoForward;
}

function updateReloadButton(loading) {
  const btn = document.getElementById('btn-reload');
  if (loading) {
    btn.title = 'Stop loading';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  } else {
    btn.title = 'Reload';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M12 7A5 5 0 1 1 9.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><polyline points="10,1 10,4 13,4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
}

// ─── Keyboard shortcuts ─────────────────────────────────────────────────────
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;

    // Ctrl+L – command bar / address bar
    if (ctrl && e.key === 'l') {
      e.preventDefault();
      window._openCommandBar && window._openCommandBar();
      return;
    }

    // Ctrl+T – new tab
    if (ctrl && e.key === 't') {
      e.preventDefault();
      createTab('void://newtab');
      return;
    }

    // Ctrl+W – close tab
    if (ctrl && e.key === 'w') {
      e.preventDefault();
      if (activeTabId !== null) closeTab(activeTabId);
      return;
    }

    // Ctrl+R / F5 – reload
    if ((ctrl && e.key === 'r') || e.key === 'F5') {
      e.preventDefault();
      if (activeTabId !== null) api.nav.reload(activeTabId);
      return;
    }

    // Ctrl+Tab – next tab
    if (ctrl && e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      cycleTab(1);
      return;
    }

    // Ctrl+Shift+Tab – prev tab
    if (ctrl && e.shiftKey && e.key === 'Tab') {
      e.preventDefault();
      cycleTab(-1);
      return;
    }

    // Alt+Left – back
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      if (activeTabId !== null) api.nav.back(activeTabId);
      return;
    }

    // Alt+Right – forward
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      if (activeTabId !== null) api.nav.forward(activeTabId);
      return;
    }

    // Ctrl+, – settings
    if (ctrl && e.key === ',') {
      e.preventDefault();
      createTab('void://settings');
      return;
    }
  });

  // Address bar shortcut via click on toolbar address area
  document.getElementById('addressbar').addEventListener('click', () => {
    document.getElementById('addressbar').select();
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', () => {
    createTab('void://settings');
  });
}

function cycleTab(direction) {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex(t => t.id === activeTabId);
  const next = (idx + direction + tabs.length) % tabs.length;
  switchToTab(tabs[next].id);
}

// ─── Utility ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatSize(bytes) {
  if (bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

// ─── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
