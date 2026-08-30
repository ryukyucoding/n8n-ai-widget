'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'widget.js'), 'utf8');

nodeTest('only the mounted same-origin chat iframe can change panel presentation', () => {
  assert.match(source, /event\.origin !== chatOrigin\(\) \|\| event\.source !== panel\.contentWindow/);
  assert.match(source, /event\.data\.action !== 'panelPresentation'/);
  assert.match(source, /event\.data\.presentation === 'plan-review'/);
});

nodeTest('plan review expansion is viewport-bounded and manual resizing becomes the new preference', () => {
  assert.match(source, /setPanelDimensions\(560, 720\)/);
  assert.match(source, /Math\.min\(width, window\.innerWidth - \(MARGIN \* 2\)\)/);
  assert.match(source, /Math\.min\(height, window\.innerHeight - \(MARGIN \* 2\) - BTN - GAP\)/);
  assert.match(source, /planReviewExpanded = false;\r?\n\s*savedPanelW = panelW;/);
});
