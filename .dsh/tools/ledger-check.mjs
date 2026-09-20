// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/ledger-check.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/ledger-check.mjs。
// 副本生成时间：2026-09-20T09:07:20.327Z
/**
 * ledger-check.mjs — 运行台账的**格式**校验（P3c）
 *
 *   node .dsh/tools/ledger-check.mjs [台账路径]
 *
 * ## 它检查什么、不检查什么
 *
 * **检查**：表头字段是否齐全、每行是否 11 列、日期/链 id/FAIL 分布/置信度/判据异议的格式是否可解析、
 * 有没有重复的链 id。目的是让台账**能被机器读取**——格式一乱，P9 的"哪条判据反复失守"
 * 就算不出来，台账就退化成一堆散文。
 *
 * **不检查**：数字是否真实。**工具的边界必须说清**——它判不了"派发 3 次"是不是真的 3 次，
 * 那要靠证据链与人工。**把格式校验说成内容校验，是比不校验更坏的事。**
 *
 * `{{paths.*}}` 占位符在本工具里**不靠 shell 展开**，而是由本工具**自己去 `profile.yaml`
 * 读 `paths.run_ledger`**（2026-09-20 修：此前写死 `docs/CHANGELOG-运行台账.md`，
 * 于是消费项目改了落点就会报"台账不存在"，而**报错指向的位置本身是错的**——
 * 与 P10d「契约去项目字面量」同族的缺陷，只是长在工具侧）。
 *
 * **两种"还没开始"都算有效状态**（2026-09-20 修）：`run_ledger: none`（本项目尚未启用台账）
 * 与"路径已声明但文件尚未建立"（首次链闭环时才创建）**都输出 N/A 并以 0 退出**。
 * 此前只放过"文件存在但为空"，而"文件还没建"判 FAIL——**同一个原因两种结论**，
 * 而契约明说台账是首次闭环时建立的，于是每个新接入项目第一次跑必然假失败。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = resolve(HERE, '..', '..')

// ── 台账落点：优先命令行参数，否则读 profile.yaml 的 paths.run_ledger ──────────
function declaredLedger() {
  const p = join(ROOT, '.dsh', 'profile.yaml')
  if (!existsSync(p)) return { value: null, why: '无 .dsh/profile.yaml' }
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const m = raw.match(/^\s*run_ledger:\s*([^#\s]+)/)
    if (m) return { value: m[1], why: '.dsh/profile.yaml 的 paths.run_ledger' }
  }
  return { value: null, why: '.dsh/profile.yaml 未声明 paths.run_ledger' }
}

const arg = process.argv[2]
const declared = declaredLedger()
if (!arg && declared.value === 'none') {
  console.log('[ledger] N/A：本项目声明 `paths.run_ledger: none`（尚未启用运行台账）')
  console.log('        这不是通过，是"不适用"——启用时把该键改为实际路径即可。')
  process.exit(0)
}
if (!arg && declared.value === null) {
  console.log(`[ledger] N/A：${declared.why}，无法确定台账落点。`)
  console.log('        请先在 .dsh/profile.yaml 声明 paths.run_ledger（或显式传台账路径）。')
  process.exit(0)
}
const LEDGER = arg ? resolve(ROOT, arg) : resolve(ROOT, declared.value)

if (!existsSync(LEDGER)) {
  // 与"文件存在但为空"同一结论：都是"还没跑过链"，不是格式错误。
  console.log('[ledger] N/A：台账尚未建立（' + LEDGER + '）')
  console.log('        运行台账在**首次链闭环时**创建；契约明说这一步之前无历史数据可补录。')
  console.log('        因此"尚未建立"与"已建立但为空"**同为有效状态**，不判失败。')
  console.log('        落点来自：' + (arg ? '命令行参数' : declared.why))
  process.exit(0)
}

const FIELDS = ['日期', '链 id', '起止', '档位', '派发', '重派', '轮次', '结论', 'FAIL 分布', '置信度', '判据异议']
const GRADES = ['A0', 'A1', 'A2简', 'A2标准', 'A2深']
const VERDICTS = ['通过', '升级用户', '未闭环']
// P8 安全通道的两个落点（2026-09-20 第十二轮补）：契约 `_shared/qa-common.md`「不确定性的安全通道（P8）」
// 明说 `confidence` 与 `criterion_issue` **进运行台账**，而本工具的 FIELDS 原先只有 9 列、**没有这两列**
// ——**契约要求台账承载它，工具却禁止多列**。后果是链式的：P9 的规则复审没有第一手输入，
// 文档里那句"四问盘点因台账无数据答不了"**不是数据还没积累，是这条通道结构上不通**。
const CONFIDENCES = ['high', 'medium', 'low']

const lines = readFileSync(LEDGER, 'utf8').split('\n')
const problems = []
const notes = []

// ── 找台账表：包含全部字段名的表头行 ────────────────────────────────────────
let headIdx = -1
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].trim().startsWith('|')) continue
  const cells = lines[i].split('|').map((c) => c.trim()).filter(Boolean)
  if (FIELDS.every((f) => cells.includes(f))) { headIdx = i; break }
}
if (headIdx < 0) {
  console.error('✗ 找不到台账表头（应含全部字段：' + FIELDS.join(' / ') + '）')
  console.error('  → 台账格式已偏离规范，检查它是否被改写或标题被吞。')
  process.exit(1)
}
notes.push('表头在第 ' + (headIdx + 1) + ' 行，' + FIELDS.length + ' 个字段齐全')

// ── 逐行校验数据行（跳过表头与分隔行）───────────────────────────────────────
const seen = new Set()
let dataRows = 0
for (let i = headIdx + 1; i < lines.length; i++) {
  const raw = lines[i]
  if (!raw.trim().startsWith('|')) break
  const cells = raw.split('|').map((c) => c.trim())
  cells.shift(); cells.pop()
  if (cells.every((c) => /^-+$/.test(c) || c === '')) continue          // 分隔行
  if (cells.every((c) => c === '—' || c === '-')) { notes.push('台账当前为空（仅有占位行）——数据从下一条链开始'); continue }
  dataRows++
  const where = '第 ' + (i + 1) + ' 行'
  if (cells.length !== FIELDS.length) {
    problems.push(where + '：应有 ' + FIELDS.length + ' 列，实得 ' + cells.length + ' 列')
    continue
  }
  const [date, id, span, grade, dispatch, redispatch, rounds, verdict, fails, confidence, criterionIssue] = cells
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(where + '：日期格式应为 YYYY-MM-DD，实得「' + date + '」')
  if (!/^\d{8}-\d{2}$/.test(id)) problems.push(where + '：链 id 格式应为 YYYYMMDD-NN，实得「' + id + '」')
  if (seen.has(id)) problems.push(where + '：链 id 重复「' + id + '」')
  seen.add(id)
  if (!/^\d{2}:\d{2}[–-]\d{2}:\d{2}$/.test(span)) problems.push(where + '：起止格式应为 HH:MM–HH:MM，实得「' + span + '」')
  if (!GRADES.includes(grade)) problems.push(where + '：档位应为 ' + GRADES.join('/') + '，实得「' + grade + '」')
  for (const [name, v] of [['派发', dispatch], ['重派', redispatch]]) {
    if (!/^\d+$/.test(v)) problems.push(where + '：' + name + '应为整数，实得「' + v + '」')
  }
  if (!/^[^/]+(\/[^/]+)*$/.test(rounds) || !/[\u4e00-\u9fa5]/.test(rounds)) {
    problems.push(where + '：轮次应形如「设计2/开发1/QA3」，实得「' + rounds + '」')
  }
  if (!VERDICTS.includes(verdict)) problems.push(where + '：结论应为 ' + VERDICTS.join('/') + '，实得「' + verdict + '」')
  if (fails !== '无' && !/^[\w-]+×\d+(,[\w-]+×\d+)*$/.test(fails)) {
    problems.push(where + '：FAIL 分布应形如「D8×2,D13×1」或「无」，实得「' + fails + '」')
  }
  // P8 两列：`confidence` 只取自三个枚举值；`criterion_issue` 记**次数**（没有该报的写 0）。
  // 不校验它们的"真实性"——与本节其余列一致，**格式校验不冒充内容校验**。
  if (!CONFIDENCES.includes(confidence)) {
    problems.push(where + '：置信度应为 ' + CONFIDENCES.join('/') + '（QA 本轮报告自己填的值），实得「' + confidence + '」')
  }
  if (!/^\d+$/.test(criterionIssue)) {
    problems.push(where + '：判据异议应记**次数**（没有该报的写 0），实得「' + criterionIssue + '」')
  }
}

console.log('[ledger] ' + LEDGER)
notes.forEach((n) => console.log('  · ' + n))
console.log('  数据行 ' + dataRows + ' 条')
if (problems.length) {
  console.log('\n--- 格式问题 ---')
  problems.forEach((p) => console.log('  ✗ ' + p))
  console.log('\n[ledger] FAIL：' + problems.length + ' 处格式问题')
  process.exit(1)
}
console.log('\n[ledger] PASS：格式可解析' + (dataRows === 0 ? '（台账为空是**有效状态**——首次建立时无历史数据可补录，见文件内说明）' : ''))
