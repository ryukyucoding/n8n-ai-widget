'use strict';

const fs = require('fs');
const path = require('path');
const { mergeStaticFindingSummaries, summaryFromLegacyCounts } = require('./safeStaticFindingSummary');

function ratio(passed, total) {
  return { passed, total, rate: total > 0 ? Number((passed / total).toFixed(6)) : null };
}

function hasBlockingFinding(summary) {
  return Object.values(summary || {}).some((bucket) => bucket?.blocking === true);
}

function staticSummaryFor(report, records) {
  const available = records.map((record) => record.staticFindingSummary).filter(Boolean);
  if (available.length) return mergeStaticFindingSummaries(available);
  return summaryFromLegacyCounts(report?.repairFindingCounts);
}

function summarizeCandidateABaseline({ artifactPath = path.join(__dirname, 'results', 'candidate-a-static-pilot-baseline-20260731.json'), readFileSync = fs.readFileSync } = {}) {
  const report = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const records = Array.isArray(report?.pilot?.records) ? report.pilot.records : [];
  const attemptedRuns = records.length;
  const completedRecords = records.filter((record) => record.outcome === 'completed');
  const availabilityFailures = records.filter((record) => record.outcome === 'availability_failure' || record.outcome === 'timeout');
  const strictJsonPass = records.filter((record) => record.strictJsonStatus === 'pass').length;
  const repairedJsonPass = records.filter((record) => record.repairedJsonStatus === 'pass').length;
  const safeFindingCategories = staticSummaryFor(report, records);
  const blockingRuns = completedRecords.filter((record) => record.staticFindingSummary ? hasBlockingFinding(record.staticFindingSummary) : record.repairNeeded === true).length;
  const repairableRuns = completedRecords.filter((record) => record.repairNeeded === true).length;
  const staticPassRuns = completedRecords.filter((record) => record.firstCandidatePass === true).length;

  return {
    schemaVersion: '1.1',
    kind: 'candidate_a_baseline_summary',
    attemptedRuns,
    completedRuns: completedRecords.length,
    availability: {
      availableRuns: attemptedRuns - availabilityFailures.length,
      availabilityFailureRuns: availabilityFailures.length,
      rate: attemptedRuns > 0 ? Number(((attemptedRuns - availabilityFailures.length) / attemptedRuns).toFixed(6)) : null,
    },
    strictJson: ratio(strictJsonPass, attemptedRuns),
    repairedJson: ratio(repairedJsonPass, attemptedRuns),
    conditionalStaticPass: ratio(staticPassRuns, completedRecords.length),
    repairable: ratio(repairableRuns, completedRecords.length),
    blocking: ratio(blockingRuns, completedRecords.length),
    safeFindingCategories,
  };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(summarizeCandidateABaseline())}\n`);

module.exports = { summarizeCandidateABaseline };
