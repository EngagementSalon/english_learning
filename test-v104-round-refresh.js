// test-v104-round-refresh.js
// v104 缺陷：营次在学员页面已打开之后才创建时，「拉取后重渲染」的比对只看了两个布尔量
// （chOpenLocked / chFinalExamLocked）。本部门从「无营次」变成「有营次」时，
// open 前后都是 true（都被锁），值没变化 → 不重渲染、不重拉，
// 学员永远停在旧状态：挑战页打得开、历史成绩照常显示、心跳照常上报，但开始考试被总闸拦下
// → 云端零上报。学员以为考完了，管理员查不到（表现为「成绩没同步过来」）。
//
// 本测试锁死两点：
//   ① 营次身份（本部门营次 id + 有无营次）必须参与比对 → 跃迁能触发重渲染
//   ② 源码级防回归：比对里必须出现 shape / dept 维度，且 _chGateRendered 必须记 shape
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else { fail++; console.log('  ✗ ' + msg) }
}

console.log('=== 组 1：营次身份比对必须存在（源码级护栏）===')

// 1) _chGateRendered 必须记录 shape（营次 id + 有无营次）
assert(/let _chGateRendered = null/.test(src), '_chGateRendered 声明为可空')
assert(/_chGateRendered\s*=\s*\{[\s\S]{0,320}?shape:\s*/.test(src),
  '_chGateRendered 赋值里记录了 shape')
assert(/_chGateRendered\s*=\s*\{[\s\S]{0,320}?dept:\s*chDeptKey\(\)/.test(src),
  '_chGateRendered 赋值里记录了 dept')
assert(/_chGateRendered\s*=\s*\{[\s\S]{0,400}?\(chRoundRecForDept\(\)\s*\|\|\s*\{\}\)\.id/.test(src),
  'shape 由 chRoundRecForDept().id 派生')
assert(/_chGateRendered\s*=\s*\{[\s\S]{0,400}?chNoRoundForDept\(\)/.test(src),
  'shape 把「本部门无营次」纳入身份')

console.log('=== 组 2：重渲染比对必须覆盖跃迁（源码级护栏）===')
assert(/shape\s*!==\s*_chGateRendered\.shape/.test(src),
  '比对包含 shape !== _chGateRendered.shape（v104 核心）')
assert(/cur\.dept\s*!==\s*_chGateRendered\.dept/.test(src),
  '比对包含 dept !== _chGateRendered.dept')
assert(/cur\.open\s*!==\s*_chGateRendered\.open/.test(src),
  '保留 open 比对（v77 原有语义不丢）')
assert(/cur\.exam\s*!==\s*_chGateRendered\.exam/.test(src),
  '保留 exam 比对（v76 原有语义不丢）')
assert(/cur\.round\s*!==\s*_chGateRendered\.round/.test(src),
  '保留 round 比对（v88 原有语义不丢）')

console.log('=== 组 3：模拟「无营次 → 有营次」跃迁，验证比对逻辑能识别 ===')

// 复刻比对逻辑（与源码同口径）
const mkShape = rec => (rec && rec.id ? String(rec.id) : '') + '|' + (rec ? '0' : '1')
const shouldRerender = (prev, cur) =>
  cur.open !== prev.open || cur.exam !== prev.exam || cur.dept !== prev.dept || cur.shape !== prev.shape

// 场景：本部门原先无营次（只有别部门营次）→ 营次后来才建
const before = { open: true, exam: true, dept: 'dining/sig', shape: mkShape(null) }      // 无适用营次
const after = { open: false, exam: false, dept: 'dining/sig', shape: mkShape({ id: 'r1' }) } // 有 r1

assert(before.shape === '|1', '无营次时 shape = "|1"')
assert(after.shape === 'r1|0', '有 r1 时 shape = "r1|0"')
assert(before.shape !== after.shape, '两态 shape 不同 → 可区分')

// 旧口径（只比 open/exam）：此处 open 从 true→false 会变；但若挑战开关本就是手动开着，
// open 可能前后都为 false，旧口径就漏了。构造这种情形：
const b2 = { open: false, exam: false, dept: 'dining/sig', shape: mkShape(null) }
const a2 = { open: false, exam: false, dept: 'dining/sig', shape: mkShape({ id: 'r1' }) }
const oldLogic = (p, c) => c.open !== p.open || c.exam !== p.exam
assert(oldLogic(b2, a2) === false, '旧口径在这种情形下判「无需重渲染」（缺陷成因）')
assert(shouldRerender(b2, a2) === true, '新口径判「需要重渲染」（已修复）')

console.log('=== 组 4：换部门也要触发重渲染 ===')
const d1 = { open: false, exam: false, dept: 'dining/yan', shape: 'r2|0' }
const d2 = { open: false, exam: false, dept: 'dining/sig', shape: 'r1|0' }
assert(shouldRerender(d1, d2) === true, '切换部门（营次随之改变）触发重渲染')

console.log('=== 组 5：营次被删除（有 → 无）同样触发 ===')
const e1 = { open: false, exam: false, dept: 'dining/sig', shape: 'r1|0' }
const e2 = { open: true, exam: true, dept: 'dining/sig', shape: '|1' }
assert(shouldRerender(e1, e2) === true, '营次被删（有→无）触发重渲染')

console.log('=== 组 6：无关变化不应误触发（防抖动）===')
const f1 = { open: false, exam: false, dept: 'dining/sig', shape: 'r1|0' }
const f2 = { open: false, exam: false, dept: 'dining/sig', shape: 'r1|0' }
assert(shouldRerender(f1, f2) === false, '完全一致时不重渲染（避免每次拉取都重绘）')

console.log('')
console.log(fail === 0 ? `✅ 全部通过（${pass} 断言）` : `❌ ${fail} 条失败 / 共 ${pass + fail} 条`)
process.exit(fail === 0 ? 0 : 1)
