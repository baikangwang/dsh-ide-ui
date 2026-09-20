# contracts/deployer — 部署专家契约与规则（形态 B，按角色注入）
> 来源基线（**模式仓库 agent-mode 的历史溯源，目标项目不需要 `baseline/`**）：baseline/project/agents/部署专家.md、baseline/global/rules/04-部署与验证.mdc、baseline/project/rules/Git提交编码规范.mdc
> 注入时机：编排者调度到「部署专家」阶段 / 部署操作时

> **项目专属取值一律来自 `.dsh/profile.yaml`**（2026-09-18 修订）。占位符 `{{paths.*}}` / `{{tech_stack.*}}` 解析到对应键。
> **`profile.yaml` 未声明 `deploy` 的项目（如本仓库 agent-mode），本契约整体不适用**——由架构师在接入时判定并说明，不留着不执行。

## 三段职责必须分清（2026-09-18 修订）

此前本契约自相矛盾：一处称"真实 K8s 部署执行属排他（Jenkins 负责）"，另一处又规定部署专家远程跑 `kubectl` 并验证 rollout。现明确为三段：

| 段 | 归属 | 内容 |
|---|---|---|
| **写编排定义** | **部署专家** | Makefile、构建/镜像定义 |
| **执行部署** | **Jenkins（排他）** | 真实 K8s 部署执行；AI 不直接执行 |
| **只读验证** | **部署专家** | 经 `{{paths.remote_entry}}` 只读查询 rollout 状态与镜像 tag，**不写入集群** |

## 职责与边界
- 正式产出：Makefile 编写（及 profile 声明的部署编排定义）
- 临时产出：`.dsh/tmp/deployer/deploy_{timestamp}.json`（部署报告、dry-run 草稿，闭环清理）
- 排他：Jenkins 流水线配置、真实 K8s 部署执行（由 Jenkins 负责）；AI 仅写 Makefile/编排定义
- **禁止写入**：`{{paths.source}}`、`{{paths.docs}}`

## Makefile 标准结构

> **下面只给"形状"，不给取值。** 四个变量（`REGISTRY` / `IMAGE` / `SERVICE` / `PLATFORM`）
> 以及 build/clean 命令**一律取自 `profile.yaml` 与目标项目现有 Makefile**。
>
> **2026-09-18 修订**：本节此前把 compute-core 的字面量当作"标准结构"——
> `harbor-local.unicloudsrv.com/moove`、`uca-compute-core`、`./gradlew build -x test`、`./gradlew clean`。
> 后果具体：**非该技术栈的项目接入后，本节要么原样照抄（写进错的仓库地址），要么整节作废**。
> 现在是"填空"，不是"照抄"。

```makefile
REGISTRY ?= {{deploy.registry}}          # 目标项目的制品仓库
PLATFORM ?= {{deploy.arch}}         # 目标架构
DOCKERFILE ?= Dockerfile
IMAGE ?= {{deploy.service}}
SERVICE ?= {{deploy.service}}
VERSION := $(shell git describe --dirty --always --tags | sed 's/-/./g')
GIT_COMMIT := $(shell git rev-parse --short HEAD)

.PHONY: build
build:
	@{{tech_stack.build}}                  # 项目未声明构建系统 → 本目标判「不适用」

.PHONY: image.develop.tag
image.develop.tag: build
	# 制品构建 + 推送 + 滚动更新

.PHONY: image.release.tag
image.release.tag: build

.PHONY: image.remove
image.remove:
	docker image rm $(REGISTRY)/$(IMAGE):$(VERSION)

.PHONY: clean
clean:
	@{{tech_stack.clean}}
```

## 关键约束
- build：`{{tech_stack.build}}`；**项目未声明构建系统时本项判「不适用」，不是 FAIL**
- 制品构建：多架构 buildx + push；**构建命令与产物路径取自 profile 的 `tech_stack.build`**，
  不预设 jar/镜像层细节（原写死 `--build-arg JAR_FILE=build/libs/*.jar`，只对 Gradle 项目成立）
  - 开发版 tag：$(REGISTRY)/$(IMAGE):$(VERSION).$(GIT_COMMIT)
  - 正式版 tag：$(REGISTRY)/$(IMAGE):$(VERSION)
- 部署（通过 {{paths.remote_entry}}）：按目标项目的编排方式执行；**本契约不预设 kubectl**
- **以目标项目现有 Makefile 为参考模板**——这是首位的，上面的形状是兜底

## 部署验证
1. 部署后验证服务已用新版本：经 {{paths.remote_entry}} 远程查询 deployment 镜像 tag，与本地 VERSION 一致
2. 确认 rollout 完成、Pod Ready：经 {{paths.remote_entry}} 远程 `kubectl rollout status deployment/<service>`
3. 构建缓存：重新执行 `{{tech_stack.build}}` + 制品构建，确认产物确为本次构建（避免构建层/Docker 层缓存带进旧产物）

## 脚本复用原则
1. 依赖/组件下载优先级：服务器网络 → 本地代理 → 本地桥接代理
2. 脚本优先复用当前项目已有脚本
3. 在原有脚本上更新升级能力，不写重复逻辑
4. 新脚本写入对应功能目录（tools/、scripts/、deploy/）
5. 禁止临时脚本散落根目录、重复实现已有功能

## 经验教训
| # | 教训 | 规则 |
|---|------|------|
| 1 | platform 格式 | linux.amd64 需转 linux/amd64 供 Docker buildx |
| 2 | JAR 文件 | 使用 build/libs/*.jar 通配，避免硬编码版本号 |
| 3 | 多架构 | buildx 需 docker buildx create --use 预先创建 builder |
| 4 | K8s 部署 | 通过 {{paths.remote_entry}}，不直接 ssh |

## 部署报告
写入 `.dsh/tmp/deployer/deploy_{timestamp}.json`（含 targets_defined、variables_defined、gradle_build）。
若含前端变更，须含 frontend_assets_verified（local/remote 文件数对比 + 采样 URL 状态）。
临时报告闭环时清理；链级闭环时 `.dsh/reports/` 随 `.dsh/tmp/` 一并清空（最终部署结论由编排者在本会话向用户汇报，不保留永久档案）。

## Git 提交编码（应对中文乱码）
- **推荐链路**：用 `write`/`edit` 工具写提交信息（干净 UTF-8、无 BOM）→ `git commit -F <文件>`（git 直接读文件字节，不经 PowerShell 解码）
- **禁止**把提交信息"读过 PowerShell"：`Get-Content <msg> | git commit -F -` 或 `git commit -m "$(Get-Content …)"`——dsh 的 `pwsh` 跑 Windows PowerShell 5.1、本机 ANSI 代码页 936(GBK)，按 GBK 误解码 UTF-8 会乱码（实测复现）
- 提交后自检 commit 对象字节无 BOM（efbbbf/bbbf/fffe）/mojibake
- 提交格式：`<type>: <主题>` + 正文 bullet
