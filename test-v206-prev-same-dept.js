// test-v206-prev-same-dept.js —— v206：上期期末必须「同部门轨道」（跨部门并行营次不算上期）
//
// 背景（2026-11-27 用户实报，截图：成绩看板·单边缺失组）：
//   日照-餐饮学员张蕊（username Rizhao）在餐饮营次 r8 视图里显示「上期期末 90」。
//   云端 ground truth：她的 chy 有 r8（餐饮）26 条 + r9（房务）44 条，90 = r9 的
//   Day21 期末 18/20。r8/r9 是**同期并行**的两期（餐饮/房务各第一期），餐饮根本不存在上期。
//
// 真因：v185 的 _roundInSameDept 只校验「学员部门 ∈ 本营次 depts」，从不校验 slug 那期
//   属于哪个部门 → 任何异 slug 记录（哪怕是隔壁部门的同期）都被当「上期」。
//
// 本版契约（不可回退）：
//   [A] _roundInSameDept 改为按 slug 查那期营次，depts 与本营次有交集才算同轨道
//   [B] 跨部门并行营次（r9 vs r8）绝不充当「上期」→ s7p 为 null
//   [C] 真跨期（同部门 r2→r6）照常显示 s7p —— v185 行为不回归
//   [D] 存量营次（depts 空 = 全部门适用）不被排除
//   [E] 旧判据 _deptOfUser 已删（死代码零残留）
//
// ★ 判据一律用进程退出码（§B）
const fs = require('fs'), path = require('path'), vm = require('vm')
const D = __dirname
const SRC = fs.readFileSync(path.join(D, 'app.js'), 'utf-8')

let pass = 0, fail = 0
function ck(ok, label, extra) {
  if (ok) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')) }
}
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ── 抽块（与 test-v185 同锚点）
function extractBlock() {
  const start = SRC.indexOf('const wantRaw = dashRoundView')
  if (start < 0) throw new Error('找不到看板取数块起点')
  const end = SRC.indexOf('list.sort((a, b) => b.q - a.q)', start)
  if (end < 0) throw new Error('找不到 list.sort 锚点')
  return SRC.slice(start, end)
}
const block = extractBlock()

console.log('\n=== [E][A] 源码契约 ===')
const code = codeOnly(SRC)
ck(!/_deptOfUser/.test(code), 'E1 旧判据 _deptOfUser 已整段移除（死代码零残留）')
const sameDeptSrc = code.slice(code.indexOf('const _roundInSameDept'), code.indexOf('const chyPrevOf'))
ck(sameDeptSrc.indexOf('dashRoundList()') >= 0, 'A1 _roundInSameDept 按 slug 查 dashRoundList 营次归属')
ck(sameDeptSrc.indexOf('wantDepts.indexOf(w) >= 0') >= 0, 'A2 判据 = 那期 depts 与本营次 wantDepts 有交集')
ck(sameDeptSrc.indexOf("typeof dashRoundList !== 'function'") >= 0, 'A3 typeof 守卫（切片沙箱缺依赖不崩，回落旧行为）')
ck(/if \(slug === wantSlug\) continue/.test(code), 'A4 本营次自身记录仍被排除（原语义保留）')

// ── 沙箱骨架（依赖面与 test-v185 一致）
function mkSb(rounds, rows, view) {
  const sb = {
    console: { log() { } },
    rdList: rounds,
    dashRoundView: view,
    dashChDept: 'all',
    dashRoundCurId: () => view,
    dashRoundList: () => rounds,
    dashRoundSlug: s => { s = String(s || ''); return (!s || s === 'r1' || s === '第一期') ? '第一期' : s },
    dashRoundUnderDept: () => true,
    normDept: d => {
      const s = String(d || '')
      if (/餐饮/.test(s)) return { key: 'rizhao/canyin', majorKey: 'rizhao' }
      if (/房务/.test(s)) return { key: 'rizhao/fangwu', majorKey: 'rizhao' }
      if (/艳中/.test(s)) return { key: 'dining/yan', majorKey: 'dining' }
      return { key: 'dining/yan', majorKey: 'dining' }
    },
    dashChStageWeight: () => 1,
    escAttr: s => String(s == null ? '' : s),
    escHtml: s => String(s == null ? '' : s),
    t: k => k,
    rows,
  }
  sb.global = sb
  return sb
}
function runList(sb) {
  const ctx = vm.createContext(sb)
  const runner = `__out = (function(){\n${block}\nreturn list\n})()`
  try { vm.runInContext(runner, ctx); return ctx.__out } catch (e) {
    ck(false, '沙箱执行失败：' + e.message)
    return null
  }
}

