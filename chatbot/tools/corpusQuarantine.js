'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, '..', 'corpus', 'source');
const QUARANTINED_SOURCE = path.join(SOURCE_DIR, 'testing_data_low_100.jsonl');
const QUARANTINE_MARKER = path.join(SOURCE_DIR, 'QUARANTINED.md');

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

function assertCorpusSourceAllowed(filePath) {
  if (canonicalPath(filePath) === canonicalPath(QUARANTINED_SOURCE)
    && fs.existsSync(QUARANTINE_MARKER)) {
    throw new Error(
      'Easy-100 source corpus is security-quarantined; do not process it until '
      + 'a2a/CORPUS_SECURITY_QUARANTINE.md is explicitly lifted by Dan.',
    );
  }
}

module.exports = { QUARANTINED_SOURCE, assertCorpusSourceAllowed };
