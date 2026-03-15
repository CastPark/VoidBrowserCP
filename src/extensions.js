'use strict';

/**
 * Extensions module – manages Chrome extension (.crx / .zip) installation,
 * listing, toggling, and removal. Extensions are stored in an "extensions/" folder.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// AdmZip is used to unpack .crx/.zip extension archives
let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (_) {
  AdmZip = null;
}

class Extensions {
  /**
   * @param {object} config - App config
   * @param {string} extensionsDir - Path to store installed extensions
   */
  constructor(config, extensionsDir) {
    this.config = config;
    this.dir = extensionsDir;
    this.metaPath = path.join(extensionsDir, 'extensions.json');
    this.extensions = {};
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (_) {}

    if (fs.existsSync(this.metaPath)) {
      try {
        this.extensions = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      } catch (e) {
        console.error('[Extensions] Failed to parse metadata:', e.message);
        this.extensions = {};
      }
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify(this.extensions, null, 2), 'utf8');
    } catch (e) {
      console.error('[Extensions] Failed to save metadata:', e.message);
    }
  }

  /**
   * Install a .crx or .zip extension from a file path.
   * Unpacks it and reads manifest.json for metadata.
   * @param {string} filePath - Path to .crx / .zip file
   * @returns {{ id, name, version, description, enabled, iconUrl }}
   */
  async install(filePath) {
    if (!AdmZip) {
      throw new Error('AdmZip is not installed. Run: npm install adm-zip');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.crx' && ext !== '.zip') {
      throw new Error('Only .crx and .zip extension files are supported.');
    }

    let fileBuffer = fs.readFileSync(filePath);

    // .crx files have a header that must be stripped before unzipping
    if (ext === '.crx') {
      fileBuffer = this._stripCrxHeader(fileBuffer);
    }

    // Generate a unique ID from file contents
    const id = crypto.createHash('sha1').update(fileBuffer).digest('hex').slice(0, 16);

    const destDir = path.join(this.dir, id);
    if (fs.existsSync(destDir)) {
      throw new Error(`Extension with ID ${id} is already installed.`);
    }

    fs.mkdirSync(destDir, { recursive: true });

    const zip = new AdmZip(fileBuffer);
    zip.extractAllTo(destDir, true);

    // Read manifest
    const manifestPath = path.join(destDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      // Cleanup on failure
      fs.rmSync(destDir, { recursive: true, force: true });
      throw new Error('Invalid extension: manifest.json not found.');
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      fs.rmSync(destDir, { recursive: true, force: true });
      throw new Error('Invalid extension: cannot parse manifest.json.');
    }

    // Extract icon path (try 128 → 64 → 48 → 32 → 16)
    let iconUrl = null;
    if (manifest.icons) {
      const sizes = ['128', '64', '48', '32', '16'];
      for (const size of sizes) {
        if (manifest.icons[size]) {
          iconUrl = path.join(destDir, manifest.icons[size]);
          break;
        }
      }
    }

    const meta = {
      id,
      name: manifest.name || path.basename(filePath),
      version: manifest.version || '?',
      description: manifest.description || '',
      enabled: true,
      path: destDir,
      iconPath: iconUrl
    };

    this.extensions[id] = meta;
    this._save();

    console.log(`[Extensions] Installed: ${meta.name} v${meta.version} (${id})`);
    return meta;
  }

  /**
   * Strip the CRX2/CRX3 binary header to expose the underlying ZIP data.
   * @param {Buffer} buf
   * @returns {Buffer}
   */
  _stripCrxHeader(buf) {
    // CRX2: magic 'Cr24' + version(4) + pubkey_len(4) + sig_len(4) + ...
    // CRX3: magic 'Cr24' + version(4) + header_size(4) + ...
    if (buf.readUInt32LE(0) !== 0x34327243) { // 'Cr24' little-endian
      return buf; // Not a CRX, treat as ZIP
    }
    const crxVersion = buf.readUInt32LE(4);
    if (crxVersion === 2) {
      const pubKeyLen = buf.readUInt32LE(8);
      const sigLen = buf.readUInt32LE(12);
      return buf.slice(16 + pubKeyLen + sigLen);
    } else if (crxVersion === 3) {
      const headerSize = buf.readUInt32LE(8);
      return buf.slice(12 + headerSize);
    }
    return buf;
  }

  /**
   * Return all installed extensions as an array.
   */
  getAll() {
    return Object.values(this.extensions);
  }

  /**
   * Toggle an extension enabled/disabled.
   * @param {string} id
   * @param {boolean} enabled
   */
  toggle(id, enabled) {
    if (this.extensions[id]) {
      this.extensions[id].enabled = enabled;
      this._save();
    }
  }

  /**
   * Remove an extension and delete its files.
   * @param {string} id
   */
  remove(id) {
    const ext = this.extensions[id];
    if (!ext) return;
    if (fs.existsSync(ext.path)) {
      try {
        fs.rmSync(ext.path, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[Extensions] Could not delete directory: ${e.message}`);
      }
    }
    delete this.extensions[id];
    this._save();
    console.log(`[Extensions] Removed: ${id}`);
  }
}

module.exports = Extensions;
