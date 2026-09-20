// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/ledger-check.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/ledger-check.mjs。
// 副本生成时间：2026-09-19T09:56:05.781Z
/**
 * ledger-check.mjs — 运行台账的**格式**校验（P3c）
 *
 *   node .dsh/tools/ledger-check.mjs [台账路径]
 *
 * ## 它检查什么、不检查什么
 *
 * **检查**：表头字段是否齐全、每行是否 9 列、日期/链 id/FAIL 分布的格式是否可解析、
 * 有没有重复的链 id。目的是让台账**能被机器读取**——格式一乱，P9 的"哪条判据反复失守"
 * 就算不出来，台账就退化成一堆散文。
 *
 * **不检查**：数字是否真实。**工具的边界必须说清**——它判不了"派发 3 次"是不是真的 3 次，
 * 那要靠证据链与人工。**把格式校验说成内容校验，是比不校验更坏的事。**
 *
 * `{{paths.*}}` 占位符在本工具的默认路径里不生效（它是给 agent 读的约定，不是 shell 展开），
 * 所以默认值直接写相对路径。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = resolve(HERE, '..', '..')

const arg = process.argv[2]
const LEDGER = arg ? resolve(ROOT, arg) : join(ROOT, 'docs', 'CHANGELOG-运行台账.md')

if (!existsSync(LEDGER)) {
  console.error('台账不存在：' + LEDGER)
  process.exit(1)
}

const FIELDS = ['日期', '链 id', '起止', '档位', '派发', '重派', '轮次', '结论', 'FAIL 分布']
const GRADES = ['A0', 'A1', 'A2简', 'A2标准', 'A2深']
const VERDICTS = ['通过', '升级用户', '未闭环']

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
notes.push('表头在第 ' + (headIdx + 1) + ' 行，9 个字段齐全')

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
  const [date, id, span, grade, dispatch, redispatch, rounds, verdict, fails] = cells
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
