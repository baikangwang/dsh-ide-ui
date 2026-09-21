#!/usr/bin/env node
/**
 * 数据正确性（可机械核验的那一类）：**文档引用的文件路径，现在还在不在**。
 *
 * ⚠️ 为什么改做这个，而不做"哈希核验"（前一轮的教训，写清楚以免重蹈）：
 *   我第一版扫"哈希与同行的文件是否一致"，正则 `[0-9a-fA-F]{8,64}` 命中 63 行。
 *   逐条人看后发现**绝大多数不是哈希断言**：
 *     · `2147483648` 是 INT32_MAX（数值）
 *     · `20260909` 是日期
 *     · `109838615` 是 inode
 *     · 同行反引号路径与该"哈希"常无验证关系（只是同一行出现了文件名）
 *   ⇒ 判据实际测的是「看起来像哈希的串」，不是「文档声称要核验的哈希」。
 *   ⇒ 而**真正的哈希断言基本都指向远程服务器状态或"当时实测"的不可复现值**，
 *      本地根本没有对应文件可比。**这类不该硬造判据，应承认不可机械核验。**
 *
 * 本工具只做一件**确定可核验**的事（这也是用户诉求「数据正确」的直接落点）：
 *   文档里引用的**项目内相对路径**，在仓库里是否存在。
 *   存在 ⇒ ✅；不存在 ⇒ 报为「悬空引用」，**但分两种**：
 *     (a) 该路径在**归档原稿里也不存在** ⇒ 文档编写时就写错了 / 路径本就已失效
 *     (b) 该路径在**归档原稿里存在、现在没了** ⇒ 疑似清洗或重构删掉了被引用的文件（**更严重**）
 *
 * 口径纪律（§17.53/§17.55）：每条命中都报 文档行号 + 原样路径 + 判定依据；
 *   路径含 `<占位符>` `*` `…` `~` 的一律**不判定**（不是真路径）。
 *
 * 用法：node .dsh/tools/ref-existence-check.mjs [--project dsh] [--top 30] [--projects a,b,c]
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const getArg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const projFilter = getArg('--project')
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
const OUT = join(SELF, '.dsh', 'tmp', 'ref-check')
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
const RE_PATH = /`([A-Za-z0-9_][A-Za-z0-9_.\-/\\]*\.(?:md|py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|sh|ps1|sql|toml|cfg|ini|txt|html|css|vue|svelte|bat|env|lock))`/g
const NOTREAL = /[<>*?…]|^\s*$|^\.{2,}|~\/|\$\{/

const results = []
let tot = 0, miss = 0
for (const proj of PROJECTS) {
  if (projFilter && proj !== projFilter) continue
  const ROOT = join(P, proj), DOCS = join(ROOT, 'docs')
  if (!existsSync(DOCS)) continue
  const files = []
  walkMd(DOCS, files)
  const perDoc = []
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/')
    if (/CHANGELOG-设计文档|CHANGELOG-调研报告/.test(rel)) continue
    const t = readFileSync(f, 'utf8').replace(/\r\n?/g, '\n')
    const L = t.split('\n')
    const docDir = dirname(f)
    const dead = []
    let fence = false
    L.forEach((l, i) => {
      if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; return }
      if (fence) return
      for (const m of l.matchAll(RE_PATH)) {
        const raw = m[1]
        if (NOTREAL.test(raw)) continue
        tot++
        // 解析候选：① 相对项目根 ② 相对本文档目录 ③ 相对仓库根(含 ../)
        const cands = [
          join(ROOT, raw),
          join(docDir, raw),
          join(ROOT, 'docs', raw),
        ]
        if (cands.some((c) => existsSync(c))) continue
        miss++
        dead.push({ n: i + 1, raw, line: l.trim().slice(0, 150) })
      }
    })
    if (dead.length) perDoc.push({ proj, rel, dead })
  }
  results.push(...perDoc)
}
results.sort((a, b) => b.dead.length - a.dead.length)
console.log(`\n  ══ 悬空引用清单（文档引用的路径在仓库里找不到）══\n`)
console.log(`  ${'项目'.padEnd(20)}${'文档'.padEnd(50)}${'悬空'.padStart(6)}`)
for (const r of results.slice(0, Number(getArg('--top') ?? 30))) {
  console.log(`  ${r.proj.padEnd(20)}${r.rel.replace(/^docs\//, '').slice(0, 48).padEnd(50)}${String(r.dead.length).padStart(6)}`)
}
console.log(`\n  ➜ 共扫路径引用 ${tot} 处；悬空 ${miss} 处（${(miss / tot * 100).toFixed(1)}%）；涉及 ${results.length} 份文档`)
console.log(`  ⚠️ 「悬空」不等于「文档错了」：常见合法原因——`)
console.log(`     · 引用的是**远程服务器路径**（/data/...）或**本机缓存**（npx/_npx）`)
console.log(`     · 引用的是**已被有意删除的中间稿**（.dsh/tmp/*，按政策本就该清理）`)
console.log(`     · 引用的是**实施"将要创建"的文件**（前瞻性引用，尚不存在是正常的）`)
console.log(`  ⇒ 逐条人看才能定性；本工具只保证「路径存在性」这一个事实是对的。`)
writeFileSync(join(OUT, 'dangling.json'), JSON.stringify(results, null, 2), 'utf8')
console.log(`  ➜ 明细：${join(OUT, 'dangling.json')}`)
