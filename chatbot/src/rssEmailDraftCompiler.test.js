'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compileDailyRssEmailDraft } = require('./rssEmailDraftCompiler');

function specification() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'daily-rss-email-draft-spec.json'), 'utf8'));
}

test('compiles an inactive email draft and leaves only credential-bound setup unresolved', () => {
  const workflow = compileDailyRssEmailDraft(specification());
  const email = workflow.nodes.at(-1);
  assert.equal(workflow.nodes.length, 7);
  assert.equal(email.type, 'n8n-nodes-base.emailSend');
  assert.equal(email.parameters.fromEmail, '');
  assert.equal(email.parameters.toEmail, '');
  assert.equal(email.parameters.text, '={{ $json.markdown }}');
  assert.deepEqual(workflow.connections['Step 6: format Markdown digest'].main[0][0], { node: email.name, type: 'main', index: 0 });
});

test('refuses to disguise a draft as credential-free', () => {
  const spec = specification();
  spec.requiredUserSetup = [];
  assert.throws(() => compileDailyRssEmailDraft(spec), /SMTP credential/);
});
