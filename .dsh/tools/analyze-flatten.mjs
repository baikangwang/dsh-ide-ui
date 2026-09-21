#!/usr/bin/env node
/**
 * 「表格拍扁」病灶**分析器**（先分析，不修）。
 *
 * 前提（已用 430/432/496 三份人看确认）：
 *   清洗把 archive 里的正常 markdown 表格**拍扁成 `- |` 列表项**并复制上移，
 *   导致：① 丢失表头行 ② 同一批数据出现两次 ③ 无关行插进碎片串中间。
 *
 * 本脚本做两件事，都**只读**：
 *   A. 对每处 `- |` 碎片串，把"去掉 `- ` 前缀后的内容"与 archive 全文比对：
 *      · 命中 archive 的**表格行** ⇒ 判「拍扁自表格」（确定是清洗病灶）
 *      · 命中 archive 的**列表项/正文** ⇒ 判「原稿如此」（不是病灶）
 *      · archive 里完全没有          ⇒ 判「清洗新增」（需人看）
 *   B. 统计病灶分布，给出修复可行性
 *
 * 用法：node .dsh/tools/analyze-flatten.mjs [--projects a,b,c]
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 作用域与落点：**自相对**，不假定兄弟项目 ─────────────────────────────
// 2026-09-20 修：此前写死 `D:/working/projects` + 固定 4 个项目清单，而这些工具
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
const OUT = join(SELF, '.dsh', 'tmp', 'flatten')
mkdirSync(OUT, { recursive: true })
const norm = (s) => s.replace(/[`*_\s\u3000]/g, '').replace(/[，。：；（）()「」、]/g, '')

const rows = []
for (const proj of PROJECTS) {
  const ROOT = join(P, proj), DOCS = join(ROOT, 'docs'), ARCH = join(ROOT, '.dsh', 'tmp', 'cleanup', 'archive')
  if (!existsSync(DOCS) || !existsSync(ARCH)) continue
  const files = []
  const walk = (d, dep = 0) => {
    if (dep > 6) return
    let es = []
    try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (/^(node_modules|\.git|visuals|archive)$/.test(e.name)) continue
      const q = join(d, e.name)
      if (e.isDirectory()) { walk(q, dep + 1); continue }
      if (e.name.endsWith('.md')) files.push(q)
    }
  }
  walk(DOCS)
  const allArch = readdirSync(ARCH)
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/')
    if (/CHANGELOG-设计文档|CHANGELOG-调研报告/.test(rel)) continue
    const base = rel.replace(/\.md$/, '').split('/').pop()
    const af = allArch.find((x) => x.startsWith(base + '-precleanup-'))
    if (!af) continue
    const cT = readFileSync(f, 'utf8').replace(/\r\n?/g, '\n')
    const aT = readFileSync(join(ARCH, af), 'utf8').replace(/\r\n?/g, '\n')
    // archive：区分表格行 vs 非表格行
    const aTbl = new Set(), aOther = new Set()
    let fence = false
    for (const l of aT.split('\n')) {
      if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; continue }
      if (fence) continue
      if (/^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)) aTbl.add(norm(l))
      else if (l.trim()) aOther.add(norm(l))
    }
    // current：找 `- |` 碎片
    const L = cT.split('\n')
    fence = false
    const frags = []
    L.forEach((l, i) => {
      if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; return }
      if (fence) return
      if (/^\s{0,3}[-*+]\s*\|/.test(l)) frags.push({ n: i + 1, raw: l, stripped: l.replace(/^\s{0,3}[-*+]\s*/, '') })
    })
    if (!frags.length) continue
    const marked = frags.map((x) => {
      const k = norm(x.stripped)
      if (aTbl.has(k)) return { ...x, verdict: 'FLAT' }   // 拍扁自表格 ⇒ 清洗病灶
      if (aOther.has(k)) return { ...x, verdict: 'ORIG' } // 原稿列表项/正文 ⇒ 不是病灶
      return { ...x, verdict: 'NEW' }                     // archive 完全没有
    })
    const c = { FLAT: 0, ORIG: 0, NEW: 0 }
    for (const m of marked) c[m.verdict]++
    rows.push({ proj, rel, base, af, count: frags.length, ...c, marked })
  }
}
rows.sort((a, b) => b.FLAT - a.FLAT)
const T = { FLAT: 0, ORIG: 0, NEW: 0 }
for (const r of rows) { T.FLAT += r.FLAT; T.ORIG += r.ORIG; T.NEW += r.NEW }
console.log(`\n  ══ 「- |」碎片逐条定性（与 archive 全文比对）══\n`)
console.log(`  判定口径：去掉 \`- \` 后归一化，命中 archive 的**表格行** ⇒ FLAT（清洗拍扁）；`)
console.log(`            命中 archive 的**非表格行** ⇒ ORIG（原稿如此，不是病灶）；`)
console.log(`            archive 完全没有 ⇒ NEW（清洗新增，需人看）\n`)
console.log(`  ${'项目/文档'.padEnd(50)}${'FLAT'.padStart(6)}${'ORIG'.padStart(6)}${'NEW'.padStart(5)}${'合计'.padStart(6)}`)
for (const r of rows.slice(0, 30)) {
  const nm = (r.proj + '/' + r.rel.replace(/^docs\//, '')).slice(0, 48)
  console.log(`  ${nm.padEnd(50)}${String(r.FLAT).padStart(6)}${String(r.ORIG).padStart(6)}${String(r.NEW).padStart(5)}${String(r.count).padStart(6)}`)
}
console.log(`\n  ── 合计（${rows.length} 份有碎片）──`)
console.log(`  **FLAT = ${T.FLAT}**   清洗把表格拍扁成列表项（= 真病灶）`)
console.log(`  ORIG = ${T.ORIG}   原稿本就是列表写法（**不是病灶，不得动**）`)
console.log(`  NEW  = ${T.NEW}   archive 查不到，需人看`)
console.log(`\n  ══ FLAT 抽样（前 14 条，看拍扁源表是否可还原）══\n`)
let n = 0
for (const r of rows) for (const m of r.marked.filter((x) => x.verdict === 'FLAT')) {
  if (n++ >= 14) break
  console.log(`  ${r.base.slice(0, 40)}  L${m.n}`)
  console.log(`     ${m.stripped.slice(0, 130)}`)
}
writeFileSync(join(OUT, 'flatten-analysis.json'), JSON.stringify(rows, null, 2), 'utf8')
console.log(`\n  ➜ 明细：${join(OUT, 'flatten-analysis.json')}`)
