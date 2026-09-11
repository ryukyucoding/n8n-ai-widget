'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');

test('chat UI exposes accessible zoom controls and persisted zoom levels', () => {
  assert.match(source, /id="zoom-out"/);
  assert.match(source, /id="zoom-in"/);
  assert.match(source, /id="zoom-level"/);
  assert.match(source, /aria-label="聊天文字大小"/);
  assert.match(source, /var CHAT_ZOOM_LEVELS = \[0\.8, 0\.9, 1, 1\.1, 1\.25, 1\.5\]/);
  assert.match(source, /localStorage\.setItem\(ZOOM_KEY/);
  assert.match(source, /messagesEl\.style\.setProperty\('--chat-zoom'/);
});

test('zoom controls are not mode buttons', () => {
  assert.doesNotMatch(source, /class="mode-btn"[^>]+id="zoom-(?:in|out)"/);
  assert.doesNotMatch(source, /id="zoom-(?:in|out)"[^>]+class="mode-btn"/);
});
