'use strict';

const { runC01ExactIdFixtureProvisioner, serializeProvisionReport } = require('./createFixtures/c01ExactIdFixtureProvisioner');
const { createProductionC01ProvisionAdapter, isRuntimeOneShotConfirmed } = require('./createFixtures/c01ProductionApiAdapter');

// Changing this requires a reviewed code change; it cannot be enabled by argv.
const CODE_LEVEL_C01_PROVISION_ENABLED = false;

function parseCliArgs(argv) {
  return Array.isArray(argv) && argv.length === 0 ? {} : null;
}

async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  fetchImpl = globalThis.fetch,
  codeLevelProvisionEnabled = CODE_LEVEL_C01_PROVISION_ENABLED,
} = {}) {
  if (!parseCliArgs(argv)
    || codeLevelProvisionEnabled !== true
    || !isRuntimeOneShotConfirmed(environment)) {
    return runC01ExactIdFixtureProvisioner();
  }
  const adapter = createProductionC01ProvisionAdapter({
    environment,
    fetchImpl,
    codeLevelProvisionEnabled,
    runtimeOneShotConfirmed: true,
  });
  return runC01ExactIdFixtureProvisioner(adapter);
}

if (require.main === module) {
  void main().then((result) => {
    process.stdout.write(`${serializeProvisionReport(result)}\n`);
  });
}

module.exports = {
  CODE_LEVEL_C01_PROVISION_ENABLED,
  main,
  parseCliArgs,
};
