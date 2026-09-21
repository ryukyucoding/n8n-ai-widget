/**
 * Catalog Action Registry Adapter
 *
 * Provides safe, catalog-backed action discovery for planner and feasibility boundary.
 * Reads compiler_supported_actions.json to expose the exact 10 compiler-verified operations.
 * Includes fail-safe in-memory fallback if the external catalog file is unavailable.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DECLARED_ACTIONS } = require('./declaredActions');

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../../../n8n-node-catalog/compiler_supported_actions.json');

// Built-in fail-safe definitions matching compiler surface if external file is missing
const FALLBACK_ACTIONS = DECLARED_ACTIONS;

class CatalogActionRegistry {
  constructor(options = {}) {
    this.registryPath = options.registryPath || DEFAULT_REGISTRY_PATH;
    this._load();
  }

  _load() {
    this.actions = new Map();
    this.capabilities = new Map();
    this.isFallback = false;

    let actionList = [];
    try {
      if (fs.existsSync(this.registryPath)) {
        const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
        actionList = Array.isArray(data.actions) ? data.actions : [];
      }
    } catch {
      actionList = [];
    }

    if (actionList.length === 0) {
      actionList = FALLBACK_ACTIONS;
      this.isFallback = true;
    }

    for (const item of actionList) {
      this.actions.set(item.cardId, item);
      if (item.operation) {
        this.actions.set(item.operation, item);
      }
      if (item.capability && !this.capabilities.has(item.capability)) {
        this.capabilities.set(item.capability, item);
      }
    }
  }

  getAction(idOrOperation) {
    if (!idOrOperation) return null;
    return this.actions.get(idOrOperation) || this.capabilities.get(idOrOperation) || null;
  }

  isSupported(idOrOperation) {
    return this.getAction(idOrOperation) !== null;
  }

  listSupportedActions() {
    return Array.from(new Set(this.actions.values()));
  }
}

const defaultRegistry = new CatalogActionRegistry();

module.exports = {
  CatalogActionRegistry,
  defaultRegistry,
};