// ====== 测试 v186：挑战云端进度恢复 —— 吸收锚点 + 跨期污染自愈 ======
// 10-19 实锤（杨宇航）：第二期（r6）页面显示第一期的前测 90 分与 Day2-5 打卡，
//   而云端 r6 里他从没考过前测。病根 = chAbsorbCloudProgress 的 wantSlug 用**实时**
//   chCurrentRound() 解析，而本函数跑在积分榜拉取的**异步回调**里 —— 回调瞬间营次解析
//   翻转（云文档刷新 / 部门切片切换 / _chRounds 瞬时为空回落 '第一期'）时，
//   challengeState 还是本营次存档，wantSlug 却指到了别的营次 → 上期记录灌进本期存档。
// v186 两道防线：
//   ① 吸收锚点 = _chRoundLoaded（存档实际装载的营次）；未装载不吸收。
//   ② 自愈清洗：restored:true 且本期云端无同 day/si 来源 → 删除；
//      真实本机记录 / manual 补录 / cleared 存根永不触碰；云端拉不到绝不清洗。
// 沙箱骨架沿用 test-v140（challenge.js 整载 + eq_session 登录态）。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
let n = 0
function assert(name, cond, msg) {
  n++
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

const CH_SRC = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')

function makeChSandbox(session) {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm() { return true },
  }
  sb.window = sb
  sb.window.__els = {}
  sb.document = {
    addEventListener() {},
    getElementById(id) { return (sb.window.__els[id] = sb.window.__els[id] || { id, innerHTML: '' }) },
  }
  sb.alert = () => {}
  sb.AntiCheat = { start() {}, stop() {}, isActive() { return false }, getViolations() { return 0 }, dismiss() {}, isAdminUser() { return false } }
  // ★ 杨宇航现场：学员属于艳中餐厅，当前营次 = r6（第二期）
  sb.CloudSync = { enqueue() {}, _chExamOpen: true, _chOpen: true, _chOpenAt: Date.now(), _chRoundCurId: 'r6', _chRoundCurName: '艳中餐厅七天挑战第二期', _chRounds: [], _chOpenLocked: false }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  vm.runInContext(['visibleOptionIndexes', 'shuffleOptions', 'checkAnswer', 'safeQType', 'escAttr', 'escHtml'].map(fn => extractFn(APP_SRC, fn)).join('\n'), sb)
  vm.runInContext(
    'const TYPE_LABELS = new Proxy({}, { get: (_, k) => k });' +
    'const LETTERS = ["A", "B", "C", "D"];' +
    'function quizTitleHtml(q) { return "<div>" + (q.question || "") + "</div>" };' +
    'function autoplayListen() {}',
    sb
  )
  vm.runInContext(CH_SRC, sb)
  vm.runInContext('function chDeptKey(){ return "dining/yan" }', sb)
  sb.localStorage.setItem('eq_session', JSON.stringify(session || { username: 'u1', name: '张三', id: 1 }))
  return sb
}

const absorbIn = (sb, rows, expr) => {
  sb.__rows = rows
  return vm.runInContext('chAbsorbCloudProgress(window.__rows)' + (expr ? '; ' + expr : ''), sb)
}

