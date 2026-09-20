# .dsh/contracts/README — 约定式 workspace 契约结构（敏捷模式 agile）

> 这是"零代码新项目接入"的规范说明。任何项目在本 workspace 的 `.dsh/` 下按此约定放置文件，
> 敏捷模式编排人格（预设内建，非外部插件）会话开始时自动读取；派发时把契约清单写进派发提示词、由子代理开工前自读契约（2026-09-09 用户决策），**无需编写任何 host 逻辑**。
> 敏捷模式自身足迹（技术骨架 / 角色契约 / skill + 临时工作区）全部收进 `<cwd>/.dsh/`，不污染真实项目根。
>
> **本文件只写敏捷模式的目录树。** workspace 的通用约定——**两态划分**、**交付单位 = `.dsh/` + `.env`**、
> **能力脚本位置**、**层内三种形态的分工**、**按角色 × 按 workspace 加载**、**回环控制律的唯一事实源**、
> **角色切分依据**、**所有权表**、**新项目接入步骤**——全部在 `_shared/contract-conventions.md`，**读那一份**。
> **不在这里重抄一遍**：同一份内容两处存放，实测已经漂移过（调研侧六节全缺）。

## 目录约定

```
<workspace>/.dsh/
├── profile.yaml                # 声明式技术骨架（项目事实声明）
├── contracts/
│   ├── _shared/                # 两模式共用的唯一正本（所有角色子代理必读）
│   │   ├── engineering-rules.md      # 通用方法论基线
│   │   ├── contract-conventions.md      # 本目录结构的通用约定（两态划分/交付单位/所有权表…）
│   │   └── qa-common.md                 # QA 通用检查契约（只在派发 QA 时加载）
│   ├── architect/              # 架构师契约（设计模板/根因/文档规范/契约维护）
│   ├── developer/              # 开发专家契约（编码规范/接口契约/包结构）
│   ├── tester/                 # 测试专家契约（数据驱动/双层断言/报告）
│   ├── deployer/               # 部署专家契约（Makefile/部署验证/脚本复用）
│   └── qa/                     # QA 检查标准（敏捷专属 D/C/P 检查项；通用规则见 _shared/qa-common.md）
├── skills/                     # 项目级 skill（低频大知识）挂载源（官方 skill-filesystem 发现根）
├── tools/                      # 模式能力脚本（随项目分发；用法见 skills，触发见契约）
├── reports/                    # 临时产物（链级闭环随 .dsh/tmp/ 一并**删除**，不保留永久档案）
└── tmp/                        # 临时工作区（一次性轮级产物，闭环**删除**）
    ├── architect/  developer/  tester/  deployer/   # 各角色一次性草稿/探针/中间物
    └── audits/                               # QA 每轮审计（中间轮随轮级闭环清理）
```

**两态划分（正式产出 vs 临时产物）、交付单位、所有权表、回环控制律**见 `_shared/contract-conventions.md`。
