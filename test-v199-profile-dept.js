// v199：学员「个人资料」改部门走统一收口 —— 修复「资料里换成日照-房务后挑战营期没变」。
//
// 真因（2026-10-30 用户实测 + 代码核对）：
//   saveProfile() 只写 eq_user 个人资料缓存（Store.setUser），三处缺口：
//   ① session.dept 不变 → sessionDeptSlug() 仍是旧部门 → chRoundRecForDept() 按旧部门
//      解析出日照-餐饮 r8 → 营期横幅不变；
//   ② 账号表 dept 不变 → 重新登录（_doLogin 用账号表 dept 重建会话）后改动整体丢失；
//   ③ 不发云端 dept 事件 → 其他设备（含管理端看板）永远不知道。
//   修法：saveProfile 对已登录用户追加 Store.setUserDept(s.id, dept)（_applyDeptChange
//   统一收口：账号表 + 会话 + 云端事件，幂等），与「管理端-修改部门」同链路；
//   并立即重渲染可见的部门敏感页（refreshDeptAwarePages）。
//
// 兼容契约：test-v156 的沙箱 Store 没有 setUserDept、document 没有 querySelectorAll
//   → 两处都必须 typeof 守卫（v156 契约不回归）。

const fs = require('fs')
const vm = require('vm')
const path = require('path')
const D = __dirname
const read = f => fs.readFileSync(path.join(D, f), 'utf-8')

let PASS = 0, FAIL = 0
const fails = []
const ok = (cond, msg) => { if (cond) { PASS++ } else { FAIL++; fails.push(msg); console.log('  ✗ ' + msg) } }
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got=' + JSON.stringify(a) + ', want=' + JSON.stringify(b) + ')')

// 抽函数体（与 test-v156 同款：braceSlice 从 function 关键字起配对花括号）
function braceSlice(src, i) {
  let depth = 0, j = i
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1) }
  }
  return src.slice(i)
}
function grabFn(src, name) {
  // 优先匹配 async function（saveProfile 是 async —— 从 'function ' 起抽会丢 async 前缀 → await 语法错）
  const a = src.indexOf('async function ' + name + '(')
  if (a >= 0) return braceSlice(src, a)
  const i = src.indexOf('function ' + name + '(')
  return i < 0 ? null : braceSlice(src, i)
}
const codeOnly = s => String(s).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const appSrc = read('app.js')
const saveProfileSrc = grabFn(appSrc, 'saveProfile')
const refreshSrc = grabFn(appSrc, 'refreshDeptAwarePages')
const spCode = codeOnly(saveProfileSrc || '')

