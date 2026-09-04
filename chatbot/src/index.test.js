'use strict';

// Startup route-registration test. Requiring index.js runs the real module
// initialization (all top-level app.post registrations); the require.main guard
// keeps it from binding a port. Dummy env only lets the module construct its
// clients — it does not bypass initialization or stub the route wiring.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./index');

function registeredPaths() {
  return app._router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
}

test('plan-first routes are registered at startup, not trapped inside a handler body', () => {
  const paths = registeredPaths();
  for (const routePath of ['/beta/plan-review', '/beta/plan-from-request', '/beta/plan-approve', '/beta/compile-approved']) {
    assert.ok(paths.includes(routePath), `plan-first route ${routePath} must be registered at startup`);
  }
});

test('the base /beta/compile route is still registered', () => {
  assert.ok(registeredPaths().includes('/beta/compile'), '/beta/compile must remain registered');
});
