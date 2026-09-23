'use strict';

/**
 * KnowledgeCardIndex: Offline, queryable knowledge index for n8n AI widget planner.
 * Ingests published behavior cards, K2 input binding synthesis results, and e-probes.
 *
 * Provides exact schema conformance, multi-attribute querying, and fail-closed diagnostics.
 */

class KnowledgeCardIndex {
  constructor(options = {}) {
    this.cards = [];
    this.byKey = new Map();
    this.byNodeType = new Map();
    this.byOperation = new Map();
    this.byFixtureFamily = new Map();
  }

  /**
   * Registers a card into the index with strict validation.
   */
  registerCard(card) {
    this._validateCardShape(card);
    const key = `${card.nodeType}@${card.version}#${card.operation}`;
    if (this.byKey.has(key)) {
      throw new Error(`Duplicate card key registered: "${key}"`);
    }

    const indexedCard = Object.freeze({ ...card, key });
    this.cards.push(indexedCard);
    this.byKey.set(key, indexedCard);

    // Index by nodeType
    if (!this.byNodeType.has(indexedCard.nodeType)) {
      this.byNodeType.set(indexedCard.nodeType, []);
    }
    this.byNodeType.get(indexedCard.nodeType).push(indexedCard);

    // Index by operation
    if (!this.byOperation.has(indexedCard.operation)) {
      this.byOperation.set(indexedCard.operation, []);
    }
    this.byOperation.get(indexedCard.operation).push(indexedCard);

    // Index by fixture family
    if (!this.byFixtureFamily.has(indexedCard.fixtureFamily)) {
      this.byFixtureFamily.set(indexedCard.fixtureFamily, []);
    }
    this.byFixtureFamily.get(indexedCard.fixtureFamily).push(indexedCard);

    return indexedCard;
  }

  _validateCardShape(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('Knowledge card must be a non-null object');
    }
    const required = [
      'nodeType',
      'version',
      'operation',
      'fixtureFamily',
      'inputContract',
      'outputContract',
      'timezoneDependency',
      'knownTraps',
      'evidence',
      'maturity',
    ];
    for (const field of required) {
      if (card[field] === undefined || card[field] === null) {
        throw new Error(`Card missing required field: "${field}"`);
      }
    }

    if (typeof card.nodeType !== 'string' || !card.nodeType.startsWith('n8n-nodes-base.')) {
      throw new Error(`Invalid nodeType: "${card.nodeType}"`);
    }
    if (typeof card.version !== 'number' || card.version <= 0) {
      throw new Error(`Invalid version: "${card.version}"`);
    }
    if (typeof card.operation !== 'string' || card.operation.trim() === '') {
      throw new Error(`Invalid operation: "${card.operation}"`);
    }
    if (typeof card.fixtureFamily !== 'string') {
      throw new Error(`Invalid fixtureFamily: "${card.fixtureFamily}"`);
    }
    if (typeof card.timezoneDependency !== 'boolean') {
      throw new Error(`timezoneDependency must be boolean`);
    }
    if (!Array.isArray(card.knownTraps)) {
      throw new Error(`knownTraps must be an array`);
    }
    if (!card.evidence || typeof card.evidence !== 'object') {
      throw new Error(`evidence must be an object`);
    }
    if (typeof card.evidence.ref !== 'string' || card.evidence.ref.trim() === '') {
      throw new Error(`evidence.ref is required`);
    }
    if (typeof card.maturity !== 'string') {
      throw new Error(`maturity is required`);
    }

    // Validate contract shapes
    this._validateContract(card.inputContract, 'inputContract');
    this._validateContract(card.outputContract, 'outputContract');
  }

  _validateContract(contract, fieldName) {
    if (!contract || typeof contract !== 'object') {
      throw new Error(`${fieldName} must be an object`);
    }
    if (!['items', 'one_object', 'binary', 'none'].includes(contract.cardinality)) {
      throw new Error(`${fieldName}.cardinality is invalid: "${contract.cardinality}"`);
    }
    if (contract.fields && typeof contract.fields !== 'object') {
      throw new Error(`${fieldName}.fields must be an object map`);
    }
  }

  get(key) {
    return this.byKey.get(key) || null;
  }

  findByNodeType(nodeType) {
    return this.byNodeType.get(nodeType) || [];
  }

  findByOperation(operation) {
    return this.byOperation.get(operation) || [];
  }

  query(filter = {}) {
    return this.cards.filter((card) => {
      if (filter.nodeType && card.nodeType !== filter.nodeType) return false;
      if (filter.version !== undefined && card.version !== filter.version) return false;
      if (filter.operation && card.operation !== filter.operation) return false;
      if (filter.fixtureFamily && card.fixtureFamily !== filter.fixtureFamily) return false;
      if (filter.timezoneDependency !== undefined && card.timezoneDependency !== filter.timezoneDependency) return false;
      if (filter.maturity && card.maturity !== filter.maturity) return false;
      if (filter.minVersion && card.version < filter.minVersion) return false;
      if (filter.maxVersion && card.version > filter.maxVersion) return false;
      return true;
    });
  }

  listAll() {
    return [...this.cards];
  }

  count() {
    return this.cards.length;
  }
}

module.exports = {
  KnowledgeCardIndex,
};
