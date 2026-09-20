/**
 * Catalog Action Registry Adapter
 *
 * Provides safe, catalog-backed action discovery for planner and feasibility boundary.
 * Reads compiler_supported_actions.json to expose the exact 10 compiler-verified operations.
 * Includes fail-safe in-memory fallback if the external catalog file is unavailable.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../../../n8n-node-catalog/compiler_supported_actions.json');

// Built-in fail-safe definitions matching compiler surface if external file is missing
const FALLBACK_ACTIONS = [
  { cardId: 'manual_trigger', capability: 'manual_trigger', nodeType: 'n8n-nodes-base.manualTrigger', version: 1 },
  { cardId: 'public_http_get', capability: 'http_request', nodeType: 'n8n-nodes-base.httpRequest', version: 4.4 },
  { cardId: 'select_fields', capability: 'data_transform', operation: 'select_fields', nodeType: 'n8n-nodes-base.set', version: 3.4 },
  { cardId: 'count_false_boolean', capability: 'data_transform', operation: 'count_false_boolean', nodeType: 'n8n-nodes-base.code', version: 2 },
  { cardId: 'limit_items', capability: 'data_transform', operation: 'limit_items', nodeType: 'n8n-nodes-base.limit', version: 1 },
  { cardId: 'sort_items', capability: 'data_transform', operation: 'sort_items', nodeType: 'n8n-nodes-base.sort', version: 1 },
  { cardId: 'remove_duplicates', capability: 'data_transform', operation: 'remove_duplicates', nodeType: 'n8n-nodes-base.removeDuplicates', version: 2 },
  { cardId: 'rename_keys', capability: 'data_transform', operation: 'rename_keys', nodeType: 'n8n-nodes-base.renameKeys', version: 1 },
  { cardId: 'join_object_and_count_false_boolean', capability: 'data_transform', operation: 'join_object_and_count_false_boolean', nodeType: 'n8n-nodes-base.code', version: 2 },
  { cardId: 'branch_if', capability: 'data_branch', operation: 'branch_if', nodeType: 'n8n-nodes-base.if', version: 2.2 },
  { cardId: 'merge_append', capability: 'data_merge', operation: 'merge_append', nodeType: 'n8n-nodes-base.merge', version: 3 },
  { cardId: 'loop_items', capability: 'data_loop', operation: 'loop_items', nodeType: 'n8n-nodes-base.splitInBatches', version: 3 },
  { cardId: 'format_date', capability: 'data_transform', operation: 'format_date', nodeType: 'n8n-nodes-base.dateTime', version: 2 },
  { cardId: 'hash_data', capability: 'data_transform', operation: 'hash_data', nodeType: 'n8n-nodes-base.crypto', version: 1 },
  { cardId: 'set_output', capability: 'set_output', nodeType: 'n8n-nodes-base.set', version: 3.4 }
];

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