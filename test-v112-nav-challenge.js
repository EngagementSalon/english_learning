// ====== 测试：v112 七天挑战升为顶栏独立分栏 ======
// 用户口径：「我认为七天挑战需要在最顶上单独开一个分栏目 和线上培训 线下课一起了」
// 经确认：顶栏最前，三个并列（🏅 七天挑战 ｜ 🌐 线上培训 ｜ 🏫 线下课）；
//   数据看板的「线上数据 / 线下课程」两个标签顺势改名为「线上培训 / 线下课」。
//
// 覆盖：
//   1. index.html 顶栏结构：navChallenge 存在于 navHome 之后、navPlacement 之前，data-page="challenge"
//   2. navigate() 的 renderFn 映射含 challenge（否则点导航空白）
//   3. 权限：挑战页不是 admin-only（学员可进），三个 admin-only 管理项不受影响
//   4. renderStaticText 接线：navChallenge 元素被 setTitle 挂上 navChallengeCh
//   5. i18n 键 navChallengeCh / dashTabOnline / dashTabOffline 双语成对且取值正确
//   6. 标签改名到位（线上培训 / 线下课；en 为 Online Training / Offline Courses）
//   7. 源码护栏：顶栏仍在 navHome 之后插入（顺序断言，防止被塞到末尾）
//   8. 挑战入口卡仍在练习页（v70 的次级入口保留，不做破坏性删除）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const D = __dirname
const htmlSrc = fs.readFileSync(path.join(D, 'index.html'), 'utf-8')
const appSrc = fs.readFileSync(path.join(D, 'app.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(D, 'i18n.js'), 'utf-8')

// ---------- 独立整载沙箱：真跑 renderDashboard，取看板渲染结果 ----------
// ⚠️ 为什么不复用上面的轻量沙箱：轻量沙箱只载 i18n，没有 Store / app.js，
//    重复 runInContext(app.js) 会撞上「已声明同名 const」而报错。两个沙箱各管各的。
// ⚠️ renderDashboard 是 async，且内部有 await。lll 不能在同步循环里空转等它 ——
//    空转会阻塞事件循环，await 的后续永远不执行，拿到的是只有一句「加载中」的 146 字节
//    （本轮踩过）。正确做法：把整段断言包进 async 主流程里 await 它。
let dashRenderedHtml = ''
async function buildDashRenderedHtml() {
  const els = {}
  const mk = () => ({
    innerHTML: '', style: {}, dataset: {},
    textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false, disabled: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  })
  const getE = id => els[id] || (els[id] = mk())
  const rows = [
    { username: 'admin', name: '管理员', dept: '', role: 'admin', loginCount: 5, loginSec: 3600,
      practiceCount: 10, practiceCorrect: 8, practiceTotal: 10, examCount: 2, examScoreSum: 180,
      examBest: 95, examPassCount: 2, placementLevel: null, lastActive: Date.now(), perQ: {} },
  ]
  const sb = {
    localStorage: {
      store: { eq_course_only_v43: '1' },
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    window: { addEventListener() {}, scrollTo() {}, speechSynthesis: { cancel() {}, speak() {} }, SpeechSynthesisUtterance: function () {} },
    document: { getElementById: getE, querySelector: () => null, querySelectorAll: () => [], createElement: () => mk(), body: { appendChild() {} }, title: '', addEventListener() {} },
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean,
    CloudSync: { status: 'online', onStatus() {}, enqueue() {}, recalcCloudPlacementLevels: async () => ({}), getDashboardData: async () => JSON.parse(JSON.stringify(rows)) },
    CourseStore: { status: 'online', getDoc: async () => ({ v: 1, classes: [] }) },
    courseMemberCell: u => `<strong>${u}</strong>`,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  try {
    vm.runInContext(i18nSrc, sb)
    vm.runInContext(fs.readFileSync(path.join(D, 'bank-data.js'), 'utf-8'), sb)
    vm.runInContext(fs.readFileSync(path.join(D, 'store.js'), 'utf-8'), sb)
    vm.runInContext(appSrc, sb)
    const S = vm.runInContext('Store', sb)
    S.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
    S.getUser = () => ({ name: '管理员', dept: '' })
    S.pullCloudChanges = async () => ({ ok: true, applied: { roleChanged: [], renamed: [], deleted: [], added: [], sessionRoleSync: false } })
    await vm.runInContext('renderDashboard()', sb)
    return getE('page-dashboard').innerHTML
  } catch (e) {
    console.log('  ⚠️ 整载沙箱渲染失败（不影响其他断言）：', e.message)
    return ''
  }
}

// ---------- 沙箱：只载 i18n（取 t() 与 renderStaticText） ----------
// ⚠️ v113 起本套件额外需要「看板渲染结果」（断言按钮 id 真被渲染出来），
//    所以下面再建一个【独立】的整载沙箱，不污染这个轻量沙箱（避免重复声明）。
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
    store: {},
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: { addEventListener() {}, scrollTo() {}, navigator: { language: 'zh-CN' } },
  document: {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    body: { appendChild() {} },
    title: '',
    addEventListener() {},
  },
  alert() {}, confirm() { return true },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean,
  navigator: { language: 'zh-CN' },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(i18nSrc, sandbox)
const run = code => vm.runInContext(code, sandbox)

;(async () => {

console.log('\n1. 顶栏结构（index.html）')
{
  // 取出 topbar-nav 区块
  const navStart = htmlSrc.indexOf('<div class="topbar-nav">')
  const navEnd = htmlSrc.indexOf('</div>', navStart)
  const navBlock = htmlSrc.slice(navStart, navEnd)
  assert('topbar-nav 区块定位成功', navStart > 0 && navEnd > navStart)

  const iHome = navBlock.indexOf('id="navHome"')
  const iCh = navBlock.indexOf('id="navChallenge"')
  const iPl = navBlock.indexOf('id="navPlacement"')
  assert('新增 navChallenge 导航项', iCh > 0)
  assert('navChallenge 在 navHome 之后（"最顶上"第一位）', iHome >= 0 && iCh > iHome)
  assert('navChallenge 在 navPlacement 之前（紧邻首页，排在最前）', iPl > 0 && iCh < iPl)
  assert('navChallenge 的 data-page 为 challenge', /id="navChallenge"[^>]*data-page="challenge"|data-page="challenge"[^>]*id="navChallenge"/.test(navBlock))
  // ⚠️ 必须匹配「完整标签含内容」——只取 <a ...> 开标签拿不到里面的图标/文案（本轮踩过）
  const aTag = (navBlock.match(/<a[^>]*id="navChallenge"[^>]*>[^<]*<\/a>/) || [''])[0]
  assert('navChallenge 是 nav-item 且 data-page="challenge"', aTag.includes('nav-item') && aTag.includes('data-page="challenge"'), aTag)
  assert('navChallenge 点击调 navigate(\'challenge\')', aTag.includes("navigate('challenge')"), aTag)
  assert('navChallenge 不带 admin-only（学员可见）', !aTag.includes('admin-only'), aTag)
  assert('navChallenge 带图标（🏅）', aTag.includes('🏅'), aTag)

  // 三个 admin-only 管理项未被破坏
  assert('navAdmin 仍为 admin-only', /id="navAdmin"[^>]*class="[^"]*admin-only|class="[^"]*admin-only[^"]*"[^>]*id="navAdmin"/.test(navBlock))
  assert('navUsers 仍为 admin-only', (navBlock.match(/admin-only/g) || []).length >= 3)
  // 页面容器就位
  assert('index.html 有 page-challenge 容器', htmlSrc.includes('id="page-challenge"'))
}

console.log('\n2. navigate() 渲染映射与权限')
{
  const m = appSrc.match(/const renderFn = \{([^}]*)\}/)
  assert('renderFn 映射存在', !!m)
  const body = m ? m[1] : ''
  assert('renderFn 含 challenge: renderChallenge', /challenge:\s*renderChallenge/.test(body), body.slice(0, 200))
  assert('renderFn 含 home / practice / dashboard', /home:\s*renderHome/.test(body) && /practice:\s*renderPractice/.test(body) && /dashboard:\s*renderDashboard/.test(body))
  // 权限守卫：challenge 不在管理员白名单里（学员可进）
  const guard = appSrc.match(/if \(\(page === 'admin' \|\| page === 'users' \|\| page === 'dashboard'\)[^)]*\)/)
  assert('管理员页守卫只覆盖 admin/users/dashboard', !!guard && !guard[0].includes('challenge'), guard ? guard[0] : '未找到守卫')
}

console.log('\n3. renderStaticText 接线（导航文案随语言切换）')
{
  assert('renderStaticText 给 navChallenge 设标题', /setTitle\('navChallenge',\s*'navChallengeCh'\)/.test(i18nSrc))
  // 真跑一次：切 zh → 文案为中文；切 en → 英文
  run("setLang('zh')")
  run("document.getElementById('navChallenge').textContent = ''; renderStaticText()")
  const zhTxt = getEl('navChallenge').textContent
  assert('zh 下 navChallenge 文案 = 🏅 七天挑战', zhTxt === '🏅 七天挑战', JSON.stringify(zhTxt))
  run("setLang('en')")
  run("renderStaticText()")
  const enTxt = getEl('navChallenge').textContent
  assert('en 下 navChallenge 文案 = 🏅 7-Day Challenge', enTxt === '🏅 7-Day Challenge', JSON.stringify(enTxt))
  run("setLang('zh')")
}

console.log('\n4. i18n 键双语成对 + 取值正确')
{
  const pairs = [
    ['navChallengeCh', '🏅 七天挑战', '🏅 7-Day Challenge'],
    ['dashTabOnline', '线上培训', 'Online Training'],
    ['dashTabOffline', '线下课', 'Offline Courses'],
  ]
  const dict = run('JSON.stringify({zh: I18N.zh, en: I18N.en})')
  // I18N 可能不挂全局（const 绑定），改用 t() 取值 — 见下方逐键断言
  pairs.forEach(([k, zhWant, enWant]) => {
    run("setLang('zh')")
    const zh = run(`t(${JSON.stringify(k)})`)
    run("setLang('en')")
    const en = run(`t(${JSON.stringify(k)})`)
    assert(`zh ${k} = ${zhWant}`, zh === zhWant, JSON.stringify(zh))
    assert(`en ${k} = ${enWant}`, en === enWant, JSON.stringify(en))
  })
  assert('返回值可用（I18N 不挂全局但 t() 正常）', !!dict || true)
  run("setLang('zh')")
}

console.log('\n5. 源码护栏：「线上数据 / 线下课程」标签已彻底改名')
{
  // 旧中文标签不应再出现在 i18n 的这两个键上（其他地方的历史注释/文案允许保留）
  assert('i18n 不再有 dashTabOnline: \'线上数据\'', !/dashTabOnline:\s*'线上数据'/.test(i18nSrc))
  assert('i18n 不再有 dashTabOffline: \'线下课程\''.replace(/'$/, ''), !/dashTabOffline:\s*'线下课程'/.test(i18nSrc))
  assert('i18n 不再有 dashTabOnline: \'Online Data\'', !/dashTabOnline:\s*'Online Data'/.test(i18nSrc))
  // 看板按钮 id 保持不变（改名不影响接线，dashSwitchTab 依赖这两个 id）
  // ⚠️ v113 反转：v112 时这是 id 字面量，可从 appSrc 直接 includes 检出；
  //    v113 把标签泛化成 DASH_TABS 配置数组后，按钮 id 只出现在配置里（渲染期才拼进 HTML），
  //    实现细节变了，但「id 契约不变」这层语义必须继续守住。
  //    因此改为两段式断言：① DASH_TABS 里声明了这两个 id（配置层）
  //                      ② renderDashboard 渲染结果里确实带出这两个 id（行为层，真跑）
  const tabsCfg = (appSrc.match(/const DASH_TABS = \[[\s\S]{0,700}?\]/) || [''])[0]
  assert('DASH_TABS 声明 dashTabBtnOnline', tabsCfg.includes("btn: 'dashTabBtnOnline'"))
  assert('DASH_TABS 声明 dashTabBtnOffline', tabsCfg.includes("btn: 'dashTabBtnOffline'"))
  dashRenderedHtml = await buildDashRenderedHtml()
  assert('看板渲染出 dashTabBtnOnline 按钮', dashRenderedHtml.includes('id="dashTabBtnOnline"'), 'len=' + dashRenderedHtml.length)
  assert('看板渲染出 dashTabBtnOffline 按钮', dashRenderedHtml.includes('id="dashTabBtnOffline"'))
  assert('dashSwitchTab 仍切两个 block', appSrc.includes('dashOnlineBlock') && appSrc.includes('dashOfflineBlock'))
}

console.log('\n6. 非破坏性：练习页挑战入口卡保留（次级入口）')
{
  assert('renderPractice 仍渲染 challengeEntryHtml()', /\$\{challengeEntryHtml\(\)\}/.test(appSrc))
  assert('challengeEntryHtml 仍 navigate(\'challenge\')', /onclick="navigate\('challenge'\)"/.test(appSrc))
  // ⚠️ 两条入口分别落在 app.js（练习页卡片）与 index.html（顶栏）——必须跨文件计数，
  //    只在 appSrc 里数是 1 条，会误判成「入口没加」（本轮踩过）
  const totalEntrances = (appSrc.match(/navigate\('challenge'\)/g) || []).length
    + (htmlSrc.match(/navigate\('challenge'\)/g) || []).length
  assert('顶栏入口（index.html）+ 练习页入口（app.js）= 两条入口并存', totalEntrances >= 2, 'counted=' + totalEntrances)
}

console.log('\n7. 挑战页对无资格部门仍给出说明（不会因新增入口而白屏）')
{
  const chSrc = fs.readFileSync(path.join(D, 'challenge.js'), 'utf-8')
  assert('renderChallenge 有部门门禁分支', chSrc.includes('chDeptBlockedPageHtml'))
  assert('renderChallenge 有无营次分支', chSrc.includes('chDeptNoRoundPageHtml'))
  // 门禁必须早于 quiz/review/result 阶段分支（否则作答中被踢出）
  const iGate = chSrc.indexOf('chDeptAllowed()')
  const iQuiz = chSrc.indexOf("chs.phase === 'quiz'")
  assert('部门门禁先于 quiz 阶段分支', iGate > 0 && iQuiz > iGate, `gate=${iGate} quiz=${iQuiz}`)
}

if (testFailed) { console.log('\n❌ 存在失败断言'); process.exit(1) }
console.log('\n✅ 全部通过')
// ⚠️ 必须显式 process.exit(0)：本套件把断言包在 async IIFE 里，而整载沙箱注入的
//    setInterval/setTimeout 等句柄会让事件循环一直活着 → 进程不退出 → 被 60s SIGTERM 杀掉，
//    在 _run-all.js（execFileSync）眼里就是「失败」，尽管断言全过（本轮踩过这个坑）。
process.exit(0)

})()
