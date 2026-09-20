// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/table-integrity.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/table-integrity.mjs。
// 副本生成时间：2026-09-20T09:07:20.327Z
/**
 * 表格结构完整性审计——**内容层判据，与数值判据互补**。
 *
 * 为什么需要它（`430` 暴露的）：
 *   数值留存判据只问"这个串还在不在"，**看不见表格被拆坏**。
 *   `430` 现行稿 §2.2 把一张 5 列表压成了 4 个**列表项碎片**
 *   （`- | 3 | 日志耗时… | ⚠️ 确认存在 | 中 | …`，丢掉表头与 1/2 行），
 *   同一批数据又在下方以完整表格重复一遍 —— 数字全"在"，文档却是坏的。
 *
 * 判据（三类，均为内容哲学的直接落点）：
 *   A **列表里的表格碎片**：以 `- |` / `* |` 开头的行 —— 表格被误压成列表
 *   B **列数不齐**：同一张表内各行的 `|` 分隔数不一致（丢列/多列）
 *   C **表头缺失/重复**：表格首行不是表头（下一行无分隔行），或同一表头在全文出现 ≥2 次
 *   D **空表/单行表**：只有分隔行没有数据行
 *
 * ⚠️ 口径纪律：每条命中都报 **文件 + 行号 + 原样行**；A/D 是硬缺陷，
 *   B/C 需人看（列数不齐可能是有意的合并单元格写法）。
 *
 * 用法：node .dsh/tools/table-integrity.mjs [--project x] [--top 40] [--projects a,b,c]
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const getArg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const projFilter = getArg('--project')
const TOP = Number(getArg('--top') ?? 40)
// ── 作用域与落点：**自相对**，不假定兄弟项目 ─────────────────────────────
// 2026-09-20 修：此前写死模式仓库的绝对路径 + 固定 4 个项目清单，而这些工具
// **随 .dsh/ 交付到消费项目**——在别人机器上它会去扫一个不存在的目录，或更糟：
// 扫到同名的别的项目。改为从工具自身位置推出所属项目（工具住在 <项目>/.dsh/tools/）。
// 保留多项目能力：显式传 --projects a,b,c（名字相对本项目的父目录）。
const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = resolve(HERE, '..', '..')            // 本工具所属的项目根
const P = dirname(SELF)                            // 兄弟项目所在目录（仅 --projects 时用到）
const PROJECTS = (() => {
  const i = process.argv.indexOf('--projects')
  if (i < 0) return [basename(SELF)]               // 默认只扫所属项目
  return (process.argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
})()
const OUT = join(SELF, '.dsh', 'tmp', 'table-check')
mkdirSync(OUT, { recursive: true })

const walkMd = (d, out, dep = 0) => {
  if (dep > 6) return
  let es = []
  try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    if (/^(node_modules|\.git|visuals|archive)$/.test(e.name)) continue
    const q = join(d, e.name)
    if (e.isDirectory()) { walkMd(q, out, dep + 1); continue }
    if (e.name.endsWith('.md')) out.push(q)
  }
}
const isDocLike = (rel) => !/CHANGELOG-设计文档|CHANGELOG-调研报告/i.test(rel)

const rows = []
for (const proj of PROJECTS) {
  if (projFilter && proj !== projFilter) continue
  const ROOT = join(P, proj), DOCS = join(ROOT, 'docs')
  if (!existsSync(DOCS)) continue
  const files = []
  walkMd(DOCS, files)
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/')
    if (!isDocLike(rel)) continue
    const t = readFileSync(f, 'utf8').replace(/\r\n?/g, '\n')
    const L = t.split('\n')
    const A = [], B = [], C = [], D = []
    let fence = false
    const hdrCnt = new Map()
    for (let i = 0; i < L.length; i++) {
      const l = L[i]
      if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; continue }
      if (fence) continue
      // A：列表里的表格碎片
      if (/^\s{0,3}[-*+]\s*\|/.test(l)) A.push({ n: i + 1, line: l.trim().slice(0, 150) })
      // 表格块识别
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(L[i + 1] || '')) {
        // 这是表头行，i+1 是分隔行
        const ncol = (l.match(/\|/g) || []).length
        hdrCnt.set(l.replace(/\s/g, '').slice(0, 70), (hdrCnt.get(l.replace(/\s/g, '').slice(0, 70)) || 0) + 1)
        const sepCol = (L[i + 1].match(/\|/g) || []).length
        const dataRows = []
        let j = i + 2
        while (j < L.length && /^\s*\|.*\|\s*$/.test(L[j])) { dataRows.push({ n: j + 1, l: L[j] }); j++ }
        if (dataRows.length === 0) D.push({ n: i + 1, line: `空表（表头 L${i + 1}，无数据行）` })
        if (ncol !== sepCol) B.push({ n: i + 2, line: `表头 ${ncol} 竖线 vs 分隔行 ${sepCol}：${L[i + 1].trim().slice(0, 90)}` })
        for (const d of dataRows) {
          const c = (d.l.match(/\|/g) || []).length
          if (c !== ncol) B.push({ n: d.n, line: `列数 ${c} ≠ 表头 ${ncol}：${d.l.trim().slice(0, 110)}` })
        }
        i = j - 1
      }
    }
    for (const [k, v] of hdrCnt) if (v >= 2) C.push({ line: `表头重复 ${v} 次：${k.slice(0, 70)}` })
    const total = A.length * 3 + B.length * 2 + C.length + D.length * 3
    if (A.length || B.length || C.length || D.length) rows.push({ proj, rel, A, B, C, D, total })
  }
}
rows.sort((a, b) => b.total - a.total)
console.log(`\n  ══ 表格结构完整性（内容层判据，与数值判据互补）══\n`)
console.log(`  ${'项目/文档'.padEnd(56)}${'碎片A'.padStart(6)}${'列不齐B'.padStart(8)}${'表头重复C'.padStart(9)}${'空表D'.padStart(6)}`)
for (const r of rows.slice(0, TOP)) {
  const nm = (r.proj + '/' + r.rel.replace(/^docs\//, '')).slice(0, 54)
  console.log(`  ${nm.padEnd(56)}${String(r.A.length).padStart(6)}${String(r.B.length).padStart(8)}${String(r.C.length).padStart(9)}${String(r.D.length).padStart(6)}`)
}
const T = { A: 0, B: 0, C: 0, D: 0 }
for (const r of rows) { T.A += r.A.length; T.B += r.B.length; T.C += r.C.length; T.D += r.D.length }
console.log(`\n  ══ 合计（扫 ${rows.length} 份有问题）══`)
console.log(`  A 表格碎片（硬缺陷，表格被压成列表）：**${T.A}** 处`)
console.log(`  B 列数不齐（需人看）：${T.B} 处`)
console.log(`  C 表头重复（违反第 6 问）：${T.C} 组`)
console.log(`  D 空表：${T.D} 处`)
console.log(`\n  ══ A 类（表格碎片）逐条：这是最硬的一类 ══\n`)
let n = 0
for (const r of rows) for (const a of r.A) {
  if (n++ >= 30) break
  console.log(`  ${r.proj}/${r.rel.replace(/^docs\//, '').slice(0, 46)}  L${a.n}`)
  console.log(`     ${a.line}`)
}
writeFileSync(join(OUT, 'table-integrity.json'), JSON.stringify(rows, null, 2), 'utf8')
console.log(`\n  ➜ 明细：${join(OUT, 'table-integrity.json')}`)
