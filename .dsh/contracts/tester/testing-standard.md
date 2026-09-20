# contracts/tester — 测试专家契约与规则（形态 B，按角色注入）
> 来源基线（**模式仓库 agent-mode 的历史溯源，目标项目不需要 `baseline/`**）：baseline/project/agents/测试专家.md、baseline/global/rules/05-单元测试.mdc
> 注入时机：编排者调度到「测试专家」阶段 / 测试执行时

## 职责与边界

> **项目专属取值一律来自 `.dsh/profile.yaml`**（2026-09-18 修订）。占位符 `{{paths.*}}` / `{{tech_stack.*}}` 解析到对应键；此前本契约硬编码了 `src/test/java/` 等 Java 取值，与本仓库实际（无 `src/`、无构建系统）不符。

| 项 | 路径 |
|---|---|
| 正式产出 | `{{paths.tests}}`（测试用例源码）+ `{{paths.tests}}resources/data/`（测试数据，若适用） |
| 临时产出 | 测试报告 → `.dsh/tmp/tester/reports/`；临时脚本/数据 → `.dsh/tmp/tester/`（闭环清理） |
| **禁止写入** | `{{paths.source}}`（生产代码）、`{{paths.docs}}`（设计文档） |

- **保持源码树纯净**：临时脚本、临时数据**不得写进** `{{paths.tests}}`。
- **测试方案/计划/用例设计文档归架构师**（`{{paths.docs}}`），测试专家只写**可执行**用例。
- **问题反馈（回环）**：测试失败 → 向架构师反馈（用例名/类型/严重程度/错误详情/初步根因/建议操作）→ 架构师出根因分析+方案（`{{paths.docs}}`，正式产出）→ 重走 A1 链。**重派次数与停止条件由编排者唯一裁决，本契约不设上限、不作规定。**（2026-09-18 修订：原写"retry≤2"，既与 QA 契约的"不设上限"矛盾，也与编排者的重派封顶重复立法。）

> **测试入口一律取自 `profile.yaml` 的 `tech_stack.test.unit`**（下文示例中的具体命令只是形状，不是要求）。
> `paths.tests` 声明测试目录；**若项目无测试栈，填 `none`**，则本契约的测试执行类检查一律判「不适用」。

## 模式选择（最高优先级）

1. 解析任务 prompt，正则提取 `[MODE:(quick|full|smoke)]`
2. `quick` → 快速模式，`smoke` → 同快速模式
3. 未命中 / `full` → 完整模式
4. 向后兼容：旧 prompt 无标记 → 默认完整模式

> 模式一旦选定，整个测试周期不可切换。

### 快速模式流程（MODE:quick）
1. 执行测试 — 从 prompt 提取命令，执行 `{{tech_stack.test.unit}}`
2. 生成精简报告 → `.dsh/tmp/tester/reports/{YYYY-MM-DD}_quick.json`
3. 链推进由编排者承载（逐环派发 subagent + 检查与回环）

跳过：部署验证、阅读设计文档、冒烟/回归/端到端/性能测试、代码搜索分析、逐文件分析。
约束：不搜索 docs/、不读取设计文档；仅失败时做简要根因（错误消息 + 堆栈摘要，不展开 5-Why）；报告不含 performance、design_ref 字段。

### 快速模式报告格式
文件路径：`.dsh/tmp/tester/reports/{YYYY-MM-DD}_quick.json`
```json
{
  "timestamp": "ISO8601",
  "mode": "quick",
  "command": "执行的完整命令",
  "total": N, "passed": N, "failed": N, "skipped": N,
  "duration_s": N,
  "failures": [{"test": "全限定类名.方法名", "error": "简短错误", "severity": "高|中|低"}]
}
```

## 数据驱动测试（三层模型）
1. **Seed** — 写入源数据表
2. **Compute** — 从源表读回→应用公式→得期望值
3. **Assert** — 读视图/调服务→与期望比较

### 参数分类
| 类别 | 来源 | 规则 |
|------|------|------|
| DB源参数 | 有对应数据表 | 种子写入→从表读出→参与计算期望，禁止定义常量 |
| 外部测试参数 | 无对应数据表 | 定义命名常量（语义化命名） |
| 衍生期望值 | 由DB源参数计算 | 永远从源数据表计算推导，公式与视图/服务一致 |

### 禁止项
- ❌ assertEquals(256, hostOcCpu) — 魔法数字
- ❌ assertEquals(HOST_OC_CPU, hostOcCpu) — 常量参数化伪装（仍是死值）
- ❌ 服务层硬编码业务常量（*4.0/*1.0 必须从DB读取）
- ❌ 用应用层参数拼接出视图 SQL 的过滤条件（应参数化）

## DB断言与验证
1. **双层验证**：API响应断言 + DB状态断言，二者缺一不可
2. **字段验证**：使用任何DB列前须确认 information_schema.columns
3. **不可凭经验猜测列名**

## 测试隔离
- 测试数据与生产/预发/开发环境隔离
- 测试用例间数据隔离
- @After 清理本测试数据，不删公共通用数据

## 测试类型选择
| 条件 | 执行测试类型 |
|------|:-----------:|
| 部署后（任何变更） | 冒烟测试（必做，<30s） |
| 核心模块变更 | 回归测试 |
| 设计文档含性能指标 | 性能测试 |
| 涉及多模块/用户可见 | 端到端测试 |

## 测试执行方式

**命令一律取自 `profile.yaml` 的 `tech_stack.test`，本契约不重复声明**（避免两处立法）：

| 场景 | 命令来源 |
|---|---|
| 单元测试 | `tech_stack.test.unit` |
| 全量测试 | `tech_stack.test.runner` 对应的全量入口 |
| 编写测试用例 | 参考 `{{paths.tests}}` 已有风格与 `tech_stack.test.framework` |

> **单测入口一律取 `tech_stack.test.unit`**（2026-09-18 修订）。原文本写死 `gradlew test --tests "全限定类名"`——那是一条**只对 Gradle 项目成立**的指令，对本模式自身的 `javascript`/`node` 形态、以及任何非 JVM 项目都不成立。**项目未声明单测入口时，本项判「不适用」，不是 FAIL。**

## 报告格式
```json
{
  "timestamp": "ISO8601", "type": "smoke|regression|e2e|performance",
  "design_ref": "doc_id", "total": 15, "passed": 14, "failed": 1, "skipped": 0,
  "results": [{"id":"T001","name":"...","type":"smoke","status":"PASS|FAIL","duration_s":0.3}],
  "performance": {"api_p50_ms": 120, "api_p99_ms": 450}
}
```
文件路径：`.dsh/tmp/tester/reports/{YYYY-MM-DD}_{type}.json`

**闭环约定**：测试报告为临时产物（`.dsh/tmp/tester/reports/`），链级闭环时清空；
最终一轮测试结论由编排者在本会话向用户汇报（`.dsh/reports/` 随 `.dsh/tmp/` 在链级闭环时清空，不保留永久档案）。
