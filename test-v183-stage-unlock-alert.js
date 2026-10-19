// test-v183-stage-unlock-alert.js —— v183：挑战阶段解锁口径 + 拦截必须有提示
//
// 现场（2026-10-19）：学员「张振强」（username=Rock，饮食部·客房送餐部，营次 r4）
//   报「无法参加七天挑战考试」。云端 chy 实证：Day1–Day6 全完成、Day7 练习 10/10 已完成，
//   但 Day7 期末考（si=1）记录为 null —— 他从未进入过考试。
//   服务端 7 道闸门（部门/营次/open/examOpen/排期/解锁/提前开放）全部为「开」→ 问题在客户端。
//
// 真因两条：
//   ① chStageUnlocked 用 chStageDone（只认 r.done）→ 前一阶段若是「成绩已重置」的 cleared 存根
//      （{cleared:true, at, total}），后续阶段永久锁死。而 chStageCounted 的注释明写自己是
//      「进度/解锁判定用……保证重置考试成绩不会影响当日打卡、进度条与次日解锁链」—— 口径不符。
//   ② chStartStage 在「未解锁」与「水平测试仅一次」两处静默 return，学员点了毫无反应也无提示，
//      与 v149 已修的「空题」静默 return 是同一类问题。
//
// 本套件锁定：
//   A. chStageUnlocked 采用 Counted 口径（cleared 也算走到过）—— 运行期真跑
//   B. chStartStage 四个拦截分支一律有 alert，无静默 return —— 源码契约 + 运行期真跑
//   C. 反证：chStageDone 仍只认 done（计分/一次性语义不被污染）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')

let pass = 0, fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  — ' + extra : '')) }
}
function extractFn(src, name) {
  const s = src.indexOf('function ' + name + '(')
  if (s < 0) return null
  let i = src.indexOf('{', s), d = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') { d--; if (d === 0) break }
  }
  return src.slice(s, i + 1)
}
// 剥注释（计数类断言必做，避免注释里的旧代码造成假红/假绿）
function codeOnly(src) {
  return src.split('\n').filter(l => {
    const t = l.trim()
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')
}

// ===== A. chStageUnlocked 用 Counted 口径（运行期真跑）=====
console.log('\nA. chStageUnlocked 解锁口径（cleared 存根也解锁）')
function makeSb(days) {
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    alert() {},
    CHALLENGE_DAYS: [
      { day: 1, stages: [{ kind: 'test', count: 20 }, { kind: 'practice', count: 10 }] },
      { day: 2, stages: [{ kind: 'practice', count: 30 }] },
      { day: 3, stages: [{ kind: 'practice', count: 30 }] },
      { day: 4, stages: [{ kind: 'practice', count: 30 }] },
      { day: 5, stages: [{ kind: 'practice', count: 30 }] },
      { day: 6, stages: [{ kind: 'practice', count: 30 }] },
      { day: 7, stages: [{ kind: 'practice', count: 10 }, { kind: 'test', count: 20 }] },
    ],
    Date, Math, JSON, String, Number, Object, Array, Boolean,
    chDayUnlocked: null,
  }
  vm.createContext(sb)
  ;['chStageRec', 'chStageDone', 'chStageCleared', 'chStageCounted', 'chDayDone', 'chStageUnlocked'].forEach(n => {
    vm.runInContext(extractFn(SRC, n), sb)
  })
  // 天锁：Day1 恒开、其余天也开（本套件只测阶段锁，不测天锁 —— 天锁另有 v68/v84 覆盖）
  vm.runInContext('chDayUnlocked = function () { return true }', sb)
  // ★ let 变量必须用 runInContext 赋值
  vm.runInContext('challengeState = ' + JSON.stringify({ uid: 't', days }), sb)
  return sb
}

// A1: 前置阶段正常 done → 解锁
{
  const sb = makeSb({ 7: { stages: [{ day: 7, si: 0, kind: 'practice', correct: 10, total: 10, done: true, at: 1 }] } })
  assert('A1 前置 done → 解锁', vm.runInContext('chStageUnlocked(7,1)', sb) === true)
}
// A2: 前置阶段是 cleared 存根（管理员重置过考试成绩）→ 必须仍解锁（v183 修复点）
{
  const sb = makeSb({ 7: { stages: [{ cleared: true, at: 1, total: 10 }] } })
  assert('A2 前置 cleared 存根 → 仍解锁（v183：旧代码此处锁死）', vm.runInContext('chStageUnlocked(7,1)', sb) === true,
    'got ' + vm.runInContext('chStageUnlocked(7,1)', sb))
}
// A3: 前置阶段完全没有记录 → 仍锁（不能被放得太宽）
{
  const sb = makeSb({ 7: { stages: [] } })
  assert('A3 前置无记录 → 仍锁（不放宽）', vm.runInContext('chStageUnlocked(7,1)', sb) === false)
}
// A4: Day1 第一环节 → 走天锁
{
  const sb = makeSb({})
  assert('A4 si=0 走天锁（返回 chDayUnlocked）', vm.runInContext('chStageUnlocked(1,0)', sb) === true)
}
// A5: 前一个阶段是「done 但 total=0」的异常态 → done 为真即解锁（保持原语义）
{
  const sb = makeSb({ 7: { stages: [{ done: true, correct: 0, total: 0, at: 1 }] } })
  assert('A5 前置 done=true 仍解锁（原语义不变）', vm.runInContext('chStageUnlocked(7,1)', sb) === true)
}

// ===== B. chStageDone 语义未被污染（反证）=====
console.log('\nB. chStageDone 仍只认 done（计分/一次性语义不受 v183 影响）')
{
  const sb = makeSb({ 7: { stages: [{ cleared: true, at: 1, total: 10 }] } })
  assert('B1 cleared 存根 → chStageDone=false（不被当作已完成计分）', vm.runInContext('chStageDone(7,0)', sb) === false)
  assert('B2 cleared 存根 → chStageCounted=true', vm.runInContext('chStageCounted(7,0)', sb) === true)
  assert('B3 cleared 存根 → chStageCleared=true', vm.runInContext('chStageCleared(7,0)', sb) === true)
}

// ===== C. 源码契约：chStartStage 不得静默 return =====
console.log('\nC. chStartStage 拦截分支必须有提示（源码契约）')
const startSrc = codeOnly(extractFn(SRC, 'chStartStage') || '')
assert('C1 chStartStage 抽到', !!startSrc)
assert('C2 未解锁分支不再静默 return',
  !/if \(!chStageUnlocked\(day, si\) && !examEarly\)\s*return\b/.test(startSrc),
  '仍存在裸 return')
assert('C3 未解锁分支给出 chStageLocked 提示',
  /if \(!chStageUnlocked\(day, si\) && !examEarly\)\s*\{\s*alert\(t\('chStageLocked'\)\)\s*return\s*\}/.test(startSrc))
assert('C4 水平测试仅一次不再静默 return',
  !/challengeKindOf\(day, si\) === 'test' && chStageDone\(day, si\)\)\s*return\b(?!\s*\})/.test(startSrc),
  '仍存在裸 return')
