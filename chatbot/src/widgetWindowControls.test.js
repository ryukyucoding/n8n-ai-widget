'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'widget.js'), 'utf8');

test('widget exposes independent window resize and maximize controls', () => {
  assert.match(source, /n8n-ai-widget-window-controls/);
  assert.match(source, /data-widget-window-action="shrink"/);
  assert.match(source, /data-widget-window-action="grow"/);
  assert.match(source, /data-widget-window-action="maximize"/);
  assert.match(source, /data-widget-window-action="close"/);
  assert.match(source, /toggleMaximized/);
  assert.match(source, /resizePanelBy\(-80, -60\)/);
  assert.match(source, /resizePanelBy\(80, 60\)/);
});

test('maximized widget is bounded by viewport margins and hides the drag handle', () => {
  assert.match(source, /window\.innerWidth - \(MARGIN \* 2\)/);
  assert.match(source, /window\.innerHeight - \(MARGIN \* 2\)/);
  assert.match(source, /resizeHandle\.style\.display = 'none'/);
});
