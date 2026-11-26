'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let repository = process.argv[2] || process.env.GITHUB_REPOSITORY || '';
repository = repository.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/')[1] === '.' || repository.split('/')[1] === '..') {
  throw new Error('请提供实际仓库 owner/repo，例如 node scripts/configure-release.cjs yourname/zhihu-long-image');
}
fs.writeFileSync(path.join(root, 'release-config.json'), JSON.stringify({ repository }, null, 2) + '\n');
console.log(`Release repository configured: ${repository}`);
