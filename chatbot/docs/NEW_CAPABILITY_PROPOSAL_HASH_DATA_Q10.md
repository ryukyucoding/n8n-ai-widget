# Q10 Milestone Proposal: New Credential-Free Capability Candidate — `hash_data` (`Crypto@1`)

**Date:** 2026-09-20  
**Owner:** claudex Forge  
**Topic:** Catalog-Derived Credential-Free Capability Identification  
**Target Candidate:** `n8n-nodes-base.crypto@1` (`action: 'hash'`, algorithms: `SHA256`, `MD5`, `SHA512`, `SHA384`, encodings: `hex`, `base64`)  
**Status:** IMPLEMENTED & AUDIT-READY (Pinned Crypto@1 / In-repo Tests / Zero .44 Execution)  

---

## 1. Candidate Identification & Catalog Facts

From `n8n_node_catalog.json` and `n8n_node_catalog_index.json`:
- **Node Type:** `n8n-nodes-base.crypto` (Version: `1`)
- **Display Name:** Crypto
- **Inputs:** `['main']` (Single input connection, index: 0)
- **Outputs:** `['main']` (Single output connection, index: 0)
- **Credential Requirements:** `credentialTypes: []` (**Zero credentials required**)
- **Data Cardinality:** `items` -> `items` (Linear, acyclic DAG compatible)
- **Operation Identified:** `action: 'hash'` (Generates cryptographic hash of a field value).
- **Supported Algorithms Policy:** `SHA256`, `MD5`, `SHA512`, `SHA384`
- **Supported Encodings Policy:** `hex`, `base64`

---

## 2. Candidate Action Card Specification (`hash_data`)

```json
{
  "cardId": "hash_data",
  "actionName": "Hash Data (Crypto)",
  "capability": "data_transform",
  "operation": "hash_data",
  "nodeType": "n8n-nodes-base.crypto",
  "typeVersion": 1,
  "description": "Calculates cryptographic hash (SHA256/MD5/SHA512/SHA384) of an input field and outputs as a hex or base64 string.",
  "credentialRequirement": {
    "required": false,
    "credentialTypes": [],
    "notes": "Pure in-memory cryptographic transform; zero credentials."
  },
  "inputMetadata": {
    "inputs": ["main"],
    "cardinality": "items",
    "notes": "Stream of items containing field to hash."
  },
  "outputMetadata": {
    "outputs": ["main"],
    "cardinality": "items",
    "notes": "Original items enriched with new hash field."
  },
  "allowedConfigurationShape": {
    "type": "object",
    "required": ["operation", "input", "field"],
    "properties": {
      "operation": { "type": "string", "enum": ["hash_data"] },
      "field": { "type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$" },
      "algorithm": { "type": "string", "enum": ["SHA256", "MD5", "SHA512", "SHA384"], "default": "SHA256" },
      "outputFieldName": { "type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$", "default": "hashValue" },
      "encoding": { "type": "string", "enum": ["hex", "base64"], "default": "hex" }
    },
    "additionalProperties": false
  },
  "compiledNodeParameters": {
    "action": "hash",
    "type": "={{ config.algorithm || 'SHA256' }}",
    "value": "={{ $json.{{ config.field }} }}",
    "dataPropertyName": "={{ config.outputFieldName || 'hashValue' }}",
    "encoding": "={{ config.encoding || 'hex' }}"
  },
  "sourceProvenance": {
    "catalogSource": "n8n-nodes-base.crypto@1",
    "catalogSha256": "dcefae5a5e7f7029c97807650f840dee9588f34ced49ace74734dc10c8d980b5"
  }
}
```

---

## 3. Feasibility & Topology Assessment

- **Topology:** Strictly linear DAG (`main[0]` -> `main[0]`). No dual outputs, no branching, no back-edges.
- **Feasibility Classification:** **`can_build_now`** (registered in compiler and candidate resolver).
- **Does it need a runtime fixture?**
  - **No special cyclic/multi-port fixture needed** (unlike `splitInBatches` or `If+Merge`).
  - Standard deterministic 3-item test fixture (e.g. 3 Todo items with email/title hashed to deterministic SHA256 hex strings) is completely sufficient for verification.

---

## 4. Proposed Synthetic Test Pipeline

1. `manual-start`: `manual_trigger`
2. `fetch-todos`: `http_request` (3 items)
3. `hash-title`: `data_transform` -> `hash_data` (`field: 'title'`, `algorithm: 'SHA256'`, `outputFieldName: 'titleHash'`, `encoding: 'hex'`)
4. `count-incomplete`: `count_false_boolean` (`completed === false`)
5. `format-output`: `set_output` (`{ totalTodos, incompleteTodos }`)

---

## 5. Security & Boundary Conformance

- Zero live MCP calls.
- Zero credentials or secrets accessed.
- Zero .44 deployment or live executions performed.
- Strictly pinned to `typeVersion: 1`.
- Rejects non-whitelisted algorithms or encodings fail-closed.
