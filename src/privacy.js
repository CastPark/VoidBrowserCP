'use strict';

/**
 * Privacy module – User-Agent randomization and session isolation helpers.
 * Ensures no fingerprinting via consistent UA; cookies cleared on exit in main.js.
 */

// Pool of realistic Windows 11 + Chrome user agents to rotate between
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
];

class Privacy {
  /**
   * @param {object} config
   */
  constructor(config) {
    this.config = config;
    // Pick one UA per session (not per request – more realistic)
    this.sessionUA = this._pickUA();
  }

  _pickUA() {
    const idx = Math.floor(Math.random() * USER_AGENTS.length);
    return USER_AGENTS[idx];
  }

  /**
   * Override the User-Agent for all requests in the given session.
   * @param {Electron.Session} sess
   */
  applyUserAgent(sess) {
    if (!this.config.user_agent_randomize) return;
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      headers['User-Agent'] = this.sessionUA;
      // Remove telemetry-related headers
      delete headers['x-client-data'];
      delete headers['X-Client-Data'];
      callback({ requestHeaders: headers });
    });
    console.log('[Privacy] User-Agent set to:', this.sessionUA);
  }

  getSessionUA() {
    return this.sessionUA;
  }
}

module.exports = Privacy;
