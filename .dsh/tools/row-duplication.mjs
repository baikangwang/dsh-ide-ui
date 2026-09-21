// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/row-duplication.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/row-duplication.mjs。
// 副本生成时间：2026-09-21T02:28:49.470Z
/**
 * 表格碎片与重复的**精确定位**（修 `430` 时确立的判据，比 table-integrity 的粗判据可靠）。
 *
 * 从 `430` 的教训里提炼出**两条真判据**（其余粗判据已证明是假阳性，见 §17.60）：
 *   ① **表格行被压成列表项**：`^\s*[-*+]\s*\|` —— 但这**只在归档原稿没有、现行稿有**时才是缺陷
 *      （很多文档原稿就爱这么写）⇒ 判据必须**与归档对照**，不能只看单份
 *   ② **同一批数据出现两次**：同一组"行首编号 + 关键字段"在相邻 60 行内重复
 *
 * ⚠️ 口径（§17.53）：① 必须归档存在才判；② 只报"编号 + 前两个字段完全相同"的严格重复，
 *   不做模糊匹配（模糊匹配会把正常的"概览表 + 明细表"误报）。
 *
 * 用法：node .dsh/tools/row-duplication.mjs [--top 30] [--projects a,b,c]
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const fragLines = (t) => {
  const out = []
  let f = false
  t.split('\n').forEach((l, i) => {
    if (/^\s*(`{3,}|~{3,})/.test(l)) { f = !f; return }
    if (f) return
    if (/^\s{0,3}[-*+]\s*\|/.test(l)) out.push({ n: i + 1, l: l.trim() })
  })
  return out
}
// 表格数据行（含表头那行也一起取，便于判重复）
const tableRows = (t) => {
  const out = []
  let f = false
  t.split('\n').forEach((l, i) => {
    if (/^\s*(`{3,}|~{3,})/.test(l)) { f = !f; return }
    if (f) return
    if (/^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)) {
      const cells = l.split('|').map((x) => x.trim()).filter((x) => x !== '')
      out.push({ n: i + 1, key: cells.slice(0, 3).join('¦'), cells })
    }
  })
  return out
}

const rows = []
for (const proj of PROJECTS) {
  const ROOT = join(P, proj), DOCS = join(ROOT, 'docs'), ARCH = join(ROOT, '.dsh', 'tmp', 'cleanup', 'archive')
  if (!existsSync(DOCS)) continue
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
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/')
    if (/CHANGELOG-设计文档|CHANGELOG-调研报告/.test(rel)) continue
    const t = readFileSync(f, 'utf8').replace(/\r\n?/g, '\n')
    const base = rel.replace(/\.md$/, '').split('/').pop()
    // ① 表格碎片：与归档对照
    const curFrag = fragLines(t)
    let archFragN = -1
    if (existsSync(ARCH)) {
      const af = readdirSync(ARCH).find((x) => x.startsWith(base + '-precleanup-'))
      if (af) archFragN = fragLines(readFileSync(join(ARCH, af), 'utf8').replace(/\r\n?/g, '\n')).length
    }
    const newFrag = archFragN >= 0 ? curFrag.length - archFragN : 0
    // ② 重复行：严格键（前 3 格）在 60 行内出现 ≥2 次
    const tr = tableRows(t)
    const dup = []
    const idx = new Map()
    for (const r of tr) {
      if (idx.has(r.key)) {
        const prev = idx.get(r.key)
        if (r.n - prev.n <= 60 && r.key.length > 8) dup.push({ a: prev.n, b: r.n, key: r.key.slice(0, 90) })
      }
      idx.set(r.key, r)
    }
    if (newFrag > 0 || dup.length) rows.push({ proj, rel, curFrag: curFrag.length, archFragN, newFrag, dup, frags: curFrag })
  }
}
rows.sort((a, b) => (b.newFrag * 3 + b.dup.length) - (a.newFrag * 3 + a.dup.length))
console.log(`\n  ══ ① 表格碎片（现行 > 归档 才算缺陷）══\n`)
console.log(`  ${'项目/文档'.padEnd(54)}${'现行碎片'.padStart(9)}${'归档碎片'.padStart(9)}${'新增'.padStart(6)}`)
let tNew = 0
for (const r of rows.filter((x) => x.newFrag > 0).slice(0, 30)) {
  const nm = (r.proj + '/' + r.rel.replace(/^docs\//, '')).slice(0, 52)
  console.log(`  ${nm.padEnd(54)}${String(r.curFrag).padStart(9)}${String(r.archFragN).padStart(9)}${String(r.newFrag).padStart(6)}`)
  tNew += r.newFrag
}
console.log(`\n  ➜ **清洗新引入的表格碎片合计：${tNew} 处**（涉及 ${rows.filter((x) => x.newFrag > 0).length} 份）`)
const none = rows.filter((x) => x.newFrag <= 0)
console.log(`  ➜ 碎片数与归档持平或更少的：${none.length} 份（原稿本就有的写法，不是缺陷）`)
console.log(`\n  ══ ② 严格重复行（前 3 格相同、60 行内出现 2 次）══\n`)
const withDup = rows.filter((x) => x.dup.length)
console.log(`  涉及 ${withDup.length} 份；合计 ${withDup.reduce((a, x) => a + x.dup.length, 0)} 组\n`)
for (const r of withDup.slice(0, 14)) {
  console.log(`  ${r.proj}/${r.rel.replace(/^docs\//, '').slice(0, 50)}`)
  r.dup.slice(0, 2).forEach((d) => console.log(`     L${d.a} ↔ L${d.b}  ${d.key}`))
}
writeFileSync(join(OUT, 'row-duplication.json'), JSON.stringify(rows, null, 2), 'utf8')
console.log(`\n  ➜ 明细：${join(OUT, 'row-duplication.json')}`)
