'use strict';

/**
 * Downloads module – intercepts Electron download events, tracks progress,
 * relays updates to the UI, and auto-shows a download bar.
 */

const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

class Downloads {
  /**
   * @param {object} config - App config (download_path)
   */
  constructor(config) {
    this.config = config;
    // Active + recent downloads: Map<id, DownloadItem>
    this.downloads = new Map();
    this._uiCallback = null;
    this._cleanupTimers = new Map();
  }

  /**
   * Set callback that sends updates to the renderer.
   * @param {function} cb - (downloadData) => void
   */
  setUICallback(cb) {
    this._uiCallback = cb;
  }

  /**
   * Attach download listener to an Electron session.
   * @param {Electron.Session} sess
   */
  attach(sess) {
    sess.on('will-download', (event, item, webContents) => {
      const id = crypto.randomUUID();
      const savePath = path.join(
        this.config.download_path || app.getPath('downloads'),
        item.getFilename()
      );

      item.setSavePath(savePath);

      const record = {
        id,
        filename: item.getFilename(),
        url: item.getURL(),
        savePath,
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        speed: 0,           // bytes/sec
        state: 'progressing',
        startTime: Date.now(),
        lastUpdate: Date.now(),
        lastBytes: 0
      };

      this.downloads.set(id, record);
      this._notify();

      item.on('updated', (event, state) => {
        const now = Date.now();
        const rec = this.downloads.get(id);
        if (!rec) return;

        const elapsed = (now - rec.lastUpdate) / 1000;
        const byteDelta = item.getReceivedBytes() - rec.lastBytes;
        const speed = elapsed > 0 ? byteDelta / elapsed : 0;

        rec.receivedBytes = item.getReceivedBytes();
        rec.totalBytes = item.getTotalBytes();
        rec.speed = Math.round(speed);
        rec.state = state; // 'progressing' | 'interrupted'
        rec.lastUpdate = now;
        rec.lastBytes = rec.receivedBytes;

        this._notify();
      });

      item.once('done', (event, state) => {
        const rec = this.downloads.get(id);
        if (!rec) return;

        rec.state = state; // 'completed' | 'cancelled' | 'interrupted'
        rec.receivedBytes = rec.totalBytes;
        rec.speed = 0;
        this._notify();

        // Auto-hide completed download after 5 seconds
        if (state === 'completed') {
          const timer = setTimeout(() => {
            this.downloads.delete(id);
            this._cleanupTimers.delete(id);
            this._notify();
          }, 5000);
          this._cleanupTimers.set(id, timer);
        }
      });
    });
  }

  /**
   * Return current download list for the UI.
   */
  getDownloads() {
    return Array.from(this.downloads.values());
  }

  /**
   * Cancel / remove a download by ID.
   * Note: We can't cancel via DownloadItem after the fact, so just remove from list.
   * @param {string} id
   */
  cancel(id) {
    const timer = this._cleanupTimers.get(id);
    if (timer) { clearTimeout(timer); this._cleanupTimers.delete(id); }
    this.downloads.delete(id);
    this._notify();
  }

  _notify() {
    if (this._uiCallback) {
      this._uiCallback(Array.from(this.downloads.values()));
    }
  }

  /**
   * Format bytes to human-readable string.
   * @param {number} bytes
   */
  static formatSize(bytes) {
    if (bytes <= 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  }
}

module.exports = Downloads;
