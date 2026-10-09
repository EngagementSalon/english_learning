// v156：① 练习页抽题口径收窄到「分部门」 ② 部门设为必选项（注册 + 资料修改）
// 背景：v154 只修了挑战页抽题池；练习页 startPractice() 仍走 Store.getSessionDeptKey()（大部门 key）
//       → 标帜餐厅学员能抽到艳中/送餐的题，管理员更是全库混题。
// 用户拍板（2026-10-09）：练习页也跟分部门走；并把部门设为必选项。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let PASS = 0, FAIL = 0
const fails = []
function ok(cond, name, extra) {
  if (cond) { PASS++; return true }
  FAIL++; fails.push(name + (extra ? ' | ' + extra : ''))
  return false
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`) }

const DIR = __dirname
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8')

// ---------- 源码提取助手 ----------
function braceEnd(src, open) {
  let d = 0, inS = null, inC = false
  for (let k = open; k < src.length; k++) {
    const ch = src[k], nx = src[k + 1]
    if (inC) { if (ch === '\n') inC = false; continue }
    if (inS) { if (ch === '\\') { k++; continue } if (ch === inS) inS = null; continue }
    if (ch === '/' && nx === '/') { inC = true; continue }
    if (ch === '/' && nx === '*') { const e = src.indexOf('*/', k + 2); k = e < 0 ? src.length : e + 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inS = ch; continue }
    if (ch === '{') d++
    else if (ch === '}') { d--; if (d === 0) return k }
  }
  return src.length - 1
}
function braceSlice(src, from) { const open = src.indexOf('{', from); return src.slice(from, braceEnd(src, open) + 1) }
function grab(src, name) { const i = src.indexOf('function ' + name + '('); return i < 0 ? null : braceSlice(src, i) }
// 剥注释行（否定断言必须先剥注释，否则注释里的被禁字面量会造成假失败）
const codeOnly = s => String(s).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const appSrc = read('app.js')
const appCode = codeOnly(appSrc)

// ============================================================
console.log('=== 组〇 源码契约护栏 ===')
// ============================================================

ok(!!grab(appSrc, 'practiceDeptKey'), 'app.js 已定义 practiceDeptKey()')
// practiceDeptKey 必须存在且被 startPractice 调用
ok(/const deptKey = practiceDeptKey\(\)/.test(appCode), 'startPractice 改走 practiceDeptKey()')
// 旧的「大部门 key」写法必须已从 startPractice 消失
ok(!/Store\.isAdmin\(\) \? \(practiceDept \|\| ''\) : Store\.getSessionDeptKey\(\)/.test(appCode),
  'startPractice 已无旧口径（isAdmin ? practiceDept : getSessionDeptKey）')
// 学员分支必须走 sessionDeptSlug（分部门 slug）
const pdKeySrc = grab(appSrc, 'practiceDeptKey')
ok(!!pdKeySrc, '能抠出 practiceDeptKey 函数体')
ok(/sessionDeptSlug\(\)/.test(pdKeySrc), 'practiceDeptKey 学员分支调用 sessionDeptSlug()')
ok(!/getSessionDeptKey\(\)/.test(pdKeySrc), 'practiceDeptKey 不再调用 getSessionDeptKey()')
ok(/PRACTICE_DEPT_SLUGS\.indexOf\(practiceDept\)/.test(pdKeySrc), 'practiceDeptKey 管理员分支校验 PRACTICE_DEPT_SLUGS')

// 注册仍必选部门
ok(/if \(!dept\) return showAuthError\('register', t\('errDeptRequired'\)\)/.test(appCode),
  'doRegister 保持部门必选校验')
// 资料修改新增必选部门
const saveProfileSrc = grab(appSrc, 'saveProfile')
ok(!!saveProfileSrc, '能抠出 saveProfile 函数体')
const spCode = codeOnly(saveProfileSrc)
ok(/const dept = readDeptCascade\(DEPT_GROUPS\.profile\)/.test(spCode), 'saveProfile 先读取部门')
ok(/if \(!dept\) return alert\(t\('errDeptRequired'\)\)/.test(spCode), 'saveProfile 部门为空则拦截')
ok(/Store\.setUser\(\{ name, dept \}\)/.test(spCode), 'saveProfile 用校验后的 dept 写入')
ok(!/Store\.setUser\(\{ name, dept: readDeptCascade/.test(spCode), 'saveProfile 不再内联 readDeptCascade 写入')

// i18n 键存在（注意：i18n.js 里 zh 块内含 `listen: '听音选义'` 等，`indexOf('en:')` 会误命中 → 用行锚点）
const i18nSrc = read('i18n.js')
const enLine = (() => { const m = /^  en: \{$/m.exec(i18nSrc); return m ? m.index : -1 })()
ok(enLine > 0, 'i18n.js 能定位 en 块（行锚点 ^  en: {$）')
const zhBlock = enLine > 0 ? i18nSrc.slice(0, enLine) : ''
const enBlock = enLine > 0 ? i18nSrc.slice(enLine) : ''
ok(/errDeptRequired:/.test(zhBlock), 'i18n zh 有 errDeptRequired')
ok(/errDeptRequired:/.test(enBlock), 'i18n en 有 errDeptRequired')

// ============================================================
console.log('=== 组一 practiceDeptKey 行为（沙箱真跑）===')
// ============================================================
function makeSandbox(opts) {
  const sb = {
    console,
    PRACTICE_DEPT_SLUGS: ['', 'dining', 'rooms', 'all',
      'dining/sig', 'dining/yan', 'dining/bar', 'dining/ird',
      'rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa'],
    practiceDept: opts.practiceDept === undefined ? '' : opts.practiceDept,
    Store: { isAdmin: () => !!opts.isAdmin },
    sessionDeptSlug: () => opts.slug === undefined ? '' : opts.slug,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(pdKeySrc, sb)
  return sb
}

// 学员：走分部门 slug
eq(makeSandbox({ isAdmin: false, slug: 'dining/sig' }).practiceDeptKey(), 'dining/sig',
  '学员（标帜）→ dining/sig')
eq(makeSandbox({ isAdmin: false, slug: 'dining/ird' }).practiceDeptKey(), 'dining/ird',
  '学员（送餐）→ dining/ird')
eq(makeSandbox({ isAdmin: false, slug: 'rooms/spa' }).practiceDeptKey(), 'rooms/spa',
  '学员（水疗）→ rooms/spa')
eq(makeSandbox({ isAdmin: false, slug: '' }).practiceDeptKey(), '',
  '学员无分部门（其他部门/旧数据）→ 空串（不限部门，回落全库）')

// 管理员：走切片
eq(makeSandbox({ isAdmin: true, practiceDept: '' }).practiceDeptKey(), '',
  '管理员切片「全部部门」→ 空串')
eq(makeSandbox({ isAdmin: true, practiceDept: 'dining/sig' }).practiceDeptKey(), 'dining/sig',
  '管理员切片「标帜」→ dining/sig')
eq(makeSandbox({ isAdmin: true, practiceDept: 'dining' }).practiceDeptKey(), 'dining',
  '管理员切片「饮食部」→ dining')
eq(makeSandbox({ isAdmin: true, practiceDept: 'all' }).practiceDeptKey(), 'all',
  '管理员切片「通用」→ all')

// ★ 管理员切片必须压过学员身份（管理员通常也有 session 部门）
const admWithSession = makeSandbox({ isAdmin: true, practiceDept: 'dining/yan', slug: 'dining/sig' })
eq(admWithSession.practiceDeptKey(), 'dining/yan',
  '★ 管理员切片优先于 session 部门（切片=艳中，session=标帜 → 取艳中）')

// 非法切片回落 ''
eq(makeSandbox({ isAdmin: true, practiceDept: 'dining/bogus' }).practiceDeptKey(), '',
  '管理员切片非法值 → 回落空串')
eq(makeSandbox({ isAdmin: true, practiceDept: undefined }).practiceDeptKey(), '',
  '管理员 practiceDept undefined → 空串')

// 异常容错
const errSb = {
  console,
  PRACTICE_DEPT_SLUGS: [''],
  practiceDept: '',
  Store: { isAdmin: () => { throw new Error('boom') } },
  sessionDeptSlug: () => { throw new Error('boom2') },
}
errSb.globalThis = errSb
vm.createContext(errSb)
vm.runInContext(pdKeySrc, errSb)
eq(errSb.practiceDeptKey(), '', '两层都抛错 → 仍安全返回空串（不崩）')

// sessionDeptSlug 不存在时
const noSlugFn = { console, PRACTICE_DEPT_SLUGS: [''], practiceDept: '', Store: { isAdmin: () => false } }
noSlugFn.globalThis = noSlugFn
vm.createContext(noSlugFn)
vm.runInContext(pdKeySrc, noSlugFn)
eq(noSlugFn.practiceDeptKey(), '', 'sessionDeptSlug 未定义 → 安全返回空串')

// ============================================================
console.log('=== 组二 与真实 store 部门筛选口径联动 ===')
// ============================================================
const storeSrc = read('store.js')
const qByDeptSrc = (() => {
  const i = storeSrc.indexOf('getQuestionsByDept(deptKey) {')
  if (i < 0) return null
  const open = storeSrc.indexOf('{', i + 'getQuestionsByDept(deptKey)'.length)
  return 'function getQuestionsByDept(deptKey) ' + storeSrc.slice(open, braceEnd(storeSrc, open) + 1)
})()
ok(!!qByDeptSrc, '能抠出 store.getQuestionsByDept')

const DEPT_SUB_SLUGS = {
  dining: { '标帜餐厅': 'sig', '艳中餐厅': 'yan', '酒吧团队': 'bar', '客房送餐': 'ird' },
  rooms: { '迎宾前台': 'fo', '礼宾部': 'concierge', '随时随需': 'ww', '客房造型': 'styling', '健身及水疗中心': 'spa' },
}
// 造一个 mini 题库：各分队各 1 题 + 大部门整包 1 题 + 通用 1 题 + 别的部门 1 题
const BANK_Q = [
  { id: 'q_sig', dept: 'dining/sig' },
  { id: 'q_yan', dept: 'dining/yan' },
  { id: 'q_ird', dept: 'dining/ird' },
  { id: 'q_bar', dept: 'dining/bar' },
  { id: 'q_dining', dept: 'dining' },   // 大部门整包（历史题）
  { id: 'q_all', dept: 'all' },         // 通用
  { id: 'q_none', dept: '' },           // 无 dept = 通用
  { id: 'q_spa', dept: 'rooms/spa' },
  { id: 'q_rooms', dept: 'rooms' },
]
const qSb = {
  console,
  DEPT_SUB_SLUGS,
  BANK_Q,
}
// getQuestionsByDept 内部用 this.getQuestions() → 造一个带该方法的 STORE 对象
qSb.globalThis = qSb
vm.createContext(qSb)
vm.runInContext(
  'var STORE = { getQuestions: function () { return BANK_Q.map(function (q) { return Object.assign({}, q) }) },' +
  qByDeptSrc.replace(/^function /, '') + '}',
  qSb
)
const gqbd = (k) => vm.runInContext('STORE.getQuestionsByDept(' + JSON.stringify(k) + ')', qSb).map(q => q.id)

console.log('  -- 学员分部门视角（v156 生效口径）--')
eq(gqbd('dining/sig'), ['q_sig', 'q_dining', 'q_all', 'q_none'],
  '★ 标帜餐厅学员：只看到 标帜 + 饮食部整包 + 通用（不含艳中/送餐/酒吧）')
eq(gqbd('dining/yan'), ['q_yan', 'q_dining', 'q_all', 'q_none'],
  '★ 艳中餐厅学员：不含标帜/送餐')
eq(gqbd('dining/ird'), ['q_ird', 'q_dining', 'q_all', 'q_none'],
  '★ 客房送餐学员：不含标帜/艳中')
// 顺序用集合比较（题目过滤保持原库顺序，这里只关心「包含哪些」）
const sorted = a => JSON.stringify([...a].sort())
ok(sorted(gqbd('rooms/spa')) === sorted(['q_spa', 'q_rooms', 'q_all', 'q_none']),
  '水疗学员：不含饮食部任何题 got=' + JSON.stringify(gqbd('rooms/spa')))

console.log('  -- 对比：旧口径（大部门 key）--')
const oldSig = gqbd('dining')
ok(oldSig.indexOf('q_yan') >= 0, '★ 旧口径 dining 含艳中题（这正是「混题」——本版修的就是它）')
ok(oldSig.indexOf('q_ird') >= 0, '★ 旧口径 dining 含送餐题')
ok(gqbd('dining/sig').indexOf('q_yan') < 0, '★ 新口径标帜不含艳中（收窄生效）')

console.log('  -- 其他 --')
eq(gqbd(''), BANK_Q.map(q => q.id), '空串 = 全部题目（管理员默认）')
eq(gqbd('other'), BANK_Q.map(q => q.id), 'other = 全部题目（兜底）')

// ============================================================
console.log('=== 组三 练习页抽题端到端（用真实代码路径）===')
// ============================================================
// 用 practiceDeptKey + getQuestionsByDept 串起来，模拟 startPractice 的题目集
function practiceList(opts) {
  const sb = makeSandbox(opts)
  const key = sb.practiceDeptKey()
  return { key, ids: gqbd(key) }
}
const r1 = practiceList({ isAdmin: false, slug: 'dining/sig' })
eq(r1.key, 'dining/sig', '端到端：标帜学员 deptKey')
ok(r1.ids.indexOf('q_yan') < 0 && r1.ids.indexOf('q_ird') < 0 && r1.ids.indexOf('q_bar') < 0,
  '★ 端到端：标帜学员练习题集里没有兄弟分队题')
ok(r1.ids.indexOf('q_sig') >= 0, '端到端：标帜学员能看到本分队题')

const r2 = practiceList({ isAdmin: true, practiceDept: '' })
eq(r2.key, '', '端到端：管理员「全部部门」= 全库')
eq(r2.ids.length, BANK_Q.length, '端到端：管理员全库看得到所有题')

const r3 = practiceList({ isAdmin: true, practiceDept: 'dining/ird' })
eq(r3.key, 'dining/ird', '端到端：管理员切片送餐')
ok(r3.ids.indexOf('q_yan') < 0, '端到端：管理员切片送餐看不到艳中题')

const r4 = practiceList({ isAdmin: false, slug: '' })
eq(r4.key, '', '端到端：无分部门学员 → 全库（不误伤其他部门）')
eq(r4.ids.length, BANK_Q.length, '端到端：无分部门学员能看到全部')

// ============================================================
console.log('=== 组四 部门必选（saveProfile 行为）===')
// ============================================================
function runSaveProfile(opts) {
  const alerts = []
  let setUserArg = null
  const sb = {
    console,
    DEPT_GROUPS: { profile: ['profileDeptMajor', 'profileDeptSub', 'profileDeptOther'] },
    t: k => '[' + k + ']',
    alert: m => { alerts.push(m); return undefined },
    document: {
      getElementById: id => {
        if (id === 'profileName') return { value: '张三' }
        if (id === 'profileUsername') return { value: 'zhangsan', readOnly: true }
        return null
      }
    },
    readDeptCascade: () => opts.dept,
    Store: {
      getSession: () => opts.session === undefined ? { id: 'u1', username: 'zhangsan', name: '张三' } : opts.session,
      setUser: a => { setUserArg = a },
      updateUser: () => {},
      renameUser: () => ({ ok: true, old: 'a', nu: 'b' }),
    },
    closeProfileSetup: () => { sb.__closed = true },
    updateUserInfoDisplay: () => {},
    applyCourseRename: () => {},
    t2: null,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(saveProfileSrc, sb)
  sb.saveProfile()
  return { alerts, setUserArg, closed: !!sb.__closed }
}

const a1 = runSaveProfile({ dept: '' })
ok(a1.alerts.length === 1, '★ 部门为空 → 弹出一次提示')
eq(a1.alerts[0], '[errDeptRequired]', '★ 提示文案 = errDeptRequired')
ok(a1.setUserArg === null, '★ 部门为空 → 不写入（saveProfile 提前 return）')
ok(!a1.closed, '★ 部门为空 → 弹窗不关闭（让用户补齐）')

const a2 = runSaveProfile({ dept: '饮食部·标帜餐厅' })
ok(a2.alerts.length === 0, '部门已填 → 无提示')
eq(a2.setUserArg, { name: '张三', dept: '饮食部·标帜餐厅' }, '部门已填 → 正确写入 name+dept')
ok(a2.closed, '部门已填 → 关闭弹窗')

// ============================================================
console.log('=== 组五 无回退：其他调用点未被误改 ===')
// ============================================================
// 首页统计 / 水平测试组题 / 考试页数 / 考试抽题 / 进度统计仍走大部门 key（本次拍板范围外，须保持原样）
const occurrences = (appCode.match(/Store\.isAdmin\(\) \? '' : Store\.getSessionDeptKey\(\)/g) || []).length
eq(occurrences, 5, '★ 其余 5 处仍是 getSessionDeptKey（水平测试/首页/考试页/考试抽题/进度统计 —— 本次不动）')
ok(appCode.indexOf("const deptKey = Store.isAdmin() ? '' : Store.getSessionDeptKey()") >= 0,
  '上述写法确实还在（未被我误删）')
// startPractice 里不再有 getSessionDeptKey
const spStart = appCode.indexOf('function startPractice()')
const spBody = appCode.slice(spStart, appCode.indexOf('function renderPracticeQuestion()', spStart))
ok(spBody.indexOf('getSessionDeptKey') < 0, '★ startPractice 内已无 getSessionDeptKey')
ok(spBody.indexOf('practiceDeptKey()') >= 0, '★ startPractice 内已用 practiceDeptKey()')

// ============================================================
console.log('=== 组六 版本号 ===')
// ============================================================
const HTML = read('index.html')
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => +s.slice(3))
ok(vms.length > 0, 'index.html 有 ?v= 资源串')
eq(vms.length, 12, 'index.html ?v= 共 12 处')
const uniq = [...new Set(vms)]
eq(uniq.length, 1, '?v= 取值唯一 got=' + JSON.stringify(uniq))
ok(uniq[0] >= 156, '?v= 唯一值 ≥ 156 got=' + uniq[0])

// ============================================================
console.log('')
console.log(`${PASS} 通过, ${FAIL} 失败` + (FAIL ? ' ❌' : ' ✅'))
if (FAIL) { fails.forEach(f => console.log('  ✗ ' + f)) }
process.exit(FAIL ? 1 : 0)
