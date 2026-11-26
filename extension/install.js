(() => {
  'use strict';
  const config = globalThis.ZLI_INSTALL || { version: '', repository: '' };
  const input = document.getElementById('repo');
  const status = document.getElementById('repository-status');
  document.getElementById('version').textContent = `v${config.version}`;
  function normalize(value) {
    return value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  }
  function bind(value) {
    const repository = normalize(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) {
      status.textContent = '请输入完整的 GitHub 仓库链接或 owner/repo。'; return;
    }
    const home = `https://github.com/${repository}`, latest = `${home}/releases/latest`;
    const destinations = {
      'install-script': `${latest}/download/zhihu-long-image.user.js`,
      'install-extension': `${latest}/download/zhihu-long-image-extension.zip`,
      'release-notes': latest,
      source: `${latest}/download/zhihu-long-image-source.zip`,
      issues: `${home}/issues`,
      privacy: `${home}/blob/HEAD/PRIVACY.md`,
      license: `${home}/blob/HEAD/LICENSE`,
    };
    for (const [id, url] of Object.entries(destinations)) {
      const link = document.getElementById(id); link.href = url; link.removeAttribute('aria-disabled');
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
    input.value = repository; status.textContent = `已绑定 ${repository}，按钮始终指向最新正式 Release。`;
  }
  document.getElementById('repository-form').addEventListener('submit', event => { event.preventDefault(); bind(input.value); });
  let inferred = config.repository;
  if (!inferred && location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.split('.')[0], project = location.pathname.split('/').filter(Boolean)[0];
    if (project && project !== 'docs') inferred = `${owner}/${project}`;
  }
  if (inferred) bind(inferred);
})();
