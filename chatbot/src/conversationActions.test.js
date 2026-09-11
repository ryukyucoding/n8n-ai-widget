'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');

test('every ready conversational plan renders Confirm and Cancel in the plan bubble', () => {
  assert.match(source, /function conversationActionHtml\(\)/);
  assert.match(source, /conv-confirm-btn/);
  assert.match(source, /conv-cancel-btn/);
  assert.match(source, /var ready = view\.status === 'ready_to_confirm';/);
  assert.match(source, /renderPlanTextHtml\(view\.planSpec, view\.credentials\) \+ \(ready \? conversationActionHtml\(\) : ''\)/);
  assert.match(source, /wireConversationActions\(planElement\)/);
});

test('conversation action handlers stay on the conversational routes', () => {
  assert.match(source, /confirmConversation\(cb\)/);
  assert.match(source, /cancelConversation/);
  assert.match(source, /CONV_CONFIRM_URL/);
  assert.match(source, /CONV_CANCEL_URL/);
});
