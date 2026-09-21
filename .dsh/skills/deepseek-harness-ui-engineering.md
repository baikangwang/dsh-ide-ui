---
name: deepseek-harness-ui-engineering
description: deepseek-harness-UI（npm 包 dsh-ide-ui）工程知识：单包双面结构、tsdown 构建机制、槽位策略、装进 DSH profile 的部署与 30 项验证、v* tag 触发的发布链路、以及本项目特有的坑。
whenToUse: 在 deepseek-harness-UI 项目做开发 / 构建 / 部署 / 发布 / 排障，需要项目级工程上下文时。
---

# deepseek-harness-ui-engineering — 项目级 skill（按需加载）

> 属性：项目级（`.dsh/skills/` 官方发现根）。
> **本文只写本项目专属事实**；通用方法论见 `.dsh/contracts/_shared/engineering-rules.md`，
> 声明式取值见 `.dsh/profile.yaml`，文档写法见 skill `design-doc-writing`，脚本用法见 skill `agile-toolkit`。

## 1. 项目概览

| 项 | 值 |
|---|---|
| npm 包名 / 目录 | `dsh-ide-ui` / `packages/ide`（单仓单包） |
| 版本（实测） | `0.1.0-rc.20` |
| 定位 | DeepSeek Harness Web UI 的 **VSCode 风格工作台**插件；**非官方社区插件**（Unofficial，MIT） |
| 仓库 / 远端 | `https://github.com/baikangwang/dsh-ide-ui.git`（单远端 origin） |
| 分支 | 稳定分支 **`master`**（不是 `main`） |
| 语言 | TypeScript（`target es2024` / `module esnext` / `strict` / `noEmit` / `jsx: react-jsx`） |
| 包管理 | pnpm 11（`pnpm-workspace.yaml` 的 `packages/*`）；**本机 PATH 上没有 pnpm**，用 `corepack pnpm`（实测 11.7.0） |

**"单包、双面"是本项目最重要的结构事实**：一个 npm 包同时携带
Host 半（`ide` Remote 能力服务：文件系统 / git / 搜索 / 系统操作）与浏览器半
（侧栏 + 编辑器 UI），经官方 `sidebar.workspaces` / `conversation.view` 槽位组合，
**零官方源码修改**。发布物是单个 npm 包；`scripts/verify-ide-plugin.ps1` 里有专门的
检查项保证旧包名不再出现（`dsh-client-ide-ui removed`、`patch has no ui-ide row`）。

## 2. 目录与写域纪律

```
packages/ide/
├── src/                       ← 唯一源码树（paths.source）
│   ├── index.ts               Host 半：IdeService（带 @Remote 装饰器）
│   ├── invariant.ts           不变量声明（独立入口，产物 lib/invariant.js）
│   ├── types.ts               跨面共享类型
│   ├── settings.ts / settings-shared.ts   设置面（Host 与浏览器半共用）
│   └── client/                浏览器半（React，无官方源码改动）
│       ├── index.ts           客户端插件入口（声明槽位与 bundle id）
│       ├── IdeSidebar.tsx     侧栏容器（logo + 活动栏 + 内容区）
│       ├── views.tsx          四个活动视图（资源管理器/搜索/源代码管理/会话）★ 最大文件
│       ├── EditorView.tsx     中栏「编辑器」标签页
│       ├── markdown.tsx       Markdown 渲染（GFM + KaTeX）
│       ├── fileicons.ts       文件图标映射 ★ 生成物，勿手改
│       ├── icons.tsx / slots.ts / stores.ts / lib.ts / settings-store.ts / version.ts
│       ├── styles.module.css  CSS Modules 样式
│       └── settings/card.tsx  设置卡片
├── lib/                       → tsdown 构建产物（勿手改）
├── tsdown.config.ts           构建配置（装饰器降级 + 客户端 bundle）
└── package.json               版本号、dsh.client 声明、依赖
```

- **改代码只动 `packages/ide/src/`**。`lib/` 是 `tsc`/`tsdown` 产物：手改会在下次构建被覆盖。
- `packages/ide/lib/client.js` 被 `.gitignore` 显式忽略（它 1.3 MB）；同目录其余 `lib/*.js` 与 `.d.ts`
  **是入库的构建产物**（`files` 字段声明的发布物），改 `@Remote` 接口面后需要重新构建并提交。
