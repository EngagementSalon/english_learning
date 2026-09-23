// ====== 测试：v114 七天挑战「部门没同步过来」自愈 ======
// 现场（用户 2026-09-23 报）：学员「陆影靓」进不去七天挑战 —— 云端部门是对的（饮食部·标帜餐厅）、
//   营次也开着，但本机被判「不可参加」，页面只给一句「还未设置所属部门」。
// 根因：本机账号记录（eq_users）的部门为空时，pullCloudChanges 第 3 步比较的是
//   「本机记录 dept」 vs 「会话 dept」——两者都空 → 该分支永不触发 → 云端那个正确的部门
//   永远回填不到会话里 → chDeptAllowed() 恒 false。管理员在看板上看到的部门却是对的，现场极易误判。
// v114 修法（三级补全）：
//   ① 云端 → 本机账号记录（pullCloudChanges 新增第 2.5 步，只补空不覆盖）
//   ② 本机账号记录 / 个人资料缓存 → 会话（新增 Store.repairSessionDept()）
//   ③ 学员侧自助入口：说明页新增「🔄 重新同步部门」按钮 + 本机/资料部门对照自检行
// 覆盖：
//   1. 静态结构（两个新函数、按钮接线、自检行接线）
//   2. i18n 4 键中英成对
//   3. repairSessionDept 四种输入（实跑 store 沙箱）
//   4. pullCloudChanges 第 2.5 步（实跑，含「只补空不覆盖」反向断言）
//   5. 端到端：会话部门丢失 → 说明页 → 自愈 → 完整挑战页（challenge 全载沙箱真跑）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}
const D = __dirname
const storeSrc = fs.readFileSync(path.join(D, 'store.js'), 'utf-8')
const chSrc = fs.readFileSync(path.join(D, 'challenge.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(D, 'i18n.js'), 'utf-8')
const appSrc = fs.readFileSync(path.join(D, 'app.js'), 'utf-8')
const bankSrc = fs.readFileSync(path.join(D, 'bank-data.js'), 'utf-8')
const csSrc = fs.readFileSync(path.join(D, 'cloud-store.js'), 'utf-8')

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, remove() {},
  }
}
function mkLocalStorage(seed) {
  return {
    store: Object.assign({}, seed || {}),
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  }
}
function grabFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{'))
  if (!m) return null
  let i = m.index + m[0].length, depth = 1
  while (i < src.length && depth > 0) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; i++ }
  return src.slice(m.index, i)
}

// ---------- 极简部门归一 stub（只认测试用到的两个值；真实 normDept 在组五用全载沙箱跑） ----------
const NORM_STUB = `
function normDept(v) {
  var s = String(v == null ? '' : v).trim()
  if (s === '饮食部·标帜餐厅') return { majorKey:'dining', majorName:'饮食部', subName:'标帜餐厅', key:'dining/sig', value:s }
  if (s === '房务部·迎宾前台') return { majorKey:'rooms', majorName:'房务部', subName:'迎宾前台', key:'rooms/fo', value:s }
  return null
}
`