assert('C5 水平测试仅一次给出 chOnceOnly 提示', /alert\(t\('chOnceOnly'\)\)/.test(startSrc))
assert('C6 空题分支仍给 chEmptyAlert（v149 不被回退）', /alert\(t\('chEmptyAlert'\)\)/.test(startSrc))
assert('C7 未开放分支仍给 chNotOpenAlert（v77 不被回退）', /alert\(t\('chNotOpenAlert'\)\)/.test(startSrc))
assert('C8 考试锁分支仍给 chExamLockedAlert（v76 不被回退）', /alert\(t\('chExamLockedAlert'\)\)/.test(startSrc))
// 逐行反证：chStartStage 里除「成功建会话后」的收尾外，不应有裸 if(...) return
{
  const bare = startSrc.split('\n').filter(l => {
    const t = l.trim()
    if (!/^if \(/.test(t)) return false
    return /\breturn\s*$/.test(t) || /\breturn\b(?!.*alert)/.test(t) && !/alert/.test(t)
  })
  assert('C9 chStartStage 内无「if(...) 裸 return」', bare.length === 0, bare.join(' | '))
}

// ===== D. i18n 键存在（中英成对）=====
console.log('\nD. 复用的 i18n 键中英成对')
;['chStageLocked', 'chOnceOnly'].forEach(k => {
  const zh = new RegExp(k + ':').test(I18N)
  assert('D ' + k + ' 在 i18n 中存在', zh)
})
assert('D chStageLocked 中文文案含「完成上方环节」', /chStageLocked: '完成上方环节后解锁'/.test(I18N))
assert('D chStageLocked 英文文案含「Finish the step above」', /chStageLocked: 'Finish the step above to unlock'/.test(I18N))

// ===== E. 注释口径一致性（防再次跑偏）=====
console.log('\nE. 口径一致性')
assert('E1 chStageUnlocked 使用 chStageCounted', /return si === 0 \? chDayUnlocked\(day\) : chStageCounted\(day, si - 1\)/.test(SRC))
assert('E2 chStageCounted 注释声明自己是解锁判定口径', /进度\/解锁判定用/.test(SRC))

console.log('\n' + (fail === 0 ? '✅ v183 全部断言通过' : '❌ 存在失败断言') + '  (' + pass + ' 通过 / ' + fail + ' 失败)')
process.exit(fail === 0 ? 0 : 1)
