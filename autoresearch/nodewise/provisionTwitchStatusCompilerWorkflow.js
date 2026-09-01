'use strict';

const { provision } = require('./provisionRuntimeCompilerWorkflow');
const { twitchStatusWorkflow } = require('./runTwitchStatusCompilerSmoke');

const PREFIX = '__autoresearch_nodewise_twitch_status__';

async function main() {
  const report = await provision({
    candidateWorkflow: twitchStatusWorkflow(),
    userRequest: 'Check whether the public Twitch channel twitch is live and return channel and isLive.',
    prefix: PREFIX,
  });
  return report;
}

async function provisionTwitch({ fetchImpl = globalThis.fetch } = {}) {
  return provision({ fetchImpl, candidateWorkflow: twitchStatusWorkflow(), prefix: PREFIX, userRequest: 'Check whether the public Twitch channel twitch is live and return channel and isLive.' });
}

if (require.main === module) main().then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { PREFIX, main, provisionTwitch };
