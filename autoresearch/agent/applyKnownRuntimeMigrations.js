'use strict';

// These migrations are intentionally narrow. They preserve existing values in
// memory only when the authoritative validator reports the exact legacy shape.

const GEMINI = '@n8n/n8n-nodes-langchain.googleGemini';
const SHOPIFY = 'n8n-nodes-base.shopify';

function reportedParameters(findings, nodeIndex, nodeType) {
  return new Set((findings || [])
    .filter((finding) => finding?.category === 'parameter_schema'
      && finding?.repairContext?.nodeIndex === nodeIndex
      && finding?.repairContext?.nodeType === nodeType)
    .map((finding) => finding.repairContext.parameterName)
    .filter((name) => typeof name === 'string'));
}

function applyKnownRuntimeMigrations(workflow, findings) {
  const actions = [];
  const blocked = [];
  for (const [nodeIndex, node] of (workflow?.nodes || []).entries()) {
    if (!node || typeof node !== 'object' || !node.parameters || typeof node.parameters !== 'object') continue;
    const reported = reportedParameters(findings, nodeIndex, node.type);
    if (node.type === GEMINI && ['modelId', 'options', 'messages', 'jsonOutput'].every((name) => reported.has(name))) {
      node.parameters.resource = 'text';
      node.parameters.operation = 'message';
      actions.push({ kind: 'select_gemini_text_message', nodeIndex, nodeType: GEMINI });
    }
    if (node.type === SHOPIFY && ['title', 'bodyHtml', 'vendor', 'productType'].every((name) => reported.has(name))) {
      const existing = node.parameters.additionalFields;
      if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
        blocked.push({ kind: 'shopify_additional_fields_conflict', nodeIndex, nodeType: SHOPIFY });
        continue;
      }
      const additionalFields = { ...(existing || {}) };
      const migrations = [['bodyHtml', 'body_html'], ['vendor', 'vendor'], ['productType', 'product_type']];
      if (migrations.some(([, target]) => Object.hasOwn(additionalFields, target))) {
        blocked.push({ kind: 'shopify_additional_fields_conflict', nodeIndex, nodeType: SHOPIFY });
        continue;
      }
      node.parameters.resource = 'product';
      node.parameters.operation = 'create';
      for (const [source, target] of migrations) {
        additionalFields[target] = node.parameters[source];
        delete node.parameters[source];
      }
      node.parameters.additionalFields = additionalFields;
      actions.push({ kind: 'migrate_shopify_product_create_fields', nodeIndex, nodeType: SHOPIFY });
    }
  }
  return { actions, blocked };
}

module.exports = { applyKnownRuntimeMigrations, reportedParameters };
