'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'widget.js'), 'utf8');

test('widget exposes two fixed window sizes and a close control', () => {
  assert.match(source, /n8n-ai-widget-window-controls/);
  assert.match(source, /data-widget-window-action="small"/);
  assert.match(source, /data-widget-window-action="large"/);
  assert.match(source, /data-widget-window-action="close"/);
  assert.match(source, /function setPanelSize\(size\)/);
  assert.match(source, /panelSize = size === 'large' \? 'large' : 'small'/);
});

test('large widget occupies about half the viewport and hides the drag handle', () => {
  assert.match(source, /Math\.round\(window\.innerWidth \* 0\.48\)/);
  assert.match(source, /Math\.round\(window\.innerHeight \* 0\.82\)/);
  assert.match(source, /Math\.min\(Math\.round\(window\.innerWidth \* 0\.48\), 960\)/);
  assert.match(source, /resizeHandle\.style\.display = 'none'/);
});
