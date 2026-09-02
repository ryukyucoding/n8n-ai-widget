#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { auditJsonLines } = require('../src/easy100CapabilityCoverage');
const { assertCorpusSourceAllowed } = require('./corpusQuarantine');

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const input = valueAfter('--input');
const output = valueAfter('--output');
if (!input || !output) throw new Error('usage: node audit_easy100_capability_coverage.js --input <testing_data_low_100.jsonl> --output <report.json>');
assertCorpusSourceAllowed(input);
const report = auditJsonLines(fs.readFileSync(path.resolve(input), 'utf8'));
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ caseCount: report.aggregate.caseCount, statuses: report.aggregate.statuses, topBlockers: report.aggregate.blockers.slice(0, 8), parseFailures: report.parseFailures.length })}\n`);
