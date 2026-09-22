// ====== 测试 v99：期末考试提前开放（管理员点「开放考试」→ 未完成课程也可参加） ======
// 用户原话：「七天挑战第七天考试在管理员点击开始后 即使没完成七天课程也可参与」
// 改造前：第七天期末考试需同时满足 ① 营次 examOpen 开（v76）② Day7 天锁解锁（v71：Day6 全部完成
//         且已过次日 0 点）③ 阶段链锁（Day7 练习完成）。学员必须走完前六天才有资格参加期末考试。
// v99：考试开关（营次 examOpen / 侧信道 _chExamOpen）开着 → 期末考试阶段本身豁免天锁与阶段链锁，
//      未完成 Day1-6 的学员可直接参加；Day7 每日练习仍按正常进度解锁；v77 挑战全局门禁不豁免。
//
// 覆盖点：
// ① chExamEarlyOpen 判定：营次 examOpen 开/关；无营次时回退侧信道 _chExamOpen
// ② chStageRowHtml：考试行在「天锁未满足 + 考试开」时直接给开始按钮 + 🎓 开放标记；
//    Day7 练习行不受影响仍锁；Day1 正常入口不受影响
// ③ chStartStage 行为：考试关 → 拦截；考试开 → 未完成课程也可开考（kind=test 防作弊照常）；
//    考试开但挑战全局关闭 → 仍拦（v77）；考试已做过 → 仍然仅一次（v76 原则不变）
// ④ chProgressHtml：考试开时第 7 天格子显示 🎓（绿色），关时恢复 🔒
// ⑤ i18n：chExamEarlyTag / dashChExamHint 中英成对且语义到位
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}

const elements = {}
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {},
    textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}
const getEl = id => elements[id] || (elements[id] = mkEl())

