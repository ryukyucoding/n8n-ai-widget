'use strict';

/**
 * Product-side Read-Only n8n-MCP Catalog & Validation Adapter (Q6 Milestone)
 *
 * Exposes a clean, safe validation service for candidate workflows before execution,
 * leveraging local n8n-mcp rules and catalog metadata.
 *
 * Invariants:
 * - Live MCP calls are strictly disabled by default (readOnly: true, liveCalls: false).
 * - Preserves existing deterministic IR and compiler boundaries.
 * - Zero external network calls, zero credentials accessed, zero mutations on .44.
 */

const path = require('node:path');
const fs = require('node:fs');

// Attempt to load the local n8n_mcp_validation_adapter
let N8nMcpValidationAdapter;
try {
  const adapterModule = require('../../../n8n-node-catalog/n8n_mcp_validation_adapter');
  N8nMcpValidationAdapter = adapterModule.N8nMcpValidationAdapter;
} catch {
  N8nMcpValidationAdapter = null;
}

class ProductN8nMcpValidator {
  constructor(options = {}) {
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    this.liveMcpEnabled = false; // Strictly disabled by default
    this.adapter = N8nMcpValidationAdapter ? new N8nMcpValidationAdapter(options) : null;
  }

  /**
   * Run read-only structural validation on a candidate compiled workflow.
   * @param {Object} workflow - Compiled workflow JSON
   * @param {Object} [options]
   * @returns {Object} Sanitized validation report
   */
  validateCandidate(workflow, options = {}) {
    if (!this.enabled || !this.adapter) {
      return {
        validated: false,
        status: 'skipped',
        reason: 'adapter_unavailable_or_disabled',
        errors: [],
        warnings: [],
      };
    }

    try {
      const report = this.adapter.validateStructure(workflow);
      return {
        validated: true,
        status: report.valid ? 'pass' : 'fail',
        totalNodes: report.totalNodes,
        errors: report.errors || [],
        warnings: report.warnings || [],
        mode: 'read_only_local_mcp',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        validated: false,
        status: 'error',
        error: err.message || 'validation_exception',
        errors: [err.message || 'validation_exception'],
        warnings: [],
      };
    }
  }
}

const defaultProductValidator = new ProductN8nMcpValidator();

module.exports = {
  ProductN8nMcpValidator,
  defaultProductValidator,
};