// ============================================================
console.log('=== 组一 源码契约：统一收口 ===')
// ============================================================
ok(!!saveProfileSrc, '能抠出 saveProfile 函数体')
ok(/^async function saveProfile\(/.test(saveProfileSrc.trim()), 'saveProfile 已改为 async（等待 setUserDept 推送完成）')
ok(/if \(s && typeof Store\.setUserDept === 'function'\)/.test(spCode), 'setUserDept 调用带 typeof 守卫（v156 沙箱无此方法）')
ok(/await Store\.setUserDept\(s\.id, dept\)/.test(spCode), 'saveProfile 调用 Store.setUserDept(s.id, dept) 统一收口')
ok(/try \{ await Store\.setUserDept/.test(spCode), 'setUserDept 包 try（推送失败不阻塞保存）')
ok(/if \(typeof refreshDeptAwarePages === 'function'\) refreshDeptAwarePages\(\)/.test(spCode), '保存后触发部门敏感页立即重渲染（带 typeof 守卫）')
// v156 既有契约不回归
ok(/const dept = readDeptCascade\(DEPT_GROUPS\.profile\)/.test(spCode), 'v156 契约：先读取部门')
ok(/if \(!dept\) return alert\(t\('errDeptRequired'\)\)/.test(spCode), 'v156 契约：部门为空则拦截')
ok(/Store\.setUser\(\{ name, dept \}\)/.test(spCode), 'v156 契约：校验后的 dept 写入资料缓存')
ok(/if \(s\) Store\.updateUser\(s\.id, \{ name \}\)/.test(spCode), '账号表姓名同步保留')
ok(spCode.indexOf('closeProfileSetup()') > spCode.indexOf('refreshDeptAwarePages()'),
  '先刷新页面后关弹窗（重渲染不打断弹窗关闭）')

// ============================================================
console.log('=== 组二 源码契约：refreshDeptAwarePages ===')
// ============================================================
ok(!!refreshSrc, 'app.js 已定义 refreshDeptAwarePages()')
const rfCode = codeOnly(refreshSrc)
ok(/page-practice/.test(rfCode) && /renderPractice\(\)/.test(rfCode), '练习页可见 → renderPractice（含挑战入口卡）')
ok(/page-challenge/.test(rfCode) && /renderChallenge\(\)/.test(rfCode), '挑战页可见 → renderChallenge（含营期横幅）')
ok(/style\.display === 'none'/.test(rfCode), '跳过隐藏页')
ok(/try \{/.test(rfCode) && /catch \(e\)/.test(rfCode), '整体 try 包裹（异常不阻塞保存）')

// ============================================================
console.log('=== 组三 行为沙箱：saveProfile 收口 ===')
// ============================================================
// saveProfile 是 async：await 之后的关弹窗/刷新在微任务里 → 沙箱必须 await + 冲微任务后再断言
async function runSaveProfile(opts) {
  const alerts = []
  const calls = { setUser: null, setUserDept: [], updateUser: [] }
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
    Store: Object.assign({
      getSession: () => (opts.session === undefined ? { id: 5, username: 'zhangsan', name: '张三', dept: '日照·日照-餐饮' } : opts.session),
      setUser: a => { calls.setUser = a },
      updateUser: (id, patch) => { calls.updateUser.push([id, patch]) },
      renameUser: () => ({ ok: true, old: 'a', nu: 'b' }),
      setUserDept: (id, dept) => { calls.setUserDept.push([id, dept]); return { ok: true, dept } },
    }, opts.storeExtra || {}),
    closeProfileSetup: () => { sb.__closed = true },
    updateUserInfoDisplay: () => {},
    applyCourseRename: () => {},
  }
  if (opts.noSetUserDept) delete sb.Store.setUserDept
  if (opts.setUserDeptThrows) sb.Store.setUserDept = () => { throw new Error('net down') }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(saveProfileSrc, sb)
  await sb.saveProfile()
  await new Promise(r => setImmediate(r))   // 冲掉后续微任务（refreshDeptAwarePages 等）
  return { alerts, calls, closed: !!sb.__closed, promise: null }
}

;(async () => {
const b1 = await runSaveProfile({ dept: '日照·日照-房务' })
eq(b1.calls.setUser, { name: '张三', dept: '日照·日照-房务' }, '部门已改 → 资料缓存写入新部门')
eq(b1.calls.setUserDept, [[5, '日照·日照-房务']], '★ 部门已改 → setUserDept(s.id, dept) 统一收口被调用')
eq(b1.calls.updateUser, [[5, { name: '张三' }]], '账号表姓名同步仍被调用')
ok(b1.alerts.length === 0, '正常保存无提示')
ok(b1.closed, '正常保存关闭弹窗')

const b2 = await runSaveProfile({ dept: '' })
eq(b2.alerts, ['[errDeptRequired]'], '部门为空 → 一次提示')
eq(b2.calls.setUserDept, [], '部门为空 → 不调用 setUserDept')
ok(!b2.closed, '部门为空 → 弹窗不关闭')

const b3 = await runSaveProfile({ dept: '日照·日照-房务', noSetUserDept: true })
ok(b3.alerts.length === 0 && b3.closed, 'v156 兼容：Store 无 setUserDept → 不抛错、照常保存')

const b4 = await runSaveProfile({ dept: '日照·日照-房务', setUserDeptThrows: true })
ok(b4.alerts.length === 0 && b4.closed, 'setUserDept 抛错（推送失败）→ 不阻塞保存、弹窗照常关闭')

// 未登录（s 为 null）→ 不调用 setUserDept
const b5 = await runSaveProfile({ dept: '日照·日照-房务', session: null })
eq(b5.calls.setUserDept, [], '未登录 → 不调用 setUserDept')

// ============================================================
console.log('=== 组四 行为沙箱：refreshDeptAwarePages ===')
// ============================================================
function runRefresh(pages) {
  const calls = []
  const sb = {
    console,
    document: { querySelectorAll: () => pages },
    renderPractice: () => { calls.push('practice') },
    renderChallenge: () => { calls.push('challenge') },
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(refreshSrc, sb)
  sb.refreshDeptAwarePages()
  return calls
}
eq(runRefresh([
  { id: 'page-home', style: { display: 'none' } },
  { id: 'page-practice', style: { display: '' } },
  { id: 'page-challenge', style: { display: 'none' } },
]), ['practice'], '练习页可见 → 只重渲染练习页')
eq(runRefresh([
  { id: 'page-practice', style: { display: 'none' } },
  { id: 'page-challenge', style: { display: '' } },
]), ['challenge'], '挑战页可见 → 重渲染挑战页')
eq(runRefresh([{ id: 'page-home', style: { display: '' } }]), [], '首页可见 → 不重渲染部门敏感页')
eq(runRefresh([]), [], '空页面列表 → 不崩')
eq(runRefresh([{ id: 'page-challenge', style: {} }]), ['challenge'], 'display 未设置（视为可见）→ 重渲染挑战页')

// ============================================================
console.log('=== 组五 端到端口径：新部门能解析到 r9 ===')
// ============================================================
// 用云端真实营次数据 + challenge.js 的 chRoundRecForDept 源码，验证部门换成
// rizhao/fangwu 后解析结果从 r8 变 r9（锁定本次用户报障的验收口径）。
const chSrc = read('challenge.js')
const recSrc = grabFn(chSrc, 'chRoundRecForDept')
ok(!!recSrc, '能抠出 chRoundRecForDept')
// roundDeptMatch / roundOpenState 从 cloud-store.js 原样抽取（记忆铁律：复算必须从 .js 原样复制）
const cloudSrc = read('cloud-store.js')
const matchSrc = grabFn(cloudSrc, 'roundDeptMatch')
const openSrc = grabFn(cloudSrc, 'roundOpenState')
ok(!!matchSrc && !!openSrc, '能抠出 roundDeptMatch / roundOpenState')
// chDeptKey 简化替身：学员口径 = sessionDeptSlug()
const ROUNDS = [
  { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: false, at: 1790058244386 },
  { id: 'r6', name: '艳中餐厅七天挑战第二期', depts: ['dining/yan'], open: true, at: 1792148649255 },
  { id: 'r8', name: '日照-餐饮21天挑战第一期', depts: ['rizhao/canyin'], open: true, chPlan: 'v3', at: 0 },
  { id: 'r9', name: '日照-房务21天挑战第一期', depts: ['rizhao/fangwu'], open: true, chPlan: 'v3', at: 0 },
]
function resolveFor(deptSlug) {
  const sb = {
    console,
    CloudSync: { _chRounds: ROUNDS, _chRoundCurId: 'r6' },
    chDeptKey: () => deptSlug,
    roundDeptMatch: null, roundOpenState: null,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(matchSrc + '\n' + openSrc + '\n' + recSrc, sb)
  return vm.runInContext('chRoundRecForDept()', sb)
}
const rs = {}
;['rizhao/canyin', 'rizhao/fangwu', 'dining/sig'].forEach(k => { rs[k] = resolveFor(k) })
ok(rs['rizhao/canyin'] && rs['rizhao/canyin'].id === 'r8', '日照-餐饮 → r8（换部门前）')
ok(rs['rizhao/fangwu'] && rs['rizhao/fangwu'].id === 'r9', '★ 日照-房务 → r9（换部门后，营期应当变化）')
ok(rs['dining/sig'] && rs['dining/sig'].id === 'r1', '标帜 → 指针 r6 不适用、本部门 r1 未开放 → ③ 级回落 r1（四级语义不回归）')
ok(rs['rizhao/canyin'].id !== rs['rizhao/fangwu'].id, '两个日照部门解析到不同营期（用户报障的验收口径）')

// ============================================================
console.log('')
console.log(PASS + ' 通过, ' + FAIL + ' 失败' + (FAIL ? ' ❌' : ' ✅'))
if (FAIL) fails.forEach(f => console.log('  ✗ ' + f))
process.exit(FAIL ? 1 : 0)
})().catch(e => { console.error('沙箱异常:', e); process.exit(1) })
