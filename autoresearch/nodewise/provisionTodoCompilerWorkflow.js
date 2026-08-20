'use strict';

const { provision } = require('./provisionRuntimeCompilerWorkflow');
const { todoSpecification } = require('./runTodoCompilerSmoke');

const PREFIX = '__autoresearch_nodewise_todo_compiler__';

async function main() {
  const report = await provision({
    specification: todoSpecification(),
    userRequest: 'Count incomplete JSONPlaceholder todos for user 1 and return totalTodos and incompleteTodos.',
    prefix: PREFIX,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { PREFIX, main };