// ---------- store-only 沙箱（组三 / 组四） ----------
function mkStoreSb(seed) {
  const sb = {
    localStorage: mkLocalStorage(seed),
    console,
    window: { addEventListener() {}, dispatchEvent() {} },
    document: { getElementById: () => mkEl(), querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl(), body: { appendChild() {} }, title: '' },
    setTimeout, clearTimeout, setInterval, clearInterval, clearTimeout,
    Date, JSON, Math, String, Number, Array, Object, Boolean,
    Event: function () {},
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(i18nSrc, sb)
  vm.runInContext(NORM_STUB, sb)
  vm.runInContext(bankSrc, sb)
  vm.runInContext(storeSrc, sb)
  return sb
}

console.log('\n===== 1. 静态结构 =====')
{
  assert('store.js 有 repairSessionDept()', /  repairSessionDept\(\)\s*\{/.test(storeSrc))
  assert('store 注释说明「只补空不覆盖」', /只补空，不覆盖/.test(storeSrc))
  assert('pullCloudChanges 返回体含 deptFilled', /deptFilled: false/.test(storeSrc))
  assert('pullCloudChanges 有第 2.5 步（云端补全本机记录）', /2\.5\) v114：本机账号记录的部门为空/.test(storeSrc))
  assert('challenge.js 有 chResyncDept()', /async function chResyncDept\(\)\s*\{/.test(chSrc))
  assert('chResyncDept 调 Store.pullCloudChanges', /chResyncDept[\s\S]{0,400}?Store\.pullCloudChanges/.test(chSrc))
  assert('chResyncDept 调 Store.repairSessionDept', /chResyncDept[\s\S]{0,400}?Store\.repairSessionDept/.test(chSrc))
  assert('chResyncDept 结尾重渲染', /chResyncDept[\s\S]{0,600}?renderChallenge\(\)/.test(chSrc))
  assert('说明页接上重新同步按钮', /onclick="chResyncDept\(\)"/.test(chSrc))
  assert('说明页仍保留「去设置部门」（v107 契约不破）', /openProfileSetup\(\)/.test(chSrc))
  assert('说明页含本机部门自检行', /chDeptDiagLocal/.test(chSrc) && /chDeptDiagProfile/.test(chSrc))
  // ⚠️ 自检行里 getSessionDept 出现在 chDeptDiagLocal **之前**（先取值再拼模板）→ 向前正则匹配必然为假。
  //    改为取函数体本身判定（本项目踩过「方向搞反 / 只截开标签」的假失败）
  const blockedFn = grabFn(chSrc, 'chDeptBlockedPageHtml') || ''
  assert('说明页函数体已提取', blockedFn.length > 400, 'len=' + blockedFn.length)
  assert('自检行读「会话部门」', blockedFn.indexOf('getSessionDept') >= 0)
  assert('自检行读「资料缓存部门」', blockedFn.indexOf('Store.getUser') >= 0)
}

console.log('\n===== 2. i18n 4 键中英成对 =====')
{
  const zhPart = i18nSrc.slice(0, i18nSrc.indexOf('\n  en:'))
  const enPart = i18nSrc.slice(i18nSrc.indexOf('\n  en:'))
  ;['chDeptResync', 'chDeptDiagLocal', 'chDeptDiagProfile', 'chDeptDiagNone'].forEach(k => {
    assert(k + ' zh/en 成对存在',
      new RegExp('\\b' + k + '\\s*:').test(zhPart) && new RegExp('\\b' + k + '\\s*:').test(enPart))
  })
  assert('chDeptResync zh 取值正确', /chDeptResync: '重新同步部门'/.test(zhPart))
  assert('chDeptResync en 取值正确', /chDeptResync: 'Re-sync department'/.test(enPart))
  assert('chDeptDiagNone zh 取值正确', /chDeptDiagNone: '未设置'/.test(zhPart))
}

console.log('\n===== 3. repairSessionDept 四种输入（store 沙箱实跑）=====')
{
  const mk = (session, users, profile) => {
    const seed = {}
    if (session) seed.eq_session = JSON.stringify(session)
    if (users) seed.eq_users = JSON.stringify(users)
    if (profile) seed.eq_user = JSON.stringify(profile)
    return mkStoreSb(seed)
  }
  // ① 会话空 + 资料缓存有 → 回填（并落盘）
  {
    const sb = mk({ id: 1, username: 'lu', name: 'lu', dept: '', role: 'student' }, [{ id: 1, username: 'lu', dept: '' }], { name: 'lu', dept: '饮食部·标帜餐厅' })
    const r = vm.runInContext('Store.repairSessionDept()', sb)
    assert('①会话空 + 资料有 → 返回部门', r === '饮食部·标帜餐厅', 'got ' + JSON.stringify(r))
    assert('①已落盘到 eq_session', JSON.parse(sb.localStorage.getItem('eq_session')).dept === '饮食部·标帜餐厅')
  }
  // ② 会话空 + 资料空 + 账号记录有 → 回填
  {
    const sb = mk({ id: 1, username: 'lu', name: 'lu', dept: '', role: 'student' }, [{ id: 1, username: 'lu', dept: '饮食部·标帜餐厅' }], { name: 'lu', dept: '' })
    const r = vm.runInContext('Store.repairSessionDept()', sb)
    assert('②会话空 + 账号记录有 → 返回部门', r === '饮食部·标帜餐厅', 'got ' + JSON.stringify(r))
  }
  // ③ 会话已有有效部门 → 原样返回，不改写
  {
    const sb = mk({ id: 1, username: 'lu', name: 'lu', dept: '房务部·迎宾前台', role: 'student' }, [{ id: 1, username: 'lu', dept: '' }], { name: 'lu', dept: '饮食部·标帜餐厅' })
    const r = vm.runInContext('Store.repairSessionDept()', sb)
    assert('③会话有效 → 原样返回（不被资料覆盖）', r === '房务部·迎宾前台', 'got ' + JSON.stringify(r))
    assert('③会话未被改写', JSON.parse(sb.localStorage.getItem('eq_session')).dept === '房务部·迎宾前台')
  }
  // ④ 三处都空 → 返回 ''（不伪造部门）
  {
    const sb = mk({ id: 1, username: 'lu', name: 'lu', dept: '', role: 'student' }, [{ id: 1, username: 'lu', dept: '' }], { name: 'lu', dept: '' })
    assert("④三处皆空 → 返回 ''", vm.runInContext('Store.repairSessionDept()', sb) === '')
    assert("④未写入伪造部门", JSON.parse(sb.localStorage.getItem('eq_session')).dept === '')
  }
}

// ---------- 组四：async 主流程 ----------
async function runGroup4() {
  console.log('\n===== 4. pullCloudChanges 第 2.5 步（实跑，async）=====')
  const mkSb = (sessionDept, recordDept, cloudDept) => {
    const sb = mkStoreSb({
      eq_session: JSON.stringify({ id: 1, username: 'lu', name: 'lu', dept: sessionDept, role: 'student' }),
      eq_users: JSON.stringify([{ id: 1, username: 'lu', name: 'lu', dept: recordDept, role: 'student' }]),
    })
    const map = {}
    if (cloudDept !== null) map.lu = { username: 'lu', name: 'lu', dept: cloudDept, role: 'student', ph: 'p', salt: 's' }
    vm.runInContext(`
      var CloudSync = {
        status: 'online',
        fetchSyncSummary: function () { return Promise.resolve({ ok: true, doc: { events: [] }, map: ${JSON.stringify(map)} }) },
        setDeptSlug: function () {}, enqueue: function () {}, pushPending: function () {}, onStatus: function () {}
      }
    `, sb)
    return sb
  }
  // ① 本机记录空 + 云端有 → 记录被补全，会话被同步
  {
    const sb = mkSb('', '', '饮食部·标帜餐厅')
    const r = await vm.runInContext('Store.pullCloudChanges()', sb)
    assert('①applied.deptFilled = true', r.applied.deptFilled === true, JSON.stringify(r.applied))
    assert('①本机账号记录被补全', vm.runInContext('Store.getUsers()[0].dept', sb) === '饮食部·标帜餐厅', vm.runInContext('Store.getUsers()[0].dept', sb))
    assert('①会话部门随之同步（sessionDeptSync）', r.applied.sessionDeptSync === true, JSON.stringify(r.applied))
    assert('①会话已落盘为正确部门', JSON.parse(sb.localStorage.getItem('eq_session')).dept === '饮食部·标帜餐厅')
    assert('①修复后 chDeptKey 可用（归一 stub）', !!vm.runInContext('normDept(Store.getSessionDept())', sb))
  }
  // ② 本机记录已有有效部门（与云端不同）→ 不被云端覆盖（关键反向断言）
  {
    const sb = mkSb('房务部·迎宾前台', '房务部·迎宾前台', '饮食部·标帜餐厅')
    const r = await vm.runInContext('Store.pullCloudChanges()', sb)
    assert('②deptFilled = false（不动非空记录）', r.applied.deptFilled === false, JSON.stringify(r.applied))
    assert('②本机记录仍是原部门', vm.runInContext('Store.getUsers()[0].dept', sb) === '房务部·迎宾前台', vm.runInContext('Store.getUsers()[0].dept', sb))
    assert('②会话未被云端改写', JSON.parse(sb.localStorage.getItem('eq_session')).dept === '房务部·迎宾前台')
  }
  // ③ 本机记录空 + 云端也空 → 不伪造成员
  {
    const sb = mkSb('', '', '')
    const r = await vm.runInContext('Store.pullCloudChanges()', sb)
    assert('③deptFilled = false（云端也没有部门）', r.applied.deptFilled === false, JSON.stringify(r.applied))
    assert('③本机记录仍为空', (vm.runInContext('Store.getUsers()[0].dept', sb) || '') === '')
  }
  // ④ 会话空 + 记录空 + 云端有 → 一条链路走完（这正是「陆影靓」现场）
  {
    const sb = mkSb('', '', '饮食部·标帜餐厅')
    await vm.runInContext('Store.pullCloudChanges()', sb)
    const s = JSON.parse(sb.localStorage.getItem('eq_session'))
    assert('④现场复现被修复：会话 dept 已是正确部门', s.dept === '饮食部·标帜餐厅', JSON.stringify(s.dept))
  }
}

// ---------- 组五：端到端（challenge 全载沙箱真跑） ----------
function mkFullSb(seed) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const sb = {
    localStorage: mkLocalStorage(seed),
    console,
    window: { addEventListener() {}, scrollTo() {}, speechSynthesis: { cancel() {}, speak() {} }, SpeechSynthesisUtterance: function () {} },
    document: { getElementById: getEl, querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl(), body: { appendChild() {} }, title: '', addEventListener() {} },
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean,
    CloudSync: {
      status: 'online',
      _chRounds: [{ id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, examOpen: true, at: 0, startAt: 0, endAt: 0 }],
      _chRoundCurId: 'r1', _chRoundCurName: '标帜餐厅七天挑战第一期', _chOpen: true, _chExamOpen: true,
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      setDeptSlug() {}, enqueue() {}, pushPending: async () => {}, onStatus() {}, onStatusChange() {},
    },
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(i18nSrc, sb)
  vm.runInContext(bankSrc, sb)
  vm.runInContext(storeSrc, sb)
  vm.runInContext(chSrc, sb)
  vm.runInContext(fs.readFileSync(path.join(D, 'course-app.js'), 'utf-8'), sb)
  vm.runInContext(appSrc, sb)
  ;['roundDeptMatch', 'roundOpenState'].forEach(n => {
    const f = grabFn(csSrc, n)
    if (f) vm.runInContext(f, sb)
  })
  return { sb, getEl }
}

async function runGroup5() {
  console.log('\n===== 5. 端到端：会话部门丢失 → 说明页 → 自愈 → 完整挑战页 =====')
  const { sb, getEl } = mkFullSb({
    // 现场状态：会话部门为空、本机账号记录为空、但个人资料缓存里存着正确部门
    eq_session: JSON.stringify({ id: 1, username: 'lu', name: 'lu', dept: '', role: 'student' }),
    eq_users: JSON.stringify([{ id: 1, username: 'lu', name: 'lu', dept: '', role: 'student' }]),
    eq_user: JSON.stringify({ name: 'lu', dept: '饮食部·标帜餐厅' }),
    eq_course_only_v43: '1',
  })
  const run = code => vm.runInContext(code, sb)
  const store = vm.runInContext('Store', sb)

  assert('前置：chDeptKey() 为空（会话部门丢失）', run('chDeptKey()') === '', JSON.stringify(run('chDeptKey()')))
  assert('前置：chDeptAllowed() = false', run('chDeptAllowed()') === false)

  elements_reset(getEl)
  let err = null
  try { run('renderChallenge()') } catch (e) { err = e }
  assert('未修复时 renderChallenge 不抛错', !err, err && err.message)
  const blocked = getEl('page-challenge').innerHTML
  assert('未修复时渲染「未设置部门」说明页', blocked.indexOf('还未设置所属部门') >= 0, blocked.slice(0, 120))
  assert('说明页含「重新同步部门」按钮', blocked.indexOf('chResyncDept()') >= 0)
  assert('说明页含本机/资料部门自检行', blocked.indexOf('本机记录的部门') >= 0 && blocked.indexOf('资料中保存的部门') >= 0)
  assert('自检行显示资料里其实有部门', blocked.indexOf('饮食部·标帜餐厅') >= 0)

  // —— 自愈（学员点「重新同步部门」走的同一条路：repairSessionDept）——
  const fixed = run('Store.repairSessionDept()')
  assert('repairSessionDept 回填出正确部门', fixed === '饮食部·标帜餐厅', JSON.stringify(fixed))
  assert('chDeptKey() 变为 dining/sig', run('chDeptKey()') === 'dining/sig', JSON.stringify(run('chDeptKey()')))
  assert('chDeptAllowed() 变为 true', run('chDeptAllowed()') === true)

  elements_reset(getEl)
  err = null
  try { run('renderChallenge()') } catch (e) { err = e }
  assert('修复后 renderChallenge 不抛错', !err, err && err.message)
  const ok = getEl('page-challenge').innerHTML
  assert('修复后渲染完整挑战页（含当前营次）', ok.indexOf('当前营次') >= 0, ok.slice(0, 140))
  assert('修复后不再是说明页', ok.indexOf('还未设置所属部门') < 0)
  assert('修复后页面显著变长（真内容而非占位）', ok.length > 3000, 'len=' + ok.length)

  // 说明页文案在英文下也要出（避免 zh 硬编码）
  const { sb: sbEn, getEl: getElEn } = mkFullSb({
    eq_session: JSON.stringify({ id: 1, username: 'lu', name: 'lu', dept: '', role: 'student' }),
    eq_users: JSON.stringify([{ id: 1, username: 'lu', dept: '' }]),
    eq_user: JSON.stringify({ name: 'lu', dept: '' }),
  })
  try {
    vm.runInContext("setLang('en')", sbEn)
    vm.runInContext('renderChallenge()', sbEn)
    const h = getElEn('page-challenge').innerHTML
    assert('英文界面：自检行英文文案出现', h.indexOf('Department on this device') >= 0, h.slice(0, 200))
    assert('英文界面：重新同步按钮英文文案出现', h.indexOf('Re-sync department') >= 0)
  } catch (e) {
    assert('英文界面渲染不抛错', false, e.message)
  }
}
function elements_reset(getEl) {
  // 清空挑战页容器，模拟「重新进入页面」
  const el = getEl('page-challenge')
  el.innerHTML = ''
}

;(async () => {
  await runGroup4()
  await runGroup5()
  if (testFailed) { console.log('\n❌ 存在失败断言'); process.exit(1) }
  console.log('\n✅ 全部通过')
  process.exit(0)
})()
