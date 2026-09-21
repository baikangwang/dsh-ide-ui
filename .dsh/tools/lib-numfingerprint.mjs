/**
 * lib-numfingerprint.mjs — 数值指纹的**唯一定义处**
 *
 * 为什么单独成模块：所有需要识别"数值型判据"的脚本都必须按同一套规则行事。
 * 若各自内联一份，规则一旦调整就会漂移——
 * 出现"闸门放过了核验会拦下的东西"这类最难查的问题。
 *
 * 依据：`.dsh/contracts/architect/design-standard.md`「压缩粒度边界」——
 * 端口、文件大小与字节数、计数、时间戳（含 nanos）、PID、epoch、百分比、耗时、
 * SHA256 前缀、inode 属**数值型判据，不得压掉**；只有排版可压。
 *
 * 注：本文中 `§17.x` 的编号沿用原《设计文档写法指南》（旧 `docs/06`）的节号——
 *   该文档已迁入 skill `design-doc-writing` 并改用中文序号，故 §17.x 属**溯源标注**，
 *   在现行交付面里查不到对应小节，不是可跳转的引用。
 */

/**
 * 数字指纹：要能核验，就必须逐字相同
 *
 * ⚠️ **不要在单位字后面写 `\b`** —— 这是本项目一个高危缺陷的根源，务必读下面这段。
 *
 * `\b` 的定义是「一侧是 `[A-Za-z0-9_]`、另一侧不是」。**CJK 汉字不是 `\w`**，
 * 所以 `\d+条\b` 里的 `\b` 要求"条"之后**紧跟 ASCII 词字符**才成立：
 *
 * ```
 * /\d+条\b/.test('1889 条，')  → false     // "条"后面是"，" → 不成立
 * /\d+条\b/.test('11 个abc')   → true      // "个"后面是"a" → 成立（荒谬：这才命中）
 * ```
 *
 * 原写法 `\b\d+(?:个|项|行|处|文件|版|次)\b` 因此**在中文语料上基本抽不到东西**——
 * 实测 `真实事件 1889 条` / `文件总数为 1072 个` / `第 95 行` / `耗时 30 秒` / `1130 字节`
 * / `版本 3 版` / `扫描 5 次` **全部抽出 0 个**，只有"单位后紧跟 ASCII"这种反常情形才命中。
 *
 * **后果的严重性**：`missingNumerics()` 只会在"抽得到"的指纹上比对，抽不到的**永远不会报缺失**。
 * 于是「正文数值缺失 0」不是"数值保住了"，而是"**这个判据看不见**"——
 * 一个**恒绿的判据**比没有判据更危险，因为它会让人以为已经验过了。
 *
 * **正确写法**：把单位后的 `\b` 换成「**后面不是 ASCII 字母或数字**」的负向先行断言。
 * 关键是**不要**用 `\b`（要求后随 `[A-Za-z0-9_]`），也不要写成 `(?=[^A-Za-z0-9_]|$)` 之外的窄写法——
 * 中文里单位后几乎总是**汉字或标点**（`1889 条，` / `1072 个。` / `第 95 行、`）。
 * 用「非 `[A-Za-z0-9_]`」当收尾条件，汉字与标点都能通过，而 `11 个abc` 这种粘连仍被排除。
 *
 * > **修复后存量文档会大面积报缺失**，这是**预期的、正确的**——说明那些缺失一直都在，
 * > 只是以前看不见。所以修复必须分两步：先出报告，**再**决定是否当闸门，不要同一天直接收紧。
 */
/** 收尾：后面不许紧跟 ASCII 字母/数字（防 `11 个abc`），但汉字与标点都允许。 */
const TAIL = '(?![A-Za-z0-9_])'

