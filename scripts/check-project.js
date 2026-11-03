'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
let count = 0;
for (const name of files) {
  if (name.endsWith('.js')) {
    execFileSync(process.execPath, ['--check', path.join(root, name)], { stdio: 'pipe' });
    count++;
  }
  if (name.endsWith('.json')) JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}
console.log(`JavaScript syntax passed (${count} files); JSON files parsed.`);
