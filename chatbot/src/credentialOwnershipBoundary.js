'use strict';

/**
 * Hardened Credential Ownership Boundary Adapter (OVR-1 Repaired Milestone)
 *
 * Implements a metadata-only credential boundary that represents authorized-owner
 * credential references without exposing secret values or admitting an administrator's
 * full inventory to planner/compiler context.
 *
 * Fixes all 6 independent audit findings:
 * 1. Exact type + ID binding: query.id resolution strictly verifies record.type === query.type.
 * 2. Trusted relation-resolved canonical owner policy: binds authorizedOwnerId with provenance in revision hash.
 * 3. Order-independent duplicate detection: duplicate IDs or duplicate (type, name) pairs fail closed (manifest_collision).
 * 4. Zero foreign identifier leakage: foreign rejection responses never expose opaque foreign IDs.
 * 5. Strict scalar validation: malformed manifests, non-scalar owners, and invalid shapes fail closed safely without throwing.
 * 6. Enforces active state: only state === 'active' can resolve as available_now; inactive/revoked/unknown states reject.
 *
 * Security Invariants:
 * - Values excluded 100%: only opaque references and types are processed.
 * - Credential name alone never proves ownership.
 * - Unknown, foreign, revoked, or ambiguous ownership strictly fails closed.
 * - Zero live n8n calls, zero .44 calls, zero network mutation.
 */

const crypto = require('node:crypto');

const DEFAULT_AUTHORIZED_OWNER_ID = 'daniel';
const VALID_STATES = new Set(['active', 'inactive', 'revoked']);

function isScalarString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

class CredentialOwnershipBoundary {
  constructor(options = {}) {
    const rawOwner = options.authorizedOwnerId;
    this.authorizedOwnerId = isScalarString(rawOwner) ? rawOwner.trim() : DEFAULT_AUTHORIZED_OWNER_ID;
    this.provenance = options.provenance || 'local_manifest';
    this.recordsById = new Map();
    this.recordsByTypeAndName = new Map();
    this.manifestValid = false;
    this.manifestError = null;
    this.manifestRevision = '0000000000000000000000000000000000000000000000000000000000000000';

    if (options.manifestEntries !== undefined) {
      this.loadManifest(options.manifestEntries);
    }
  }

  isAuthorizedOwner(owner) {
    if (!isScalarString(owner)) return false;
    return owner.trim().toLowerCase() === this.authorizedOwnerId.toLowerCase();
  }

  /**
   * Load and sanitize credential manifest metadata.
   * Fails closed safely if manifest is malformed or contains duplicate IDs/(type, name) collisions.
   * Strips all non-metadata fields immediately.
   *
   * @param {Array<Object>} entries
   * @returns {Object} { valid: boolean, count: number, error?: string }
   */
  loadManifest(entries) {
    this.recordsById.clear();
    this.recordsByTypeAndName.clear();
    this.manifestValid = false;
    this.manifestError = null;
    this.manifestRevision = '0000000000000000000000000000000000000000000000000000000000000000';

    if (!Array.isArray(entries)) {
      this.manifestError = 'manifest_not_an_array';
      return { valid: false, count: 0, error: this.manifestError };
    }

    const seenIds = new Set();
    const seenTypeAndNames = new Set();
    const sanitizedList = [];

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        this.manifestError = `malformed_entry_at_index_${i}`;
        return { valid: false, count: 0, error: this.manifestError };
      }

      const id = isScalarString(entry.id) ? entry.id.trim() : null;
      const credentialType = isScalarString(entry.type) ? entry.type.trim() : null;
      const name = isScalarString(entry.name) ? entry.name.trim() : (id || null);
      const rawOwner = isScalarString(entry.ownerUserId) ? entry.ownerUserId.trim() : (isScalarString(entry.owner) ? entry.owner.trim() : null);
      const state = isScalarString(entry.state) ? entry.state.trim().toLowerCase() : 'active';

      if (!id || !credentialType) {
        this.manifestError = `missing_id_or_type_at_index_${i}`;
        return { valid: false, count: 0, error: this.manifestError };
      }

      if (!VALID_STATES.has(state)) {
        this.manifestError = `invalid_state_at_index_${i}`;
        return { valid: false, count: 0, error: this.manifestError };
      }

      // Order-independent duplicate ID check
      if (seenIds.has(id)) {
        this.manifestError = 'duplicate_credential_id_collision';
        return { valid: false, count: 0, error: this.manifestError };
      }
      seenIds.add(id);

      // Order-independent duplicate (type, name) collision check
      const typeAndNameKey = `${credentialType}:${name}`;
      if (seenTypeAndNames.has(typeAndNameKey)) {
        this.manifestError = 'duplicate_type_and_name_collision';
        return { valid: false, count: 0, error: this.manifestError };
      }
      seenTypeAndNames.add(typeAndNameKey);

