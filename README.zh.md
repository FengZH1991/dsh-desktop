<h1 align="center">
  <img src="docs/images/readme-logo-black-v020.png" width="64" alt="DSH Desktop Logo" valign="middle" />
  DSH Desktop —— 社区 Fork
</h1>

<p align="center">
  为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 打造的本地优先桌面应用。
  本仓库 fork 自 <a href="https://github.com/dataelement/dsh-desktop">dataelement/dsh-desktop</a>，
  增加了适用于未签名构建的自托管自动更新渠道。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-171513.svg" /></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon-171513.svg" />
  <a href="https://github.com/FengZH1991/dsh-desktop/releases"><img alt="下载" src="https://img.shields.io/badge/download-releases-171513.svg" /></a>
</p>

> [!NOTE]
> 这是**非官方的社区 fork**，不是官方 DSH Desktop。
> 如需官方签名、公证过的正式产品（macOS Intel/ARM、Windows x64），
> 请使用 [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)
> 和官网 [dshdesktop.com](https://www.dshdesktop.com/)。

## 为什么会有这个 fork

官方桌面版从厂商的签名发布源自动更新，这套机制依赖 Apple Developer ID
签名证书——个人自建的副本没有证书，只会永远落后、又无法走官方渠道升级。
本 fork 增加了一个任何 fork 维护者都能用 **自己的 GitHub Releases** 运营的
更新渠道，不需要任何签名证书。

## 与上游的差异

包含上游 0.1.1 的全部功能，另外增加：

- **面向未签名构建的自托管自动更新** —— 应用检查本仓库 GitHub Releases 上的
  `latest-mac.json` 清单，SHA-512 校验下载内容，然后用替换式安装器完成升级
  （解压 → 校验是同一个应用 → 退出后换包 → 自动重启，失败自动回滚）。
  上游的更新界面、状态机和「跳过此版本」行为原样复用；
  fork 安装器暂不支持 Windows。
- **全局快捷键** 唤起/隐藏窗口。
- **原生桌面通知**：有人在等你看的事件会弹系统通知。
- **一键发布脚本** —— `npm run release:local` 自动完成版本递增、打包、
  哈希计算、发布 GitHub Release 并附带更新清单。
- fork 版本号采用 `<上游版本>-feng.N` 形式（如 `0.1.1-feng.2`），
  与上游版本号干净排序。

## 下载与安装（macOS Apple Silicon）

从 [Releases](https://github.com/FengZH1991/dsh-desktop/releases) 下载
`dsh-desktop-mac-arm64.zip`（或 DMG）。

构建产物**未签名、未公证**，macOS Gatekeeper 首次启动会警告——
右键点击应用选择「打开」，或执行：

```sh
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
```

安装后，应用会在启动后不久及每六小时自动检查 fork 更新，
通过自己的「重启并安装」流程完成升级；也可在应用菜单手动检查。

## 运营你自己的更新渠道

更新源只是 GitHub Releases 上的一个 JSON 清单，任何 fork 都可以自建渠道：

1. 编辑 [`build/fork-update.json`](build/fork-update.json)，指向**你自己的**仓库。
2. 用 fork 打包配置构建：
   ```sh
   npm install          # 会自动应用 patches/ 下的 patch-package 补丁
   npm run test && npm run typecheck
   npm run package:fork:mac:arm64
   ```
3. 发布版本（需要 [`gh`](https://cli.github.com/) 登录，令牌需 `repo` 权限）：
   ```sh
   npm run release:local          # 加 --dry-run 可预览
   ```

发布脚本会自动递增 `-feng.N` 后缀、提交并推送、构建 zip/dmg、
计算 SHA-512 清单，并把所有产物附加到 GitHub Release。
已安装的副本会自动发现新版本。

如果构建产物中同时存在上游 `app-update.yml` 和 `fork-update.json`，
上游更新器优先——只有上游渠道不存在时 fork 渠道才生效，
因此将来合并上游对 `src/main/update/update-manager.ts` 的改动不会冲突。

## 官方产品与上游版本

本仓库是社区 fork。需要官方签名版本请看原厂商渠道：

- 官方下载：<https://dshdesktop.com/#download>（中文站 <https://dshdesktop.com/zh/>）
- 上游源码与 **Pre-release** 预览版：<https://github.com/dataelement/dsh-desktop/releases>

## 技术要点

- 内置 DeepSeek Harness 运行时 `@deepseek-ai/dsh@0.1.2-rc.1`，以固定版本 tarball +
  `patch-package` 补丁方式交付，应用可完全离线运行，无需全局安装。
- 运行时同时支持 `--safe-mode`（安全模式）启动，便于排障。
- 局域网手机端访问通过 **Cloudflare Quick Tunnel** 打通，同一网络下手机即可操作会话。
- Windows 安装包使用 **NSIS**，macOS 提供 DMG + ZIP。

## 文档

- [架构](docs/architecture.md) 与 [开发指南](docs/development.md) —— 继承自上游；
  其中关于官方更新源与代码签名的章节描述的是**上游产品**，不适用于本 fork。
- [模型切换排障](docs/model-switch-troubleshooting.md) —— 容量/上下文溢出/REQUEST_EXTENSION 三类失败的成因与修复
- [Preset 包格式](docs/preset-packages.md)
- [PPT 运行时指南](packages/ppt-runtime/README.md)

## 第三方项目与署名

本项目建立在他人的工作之上，完整清单见 [NOTICE.md](NOTICE.md)。摘要：

- **[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)**
  （MIT，© DataElement）—— 本 fork 的上游项目，绝大部分代码来自他们。
- **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**
  （MIT）—— 应用内承载的 Agent 运行时与 Web UI；以 tarball 形式内置于
  `packages/harness-0.1.2-rc.1/`，并通过 `patches/` 下 21 个
  `patch-package` 补丁做适配。
- **Electron**、**electron-builder**、**electron-vite** 及
  `package-lock.json` 中列出的其他依赖，各自遵循其原有许可证。

「DeepSeek」「DSH Desktop」名称与图标归各自所有者所有；
本 fork 与其无任何隶属或背书关系。

## 许可证

基于 [MIT 许可证](LICENSE)开源 —— 允许商用、修改与再分发，
前提是保留版权声明。上游代码 © DataElement；fork 修改 © FengZH1991。
