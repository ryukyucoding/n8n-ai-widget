'use strict';

/**
 * Pure in-repo source of truth for declared action node specifications and typeVersions.
 * Zero filesystem I/O. Safe to import anywhere in compiler or tests.
 */
const DECLARED_ACTIONS = Object.freeze([
  { cardId: 'manual_trigger', capability: 'manual_trigger', nodeType: 'n8n-nodes-base.manualTrigger', version: 1 },
  { cardId: 'public_http_get', capability: 'http_request', nodeType: 'n8n-nodes-base.httpRequest', version: 4.4 },
  { cardId: 'select_fields', capability: 'data_transform', operation: 'select_fields', nodeType: 'n8n-nodes-base.set', version: 3.4 },
  { cardId: 'count_false_boolean', capability: 'data_transform', operation: 'count_false_boolean', nodeType: 'n8n-nodes-base.code', version: 2 },
  { cardId: 'limit_items', capability: 'data_transform', operation: 'limit_items', nodeType: 'n8n-nodes-base.limit', version: 1 },
  { cardId: 'sort_items', capability: 'data_transform', operation: 'sort_items', nodeType: 'n8n-nodes-base.sort', version: 1 },
  { cardId: 'remove_duplicates', capability: 'data_transform', operation: 'remove_duplicates', nodeType: 'n8n-nodes-base.removeDuplicates', version: 2 },
  { cardId: 'rename_keys', capability: 'data_transform', operation: 'rename_keys', nodeType: 'n8n-nodes-base.renameKeys', version: 1 },
  { cardId: 'join_object_and_count_false_boolean', capability: 'data_transform', operation: 'join_object_and_count_false_boolean', nodeType: 'n8n-nodes-base.code', version: 2 },
  { cardId: 'branch_if', capability: 'data_branch', operation: 'branch_if', nodeType: 'n8n-nodes-base.if', version: 2.3 },
  { cardId: 'merge_append', capability: 'data_merge', operation: 'merge_append', nodeType: 'n8n-nodes-base.merge', version: 3.2 },
  { cardId: 'loop_items', capability: 'data_loop', operation: 'loop_items', nodeType: 'n8n-nodes-base.splitInBatches', version: 3 },
  { cardId: 'format_date', capability: 'data_transform', operation: 'format_date', nodeType: 'n8n-nodes-base.dateTime', version: 2 },
  { cardId: 'extract_date', capability: 'data_transform', operation: 'extract_date', nodeType: 'n8n-nodes-base.dateTime', version: 2 },
  { cardId: 'hash_data', capability: 'data_transform', operation: 'hash_data', nodeType: 'n8n-nodes-base.crypto', version: 1 },
  { cardId: 'render_markdown', capability: 'data_transform', operation: 'render_markdown', nodeType: 'n8n-nodes-base.markdown', version: 1 },
  { cardId: 'xml_convert', capability: 'data_transform', operation: 'xml_convert', nodeType: 'n8n-nodes-base.xml', version: 1 },
  { cardId: 'set_output', capability: 'set_output', nodeType: 'n8n-nodes-base.set', version: 3.4 },
]);

function getDeclaredAction(capability, operation = null) {
  if (capability === 'data_transform' || capability === 'data_branch' || capability === 'data_merge' || capability === 'data_loop') {
    return DECLARED_ACTIONS.find((a) => a.capability === capability && a.operation === operation) || null;
  }
  return DECLARED_ACTIONS.find((a) => a.capability === capability) || null;
}

module.exports = {
  DECLARED_ACTIONS,
  getDeclaredAction,
};
