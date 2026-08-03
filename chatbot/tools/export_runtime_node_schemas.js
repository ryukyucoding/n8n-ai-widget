#!/usr/bin/env node
'use strict';

// Run this inside the n8n container. It serializes node descriptions already
// loaded from the installed packages, so the chatbot validates against that
// exact n8n version instead of a hand-maintained node list.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const root = process.argv[2] || '/usr/local/lib/node_modules/n8n/node_modules';
const output = process.argv[3] || '/tmp/runtime_node_schemas.json';
const agentSchemaDirectory = process.argv[4] || '/tmp/runtime_node_schemas';
const packages = [
  ['n8n-nodes-base', 'n8n-nodes-base'],
  ['@n8n/n8n-nodes-langchain', '@n8n/n8n-nodes-langchain'],
];
const nodeTypes = {};
const skipped = [];

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

for (const [packagePath, namespace] of packages) {
  const directories = execFileSync('find', [root, '-path', `*/node_modules/${packagePath}/dist/nodes`, '-type', 'd'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const directory of directories) {
    const files = execFileSync('find', [directory, '-type', 'f', '-name', '*.node.js'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    for (const file of files) {
      try {
        const moduleExports = require(file);
        for (const exported of Object.values(moduleExports)) {
          if (typeof exported !== 'function') continue;
          let instance;
          try { instance = new exported(); } catch { continue; }
          const descriptions = instance.nodeVersions
            ? Object.fromEntries(Object.entries(instance.nodeVersions).map(([version, node]) => [version, jsonClone(node.description)]))
            : Object.fromEntries((Array.isArray(instance.description?.version) ? instance.description.version : [instance.description?.version])
              .filter((version) => version !== undefined)
              .map((version) => [String(version), jsonClone(instance.description)]));
          for (const description of Object.values(descriptions)) {
            if (!description?.name || !Array.isArray(description.properties)) continue;
            const type = `${namespace}.${description.name}`;
            nodeTypes[type] ??= { versions: {} };
            Object.assign(nodeTypes[type].versions, descriptions);
          }
        }
      } catch (error) {
        skipped.push({ file, error: error.message });
      }
    }
  }
}

fs.writeFileSync(output, JSON.stringify({ format: 1, generatedAt: new Date().toISOString(), nodeTypes, skipped }, null, 2));
fs.rmSync(agentSchemaDirectory, { recursive: true, force: true });
fs.mkdirSync(agentSchemaDirectory, { recursive: true });
for (const [type, node] of Object.entries(nodeTypes)) {
  const versions = Object.keys(node.versions).sort((left, right) => Number(right) - Number(left));
  const latestVersion = versions[0];
  if (!latestVersion) continue;
  const description = { ...node.versions[latestVersion], name: type, typeVersion: Number(latestVersion) };
  const filename = `${type.replace(/[^a-zA-Z0-9]+/g, '_')}.json`;
  fs.writeFileSync(`${agentSchemaDirectory}/${filename}`, JSON.stringify(description, null, 2));
}
console.log(`Exported ${Object.keys(nodeTypes).length} validated node types to ${output} and ${agentSchemaDirectory}; skipped ${skipped.length} modules.`);