      // Ownership classification
      let ownershipClassification = 'unknown';
      if (rawOwner && this.isAuthorizedOwner(rawOwner)) {
        ownershipClassification = 'daniel_owned';
      } else if (rawOwner) {
        ownershipClassification = 'foreign_rejected';
      }

      // Record strictly sanitized metadata without secret fields
      const sanitizedRecord = {
        id,
        type: credentialType,
        name,
        ownerUserId: rawOwner || 'unspecified',
        ownership: ownershipClassification,
        state,
      };

      this.recordsById.set(id, sanitizedRecord);
      this.recordsByTypeAndName.set(typeAndNameKey, sanitizedRecord);
      sanitizedList.push(sanitizedRecord);
    }

    // Sort deterministically by ID for reproducible revision hashing
    sanitizedList.sort((a, b) => a.id.localeCompare(b.id));

    const manifestData = {
      authorizedOwnerId: this.authorizedOwnerId,
      provenance: this.provenance,
      records: sanitizedList,
    };

    this.manifestRevision = crypto.createHash('sha256').update(JSON.stringify(manifestData)).digest('hex');
    this.manifestValid = true;
    return { valid: true, count: sanitizedList.length };
  }

  /**
   * Resolve a requested credential reference or requirement against authorized inventory.
   *
   * @param {Object} query
   * @param {string} query.type - Required credential type (e.g. 'googleCalendarOAuth2')
   * @param {string} [query.id] - Specific credential ID
   * @param {string} [query.name] - Credential name
   * @returns {Object} Sanitized capability report
   */
  resolveCredentialRequirement(query = {}) {
    if (!this.manifestValid) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: this.manifestError || 'manifest_invalid_or_unloaded',
        manifestRevision: this.manifestRevision,
      };
    }

    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: 'invalid_query_object',
        manifestRevision: this.manifestRevision,
      };
    }

    const type = isScalarString(query.type) ? query.type.trim() : '';
    const id = isScalarString(query.id) ? query.id.trim() : '';
    const name = isScalarString(query.name) ? query.name.trim() : '';

    if (!type) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: 'missing_credential_type',
        manifestRevision: this.manifestRevision,
      };
    }

    let record = null;

    if (id) {
      // 1. Exact type + ID binding check
      const candidate = this.recordsById.get(id);
      if (candidate) {
        if (candidate.type !== type) {
          // Reject type mismatch immediately; do not authorize
          return {
            status: 'unavailable',
            allowed: false,
            type,
            reason: 'credential_type_mismatch_for_id',
            manifestRevision: this.manifestRevision,
          };
        }
        record = candidate;
      }
    } else if (name) {
      const typeAndNameKey = `${type}:${name}`;
      record = this.recordsByTypeAndName.get(typeAndNameKey) || null;
    } else {
      // Find single candidate by type
      const matching = Array.from(this.recordsById.values()).filter((r) => r.type === type);
      if (matching.length === 1) {
        record = matching[0];
      } else if (matching.length > 1) {
        return {
          status: 'unavailable',
          allowed: false,
          type,
          reason: 'ambiguous_multiple_credentials',
          candidateCount: matching.length,
          manifestRevision: this.manifestRevision,
        };
      }
    }

    if (!record) {
      return {
        status: 'needs_setup',
        allowed: false,
        type,
        reason: 'credential_not_found',
        manifestRevision: this.manifestRevision,
      };
    }

    // 4. Foreign rejection: never leak the foreign opaque ID
    if (record.ownership === 'foreign_rejected') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        reason: 'foreign_owner_rejected',
        manifestRevision: this.manifestRevision,
      };
    }

    // Ambiguous or missing owner
    if (record.ownership !== 'daniel_owned') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        reason: 'ambiguous_or_unverified_ownership',
        manifestRevision: this.manifestRevision,
      };
    }

    // 6. State enforcement: only active state may resolve as available_now
    if (record.state !== 'active') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        reason: `credential_state_${record.state}`,
        manifestRevision: this.manifestRevision,
      };
    }

    // Authorized, active, Daniel-owned resolution
    return {
      status: 'available_now',
      allowed: true,
      opaqueRef: {
        id: record.id,
        type: record.type,
        name: record.name,
      },
      ownership: 'daniel_owned',
      manifestRevision: this.manifestRevision,
    };
  }

  getRevision() {
    return this.manifestRevision;
  }
}

module.exports = {
  DEFAULT_AUTHORIZED_OWNER_ID,
  isScalarString,
  CredentialOwnershipBoundary,
};