;(async () => {
  console.log('\n🧪 v186 挑战吸收锚点 + 跨期污染自愈')

  // ---------- ① 锚点：营次解析瞬时翻转也不许把上期记录灌进本期存档 ----------
  console.log('\n[1] 锚点防线：存档已装载 r6，chCurrentRound() 瞬时翻转成 r2 → r2 记录拒绝吸收')
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    assert('装载后 _chRoundLoaded = r6', vm.runInContext('_chRoundLoaded', sb) === 'r6', String(vm.runInContext('_chRoundLoaded', sb)))
    assert('r6 存档初始为空', vm.runInContext('Object.keys(challengeState.days).length', sb) === 0)
    // 模拟错位窗口：异步回调瞬间实时营次解析翻转成上一期 r2
    vm.runInContext('chCurrentRound = function(){ return "r2" }', sb)
    const changed = absorbIn(sb, [{ username: 'u1', name: '张三', dept: 'dining/yan', chy: [
      { day: 1, si: 0, kind: 'test', correct: 9, total: 10, usedSec: 139, at: 1790696124488, rd: 'r2' },
      { day: 2, si: 0, kind: 'practice', correct: 30, total: 32, usedSec: 536, at: 1790758160680, rd: 'r2' },
    ] }])
    assert('吸收返回 false（r2 记录被拒）', changed === false, String(changed))
    assert('r6 存档仍为空（无跨期污染）', vm.runInContext('Object.keys(challengeState.days).length', sb) === 0)
  }

  // ---------- ② 未装载不吸收 ----------
  console.log('\n[2] 未装载防线：_chRoundLoaded 为空 → 直接不吸收')
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    vm.runInContext('_chRoundLoaded = ""', sb)   // 模拟尚未装载过任何存档
    const changed = absorbIn(sb, [{ username: 'u1', name: '张三', dept: 'dining/yan', chy: [
      { day: 1, si: 0, kind: 'test', correct: 18, total: 20, usedSec: 200, at: 1790000000000, rd: 'r6' },
    ] }])
    assert('吸收返回 false', changed === false, String(changed))
    assert('存档未被写入', vm.runInContext('Object.keys(challengeState.days).length', sb) === 0)
  }

  // ---------- ③ 自愈：污染记录清除，真实/补录/存根保留 ----------
  console.log('\n[3] 自愈清洗：restored 脏数据删除；真实 / manual / cleared 保留')
  {
    const sb = makeChSandbox()
    // 预置被污染的 r6 存档（模拟 v186 之前已中招的设备）：
    //   1-0 = 从 r2 灌进来的前测（restored，云端 r6 无来源）
    //   1-1 = 学员当天真实练习（无 restored 标记）
    //   2-0 = 从 r2 灌进来的 Day2 打卡（restored，无来源）
    //   3-0 = 管理员补录（manual）
    //   4-0 = 管理员重置存根（cleared）
    sb.localStorage.setItem('eq_challenge_v2_r6', JSON.stringify({
      uid: 'u1',
      days: {
        1: { stages: {
          0: { done: true, restored: true, correct: 9, total: 10, at: 1792000000000 },
          1: { done: true, correct: 9, total: 10, at: 1792000100000 },
        } },
        2: { stages: { 0: { done: true, restored: true, correct: 30, total: 32, at: 1792000200000 } } },
        3: { stages: { 0: { done: true, manual: true, correct: 30, total: 30, at: 1792000300000 } } },
        4: { stages: { 0: { done: true, cleared: true, at: 1792000400000 } } },
      },
    }))
    vm.runInContext('challengeLoad()', sb)
    const changed = absorbIn(sb, [{ username: 'u1', name: '张三', dept: 'dining/yan', chy: [
      // 云端 r6 只有当天真实练习一条（与本地 1-1 同源）
      { day: 1, si: 1, kind: 'practice', correct: 9, total: 10, usedSec: 77, at: 1792000100000, rd: 'r6' },
    ] }])
    assert('清洗发生 → 返回 true', changed === true, String(changed))
    assert('✓ 污染前测（1-0 restored 无来源）已删除', vm.runInContext('chStageRec(1, 0)', sb) === null || vm.runInContext('chStageRec(1, 0) && chStageRec(1, 0).restored', sb) == null, JSON.stringify(vm.runInContext('chStageRec(1, 0)', sb)))
    assert('✓ 真实练习（1-1 无 restored）保留', vm.runInContext('chStageRec(1, 1) && chStageRec(1, 1).done && !chStageRec(1, 1).restored', sb) === true, JSON.stringify(vm.runInContext('chStageRec(1, 1)', sb)))
    assert('✓ 污染 Day2（2-0 restored 无来源）已删除', !vm.runInContext('chStageRec(2, 0)', sb), JSON.stringify(vm.runInContext('chStageRec(2, 0)', sb)))
    assert('✓ 管理员补录（3-0 manual）保留', vm.runInContext('chStageRec(3, 0) && chStageRec(3, 0).manual', sb) === true, JSON.stringify(vm.runInContext('chStageRec(3, 0)', sb)))
    assert('✓ 重置存根（4-0 cleared）保留', vm.runInContext('chStageRec(4, 0) && chStageRec(4, 0).cleared', sb) === true, JSON.stringify(vm.runInContext('chStageRec(4, 0)', sb)))
    assert('存档已落盘（challengeSave）', JSON.parse(sb.localStorage.getItem('eq_challenge_v2_r6')).days[1].stages[0] === undefined)
  }

  // ---------- ④ 合法恢复幂等保留 ----------
  console.log('\n[4] 合法 restored（本期云端有来源）保留 —— 幂等不误删')
  {
    const sb = makeChSandbox()
    sb.localStorage.setItem('eq_challenge_v2_r6', JSON.stringify({
      uid: 'u1',
      days: { 1: { stages: { 0: { done: true, restored: true, correct: 20, total: 20, at: 1792000000000 } } } },
    }))
    vm.runInContext('challengeLoad()', sb)
    const changed = absorbIn(sb, [{ username: 'u1', name: '张三', dept: 'dining/yan', chy: [
      { day: 1, si: 0, kind: 'test', correct: 20, total: 20, usedSec: 97, at: 1791983402322, rd: 'r6' },
    ] }])
    assert('云端有来源 → 无变化返回 false', changed === false, String(changed))
    assert('合法恢复记录保留（20/20=100）', vm.runInContext('chStageDone(1, 0) && chStageScore(1, 0) === 100', sb) === true)
  }

  // ---------- ⑤ 正常吸收回归（v140 主场景仍通） ----------
  console.log('\n[5] 回归：空存档 + 本期云端记录 → 正常恢复')
  {
    const sb = makeChSandbox()
    vm.runInContext('challengeLoad()', sb)
    const changed = absorbIn(sb, [{ username: 'u1', name: '张三', dept: 'dining/yan', chy: [
      { day: 1, si: 0, kind: 'test', correct: 18, total: 20, usedSec: 200, at: 1790000000000, rd: 'r6' },
      { day: 1, si: 1, kind: 'practice', correct: 10, total: 10, usedSec: 60, at: 1790000100000, rd: 'r6' },
    ] }])
    assert('吸收返回 true', changed === true, String(changed))
    assert('前测恢复（18/20=90）', vm.runInContext('chStageDone(1, 0) && chStageScore(1, 0) === 90', sb) === true)
    assert('练习恢复（10/10）', vm.runInContext('chStageDone(1, 1)', sb) === true)
    assert('恢复记录打 restored 标记', vm.runInContext('chStageRec(1, 0) && chStageRec(1, 0).restored', sb) === true)
  }

  // ---------- ⑥ 云端拉不到本人数据 → 绝不清洗 ----------
  console.log('\n[6] 云端无本人数据（me 缺失）→ 存档一个字都不动')
  {
    const sb = makeChSandbox()
    sb.localStorage.setItem('eq_challenge_v2_r6', JSON.stringify({
      uid: 'u1',
      days: { 1: { stages: { 0: { done: true, restored: true, correct: 9, total: 10, at: 1792000000000 } } } },
    }))
    vm.runInContext('challengeLoad()', sb)
    const changed = absorbIn(sb, [{ username: '别人', name: '别人', dept: 'dining/yan', chy: [] }])
    assert('返回 false', changed === false, String(changed))
    assert('污染记录未被触碰（等本人数据到手才清洗）', vm.runInContext('chStageRec(1, 0) && chStageRec(1, 0).restored', sb) === true)
  }

  // ---------- ⑦ 源码契约 ----------
  console.log('\n[7] 源码契约')
  assert('wantSlug 锚定 _chRoundLoaded（不再实时解析）', /wantSlug = chRoundSlug\(_chRoundLoaded\)/.test(CH_SRC))
  assert('旧写法（wantSlug = chRoundSlug(chCurrentRound())）已移除', !/wantSlug = chRoundSlug\(chCurrentRound\(\)\)/.test(CH_SRC))
  assert('未装载守卫存在（typeof _chRoundLoaded）', /typeof _chRoundLoaded === 'undefined' \|\| !_chRoundLoaded/.test(CH_SRC))
  assert('自愈清洗存在（restored + own 来源校验）', CH_SRC.includes('let healed = false') && /r\.restored \|\| r\.manual/.test(CH_SRC) && /own\.has\(Number\(dayK\) \+ '-' \+ Number\(siK\)\)/.test(CH_SRC))
  assert('返回值并入 healed（!changed && !healed）', /if \(!changed && !healed\) return false/.test(CH_SRC))

  console.log('\n' + (testFailed ? '❌ 有断言失败' : `✅ 全部 ${n} 项断言通过`))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