- `src/client/fileicons.ts`（约 82 KB）是**生成物**：由仓库根 `scripts/gen-fileicons-map.mjs`
  从 CodeBuddy genie 主题重新生成，不要手改。同类还有 `scripts/gen-typert-gitstatusmap.mjs`、
  `scripts/gen-typert-newmethods.mjs`（Typert 侧生成器）。
- 仓库根 `scripts/` 是发布 / 验证 / 生成脚本（`paths.tests` 指向它）；
  `skills/release/SKILL.md` 是发布操作层 skill（挂到 agent 预设用）；
  `dist/` 放 tgz / 离线 zip 与历史备份，不是源码。

## 3. 构建：tsdown 自包含，三产物

```sh
npm --prefix packages/ide run build       # = tsdown，实测退出码 0，约 3 秒
npm --prefix packages/ide run typecheck   # = tsc --noEmit，实测退出码 0
corepack pnpm build                       # 规范写法（需 pnpm 在 PATH 上；本机没有）
```

- **`.dsh/profile.yaml` 的 `build` 键必须写 `npm --prefix packages/ide run build`**：该键会被
  code-gate 的 C5 **真的执行**并取退出码；本机没有 pnpm，写 `pnpm build` 会让 C5 FAIL。
- **产物三件**：`lib/index.js`（Host 半）、`lib/invariant.js`、`lib/client.js`（浏览器半 CJS bundle），
  外加 `lib/types/**` 与 `lib/typert.*`（Typert 协议产物，只在 `@Remote` 接口面变化时重新生成）。
- **装饰器降级是本项目构建的核心难点**（`tsdown.config.ts` 顶部有完整说明）：官方流水线先 `tsc`
  产出 `__esDecorate` 辅助函数、再由 tsdown 打包；本项目自包含构建直接用 tsdown 编译 `.ts`，
  而 rolldown/oxc 会保留原生 `@dec` 语法——**Node 的 ESM 加载器解析不了**。
  因此配置里有一个 `dshide-lower-decorators` 插件，对含 `@` 的 `.ts` 回放 tsc 的降级。
  **动构建配置前先读懂这一段**，否则 Host 半会在 `import()` 时炸。
- `@deepseek-ai/dsh-typert-protocol` 保持 external（运行时 peer）；其余 `@deepseek-ai/*` 导入是纯类型、会被擦除。
- **⚠️ BOM 会让构建崩**：tsdown 读 `package.json`，遇 BOM 直接失败。用 PowerShell 改 `packages/ide/package.json`
  的 version 时，**必须**用 `UTF8Encoding($false)` 写回（`docs/deployment.md` §2 有实测记录）。

## 4. 部署：装进本机 DSH profile（**不是容器部署**）

本项目**没有服务器 / 容器 / K8s 部署**。`deploy` 段的真实含义是"把包装进本机 DSH profile"：

```powershell
# 1) 打包（npm pack 需要临时 cache）
npm pack packages/ide            # → dist/dsh-ide-ui-<version>.tgz
# 2) 解包/替换 ~/.dsh/profiles/<name>/node_modules/dsh-ide-ui
# 3) profile 的 package.json 依赖指向 file:…/dsh-ide-ui-<version>.tgz
# 4) profile 的 cordis.patch.yml **单行**激活：
#      - insert:
#          - id: ide-ui
#            name: 'dsh-ide-ui'
# 5) node scripts/verify-ide-plugin.ps1   全绿后重启 dsh web
```

- **无编译环境的目标机**：用 `dist/dsh-ide-ui-offline-<version>.zip`（预编译 + 一键脚本），
  解压后跑 `scripts/offline/install-dsh-ide-ui.ps1`（默认装到 `~/.dsh/profiles/web`，可 `-ProfileName`）。
- **生效条件不对称（实测结论）**：**Host 半改动必须完全重启 `dsh web` 进程，刷新页面不够**；
  浏览器半改动刷新页面即可。
- **`scripts/verify-ide-plugin.ps1` 的边界，必须知道**：
  - 它**绑定本机固定路径** `$env:USERPROFILE\.dsh\profiles\web` 与**固定版本** `0.1.0-rc.20`
    （检查 `client bundle id`、`version is rc.20`、`fallback junctions >= 190` 等 30 项）。
  - 因此它**不是可以随手跑的自检**：profile 名不同或版本 bump 后，不改脚本就会假红。
    跑之前先确认这两点，或按当前 profile/版本改脚本。
  - 它的结论口径是"改完代码、装进 profile 之后，重启前是否全绿"，不是"仓库是否健康"。

