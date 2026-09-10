// ====== 测试：v65 防作弊对管理员账号豁免 ======
// ① AntiCheat 层：管理员 start() 不激活、不挂监听、切屏不计数、不弹窗；学员照常
// ② 按当前会话动态判定：管理员豁免后换学员会话 → 仍能正常启用
// ③ 集成：管理员 courseStart(homework) 不激活防作弊且能正常交卷记分；学员仍激活
// ④ 源码级：anti-cheat.js 豁免分支 + isAdminUser 导出；app.js/小程序调用点接线
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkEl() {
  const el = {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener(ev, fn) { (el._handlers[ev] = el._handlers[ev] || []).push(fn) },
    removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() { el._removed = true }, lastElementChild: null,
    scrollIntoView() {}, _handlers: {},
    duration: NaN, currentTime: 0, seeking: false, paused: true, ended: false,
  }
  return el
}

function makeSandbox(courseDocRef) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = {}
  const docListeners = {}
  const winListeners = {}
  const counters = { append: 0 }
  const sandbox = {
    console,
    localStorage: {
      store: lsStore,
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => mkEl(),
      body: { appendChild() { counters.append++ } }, title: '',
      hidden: false,
      addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) {
        if (docListeners[ev]) docListeners[ev] = docListeners[ev].filter(f => f !== fn)
      },
      visibilityState: 'visible',
    },
    window: {
      addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) {
        if (winListeners[ev]) winListeners[ev] = winListeners[ev].filter(f => f !== fn)
      },
      dispatchEvent() { return true }, scrollTo() {}, focus() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    alert(m) { sandbox._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      getDashboardData: async () => [], recalcCloudPlacementLevels: async () => ({}),
      flushDuration() {}, pushPending: async () => {},
    },
    CourseStore: {
      status: 'online',
      newId: () => 'aX' + Math.floor(Math.random() * 1e6),
      findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
      findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
      getDoc: async () => JSON.parse(JSON.stringify(courseDocRef.doc)),
      mutate: async fn => {
        const doc = JSON.parse(JSON.stringify(courseDocRef.doc))
        const ret = fn(doc)
        if (ret === false) return null
        courseDocRef.doc = doc
        return true
      },
    },
    _els: elements, _getEl: getEl, _docListeners: docListeners, _winListeners: winListeners, _counters: counters,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  // 真实浏览器里顶层 function 声明会成为 window 属性；vm 沙箱需手动补齐（anti-cheat.js 用 window.t 取词）
  vm.runInContext('try { window.t = t } catch (e) {}', sandbox)
  vm.runInContext(load('anti-cheat.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext('try { window.Store = Store } catch (e) {}', sandbox)
  vm.runInContext(load('qgen.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

// 用 localStorage 里的会话模拟真实登录态（store.js 的 getSession 读 eq_session）
function asRole(sb, username, role) {
  sb.localStorage.setItem('eq_session', JSON.stringify({ id: 1, username, name: username, role }))
  sb.document.hidden = false
}
// 触发一次真实切屏（隐藏标签页）
function fireHide(sb) {
  sb.document.hidden = true
  ;(sb._docListeners.visibilitychange || []).forEach(f => f())
  sb.document.hidden = false
}

const docRef = {
  doc: {
    v: 1,
    classes: [{
      id: 'c1', name: '测试班', note: '', createdBy: 'admin', members: ['张三', 'admin'],
      assignments: [
        { id: 'h1', type: 'homework', title: '第一节作业', status: 'open', questions: [
          { id: 901, category_id: 1, dept: 'all', type: 'single', difficulty: 1, question: 'colleague', options: ['同事', '账单', '菜单', '投诉'], answer: [0], explanation: 'colleague = 同事' },
        ], results: {} },
        { id: 'e1', type: 'exam', title: '小测', status: 'open', duration: 10, questions: [
          { id: 902, category_id: 1, dept: 'all', type: 'single', difficulty: 1, question: 'menu', options: ['菜单', '账单', '同事', '投诉'], answer: [0], explanation: 'menu = 菜单' },
        ], results: {} },
      ],
    }],
  },
}

;(async () => {
  console.log('\n🧪 A. AntiCheat 层：管理员豁免 / 学员照常')
  {
    const sb = makeSandbox(docRef)
    const AC = vm.runInContext('AntiCheat', sb)

    // A1 学员：正常激活 + 切屏计数 + 弹窗
    asRole(sb, '张三', 'student')
    AC.start({ maxViolations: 2, onSubmit: () => { sb._submitted = true } })
    assert('学员 start → 激活', AC.isActive() === true)
    const apBefore = sb._counters.append
    fireHide(sb)
    assert('学员切屏 → 违规计数 1', AC.getViolations() === 1, String(AC.getViolations()))
    assert('学员切屏 → 弹出警告', sb._counters.append > apBefore)
    AC.stop()
    assert('学员 stop → 取消激活', AC.isActive() === false)
    assert('学员 start → 按当前会话 isAdminUser=false', AC.isAdminUser() === false)

    // A2 管理员：不激活、不挂监听、不弹窗、不计数、不强制结束
    asRole(sb, 'admin', 'admin')
    const visBefore = (sb._docListeners.visibilitychange || []).length
    const blurBefore = (sb._winListeners.blur || []).length
    const before = sb._counters.append
    AC.start({ maxViolations: 2, finalKey: 'anticheatTerminate', onSubmit: () => { sb._submitted = true } })
    assert('管理员 start → 不激活', AC.isActive() === false)
    assert('管理员 start → 未新增 visibilitychange 监听', (sb._docListeners.visibilitychange || []).length === visBefore)
    assert('管理员 start → 未新增 blur 监听', (sb._winListeners.blur || []).length === blurBefore)
    const vBefore = AC.getViolations()
    fireHide(sb)
    assert('管理员切屏 → 违规数不增长', AC.getViolations() === vBefore, `${vBefore} → ${AC.getViolations()}`)
    assert('管理员切屏 → 不弹窗', sb._counters.append === before, `append=${sb._counters.append}`)
    assert('管理员切屏 → 不触发强制结束', !sb._submitted)
    assert('管理员 isAdminUser()=true', AC.isAdminUser() === true)

    // A3 动态判定：同一页面换回学员，防作弊要能恢复启用
    asRole(sb, '李四', 'student')
    assert('会话切回学员 → isAdminUser false', AC.isAdminUser() === false)
    AC.start({ maxViolations: 2 })
    assert('会话切回学员 → start 再次生效', AC.isActive() === true)
    AC.stop()

    // A4 无会话（未登录）不豁免，保持原行为
    sb.localStorage.removeItem('eq_session')
    AC.start({ maxViolations: 2 })
    assert('未登录/无 role → 不豁免（照常激活）', AC.isActive() === true)
    AC.stop()
  }

  console.log('\n🧪 B. 集成：线下课作业')
  {
    // B1 管理员试做作业 → 不激活、可正常答完记分
    const sbA = makeSandbox(docRef)
    asRole(sbA, 'admin', 'admin')
    await vm.runInContext('courseTestSeedDoc()', sbA)
    vm.runInContext(`courseStart('c1', 'h1')`, sbA)
    assert('管理员 courseStart(作业) → 防作弊未激活', vm.runInContext('AntiCheat.isActive()', sbA) === false)
    vm.runInContext('courseQuiz.index = 0; coursePick(0)', sbA)
    await vm.runInContext('courseFinishHomework()', sbA)
    const savedAdmin = docRef.doc.classes[0].assignments[0].results['admin']
    assert('管理员作业成绩仍正常记录', !!savedAdmin && savedAdmin.score != null, JSON.stringify(savedAdmin || {}))

    // B2 学员同一作业 → 激活（回归保护）
    const sbS = makeSandbox(docRef)
    asRole(sbS, '张三', 'student')
    await vm.runInContext('courseTestSeedDoc()', sbS)
    vm.runInContext(`courseStart('c1', 'h1')`, sbS)
    assert('学员 courseStart(作业) → 防作弊激活', vm.runInContext('AntiCheat.isActive()', sbS) === true)
  }

  console.log('\n🧪 C. 源码级接线')
  {
    const acSrc = fs.readFileSync(path.join(__dirname, 'anti-cheat.js'), 'utf-8')
    assert('anti-cheat.js 含管理员豁免分支', /if \(isAdminUser\(\)\) \{ stop\(\); return \}/.test(acSrc))
    assert('anti-cheat.js 优先用 Store.isAdmin 判定', /function isAdminUser\(\)[\s\S]{0,500}typeof S\.isAdmin === 'function' && S\.isAdmin\(\)/.test(acSrc))
    assert('anti-cheat.js 兜底读 getSession().role', /function isAdminUser\(\)[\s\S]{0,700}S\.getSession\(\)/.test(acSrc))
    assert('anti-cheat.js 导出 isAdminUser', /return \{ start, stop, isActive, getViolations, dismiss, isAdminUser \}/.test(acSrc))

    // 豁免统一在模块内生效 → 各调用点无需各自判断（平台考试仍照常调用 start）
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    assert('app.js 平台考试仍调用 AntiCheat.start', /AntiCheat\.start\(\{ maxViolations: 3/.test(appSrc))
    const courseSrc = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    assert('course-app.js 作业/测评仍调用 AntiCheat.start', /finalKey: 'anticheatTerminate'/.test(courseSrc))

    const mpTake = path.join(__dirname, '..', 'english-quiz-miniprogram', 'pages', 'take', 'take.js')
    assert('小程序 take.js 存在', fs.existsSync(mpTake), mpTake)
    if (fs.existsSync(mpTake)) {
      const mpSrc = fs.readFileSync(mpTake, 'utf-8')
      assert('小程序 take.js onHide 含管理员豁免', /onHide\(\)[\s\S]{0,600}role === 'admin'\) return/.test(mpSrc))
    }
  }

  console.log(failed ? '\n❌ 存在失败项' : '\n✅ v65 管理员防作弊豁免 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
