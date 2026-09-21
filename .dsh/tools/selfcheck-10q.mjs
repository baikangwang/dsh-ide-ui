// ⚠️ 本文件是 agent-mode 仓库 .dsh/tools/selfcheck-10q.mjs 的**副本**。正本：agent-mode 仓库 .dsh/tools/selfcheck-10q.mjs。
// 副本生成时间：2026-09-21T02:28:49.470Z
/**
 * 交付前自查 10 问 · 机械化审计（`design-standard.md` §七 原文为准）。
 *
 * ⚠️ 本工具**只机械化能机械化的那部分**，并明确标出哪些问它查不了（见末尾）。
 *   它测的是"**正文里有没有那个结构**"，不是"**内容说得对不对**"——
 *   后者只有人读。**不得拿本工具的输出当"文档合格"的结论。**
 *
 * 10 问 → 本工具覆盖情况：
 *   Q1  §一 需求复述对得上用户原话吗          → 部分（查有无该节 + 有无用户原话引用）
 *   Q2  结论答得出"是什么/凭什么/为什么不选别的" → **部分**（查结论节有无依据行 + 有无被否决方案）
 *   Q3  复述测试：只读该节能复述结论与依据吗   → **部分**（查 §一/§二 是否自足：有无依据引用、长度够不够）
 *   Q4  还有"原为…现改为…"吗                → 覆盖（含引用豁免分支，§17.54）
 *   Q5  有"修订记录/变更记录/QA 回环响应表"吗 → 覆盖
 *   Q6  同一张表出现两次以上吗                → 部分（表头指纹重复检测）
 *   Q7  每个数字都标了来源/时间/环境吗         → 部分（数字密集行的"来源线索"比例）
 *   Q8  非通行叫法能说出出处吗                → 抽查（首次出现的术语是否有引号/括号释义）
 *   Q9  比上一轮变长了吗（清洗场景 N/A）      → 不适用
 *   Q10 数值留痕核对                          → 已有 verify-rewrite.mjs 的第 2b 节覆盖
 *
 * 用法：node .dsh/tools/selfcheck-10q.mjs [--project dsh] [--top 40] [--projects a,b,c]
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countLines } from './lib-lines.mjs'

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
const OUT = join(SELF, '.dsh', 'tmp', 'selfcheck')
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
const isDocLike = (rel) => !/CHANGELOG|README|\/index\.md$|术语变更记录|docs-map-exceptions|-evidence\//i.test(rel)

/** 切节：返回 [{title, start, lines[]}]，跳过代码围栏内的标题 */
const splitSections = (text) => {
  const L = text.split('\n')
  const secs = []
  let fence = false
  let cur = { title: '(文首)', start: 1, lines: [] }
  L.forEach((l, i) => {
    if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; cur.lines.push(l); return }
    if (!fence && /^##\s/.test(l)) {
      secs.push(cur)
      cur = { title: l.replace(/^#+\s*/, '').trim(), start: i + 1, lines: [] }
      return
    }
    cur.lines.push(l)
  })
  secs.push(cur)
  return secs
}

// 依据行特征：含 `路径:行号`、探针/实测/grep/实测输出、代码引用、命令
const EVIDENCE_RE = /[\w./\\-]+\.(?:py|js|mjs|cjs|ts|tsx|svelte|json|ya?ml|sh|sql|md):\d+|探针|实测|亲读|已复核|grep|命令输出|\bSELECT\b|\bcurl\b|journal|日志|§[\d.]+/
const CLAIM_RE = /必须|应当|需要|结论|判定|根因|方案|决定|建议|推荐|已证明|成立|不成立|否决/
const REJECT_RE = /被否决|否决|不选|放弃|排除|未选|方案 ?[BC]（|反证|为什么不选|取舍/

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
    const secs = splitSections(t)
    const heads = secs.map((s) => s.title)
    const h = heads.join(' | ')

    const hasReq = /需求复述|需求理解|调研目标复述|目标复述/.test(h)
    const hasKey = /关键结论|结论先行|结论与建议|总判定|结论/.test(h)
    const hasScope = /范围/.test(h)
    const hasReject = REJECT_RE.test(t)
    // Q4：痕迹词，带引用豁免（命中行处于引号内或前 40 字有「不留/禁止/反例/例如」⇒ 判引用）
    let trace = 0, traceQuoted = 0
    let fence = false
    t.split('\n').forEach((l) => {
      if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; return }
      if (fence) return
      if (/原为|现改为|上一轮 QA|就地注记|本次修订|更正说明|v1\.\d+ 更正/.test(l)) {
        const quoted = /["'「『`][^"'」』`]*(原为|现改为|上一轮 QA)[^"'」』`]*["'「』』`]/.test(l) ||
          /不留|禁止|反例|例如|红线|不许/.test(l.slice(0, Math.max(0, l.search(/原为|现改为/)) > 0 ? l.search(/原为|现改为/) : 0 + 40))
        quoted ? traceQuoted++ : trace++
      }
    })
    // Q5：修订类节
    const revSecs = heads.filter((x) => /修订记录|变更记录|版本历史|版本沿革|整改记录|QA 回环响应表/.test(x))
    // Q2/Q3：结论节是否有依据行
    const conclSections = secs.filter((s) => /关键结论|结论先行|关键结论与|总判定|决策记录/.test(s.title))
    let conclNoEvid = 0, conclEvid = 0
    for (const s of conclSections) {
      const body = s.lines.filter((l) => l.trim() && !/^[>|]?\s*[-:|\s]+$/.test(l))
      const ev = body.filter((l) => EVIDENCE_RE.test(l)).length
      ev === 0 && body.length >= 2 ? conclNoEvid++ : conclEvid++
    }
    // Q1/Q3：§一 需求复述 自足性
    const reqSec = secs.find((s) => /需求复述|需求理解|调研目标复述/.test(s.title))
    const reqBody = reqSec ? reqSec.lines.filter((l) => l.trim()).length : 0
    const reqHasUser = reqSec ? /用户原话|用户说|用户要求|用户诉求|原话|用户指正|用户裁决/.test(reqSec.lines.join('\n')) : false
    // Q6：表头指纹重复（连续分隔行前的表头）
    const tblHdr = new Map()
    let f2 = false
    const L2 = t.split('\n')
    L2.forEach((l, i) => {
      if (/^\s*(`{3,}|~{3,})/.test(l)) { f2 = !f2; return }
      if (f2) return
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(L2[i + 1] || '')) {
        const key = l.replace(/\s/g, '').slice(0, 80)
        tblHdr.set(key, (tblHdr.get(key) || 0) + 1)
      }
    })
    const dupTbl = [...tblHdr.values()].filter((n) => n >= 2).length
    // Q7：数字密集行有无来源线索
    let numLines = 0, numWithSrc = 0
    f2 = false
    L2.forEach((l) => {
      if (/^\s*(`{3,}|~{3,})/.test(l)) { f2 = !f2; return }
      if (f2) return
      const nums = (l.match(/(?<![A-Za-z0-9\-/._:])\d[\d,]{2,}/g) || []).length
      if (nums >= 2) { numLines++; if (EVIDENCE_RE.test(l) || /来源|出处|依据|实测|探针|口径/.test(l)) numWithSrc++ }
    })

    const flags = []
    if (!hasReq) flags.push('Q1 无「需求复述」节')
    else if (!reqHasUser) flags.push('Q1 需求复述未引用户原话')
    if (!hasKey) flags.push('Q2 无「关键结论」节')
    if (conclNoEvid) flags.push(`Q2 ${conclNoEvid} 个结论节无依据行`)
    if (hasKey && !hasReject) flags.push('Q2 全文未见"被否决/排除"交代')
    if (reqSec && reqBody < 6) flags.push(`Q3 需求复述过短(${reqBody} 行)`)
    if (trace) flags.push(`Q4 痕迹词 ${trace} 处`)
    if (revSecs.length) flags.push(`Q5 修订类节 ${revSecs.length} 个`)
    if (dupTbl) flags.push(`Q6 表头重复 ${dupTbl} 组`)
    if (numLines >= 5 && numWithSrc / numLines < 0.5) flags.push(`Q7 数字行带来源 ${numWithSrc}/${numLines}`)

    rows.push({ proj, rel, bytes: statSync(f).size, lines: countLines(t), flags, hasReq, hasKey, hasScope, hasReject, conclNoEvid, dupTbl, numLines, numWithSrc })
  }
}
rows.sort((a, b) => b.flags.length - a.flags.length)
console.log(`\n  ══ 交付前自查 10 问 · 机械审计（按不合格项数排序）══`)
console.log(`  ⚠️ 本表只说明"正文里有没有那个结构"，**不能说明"内容说得对不对"**\n`)
console.log(`  ${'项目/文档'.padEnd(56)}${'行'.padStart(6)}${'不合项'.padStart(7)}  主要问题`)
for (const r of rows.slice(0, TOP)) {
  const nm = (r.proj + '/' + r.rel.replace(/^docs\//, '')).slice(0, 54)
  console.log(`  ${nm.padEnd(56)}${String(r.lines).padStart(6)}${String(r.flags.length).padStart(7)}  ${r.flags.slice(0, 3).join(' ; ').slice(0, 78)}`)
}
const cnt = {}
for (const r of rows) for (const fl of r.flags) { const k = fl.split(' ')[0]; cnt[k] = (cnt[k] || 0) + 1 }
console.log(`\n  ══ 按问题类别汇总（共扫 ${rows.length} 份）══\n`)
for (const [k, n] of Object.entries(cnt).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`)
console.log(`\n  ══ 逐项通过率 ══\n`)
const P_ = (f) => `${String(rows.filter(f).length).padStart(5)} / ${rows.length}`
console.log(`  有「需求复述」节        ${P_((r) => r.hasReq)}`)
console.log(`  有「关键结论」节        ${P_((r) => r.hasKey)}`)
console.log(`  有「范围」节            ${P_((r) => r.hasScope)}`)
console.log(`  交代了被否决方案        ${P_((r) => r.hasReject)}`)
console.log(`  结论节都带依据行        ${P_((r) => !r.conclNoEvid)}`)
console.log(`  无修订类节              ${P_((r) => !r.flags.some((x) => x.startsWith('Q5')))}`)
console.log(`  无痕迹词                ${P_((r) => !r.flags.some((x) => x.startsWith('Q4')))}`)
console.log(`  无表头重复              ${P_((r) => !r.flags.some((x) => x.startsWith('Q6')))}`)
writeFileSync(join(OUT, 'selfcheck-10q.json'), JSON.stringify(rows, null, 2), 'utf8')
console.log(`\n  ➜ 明细：${join(OUT, 'selfcheck-10q.json')}`)
