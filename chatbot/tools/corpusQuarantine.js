'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, '..', 'corpus', 'source');
const QUARANTINED_SOURCE = path.join(SOURCE_DIR, 'testing_data_low_100.jsonl');
const QUARANTINED_PLANNER_CORPUS = path.join(__dirname, '..', 'corpus', 'planner_corpus.json');
const QUARANTINED_ARTIFACTS = new Set([
  canonicalPath(QUARANTINED_SOURCE),
  canonicalPath(QUARANTINED_PLANNER_CORPUS),
]);

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

function assertCorpusArtifactAllowed(filePath) {
  if (QUARANTINED_ARTIFACTS.has(canonicalPath(filePath))) {
    throw new Error(
      'Easy-100 corpus artifact is security-quarantined; do not process it until '
      + 'a2a/CORPUS_SECURITY_QUARANTINE.md is explicitly lifted by Dan.',
    );
  }
}

module.exports = {
  QUARANTINED_SOURCE,
  QUARANTINED_PLANNER_CORPUS,
  assertCorpusArtifactAllowed,
  assertCorpusSourceAllowed: assertCorpusArtifactAllowed,
};