console.log('\n=== [B] 跨部门并行营次不算上期（现场复现：张蕊 r8 视图）===')
{
  const rounds = [
    { id: 'r8', name: '日照-餐饮21天挑战第一期', depts: ['rizhao/canyin'], chPlan: 'v3' },
    { id: 'r9', name: '日照-房务21天挑战第一期', depts: ['rizhao/fangwu'], chPlan: 'v3' },
  ]
  const rows = [{
    username: 'Rizhao', name: '张蕊', dept: '日照·日照-餐饮', role: 'student', chQ: {},
    chy: [
      // 本期 r8（餐饮）：前测 20/20，无 Day21
      { kind: 'test', day: 1, rd: 'r8', correct: 20, total: 20, at: 1000 },
      { kind: 'practice', day: 2, rd: 'r8', correct: 25, total: 30, si: 0, at: 1100, usedSec: 300 },
      // 并行的房务营次 r9：44 条里的关键几条 —— 含 Day21 期末 18/20
      { kind: 'practice', day: 1, rd: 'r9', correct: 20, total: 30, si: 0, at: 1200, usedSec: 300 },
      { kind: 'test', day: 21, rd: 'r9', correct: 18, total: 20, at: 1300 },
    ],
  }]
  const list = runList(mkSb(rounds, rows, 'r8'))
  if (list) {
    const p = list.find(x => x.username === 'Rizhao')
    ck(!!p, 'B1 学员在名单里（本期有记录）')
    if (p) {
      ck(p.s1 === 100, 'B2 本期前测 = 100（r8 Day1 20/20）', 's1=' + p.s1)
      ck(p.s7 == null, 'B3 本期期末 = 空（r8 无 Day21）', 's7=' + p.s7)
      ck(p.s7p == null, 'B4 上期期末不再显示 90（r9 是隔壁部门同期，绝不当上期）', 's7p=' + p.s7p)
      ck(p.q === 50, 'B5 本期题量只含 r8（test 20 + practice 30 = 50，不吃 r9）', 'q=' + p.q)
    }
  }
}

console.log('\n=== [C] 真跨期照常显示（v185 行为不回归）===')
{
  const rounds = [
    { id: 'r2', name: '艳中第一期', depts: ['dining/yan'] },
    { id: 'r6', name: '艳中第二期', depts: ['dining/yan'] },
  ]
  const rows = [{
    username: 'A', name: '甲', dept: '饮食部·艳中餐厅', role: 'student', chQ: {},
    chy: [
      { kind: 'test', day: 1, rd: 'r2', correct: 8, total: 10, at: 100 },
      { kind: 'test', day: 7, rd: 'r2', correct: 18, total: 20, at: 200 },
      { kind: 'practice', day: 1, rd: 'r6', correct: 9, total: 10, si: 0, at: 300, usedSec: 60 },
    ],
  }]
  const list = runList(mkSb(rounds, rows, 'r6'))
  if (list) {
    const p = list.find(x => x.username === 'A')
    if (p) {
      ck(p.s7p === 90, 'C1 同部门真跨期：上期期末 = 90 照常显示', 's7p=' + p.s7p)
      ck(p.s1 == null, 'C2 上期前测仍不展示（v185 [C] 契约）', 's1=' + p.s1)
      ck(p.q === 10, 'C3 本期统计不受上期影响', 'q=' + p.q)
    }
  }
}

console.log('\n=== [D] 存量营次（depts 空）不被排除 ===')
{
  const rounds = [
    { id: 'r2', name: '艳中第一期', depts: [] },          // 存量：全部门适用
    { id: 'r6', name: '艳中第二期', depts: ['dining/yan'] },
  ]
  const rows = [{
    username: 'B', name: '乙', dept: '饮食部·艳中餐厅', role: 'student', chQ: {},
    chy: [{ kind: 'test', day: 7, rd: 'r2', correct: 16, total: 20, at: 200 }],
  }]
  const list = runList(mkSb(rounds, rows, 'r6'))
  if (list) {
    const p = list.find(x => x.username === 'B')
    ck(!!p, 'D1 上期参与过的人仍入名单（仅上期角标语义保留）')
    if (p) ck(p.s7p === 80, 'D2 空 depts 存量营次仍可作上期参照 = 80', 's7p=' + p.s7p)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