export const NUM_PATTERNS = [
  // ⚠️ 必须带 `i`（或写成 `[0-9a-fA-F]`）：只认小写是**同一类恒盲**——
  //    实测 `050F56CD13175E4C`（大写）在原写法下抽出 **0 个**，于是大写 SHA256
  //    **既不会报缺失、也不会报凭空新增**。范围比单位 `\b` 小，但性质完全相同。
  { name: 'SHA256前缀', re: /\b[0-9a-f]{12,}\b/gi },
  { name: 'inode', re: /\binode\s*\d{6,}/gi },
  // 单位既有 ASCII（chars）也有 CJK（字节），两种都要能收尾 —— 见文件头的 `\b` 说明
  { name: '长度/字节', re: new RegExp(`\\b\\d+\\s*(?:字节|chars?)${TAIL}`, 'g') },
  { name: '端口', re: /\b(?:TCP_(?:OPEN|CLOSED)|端口\s*\d{2,5}|\b1[0-9]{4}\b|\b8[0-9]{3}\b|\b9[0-9]{3}\b|PID\s*\d{2,7})/g },
  // 单位后可跟汉字、标点、空格、串尾 —— 一律允许；只有紧跟 ASCII 词字符才算粘连
  // ⚠️ **`轮` 已从单位字表移除**——它会让两条判据自相冲突：
  //
  //     删掉 `（第 1 轮…）` → ① 报"数值缺失 1"
  //     留下 `（第 1 轮…）` → ② 报"修订痕迹"
  //
  //   两条判据互相打架时，**两条都不可用**——因为无论架构师怎么做都会被判违规。
  //   而 `轮` 量化的是**评审轮次**（过程），不是交付物：`个/项/行/处/文件/版/次/条/列/张/组`
  //   量化"设计里有几个 X"，`轮` 量化"我们评审了几遍"。**它保护的恰是本轮必须删的东西。**
  //
  //   移除后的行为：删掉 `N 轮` 不再报①；若它出现在 `（第 N 轮…）` 这类自指语境里，
  //   仍会被 ② 的痕迹词表抓到。**这才是对的方向。**
  //   至于"研究报告中描述方法学的轮次"确实可能是正式值——那类走 `_superseded` 豁免登记，
  //   而不是靠把所有 `N 轮` 都设成不可删。
  { name: '版本区间/计数', re: new RegExp(`\\b\\d+(?:\\s*个|\\s*项|\\s*行|\\s*处|\\s*文件|\\s*版|\\s*次|\\s*条|\\s*列|\\s*张|\\s*组)${TAIL}`, 'g') },
  { name: '百分比', re: /\b\d+(?:\.\d+)?%/g },
  { name: '时间/耗时', re: new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*(?:ms|s|秒|分钟|小时|天|日)${TAIL}`, 'g') },
  // 下面两条是按"编造与遗漏都要抓"补的：时间戳与日期是**决定性判据**，
  // 原先完全不在指纹里，于是"删掉时间戳"既不会报缺失、也不会报凭空新增。
  { name: '时间戳', re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g },
  { name: '日期', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { name: '文件:行号', re: /[\w./-]+\.(?:md|mjs|cjs|js|ts|tsx|json|py|sh|ps1|yml|yaml):\d+(?:-\d+)?/g },
]

/**
 * 归一化数字指纹，消除"仅空格不同"造成的误报。
 * 例：原稿写 `失败 13 次`、改后稿写成 `失败：13 次` 或表格里的 `13`，
 * 按字面比对会报"缺失"，但数字本身在。故比对时把 `数字+空格+单位`
 * 的中间空格去掉再比。
 */
export function normNumKey(s) {
  return s.replace(/\s+/g, '')
}

/**
 * 从一段文本里抽取全部数值指纹，返回 `Map<归一化指纹, {family, raw, count}>`。
 *
 * 🔴 **`count` 是 2026-09-17 补上的，缺它曾遮住一个真实事故。**
 *
 * v1 的写法是 `if (!out.has(key)) out.set(...)`——**只保留首次出现**，
 * 于是返回值里**没有任何出现次数信息**。后果是：
 *
 *   1. **`value.length` 恒为 `undefined`**。任何写 `value.length` 的"出现次数"判据
 *      **恒不成立**（`undefined > 1` 恒 false）——又一个 §17.12 的恒绿判据。
 *   2. 更要命的是**语义盲区**：所有基于它的判据都只回答"**这个值还在不在**"，
 *      而**从不回答"它出现了几次"**。
 *
 * **被遮住的那个事故**：Sangfor 旗舰调研稿把 `76.26%` 写成 `71.52%`
 * （原稿 0 次），同时把 `76.26%` 从 **3 处降到 2 处**。
 * 当时的结论是 `missing: 1` ——**而"凭空多 1"掩盖了"减少 1"**。
 * 那次的教训被总结为"**只查缺失的工具会把「编造」伪装成「遗漏」**"；
 * **现在补上另一半：只查「值是否存在」的工具，会把「次数减少」伪装成「完整」。**
 *
 * ⇒ 补 `count` 后，`数值出现次数减少`（判据 ①c）才可能被检出来。
 *   **注意**：`count` 是 `Map` **值**上的字段，不是 `map.size`——
 *   `map.size` 是**不同值的个数**，两者是不同的问题。
 */
export function extractNumerics(text) {
  const out = new Map()
  for (const p of NUM_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags)
    let m
    while ((m = re.exec(text))) {
      const key = p.name + '\u0000' + normNumKey(m[0])
      const hit = out.get(key)
      if (hit) hit.count++
      else out.set(key, { family: p.name, raw: m[0], count: 1 })
    }
  }
  return out
}

/**
 * 计算"改后稿里**出现次数减少**的数值"（判据 ①c）。
 *
 * **为什么要单独一条**：`missingNumerics` 只报"**值彻底消失**"。
 * 而"同一个值从 3 处降到 2 处"**不在它的输出里**——原稿有、改后也有，只是少了。
 * Sangfor 那份稿子的 `76.26%` 就是这样丢的。
 *
 * **必须与 `missingNumerics` 对称地扣除"移出件"**（搬家不是丢失），
 * 否则每份文档都会因"删掉尾部的评审记录"而误报一片。
 *
 * @param {Map} before 原稿指纹（含 count）
 * @param {Map} after  改后稿指纹（含 count）
 * @param {Map} [movedOut] 移出件的指纹（可选）。计入它之后仍减少的才算真减少。
 * @returns {Array<{family:string, raw:string, from:number, to:number}>}
 */
export function reducedNumerics(before, after, movedOut) {
  const out = []
  for (const [key, b] of before) {
    const a = after.get(key)
    const m = movedOut ? movedOut.get(key) : null
    const to = (a ? a.count : 0) + (m ? m.count : 0)
    if (to < b.count) {
      out.push({ family: b.family, raw: b.raw, from: b.count, to })
    }
  }
  return out
}

/**
 * 计算"改后稿相对原稿丢掉的数值"，并在原稿里定位其上下文。
 * @returns {Array<{family:string, raw:string, context:string}>}
 */
export function missingNumerics(originalText, rewriteText) {
  const before = extractNumerics(originalText)
  const after = extractNumerics(rewriteText)
  const lost = []
  for (const [key, info] of before) {
    if (after.has(key)) continue
    const idx = originalText.indexOf(info.raw)
    const context = idx >= 0
      ? originalText.slice(Math.max(0, idx - 150), idx + 100).replace(/\s+/g, ' ')
      : '(原稿中未定位到字面出现，疑为跨行拼接产物)'
    lost.push({ family: info.family, raw: info.raw, context })
  }
  return lost
}
