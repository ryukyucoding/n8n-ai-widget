'use strict';

const fs = require('node:fs');
const path = require('node:path');

class TaskStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.tasks = new Map();
  }

  load() {
    if (!fs.existsSync(this.statePath)) return;
    const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    for (const task of parsed.tasks || []) this.tasks.set(task.id, task);
  }

  save() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ tasks: [...this.tasks.values()] }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, this.statePath);
  }

  create(task) {
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }

  get(taskId) {
    return this.tasks.get(taskId);
  }

  update(task) {
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }
}

module.exports = { TaskStore };
