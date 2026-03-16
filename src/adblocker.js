'use strict';

/**
 * Adblocker – network-level ad/tracker blocking via Electron webRequest API.
 * Downloads EasyList, EasyPrivacy, and Peter Lowe's list on startup.
 * Falls back to local assets/blocklist.txt if offline.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Remote filter lists to fetch
const REMOTE_LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext'
];

// Cached parsed rules directory
const CACHE_DIR_NAME = 'adblock_cache';

// Domains that must never be blocked to keep major sites functional.
const COMPAT_ALLOWLIST = [
  'youtube.com',
  'googlevideo.com',
  'ytimg.com',
  'googleusercontent.com',
  'gstatic.com',
  'accounts.google.com',
  'google.com',
  'twitch.tv',
  'ttvnw.net',
  'jtvnw.net',
  'amazonaws.com',
  'github.com',
  'api.github.com',
  'githubusercontent.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
];

class Adblocker {
  /**
   * @param {object} config - App config object
   * @param {string} fallbackPath - Path to local blocklist.txt
   */
  constructor(config, fallbackPath) {
    this.config = config;
    this.fallbackPath = fallbackPath;
    this.enabled = config.adblock_enabled !== false;
    // Set of blocked domain strings (exact domain match)
    this.blockedDomains = new Set();
    this.cacheDir = path.join(path.dirname(fallbackPath), '..', CACHE_DIR_NAME);
    this._onBlocked = null; // callback(tabId)
  }

  /**
   * Load filter lists – tries remote first, then cache, then fallback.
   */
  async initialize() {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch (_) {}

    if (this.config.adblock_online_update !== false) {
      await this._fetchAndCacheLists();
    } else {
      this._loadFromCache();
    }

    // Always merge the local fallback
    this._loadFallback();
    console.log(`[Adblocker] Loaded ${this.blockedDomains.size} domains.`);
  }

  /**
   * Force re-download of all remote lists.
   */
  async updateLists() {
    this.blockedDomains.clear();
    await this._fetchAndCacheLists();
    this._loadFallback();
    console.log(`[Adblocker] Updated. ${this.blockedDomains.size} domains loaded.`);
  }

  async _fetchAndCacheLists() {
    const fetches = REMOTE_LISTS.map((url, i) =>
      this._fetchList(url)
        .then(text => {
          const cachePath = path.join(this.cacheDir, `list_${i}.txt`);
          try { fs.writeFileSync(cachePath, text, 'utf8'); } catch (_) {}
          this._parseList(text);
        })
        .catch(err => {
          console.warn(`[Adblocker] Failed to fetch ${url}: ${err.message}. Trying cache.`);
          const cachePath = path.join(this.cacheDir, `list_${i}.txt`);
          if (fs.existsSync(cachePath)) {
            try {
              this._parseList(fs.readFileSync(cachePath, 'utf8'));
            } catch (e) {
              console.warn(`[Adblocker] Cache read error: ${e.message}`);
            }
          }
        })
    );
    await Promise.all(fetches);
  }

  _loadFromCache() {
    let found = false;
    for (let i = 0; i < REMOTE_LISTS.length; i++) {
      const cachePath = path.join(this.cacheDir, `list_${i}.txt`);
      if (fs.existsSync(cachePath)) {
        try {
          this._parseList(fs.readFileSync(cachePath, 'utf8'));
          found = true;
        } catch (e) {
          console.warn(`[Adblocker] Cache load error: ${e.message}`);
        }
      }
    }
    if (!found) {
      console.warn('[Adblocker] No cache found, using fallback only.');
    }
  }

  _loadFallback() {
    if (fs.existsSync(this.fallbackPath)) {
      try {
        this._parseList(fs.readFileSync(this.fallbackPath, 'utf8'));
      } catch (e) {
        console.warn(`[Adblocker] Fallback read error: ${e.message}`);
      }
    }
  }

  /**
   * Parse an Adblock Plus / hosts format filter list.
   * Supports domain rules, ||domain^, and hosts format (0.0.0.0 domain).
   */
  _parseList(text) {
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) continue;

      // Hosts format: 0.0.0.0 domain.com or 127.0.0.1 domain.com
      const hostsMatch = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([^\s#]+)/);
      if (hostsMatch) {
        const domain = hostsMatch[1].toLowerCase();
        if (domain && domain !== 'localhost' && !domain.includes('*.')) {
          this.blockedDomains.add(domain);
        }
        continue;
      }

      // ABP format: ||domain.com^
      if (line.startsWith('||')) {
        const rest = line.slice(2);
        const end = rest.search(/[\/\^\?\*\=]/);
        const domain = (end >= 0 ? rest.slice(0, end) : rest).toLowerCase();
        if (domain && !domain.includes(' ')) {
          this.blockedDomains.add(domain);
        }
        continue;
      }

      // We intentionally ignore generic pattern lines because loose substring
      // matching causes false positives and can break normal site CSS/JS.
    }
  }

  /**
   * Check if a URL should be blocked.
   * @param {string} url
   * @returns {boolean}
   */
  shouldBlock(url) {
    if (!this.enabled) return false;
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

      // Keep core media/auth endpoints available.
      for (const allowed of COMPAT_ALLOWLIST) {
        if (hostname === allowed || hostname.endsWith(`.${allowed}`)) {
          return false;
        }
      }

      // Exact domain match
      if (this.blockedDomains.has(hostname)) return true;

      // Subdomain match (e.g. ads.example.com → blocked if example.com blocked)
      const parts = hostname.split('.');
      for (let i = 1; i < parts.length - 1; i++) {
        if (this.blockedDomains.has(parts.slice(i).join('.'))) return true;
      }

    } catch (_) {
      // Invalid URL – let it through
    }
    return false;
  }

  /**
   * Attach to an Electron session's webRequest API.
   * @param {Electron.Session} sess
   * @param {function} onBlocked - callback when a request is blocked
   */
  attachToSession(sess, onBlocked) {
    this._onBlocked = onBlocked;

    // We need the tab ID from the webContents. We map webContentsId → tabId via
    // the 'tab-switch' flow, but for simplicity we use webContentsId as tabId here.
    sess.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        if (!this.enabled) {
          callback({ cancel: false });
          return;
        }

        // Never block top-level document loads or nested frames (prevents
        // login/consent/video-player breakage on sites like YouTube/Twitch).
        if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
          callback({ cancel: false });
          return;
        }

        if (this.shouldBlock(details.url)) {
          if (this._onBlocked) {
            this._onBlocked(details.webContentsId);
          }
          callback({ cancel: true });
        } else {
          callback({ cancel: false });
        }
      }
    );
  }

  setEnabled(val) {
    this.enabled = val;
  }

  /**
   * Fetch a remote list over HTTPS/HTTP with a 10s timeout.
   * @param {string} url
   * @returns {Promise<string>}
   */
  _fetchList(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', reject);
    });
  }
}

module.exports = Adblocker;



