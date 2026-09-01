'use strict';

const { provision } = require('./provisionRuntimeCompilerWorkflow');
const { c07Specification } = require('./runC07CompilerSmoke');

const PREFIX = '__autoresearch_nodewise_c07_compiler__';

async function main() {
  const report = await provision({
    specification: c07Specification(),
    userRequest: 'Fetch JSONPlaceholder user 1 and todos, then return name, email, totalTodos, and incompleteTodos.',
    prefix: PREFIX,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { PREFIX, main };
