# 发布指南

作者署名：jasonLi。仓库建议名称：`zhihu-long-image`，公开。

## 先检查内容

只发布本项目目录。不要把上一级“杂项”工作区、个人资料、其他项目、凭证或 `.env` 带入仓库。

```sh
npm run build
npm test
npm run package
```

运行后 `dist/` 中有扩展 ZIP、油猴脚本及源码 ZIP。扩展 ZIP 的根目录直接包含 `manifest.json`，可以用于本地安装或提交 Chrome Web Store 审核。

## 建立 GitHub 仓库

在 GitHub 创建一个空的公开仓库，名称可用 `zhihu-long-image`。以下 `YOUR_GITHUB_ACCOUNT` 必须替换成实际账号；显示署名 jasonLi 不自动证明对应登录账号的所有权。

如果本目录已经是独立 Git 仓库，可跳过 `git init`。下列命令必须在**本项目目录**运行，不能在包含其他项目的父目录运行：

```sh
git init -b main
git add .
git commit -m "Release Zhihu Long Image userscript and Chrome extension"
git remote add origin https://github.com/YOUR_GITHUB_ACCOUNT/zhihu-long-image.git
git push -u origin main
```

也可以在 GitHub 新仓库网页用 Upload files 上传本目录的文件，保留子目录层级。

## 让别人一键安装油猴脚本

1. 将源码上传到自己的仓库，保留 `.github/workflows/release.yml`。
2. 推送与版本对应的标签，例如 `v1.8.0`，等待Release工作流成功。
3. 分发Release中的 `zhihu-long-image.user.js` 或安装指南页面的链接。

工作流使用 `GITHUB_REPOSITORY` 自动绑定实际账号和仓库，生成稳定的下载地址及独立 `.meta.js` 更新地址。用户从该Release安装一次后，Tampermonkey可按其更新设置自动检查新版本。不要将源码中未绑定的Raw脚本宣传为已经配置在线自动更新。

如果需要在本地先绑定自己的仓库，再生成安装包：

```sh
node scripts/configure-release.cjs YOUR_GITHUB_ACCOUNT/zhihu-long-image
npm run build
npm test
npm run package
```

`release-config.json`、用户脚本元数据、扩展的安装页和更新入口会自动使用实际地址。不要填写别人的账号；本项目默认留空，示例名不是已发布地址。

## 公开安装页

`docs/install.html` 可本地直接打开，也已放入扩展包，通过弹窗“安装与更新指南”打开。首次没有绑定仓库时，输入仓库链接即可生成下载入口；生成链接不等于远程Release已存在。

若要公开提供网页，在仓库 Settings → Pages 中选择从 `main` 分支 `/docs` 发布，之后打开 `https://YOUR_GITHUB_ACCOUNT.github.io/zhihu-long-image/install.html`。GitHub Pages域名下会自动识别账号与仓库。将实际网页地址放在README顶部。启用Pages和发布Release都由仓库所有者在GitHub完成，本地构建不会替你发布。

## 扩展如何更新

开发者模式安装的扩展不会像商店版那样自动更新。用户点击弹窗“查看最新发布”，下载稳定名称的扩展ZIP，解压覆盖**原安装目录**，在扩展管理页点击重新加载，再刷新知乎即可。不要卸载后从不同目录重新安装，以免改变扩展ID并丢失本地设置。

## 自动生成 Release

仓库包含 GitHub Actions：

- push / pull_request 自动运行构建和测试。
- 推送 `v1.8.0` 形式的标签时，验证标签与 package.json 一致，自动绑定仓库，构建并上传版本化及稳定名称的扩展/源码ZIP、用户脚本、`.meta.js`、校验文件到GitHub Release。

```sh
git tag v1.8.0
git push origin v1.8.0
```

首次发布前应在登录的知乎提问页面人工核对：前2条回答的顺序和末尾、图片、取消、单张/分图、扩展设置保存及刷新生效、付费提示与短缺提示。现有自动测试不替代这一检查。

更新版本时同步修改 package.json、用户脚本元数据、manifest.json 和弹窗版本文字，再构建、测试和打新标签。

## Chrome Web Store

从 GitHub 下载 ZIP 后“加载已解压的扩展”属于开发者模式安装。让普通用户从商店直接安装，需要维护者另行上架：

1. 使用自己的 Google 账号注册 [Chrome Web Store 开发者账号](https://developer.chrome.com/docs/webstore/register)，按当时要求完成注册、费用及验证。
2. 在开发者控制台新建项目，上传 `dist/zhihu-long-image-extension-v1.8.0.zip`。
3. 填写简介、完整说明、分类、语言和真实联系方式；开发者公开身份由账号配置决定，代码中的 `author` 字段不会替代商店身份信息。
4. 提供真实扩展截图、商店要求尺寸的素材；代码中已包含16/48/128像素图标。不要将尚未实测的效果描述为保证。
5. 把本仓库 `PRIVACY.md` 的公开链接填入隐私政策地址。按实际行为填写隐私披露和权限用途，说明只读取用户打开的知乎内容、没有远程代码和遥测。
6. 按控制台要求填写审核说明，并提交审核。未审核通过前不要宣传为商店上架版。

商店注册、身份验证、费用支付及正式提交应由账号所有者完成。GitHub Release、本地加载版与商店上架是不同状态。