## 5. 测试与验证：**本项目没有单元测试**

- 全仓**没有** test 脚本、没有测试用例目录、没有测试框架（`jest`/`vitest`/`node:test` 均无）。
  这一点是实测事实，不要按"应该有单测"去设计流程。
- 现有的可跑验证资产只有两类，登记在 `profile.yaml` 的 `tech_stack.test` 与 `checks`：
  1. `npm --prefix packages/ide run typecheck`（`tsc --noEmit`，构建前的第一道闸）；
  2. `node .dsh/tests/ref-integrity-check.mjs` 等 **3 支交付件自检**（随 `.dsh/` 交付，可重跑）。
- **功能验证目前是人工的**：按 `docs/deployment.md` §6「验证点」在真实页面上逐项点验。
  新增功能时，验证步骤要写进设计文档的实施清单，不要默认有自动化回归。
- **旧的 `docs/smoke-rc20.md` 是上一轮 rc.20 的冒烟记录**，是历史证物，不是可重跑的脚本。

## 6. 发布：`v*` tag → GitHub Actions（不是 npm publish）

```
编辑 packages/ide/package.json 的 version → commit → git push origin master（普通推送，零触发）
node scripts/dsh-release.mjs            # 交互；agent 场景：--yes；预演：--dry-run
   ↓ 自动读版本 → 打 v<version> tag → push
.github/workflows/release.yml           # 校验版本与 tag 一致 → typecheck → build → npm pack → 离线 zip → GitHub Release
```

- 项目差异**全部收敛在仓库根 `dsh-release.json`**（`packageDir` / `packageName` / `tagPrefix` /
  `offline` / 命令 / `pnpmVersion`），改项目不改脚本。
- 当前 `npm: false`（**不发 npm registry**，制品走 GitHub Release + 离线 zip）。
- **只推 `v*` tag 才触发构建**；普通 `git push` 完全零触发。确认点在打 tag 之前。
- 已在 `docs/cicd.md` 记录过的坑（不要重新踩）：lockfile 陈旧导致 `ERR_PNPM_OUTDATED_LOCKFILE`；
  **CI 冷环境**缺类型依赖报一片 `TS2307`（本地因为已有 `node_modules` 而看不见，这是最大的一类本地/CI 差异）；
  Node 20 弃用让 action 报错；PowerShell 脚本编码（BOM）；GitHub Actions 的 `env`/`secrets` 求值时机。

## 7. 本项目特有的纪律与坑

1. **`.dsh/tools/` 是副本，不要手改**。它们是 agent-mode 仓库 `.dsh/tools/` 的副本（文件头两行写着正本位置
   与生成时间）。改了副本会造成"同一判据在不同项目给出不同答案"的**副本漂移**。要改进工具，
   走模式仓库的正本 + `node dev/sync-tools.mjs` 分发。
2. **接入/复制 `.dsh/` 时务必逐份核对身份**：写错的特征是"契约与 profile 都在、
   检查也照常出结论"，不会自己报错。
3. **`.gitignore` 第 5 行是 `.dsh/`**，整个交付件被忽略、无法提交（`git ls-files .dsh` 为空）。
   `.gitignore` 里也**没有** `.env` 规则，`.env` 显示为未跟踪。修法见 `profile.yaml` 的
   `security.delivery_gap`（只登记，未执行）。
4. **`docs/CHANGELOG-设计文档.md` 与 `docs/CHANGELOG-运行台账.md` 目前不存在**：
   profile 里声明的是契约要求的路径，首次产生变更 / 首条链闭环时新建，别当已存在去引用。
5. **颜色与图标两层纪律**：颜色一律走 `--dsw-alias-*` 主题 token（自动适配浅/深色）；
   菜单图标沿用官方 `ic_ds_*` 字形（18px）。自造颜色会在主题切换时露馅。
6. **文件图标是"文件名 → 扩展名 → 语言 ID"三层映射**，与 VSCode / CodeBuddy 同源。
   改映射要改生成器再重生成 `fileicons.ts`，不要手改映射表（会与生成器打架）。
7. **槽位冲突**：`sidebar.workspaces` 用了 shadow 优先级 `-1` 以避开原生组件（原生是 0）。
   改槽位注册时要保持这个优先级，否则会与原生侧栏打架。
