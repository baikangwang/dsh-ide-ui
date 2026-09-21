// code-gate 的三态验证：N/A（不适用）、PASS、FAIL 都要能出。
//
// ── 2026-09-18 第八轮重写：从"在宿主项目上跑"改为"在自己的 fixture 上跑" ──────
//
// **原实现有一个结构性缺陷**：它直接在**宿主项目**上跑 `code-gate.mjs`，然后断言
// `C5 === 'N/A'`、`C2 === 'N/A'`。这两个期望值**只对模式仓库成立**（agent-mode 的
// `tech_stack.build: none`、且没有 `package_layout`）。
//
// 后果：`code-gate-check.mjs` 随 `.dsh/` 交付到每个项目，而**任何声明了真实构建系统的项目都过不了**。
// 实测两个项目同时撞上：
//   - HelpDocToolkit（`build: msbuild`）→ C5=REVIEW → FAIL
//   - teamcodingknowledge（`build: pip`）→ C5=REVIEW → FAIL
// **交付件在消费项目里用不了，是交付件的问题，不是项目的问题。**
//
// **修法：自检自足。** `code-gate.mjs` 用 `ROOT = resolve(HERE, '..', '..')` 推导根目录，
// 所以把它复制进 `<临时目录>/.dsh/tools/`，它的 ROOT 就变成那个临时目录——
// 于是本脚本可以**自己造 profile**，断言值就重新变成确定的，且与宿主项目无关。
//
// 三种状态各有 fixture 覆盖，**每一种都双向可证**（不是"恒 N/A 也算过"）：
//   F1  build:none        → C5=N/A     （不适用）
//   F2  build:msbuild     → C5=REVIEW  （声明了但无法安全自动执行）
//   F3  声明 package_layout → C2=PASS   （证明 C2 不是恒 N/A）
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const R = process.cwd();
const T = join(R, '.dsh', '_cgtest');
rmSync(T, { recursive: true, force: true });
mkdirSync(join(T, '.dsh', 'tools'), { recursive: true });
mkdirSync(join(T, 'src'), { recursive: true });

// 把被测工具复制进 fixture —— 它的 ROOT 因此变成 T，读的是我们写的 profile
copyFileSync(join(R, '.dsh/tools/code-gate.mjs'), join(T, '.dsh/tools/code-gate.mjs'));

const run = (args) => {
  const r = spawnSync(process.execPath, [join(T, '.dsh/tools/code-gate.mjs'), ...args, '--json'], { cwd: T, encoding: 'utf8' });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
};
const byId = (j) => Object.fromEntries(j.results.map((r) => [r.id, r.status]));

/** 写一份合成 profile，然后跑一次，返回 {code, s} */
function withProfile(yaml, scope) {
  writeFileSync(join(T, '.dsh/profile.yaml'), yaml, 'utf8');
  const r = run(['--scope', scope]);
  return { code: r.code, s: byId(r.json) };
}

let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? '  [OK]   ' : '  [FAIL] ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };

// 干净的扫描对象：C3 对它判 PASS
writeFileSync(join(T, 'src/clean.mjs'), 'const apiKey = process.env.API_KEY;\n', 'utf8');
// 违规的扫描对象：C3 对它判 FAIL
writeFileSync(join(T, 'src/bad.mjs'), [
  'const apiKey = "sk-live-9f3a2b7c1d4e";',
  'const sql = "SELECT * FROM users WHERE id = " + userId;',
].join('\n'), 'utf8');

// ── F1：build:none、未声明 layout → C5/C2 都应 N/A，且不判 FAIL ──────────────
const f1 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: none\n', 'src/clean.mjs');
check('C5 在 build:none 时为 N/A（不判 FAIL）', f1.s.C5 === 'N/A', 'C5=' + f1.s.C5);
check('C2 在未声明 package_layout 时为 N/A', f1.s.C2 === 'N/A', 'C2=' + f1.s.C2);
check('C1 恒为 MANUAL（脚本不覆盖）', f1.s.C1 === 'MANUAL', 'C1=' + f1.s.C1);
check('无不适用条款被误判成 FAIL：退出码 0', f1.code === 0, 'code=' + f1.code);

// ── F2：声明了真实构建工具（不在可自动执行白名单）→ C5 必须是 REVIEW，不能是 N/A ──
//    这一条是原实现缺的：**证明 C5 不是恒 N/A**。
const f2 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: msbuild\n', 'src/clean.mjs');
check('C5 在 build:msbuild 时为 REVIEW（声明了就不能报不适用）', f2.s.C5 === 'REVIEW', 'C5=' + f2.s.C5);

// ── F3：声明了 package_layout 且变更文件在其前缀内 → C2 必须是 PASS，不能是 N/A ──
//    同理：**证明 C2 不是恒 N/A**。
const f3 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: none\n  package_layout:\n    - src/\n', 'src/clean.mjs');
check('C2 在 package_layout 命中时为 PASS（非恒 N/A）', f3.s.C2 === 'PASS', 'C2=' + f3.s.C2);