const sandbox = {
  localStorage: {
    store: { 'eq_course_only_v43': '1' },
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: {
    addEventListener() {}, scrollTo() {},
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function () {},
  },
  document: {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    body: { appendChild() {} },
    title: '',
    addEventListener() {},
  },
  __alerts: [],
  alert(m) { sandbox.__alerts.push(String(m)) },
  confirm() { return true }, prompt() { return null },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean,
  AntiCheat: { start() {}, stop() {} },   // chStartStage 对 test 阶段会调用；v99 不测防作弊本身
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sandbox)

const run = code => vm.runInContext(code, sandbox)
const Store = run('Store')

run(`localStorage.setItem('eq_categories', JSON.stringify(BANK.categories))`)
// v99 不测题池构建（v80 已覆盖）→ 抽题函数打桩，专注门禁/渲染行为
run(`challengeStageQuestions = function (day, si) {
  return [{ id: 9001, type: 'single', options: ['a', 'b'], answer: [0], difficulty: 1, question: 'V99' }]
}`)
run(`renderChallengeQuiz = function () { window.__r99 = (window.__r99 || 0) + 1 }`)

// 云端营次：单营次全部门适用，手动开放、无排期；考试开关默认关
const R1 = { id: 'r1', name: '第一期', depts: [], open: true, startAt: 0, endAt: 0, examOpen: false }
function feedCloud(examOpen) {
  R1.examOpen = examOpen === true
  run(`CloudSync._chRounds = ${JSON.stringify([R1])}`)
  run(`CloudSync._chRoundCurId = 'r1'`)
  run(`CloudSync._chRoundCurName = '第一期'`)
  run(`CloudSync._chOpen = true; CloudSync._chOpenAt = 0; CloudSync._chExamOpen = ${examOpen === true}; CloudSync._chNoRound = false`)
  run(`CloudSync._chOpenLocked = undefined`)
  run(`CloudSync._chResets = {}; CloudSync._chResetModes = {}`)
}
function setStudent() {
  Store.getSession = () => ({ role: 'student', name: 's1', dept: '饮食部·标帜餐厅' })
  Store.getUser = () => ({ name: 's1', dept: '饮食部·标帜餐厅' })
}
const examRowStageJson = () => run(`JSON.stringify(CHALLENGE_DAYS.find(d => d.day === 7).stages[1])`)
const practiceRowStageJson = () => run(`JSON.stringify(CHALLENGE_DAYS.find(d => d.day === 7).stages[0])`)
const day1RowStageJson = () => run(`JSON.stringify(CHALLENGE_DAYS.find(d => d.day === 1).stages[0])`)

;(async () => {
  console.log('\n🧪 v99 期末考试提前开放（管理员点「开放考试」→ 未完成课程也可参加）')

  setStudent()
  run(`challengeLoad()`)
  feedCloud(false)

  console.log('\n1️⃣  chExamEarlyOpen 开关判定')
  assert('考试关（examOpen=false）→ 提前开放 = false', run('chExamEarlyOpen()') === false, run('chExamEarlyOpen()'))
  assert('考试关 → chFinalExamLocked = true', run('chFinalExamLocked()') === true)
  feedCloud(true)
  assert('考试开（examOpen=true）→ 提前开放 = true', run('chExamEarlyOpen()') === true, run('chExamEarlyOpen()'))
  assert('考试开 → chFinalExamLocked = false', run('chFinalExamLocked()') === false)
  run(`CloudSync._chRounds = null; CloudSync._chRounds = undefined`)
  run(`CloudSync._chExamOpen = true`)
  assert('无营次数据 → 回退侧信道 _chExamOpen=true → 提前开放', run('chExamEarlyOpen()') === true, run('chExamEarlyOpen()'))
  run(`CloudSync._chExamOpen = false`)
  assert('无营次数据 + _chExamOpen=false → 不提前开放', run('chExamEarlyOpen()') === false, run('chExamEarlyOpen()'))
  feedCloud(true)

  console.log('\n2️⃣  chStageRowHtml：考试行 vs 练习行 vs Day1')
  const row71open = run(`chStageRowHtml(7, 1, ${examRowStageJson()})`)
  assert('考试开 + 未走到 Day7 → 考试行有开始按钮 chStartStage(7,1)', row71open.indexOf('chStartStage(7,1)') >= 0, row71open.slice(0, 200))
  assert('考试行带 🎓 全员开放标记', row71open.indexOf(run(`t('chExamEarlyTag')`)) >= 0)
  assert('考试行不再显示阶段锁文案', row71open.indexOf(run(`t('chStageLocked')`)) < 0, row71open.slice(0, 200))
  const row70open = run(`chStageRowHtml(7, 0, ${practiceRowStageJson()})`)
  assert('Day7 练习行不受豁免：仍无开始按钮', row70open.indexOf('chStartStage(7,0)') < 0, row70open.slice(0, 200))
  assert('Day7 练习行仍显示锁', row70open.indexOf('🔒') >= 0)
  const row10 = run(`chStageRowHtml(1, 0, ${day1RowStageJson()})`)
  assert('Day1 首环节正常有开始按钮（不受 v99 影响）', row10.indexOf('chStartStage(1,0)') >= 0, row10.slice(0, 200))
  feedCloud(false)
  const row71closed = run(`chStageRowHtml(7, 1, ${examRowStageJson()})`)
  assert('考试关 + 未走到 Day7 → 考试行仍是阶段锁文案（v99 前行为）', row71closed.indexOf(run(`t('chStageLocked')`)) >= 0 && row71closed.indexOf('chStartStage(7,1)') < 0, row71closed.slice(0, 200))
  feedCloud(true)

  console.log('\n3️⃣  chStartStage 行为')
  run(`chs = null`)
  feedCloud(false)
  const alertsBefore = sandbox.__alerts.length
  run(`chStartStage(7, 1)`)
  assert('考试关 → chs 不建立（未走到 Day7 被拦）', run('chs') === null || run('chs') === undefined, JSON.stringify(run('chs')))
  assert('考试关 → 未触发考试锁 alert（走的是阶段锁静默 return）', sandbox.__alerts.length === alertsBefore)
  feedCloud(true)
  run(`chStartStage(7, 1)`)
  const sess = run('JSON.stringify(chs && { day: chs.day, si: chs.si, kind: chs.kind })')
  assert('考试开 → 未完成课程也能开考：chs={day:7,si:1,kind:test}', sess === JSON.stringify({ day: 7, si: 1, kind: 'test' }), sess)
  assert('考试开 → 进入答题渲染', run('window.__r99') === 1, run('window.__r99'))
  run(`chs = null`)
  run(`CloudSync._chRounds[0].open = false; CloudSync._chOpen = false`)
  const alertsMid = sandbox.__alerts.length
  run(`chStartStage(7, 1)`)
  assert('考试开但挑战全局关 → 仍被 v77 门禁拦截并 alert', run('chs') == null && sandbox.__alerts.length > alertsMid, JSON.stringify(run('chs')) + ' / ' + sandbox.__alerts.join('|'))
  feedCloud(true)
  run(`challengeLoad()`)
  run(`challengeState.days[7] = { stages: { 1: { done: true, correct: 18, total: 20, at: ${Date.now()} } } }; challengeSave()`)
  run(`chs = null`)
  run(`chStartStage(7, 1)`)
  assert('考试已做过 → 仍然仅一次，不再建立会话', run('chs') == null, JSON.stringify(run('chs')))

  console.log('\n4️⃣  chProgressHtml 第 7 天格子')
  feedCloud(false)
  run(`challengeLoad()`)
  assert('考试关 → 进度卡无 🎓', run('chProgressHtml()').indexOf('🎓') < 0)
  feedCloud(true)
  run(`challengeLoad()`)
  const prog = run('chProgressHtml()')
  assert('考试开 → 第 7 天格子显示 🎓', prog.indexOf('🎓') >= 0, prog.slice(0, 160))
  assert('进度卡其余天仍显示 🔒（只有第 7 天换 🎓）', prog.indexOf('🔒') >= 0)

  console.log('\n5️⃣  i18n 中英成对')
  const tagZh = run(`t('chExamEarlyTag')`)
  assert('中文标记含「全员开放」', tagZh.indexOf('全员开放') >= 0, tagZh)
  run(`setLang('en')`)
  const tagEn = run(`t('chExamEarlyTag')`)
  assert('英文标记含 Open to all', tagEn.indexOf('Open to all') >= 0, tagEn)
  const hintEn = run(`t('dashChExamHint')`)
  assert('英文看板提示提到未完成课程也可参加', /have not finished/i.test(hintEn), hintEn)
  run(`setLang('zh')`)
  const hintZh = run(`t('dashChExamHint')`)
  assert('中文看板提示提到未完成七天课程也可直接参加', hintZh.indexOf('未完成七天课程的学员也可直接参加') >= 0, hintZh)
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  const zhPart = i18nSrc.slice(i18nSrc.indexOf('zh: {'), i18nSrc.indexOf('en: {'))
  const enPart = i18nSrc.slice(i18nSrc.indexOf('en: {'))
  assert('chExamEarlyTag 键 zh/en 成对存在', /\bchExamEarlyTag\s*:/.test(zhPart) && /\bchExamEarlyTag\s*:/.test(enPart))

  console.log('\n' + (testFailed ? '❌ 存在失败断言' : '✅ v99 全部断言通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
