#!/usr/bin/env node
/**
 * 「表体被删」扫描——`416` §6.2 暴露的病灶。
 *
 * 判据（只用**可证明**的信号，不猜）：
 *   一张表的**分隔行**（`|---|---|`）之后既非表格行、也非空行 ⇒ 表体缺失。
 *   再与 archive / git HEAD 对照，确认是"被删了"而非"原稿就空"。
 *
 * ⚠️ 这是 `430`/`432` 那类「表格拍扁」的**姊妹病灶**：
 *   拍扁 = 表行变成 `- |` 列表项（行还在，位置错）；
 *   删体 = 表行直接消失（**数据真丢**）。
 *   两者数值判据都看不见。
 *
 * 用法：node .dsh/tools/find-empty-table-body.mjs [--top 30] [--projects a,b,c]
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

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
const OUT = join(SELF, '.dsh', 'tmp', 'table-check')
mkdirSync(OUT, { recursive: true })
const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l || '')
const isTbl = (l) => /^\s*\|.*\|\s*$/.test(l || '')

/** 返回该文档中"分隔行后无表体"的位置 */
const emptyBodies = (t) => {
  const L = t.split('\n')
  const out = []
  let f = false
  for (let i = 0; i < L.length; i++) {
    if (/^\s*(`{3,}|~{3,})/.test(L[i])) { f = !f; continue }
    if (f) continue
    if (isSep(L[i]) && !isTbl(L[i + 1]) && (L[i + 1] || '').trim() !== '') {
      out.push({ sepLine: i + 1, header: (L[i - 1] || '').trim().slice(0, 90), next: (L[i + 1] || '').trim().slice(0, 70) })
    }
  }
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
  const allArch = existsSync(ARCH) ? readdirSync(ARCH) : []
  const isRepo = existsSync(join(ROOT, '.git'))
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/')
    if (/CHANGELOG-/.test(rel)) continue
    const t = readFileSync(f, 'utf8').replace(/\r\n?/g, '\n')
    const eb = emptyBodies(t)
    if (!eb.length) continue
    const base = rel.replace(/\.md$/, '').split('/').pop()
    for (const e of eb) {
      // 与 archive 对照
      const af = allArch.find((x) => x.startsWith(base + '-precleanup-'))
      let archHas = null
      if (af) archHas = emptyBodies(readFileSync(join(ARCH, af), 'utf8').replace(/\r\n?/g, '\n')).some((x) => x.header === e.header)
      // 与 git HEAD 对照
      let head = null
      if (isRepo) {
        try {
          const hT = execSync(`git -C "${ROOT}" show HEAD:"${rel}"`, { encoding: 'utf8', maxBuffer: 1 << 28 }).replace(/\r\n?/g, '\n')
          const L2 = hT.split('\n')
          const hi = L2.findIndex((l) => l.trim() === e.header)
          head = hi >= 0 && isTbl(L2[hi + 2] || '') ? L2[hi + 2].trim().slice(0, 110) : (hi >= 0 ? '(HEAD 里表体也空)' : '(HEAD 无此表)')
        } catch { head = '(git 读取失败)' }
      }
      rows.push({ proj, rel, ...e, archAlsoEmpty: archHas, headFirstRow: head })
    }
  }
}
console.log(`\n  ══ 「表体被删」扫描：分隔行后无表体 ══\n`)
console.log(`  共 ${rows.length} 处\n`)
for (const r of rows.slice(0, Number(process.argv[2] || 30))) {
  const verdict = r.headFirstRow && r.headFirstRow.startsWith('|') ? '🔴 **HEAD 里有表体 ⇒ 被删**' : (r.archAlsoEmpty ? '⚪ archive 里也空（原稿如此）' : '⚪ 待看')
  console.log(`  ${verdict}`)
  console.log(`     ${r.proj}/${r.rel.replace(/^docs\//, '')}  L${r.sepLine}`)
  console.log(`     表头: ${r.header}`)
  console.log(`     分隔行后: ${r.next}`)
  if (r.headFirstRow && r.headFirstRow.startsWith('|')) console.log(`     HEAD 里应有: ${r.headFirstRow}`)
}
const real = rows.filter((r) => r.headFirstRow && r.headFirstRow.startsWith('|'))
console.log(`\n  ➜ **HEAD 里有表体、现行没有的：${real.length} 处** ← 这些是真丢数据`)
writeFileSync(join(OUT, 'empty-table-body.json'), JSON.stringify(rows, null, 2), 'utf8')
console.log(`  ➜ 明细：${join(OUT, 'empty-table-body.json')}`)
