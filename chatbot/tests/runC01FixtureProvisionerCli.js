'use strict';

const {
  runC01ExactIdFixtureProvisioner,
  serializeProvisionReport,
} = require('./createFixtures/c01ExactIdFixtureProvisioner');

function parseCliArgs(argv) {
  return Array.isArray(argv) && argv.length === 0 ? {} : null;
}

async function main({ argv = process.argv.slice(2), createCanonicalC01, readExactWorkflow } = {}) {
  if (!parseCliArgs(argv)) {
    return {
      caseId: 'C01',
      status: 'skipped',
      creationProvenance: false,
      integrity: { status: 'skipped', category: 'adapter_unavailable' },
      humanUiNextStep: false,
      cleanup: { eligible: false, category: 'human_owner_required' },
    };
  }
  return runC01ExactIdFixtureProvisioner({ createCanonicalC01, readExactWorkflow });
}

if (require.main === module) {
  void main().then((result) => {
    process.stdout.write(`${serializeProvisionReport(result)}\n`);
  });
}

module.exports = { main, parseCliArgs };
