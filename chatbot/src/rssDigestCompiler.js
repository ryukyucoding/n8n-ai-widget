'use strict';

const crypto = require('node:crypto');
const runtimeSchemas = require('../schemas/runtime_node_schemas.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function latestCard(type) {
  const versions = Object.keys(runtimeSchemas.nodeTypes?.[type]?.versions || {})
    .filter((value) => Number.isFinite(Number(value)))
    .sort((left, right) => Number(right) - Number(left));
  assert(versions.length, `runtime does not expose ${type}`);
  return { type, typeVersion: Number(versions[0]) };
}

function nodeId(stepId) {
  const hex = crypto.createHash('sha256').update(`rss-digest-compiler:${stepId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function validateDailyRssDigestSpecification(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'specification must be an object');
  assert(value.schemaVersion === '1.0', 'schemaVersion must be 1.0');
  assert(value.kind === 'daily_rss_digest_specification', 'kind must be daily_rss_digest_specification');
  assert(typeof value.goal === 'string' && value.goal.trim(), 'goal is required');
  assert(Array.isArray(value.requiredUserSetup) && value.requiredUserSetup.length === 0, 'user setup must be resolved before compilation');
  assert(value.schedule && Number.isInteger(value.schedule.hour) && value.schedule.hour >= 0 && value.schedule.hour <= 23, 'schedule.hour must be 0 to 23');
  assert(value.schedule && Number.isInteger(value.schedule.minute) && value.schedule.minute >= 0 && value.schedule.minute <= 59, 'schedule.minute must be 0 to 59');
  assert(typeof value.feedUrl === 'string' && value.feedUrl.trim(), 'feedUrl is required');
  const feedUrl = new URL(value.feedUrl);
  assert(feedUrl.protocol === 'https:', 'feedUrl must use HTTPS');
  assert(Number.isInteger(value.lookbackHours) && value.lookbackHours >= 1 && value.lookbackHours <= 168, 'lookbackHours must be 1 to 168');
  assert(Number.isInteger(value.maxItems) && value.maxItems >= 1 && value.maxItems <= 25, 'maxItems must be 1 to 25');
  assert(value.expectedOutput?.deliveryShape === 'one_object', 'only one_object output is supported');
  assert(Array.isArray(value.expectedOutput.fields) && value.expectedOutput.fields.join(',') === 'markdown,count', 'expected output must be markdown,count');
  return {
    goal: value.goal.trim(), feedUrl: feedUrl.toString(), schedule: value.schedule,
    lookbackHours: value.lookbackHours, maxItems: value.maxItems,
  };
}

function compileDailyRssDigestSpecification(specification) {
  const spec = validateDailyRssDigestSpecification(specification);
  const names = {
    manual: 'Step 1: manual test trigger', schedule: 'Step 2: daily schedule', rss: 'Step 3: read RSS feed',
    filter: 'Step 4: filter and deduplicate', limit: 'Step 5: limit entries', output: 'Step 6: format Markdown digest',
  };
  const filterCode = [
    `const cutoff = Date.now() - ${spec.lookbackHours} * 60 * 60 * 1000;`,
    'const seenTitles = new Set();',
    'return $input.all().filter((item) => {',
    '  const title = String(item.json.title || \"\").trim();',
    '  const published = item.json.isoDate || item.json.pubDate || item.json.published || null;',
    '  const timestamp = published ? Date.parse(published) : NaN;',
    '  if (!title || seenTitles.has(title) || !Number.isFinite(timestamp) || timestamp < cutoff) return false;',
    '  seenTitles.add(title);',
    '  return true;',
    '});',
  ].join('\n');
  const outputCode = [
    'const entries = $input.all().map((item) => item.json);',
    'const lines = entries.map((entry, index) => {',
    '  const title = String(entry.title || \"Untitled\").trim();',
    '  const link = String(entry.link || \"\").trim();',
    '  const published = entry.isoDate || entry.pubDate || entry.published || \"unknown date\";',
    '  return `${index + 1}. [${title}](${link}) - ${published}`;',
    '});',
    `return [{ json: { markdown: ['# RSS digest', '', ...lines].join('\\n'), count: entries.length } }];`,
  ].join('\n');
  const nodes = [
    { id: nodeId('manual'), name: names.manual, ...latestCard('n8n-nodes-base.manualTrigger'), parameters: {}, position: [180, 220] },
    { id: nodeId('schedule'), name: names.schedule, ...latestCard('n8n-nodes-base.scheduleTrigger'), parameters: { rule: { interval: [{ field: 'days', triggerAtHour: spec.schedule.hour, triggerAtMinute: spec.schedule.minute }] } }, position: [180, 420] },
    { id: nodeId('rss'), name: names.rss, ...latestCard('n8n-nodes-base.rssFeedRead'), parameters: { url: spec.feedUrl, options: {} }, position: [460, 300] },
    { id: nodeId('filter'), name: names.filter, ...latestCard('n8n-nodes-base.code'), parameters: { jsCode: filterCode }, position: [720, 300] },
    { id: nodeId('limit'), name: names.limit, ...latestCard('n8n-nodes-base.limit'), parameters: { maxItems: spec.maxItems, keep: 'firstItems' }, position: [980, 300] },
    { id: nodeId('output'), name: names.output, ...latestCard('n8n-nodes-base.code'), parameters: { jsCode: outputCode }, position: [1240, 300] },
  ];
  const connect = (from, to) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
  return {
    name: `RSS digest compiler - ${spec.goal}`, active: false, settings: { executionOrder: 'v1' }, nodes,
    connections: {
      [names.manual]: connect(names.manual, names.rss),
      [names.schedule]: connect(names.schedule, names.rss),
      [names.rss]: connect(names.rss, names.filter),
      [names.filter]: connect(names.filter, names.limit),
      [names.limit]: connect(names.limit, names.output),
    },
  };
}

module.exports = { compileDailyRssDigestSpecification, validateDailyRssDigestSpecification };