// ── F4：**嵌套写法** `build: { compile: <可执行命令> }` → C5 必须是 PASS，不能是 N/A ──
//
// **这一条是 2026-09-19 第九轮补的回归断言。** 当时实测发现：
// `code-gate.mjs` 先看标量 `tech_stack.build`、为空就提前返回 N/A，
// 而 `build.compile` 在这之后才被使用 —— 于是**嵌套写法永远拿不到那条命令**
// （YAML 里 `build` 是有子键的父行，扁平解析返回空串 ⇒ `!build` 成立 ⇒ N/A）。
// 工具本来就想支持嵌套写法（它读了这个键），是判断顺序把它废掉了。
//
// **为什么必须钉住**：N/A 在本模式里是**合法且不阻断**的结论，
// 所以"项目明明有构建、闸门却说不适用"会**静默通过**而不是报错。
// 这条断言连同 F2（REVIEW）、F3（PASS）一起，保证 C5/C2 **四种结论都不是恒定的**。
const f4 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build:\n    compile: "npm --version"\n', 'src/clean.mjs');
check('C5 在嵌套 build.compile 时按命令判定（不是 N/A）', f4.s.C5 === 'PASS', 'C5=' + f4.s.C5);

// ── F5：**YAML 块标量** `build: >-` + 缩进命令 → 必须解析成那条命令，不能是 `>-` ──
//
// **2026-09-19 第九轮补的第二条回归断言。** 当时实测发现：`code-gate.mjs` 的
// profile 解析器只取冒号后的**行内**文本，于是 `build: >-` 后面那两行缩进的命令
// **根本没被读到**，解析结果是字面量 `>-`。HelpDocToolkit 的 C5 提示因此变成
// 「构建命令 `>-` 无法安全自动执行」——结论（REVIEW）碰巧没错，但**给出的命令是垃圾**。
//
// `>-` 是**多行命令的自然写法**，profile 里到处都是（`build_command`、`package`、
// `checks.*`）。解析器不支持块标量，等于所有多行取值都读到一串折叠符号。
const f5 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: >-\n    npm --version\n', 'src/clean.mjs');
check('C5 能解析 YAML 块标量（build: >- 后缩进的命令）', f5.s.C5 === 'PASS', 'C5=' + f5.s.C5);
const f6 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: |\n    npm --version\n', 'src/clean.mjs');
check('C5 能解析字面块标量（build: | 后缩进的命令）', f6.s.C5 === 'PASS', 'C5=' + f6.s.C5);

// ── F7：**YAML 列表项带行尾注释** → C2 必须仍判 PASS，不能静默降级成 N/A ──
//
// **2026-09-20 第十轮补的第三条回归断言。** `code-gate.mjs` 的 profile 解析器有两个分支：
// 标量分支（`val`）剥行尾注释，**列表分支（`list`）不剥**。于是
// `- src/   # 主源码树` 解析出来的前缀**带着注释文本**，变更文件一个都匹配不上，
// C2 落到「不在声明的前缀内」→ 判 **N/A**。
//
// **为什么这条最阴**：N/A 在本模式里合法且**不阻断**，所以表现是
// 「检查通过、结论看起来正常」——缺陷被静默吞掉，而不是报错。
// deepseek-harness-UI 接入时实测复现（作者给列表项加了行尾注释，C2 静默降级）。
// 修法是让两个分支同口径；这条断言保证它不会退回去。
const f7 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: none\n  package_layout:\n    - src/          # 主源码树\n', 'src/clean.mjs');
check('C2 在 package_layout 列表项带行尾注释时仍 PASS（不静默降级成 N/A）', f7.s.C2 === 'PASS', 'C2=' + f7.s.C2);

// ── C3：明文密钥 + 拼接 SQL 必须 FAIL，且退出码 1 ───────────────────────────
const r3 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: none\n', 'src/bad.mjs');
check('C3 对明文密钥 + 拼接 SQL 判 FAIL', r3.s.C3 === 'FAIL', 'C3=' + r3.s.C3);
check('有 FAIL 时退出码为 1', r3.code === 1, 'code=' + r3.code);

// ── C3 反向：读环境变量必须 PASS（证明上一条不是恒 FAIL）────────────────────
const r4 = withProfile('meta:\n  kind: agile-project\ntech_stack:\n  build: none\n', 'src/clean.mjs');
check('C3 对环境变量读取判 PASS（非恒 FAIL）', r4.s.C3 === 'PASS', 'C3=' + r4.s.C3);

rmSync(T, { recursive: true, force: true });
console.log('\n' + (fail ? 'code-gate-check FAIL：' + fail + ' 项' : 'code-gate-check PASS：三态（N/A / PASS / FAIL / REVIEW）与退出码均正确'));
process.exit(fail ? 1 : 0);
