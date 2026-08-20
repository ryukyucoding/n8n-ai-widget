'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseAndValidateIntentPlan } = require('./intentPlan');

function parseArgs(args) {
  if (args.length !== 4 || args[0] !== '--state' || args[2] !== '--output') {
    throw new Error('Usage: --state <broker-tasks.json> --output <report.json>');
  }
  return { statePath: path.resolve(args[1]), outputPath: path.resolve(args[3]) };
}

function category(error) {
  const message = String(error?.message || 'invalid_reply');
  if (/JSON object|Markdown fence/.test(message)) return 'not_json_object';
  if (/earlier step/.test(message)) return 'invalid_dataflow_order';
  if (/capability/.test(message)) return 'unsupported_capability';
  if (/requiredUserSetup/.test(message)) return 'invalid_user_setup';
  return 'contract_invalid';
}

function collectIntentTrial(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const records = tasks.filter((task) => task?.taskType === 'nodewise_intent_plan').map((task) => {
    const reply = Array.isArray(task.messages)
      ? [...task.messages].reverse().find((message) => message?.senderAgentId === 'debugger' && message?.state === 'completed')
      : null;
    if (!reply) return { taskId: task.id, outcome: task?.state === 'failed' ? 'agent_failed' : 'reply_missing' };
    try {
      const plan = parseAndValidateIntentPlan(reply.text);
      return {
        taskId: task.id,
        outcome: plan.requiredUserSetup.length || plan.steps.some((step) => step.requiredUserSetup.length) ? 'clarification_required' : 'valid_plan',
        stepCount: plan.steps.length,
        capabilityCount: new Set(plan.steps.map((step) => step.capability)).size,
      };
    } catch (error) {
      return { taskId: task.id, outcome: 'contract_rejected', errorCategory: category(error) };
    }
  });
  const aggregate = records.reduce((result, record) => {
    result[record.outcome] = (result[record.outcome] || 0) + 1;
    if (record.errorCategory) result.errorCategories[record.errorCategory] = (result.errorCategories[record.errorCategory] || 0) + 1;
    return result;
  }, { submittedTasks: records.length, errorCategories: {} });
  return { schemaVersion: '1.0', kind: 'nodewise_intent_trial_report', executionPolicy: 'no_model_no_n8n_create_or_execution', records, aggregate };
}

function main(args = process.argv.slice(2)) {
  const { statePath, outputPath } = parseArgs(args);
  const report = collectIntentTrial(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.aggregate)}\n`);
}

if (require.main === module) main();

module.exports = { category, collectIntentTrial, parseArgs };
