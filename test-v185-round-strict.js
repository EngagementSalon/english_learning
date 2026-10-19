// test-v185-round-strict.js —— v185：看板营次口径「严格本期 + 上期期末仅参照」
//
// 背景（用户 10-19 实报）：
//   v184 加了 chyAnyOf「本营次为空 → 回落到同部门最近营次」，
//   结果管理员切到「艳中第二期」看到 9 个人全带第一期的成绩 —— **编造数据**，比原缺陷更严重。
//   真实数据：r6 只有 2 人 3 条记录（何旭艳 2、杨宇航 1，均 10-19 当日写入），r2 有 89 条。
//
// 本版契约（不可回退）：
//   [A] 统计口径只用本营次：q / acc / checkin / maxDay / 积分 全部派生自 chyOf(r)
//   [B] 上期只允许提供**期末成绩**一个参照值（s7p），且只用于灰色显示
//   [C] 上期前测绝不展示（s1p 不存在）
//   [D] 参与名单 = 本期有记录 ∪ 上期有记录（人不上榜会让管理员误判未参加）
//   [E] 源码不得再出现 chyAnyOf 的行为性调用（只允许注释里提到作废说明）
//
// ★ 判据一律用进程退出码（§B：绝不用 grep 判回归成败）
const fs = require('fs'), path = require('path'), vm = require('vm')
const D = __dirname
const SRC = fs.readFileSync(path.join(D, 'app.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(D, 'i18n.js'), 'utf-8')

let pass = 0, fail = 0
function ck(ok, label, extra) {
  if (ok) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')) }
}
// ★ 剥注释：计数类断言必须走 codeOnly（本项目九次复发的坑）
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ── 抽出看板函数块，在 vm 沙箱里真跑
function extractBlock() {
  const start = SRC.indexOf('const wantRaw = dashRoundView')
  if (start < 0) throw new Error('找不到看板取数块起点')
  // 取到 list.sort 之前（含 list.map 主体）
  const end = SRC.indexOf('list.sort((a, b) => b.q - a.q)', start)
  if (end < 0) throw new Error('找不到 list.sort 锚点')
  return SRC.slice(start, end)
}

console.log('\n=== [A] 统计口径只用本营次 ===')
const block = extractBlock()

// A1: chy 必须来自 chyOf（严格本期），不得来自任何「回落/合并」函数
ck(/const chy = chyOf\(r\)/.test(block), 'list.map 内 chy 直接取 chyOf(r)（严格本期）')

// A2: 整份 app.js 里不得再有 chyAnyOf 的调用（注释里提到作废是允许的）
const appCode = codeOnly(SRC)
ck(!/chyAnyOf\s*\(/.test(appCode), 'app.js 代码中已无 chyAnyOf 调用（仅注释可提及）')
ck(!/_latestSlugOf\s*\(/.test(appCode), 'app.js 代码中已无 _latestSlugOf 调用（v184 回落源）')

// A3: chyPrevOf 只允许出现在「上期参照」一处赋值，不得参与 q/acc 计算
const prevAssign = (appCode.match(/const prevChy = chyPrevOf\(r\)/g) || []).length
ck(prevAssign === 1, 'chyPrevOf 仅用于上期参照赋值一次', '(' + prevAssign + ')')
ck(!/const chy = chyPrevOf/.test(appCode), 'chy 绝不由 chyPrevOf 赋值')

// ── 运行期真跑：模拟一期有数据、二期为空
console.log('\n=== [B][C] 上期只给期末成绩，前测不展示 ===')
const sandbox = {
  console: { log() { } },
  // 营次表：r2 第一期（艳中）、r6 第二期（艳中）
  rdList: [
    { id: 'r2', name: '第一期', depts: ['dining/yan'] },
    { id: 'r6', name: '第二期', depts: ['dining/yan'] },
  ],
  dashRoundView: 'r6',
  dashChDept: 'all',
  dashRoundCurId: () => 'r6',
  dashRoundList: () => sandbox.rdList,
  dashRoundSlug: s => { s = String(s || ''); return (!s || s === 'r1' || s === '第一期') ? '第一期' : s },
  dashRoundUnderDept: () => true,
  normDept: d => {
    const s = String(d || '')
    if (/艳中/.test(s)) return { key: 'dining/yan', majorKey: 'dining' }
    if (/标帜/.test(s)) return { key: 'dining/sig', majorKey: 'dining' }
    return { key: 'dining/yan', majorKey: 'dining' }
  },
  dashChStageWeight: () => 1,
  escAttr: s => String(s == null ? '' : s),
  escHtml: s => String(s == null ? '' : s),
  t: k => k,
  // 学员：A 两期都有；B 只有上期（第一期）
  rows: [
    {
      username: 'A', name: '甲', dept: '饮食部·艳中餐厅', role: 'student', chQ: {},
      chy: [
        // 上期（r2）
        { kind: 'test', day: 1, rd: 'r2', correct: 8, total: 10, at: 100 },
        { kind: 'test', day: 7, rd: 'r2', correct: 18, total: 20, at: 200 },
        // 本期（r6）：只做了练习，没考试
        { kind: 'practice', day: 1, rd: 'r6', correct: 9, total: 10, si: 0, at: 300, usedSec: 60 },
      ],
    },
    {
      username: 'B', name: '乙', dept: '饮食部·艳中餐厅', role: 'student', chQ: {},
      chy: [
        { kind: 'test', day: 1, rd: 'r2', correct: 7, total: 10, at: 100 },
        { kind: 'test', day: 7, rd: 'r2', correct: 16, total: 20, at: 200 },
      ],
    },
  ],
}
sandbox.global = sandbox
const ctx = vm.createContext(sandbox)

// 执行抽出的块，最后拿到 list
// ★ 必须包在函数里：块内有 `if (!parts.length) { ...; return }` 的早退（空态分支），
//   裸跑会抛「Illegal return statement」。
const runner = `__out = (function(){
${block}
return list
})()`
let list = null
try {
  vm.runInContext(runner, ctx)
  list = ctx.__out
} catch (e) {
  console.log('  ✗ 运行期执行失败：' + e.message)
  fail++
}
if (list) {
  const A = list.find(p => p.username === 'A')
  const B = list.find(p => p.username === 'B')

  // B：本期零记录 → 所有统计必须为 0/空，只有 s7p 有值
  ck(!!B, 'B（只有上期记录）仍在名单里，不会整行消失')
  if (B) {
    ck(B.q === 0, 'B 本期题量为 0（不吃上期 20 题）', 'q=' + B.q)
    ck(B.acc === 0, 'B 本期正确率为 0（不吃上期正确率）', 'acc=' + B.acc)
    ck(B.s1 == null, 'B 本期前测为空（不显示上期前测）', 's1=' + B.s1)
    ck(B.s7 == null, 'B 本期期末为空（不冒充本期成绩）', 's7=' + B.s7)
    ck(B.s7p === 80, 'B 上期期末成绩可作参照 = 80', 's7p=' + B.s7p)
    ck(!('s1p' in B), 'B 对象上没有 s1p 字段（上期前测绝不展示）')
    ck((B.checkin || []).every(c => c === 0), 'B 本期打卡全空（不吃上期打卡）')
    ck((B.maxDay || 0) === 0, 'B 本期最高天为 0（不吃上期 Day7）', 'maxDay=' + B.maxDay)
  }

  // A：本期有练习 → q=10，但两场考试本期都没有 → s1/s7 空，s7p=90
  ck(!!A, 'A 在名单里')
  if (A) {
    ck(A.q === 10, 'A 本期题量 = 10（只算 r6 那条练习）', 'q=' + A.q)
    ck(A.acc === 90, 'A 本期正确率 = 90', 'acc=' + A.acc)
    ck(A.s1 == null, 'A 本期前测为空（r2 的 80 不得冒充）', 's1=' + A.s1)
    ck(A.s7 == null, 'A 本期期末为空（r2 的 90 不得冒充）', 's7=' + A.s7)
    ck(A.s7p === 90, 'A 上期期末参照 = 90', 's7p=' + A.s7p)
  }

  // 汇总口径：totalQ 只含本期
  const totalQ = list.reduce((s, p) => s + p.q, 0)
  ck(totalQ === 10, '汇总题量只含本期（A 的 10，不含 B 的上期 20）', 'totalQ=' + totalQ)
}

// ── 源码契约：渲染层
console.log('\n=== [D][E] 渲染层契约 ===')
ck(/scoreCell\(p\.s1, p\.m1\)/.test(appCode), '前测列不传上期参照（第 3 参缺省）')
ck(/scoreCell\(p\.s7, p\.m7, p\.s7p\)/.test(appCode), '期末列传 s7p 作上期参照')
ck(/s7p/.test(appCode) && !/s1p\b/.test(appCode), '代码里只有 s7p，无 s1p 残留')
ck(/dashChPrevHint/.test(I18N), 'i18n 含 dashChPrevHint（上期期末说明）')
ck(/dashChPrevMark/.test(I18N), 'i18n 含 dashChPrevMark（上标「上」）')
ck(!/dashChPrevOnlyBadge/.test(I18N), 'i18n 已清理「仅上期」角标键（用户要求不显示其他）')
// ★ 带参 i18n 键必须是函数值；这两个是纯字符串，正确
ck(/dashChPrevHint: '[^']*'/.test(I18N), 'dashChPrevHint 为字符串（无参文案正确）')

console.log('\n────────────────────────────')
console.log((fail === 0 ? '✅ v185 全部通过' : '❌ 失败 ' + fail + ' 项') +
  '  （通过 ' + pass + ' / ' + (pass + fail) + '）')
process.exitCode = fail === 0 ? 0 : 1
