'use strict';

/**
 * AI module – interfaces with Ollama (http://localhost:11434) for local LLM queries.
 * Detects if Ollama is running, lists models, and streams/returns completions.
 */

const http = require('http');

const OLLAMA_BASE = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';

class AI {
  /**
   * @param {object} config - App config (ai_model, ai_enabled)
   */
  constructor(config) {
    this.config = config;
    this.conversationHistory = []; // Simple in-memory history (cleared on restart)
  }

  /**
   * Check if Ollama is reachable.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return new Promise((resolve) => {
      const req = http.get(`${OLLAMA_BASE}/api/tags`, { timeout: 3000 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  /**
   * Get list of installed Ollama models.
   * @returns {Promise<string[]>} model names
   */
  async getModels() {
    return new Promise((resolve, reject) => {
      const req = http.get(`${OLLAMA_BASE}/api/tags`, { timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Ollama returned HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const names = (data.models || []).map(m => m.name);
            resolve(names);
          } catch (e) {
            reject(new Error('Failed to parse Ollama models response'));
          }
        });
        res.on('error', reject);
      });
      req.on('error', (err) => reject(new Error('Ollama not reachable: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama connection timeout')); });
    });
  }

  /**
   * Send a query to Ollama and return the full response text.
   * @param {string} prompt - User question or text
   * @param {string} [context] - Optional selected text or page context
   * @returns {Promise<string>}
   */
  async query(prompt, context) {
    if (!this.config.ai_enabled) {
      throw new Error('AI is disabled. Enable it in Settings.');
    }

    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        'Ollama is not running. To use AI features:\n' +
        '1. Download Ollama from https://ollama.ai\n' +
        '2. Install and run: ollama serve\n' +
        '3. Pull a model: ollama pull llama3\n' +
        'Then restart VoidBrowser.'
      );
    }

    const model = this.config.ai_model || DEFAULT_MODEL;

    // Build message with optional context
    let fullPrompt = prompt;
    if (context && context.trim()) {
      fullPrompt = `Context from webpage:\n"""\n${context.trim()}\n"""\n\nQuestion: ${prompt}`;
    }

    // Add to conversation history
    this.conversationHistory.push({ role: 'user', content: fullPrompt });

    const body = JSON.stringify({
      model,
      messages: this.conversationHistory,
      stream: false
    });

    const response = await this._post('/api/chat', body);

    // Extract assistant reply
    const reply = response?.message?.content || response?.response || '';
    if (reply) {
      this.conversationHistory.push({ role: 'assistant', content: reply });
    }

    // Keep history from growing unbounded (last 20 turns)
    if (this.conversationHistory.length > 40) {
      this.conversationHistory = this.conversationHistory.slice(-40);
    }

    return reply;
  }

  /**
   * Clear conversation history.
   */
  clearHistory() {
    this.conversationHistory = [];
  }

  /**
   * POST JSON to Ollama API.
   * @param {string} endpoint
   * @param {string} body - JSON string
   * @returns {Promise<object>}
   */
  _post(endpoint, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: 11434,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 120000  // 2 min – LLM can be slow
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama API error: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('Failed to parse Ollama response: ' + e.message));
          }
        });
        res.on('error', reject);
      });

      req.on('error', (err) => reject(new Error('Ollama request failed: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timed out after 120s')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = AI;
