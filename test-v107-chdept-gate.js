// v107：七天挑战部门门禁（bug2）
// 业务口径：七天挑战只对饮食部下的四个二级部门开放 —— 标帜餐厅 / 艳中餐厅 / 酒吧团队 / 客房送餐。
//   饮食部是一级；四个分队是二级；三级只有酒吧团队下的 WOOBAR / WETBAR / LIQUID，
//   它们是「酒吧团队」的别名（deptSubAlias 归一），不单独成队、也不单独开营。
//   房务部（rooms）与其他部门（other）不参加七天挑战。
// 覆盖：① CH_DEPT_SLUGS 白名单 = 四个分队；② chDeptAllowed 学员/管理员/未设部门判定；
//      ③ chDeptBlockReason 文案选择；④ 入口卡与挑战页均有门禁（注入沙箱实跑）；
//      ⑤ 三级别名归一到 dining/bar（不产生独立 slug）；⑥ 题库部门下拉不含三级。
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
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) return null
  const open = src.indexOf('{', i)
  let d = 0, inS = null, inC = false
  for (let k = open; k < src.length; k++) {
    const ch = src[k], nx = src[k + 1]
    if (inC) { if (ch === '\n') inC = false; continue }
    if (inS) { if (ch === '\\') { k++; continue } if (ch === inS) inS = null; continue }
    if (ch === '/' && nx === '/') { inC = true; continue }
    if (ch === '/' && nx === '*') { const e = src.indexOf('*/', k + 2); k = e < 0 ? src.length : e + 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inS = ch; continue }
    if (ch === '{') d++
    else if (ch === '}') { d--; if (d === 0) return src.slice(i, k + 1) }
  }
  return null
}

const appSrc = read('app.js')
const chSrc = read('challenge.js')
const i18nSrc = read('i18n.js')

console.log('=== 一、白名单常量：正好是饮食部四个二级分队 ===')
const mSlugs = chSrc.match(/const CH_DEPT_SLUGS = \[([^\]]*)\]/)
ok(!!mSlugs, 'challenge.js 定义了 CH_DEPT_SLUGS')
const slugs = mSlugs ? mSlugs[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : []
eq(slugs, ['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird'], 'CH_DEPT_SLUGS = 标帜/艳中/酒吧团队/客房送餐')
ok(slugs.indexOf('dining') < 0, '一级部门 dining 不在白名单（饮食部本身不参赛）')
ok(slugs.every(s => !/woobar|wetbar|liquid/i.test(s)), '三级部门（WOOBAR/WETBAR/LIQUID）不在白名单')
ok(slugs.every(s => !/^rooms/.test(s)), '房务部不在白名单')

console.log('=== 二、三级部门只是别名，不产生独立 slug ===')
// deptSubAlias：WOOBAR/WETBAR/LIQUID → 酒吧团队
const aliasBlock = i18nSrc.match(/deptSubAlias:\s*\{([\s\S]*?)\}/)
ok(!!aliasBlock, 'i18n 定义了 deptSubAlias')
if (aliasBlock) {
  const body = aliasBlock[1]
  ok(/'WOOBAR':\s*'酒吧团队'/.test(body), 'WOOBAR → 酒吧团队')
  ok(/'WETBAR':\s*'酒吧团队'/.test(body), 'WETBAR → 酒吧团队')
  ok(/'LIQUID':\s*'酒吧团队'/.test(body), 'LIQUID → 酒吧团队')
}
// DEPT_SUB_SLUGS：dining 只有 4 个分队，没有 woobar/wetbar/liquid
const mSub = appSrc.match(/const DEPT_SUB_SLUGS = \{([\s\S]*?)\n\}/)
ok(!!mSub, 'app.js 定义了 DEPT_SUB_SLUGS')
if (mSub) {
  const body = mSub[1]
  const diningLine = (body.match(/dining:\s*\{[^}]*\}/) || [''])[0]
  ok(diningLine.indexOf('woobar') < 0 && diningLine.indexOf('wetbar') < 0 && diningLine.indexOf('liquid') < 0,
    'DEPT_SUB_SLUGS.dining 无三级 slug')
  ok(/标帜餐厅':\s*'sig'/.test(diningLine) && /艳中餐厅':\s*'yan'/.test(diningLine) &&
     /酒吧团队':\s*'bar'/.test(diningLine) && /客房送餐':\s*'ird'/.test(diningLine),
    'DEPT_SUB_SLUGS.dining 正好四个分队 sig/yan/bar/ird')
}

console.log('=== 三、chDeptAllowed 判定（注入沙箱实跑）===')
// 沙箱里注入最小依赖：Store.isAdmin / chDeptKey / CH_DEPT_SLUGS
const sb = { console }
// 先取常量 + 两个函数
const fnAllowed = grab(chSrc, 'chDeptAllowed')
const fnReason = grab(chSrc, 'chDeptBlockReason')
ok(!!fnAllowed, 'chDeptAllowed 已实现')
ok(!!fnReason, 'chDeptBlockReason 已实现')
sb.globalThis = sb
vm.createContext(sb)
// 注意：被注入的函数在沙箱里也是函数声明，读的是沙箱全局。用 sb 上的可变属性做桩，
// 不能写在 runInContext('let x') 里 —— 那对后续 runInContext 是独立的词法环境，函数看不到。
sb.__admin = false
sb.__dept = ''
vm.runInContext('var CH_DEPT_SLUGS = ' + JSON.stringify(slugs) + ';', sb)
vm.runInContext('var Store = { isAdmin: function(){ return globalThis.__admin } };', sb)
vm.runInContext('function chDeptKey(){ return globalThis.__dept }', sb)
vm.runInContext(fnAllowed, sb)
vm.runInContext(fnReason, sb)
const run = code => vm.runInContext(code, sb)
const setSt = (admin, dept) => { sb.__admin = admin; sb.__dept = dept }

setSt(false, 'dining/sig'); eq(run('chDeptAllowed()'), true, '学员 标帜餐厅 → 可进')
setSt(false, 'dining/yan'); eq(run('chDeptAllowed()'), true, '学员 艳中餐厅 → 可进')
setSt(false, 'dining/bar'); eq(run('chDeptAllowed()'), true, '学员 酒吧团队 → 可进')
setSt(false, 'dining/ird'); eq(run('chDeptAllowed()'), true, '学员 客房送餐 → 可进')
setSt(false, 'dining'); eq(run('chDeptAllowed()'), false, '学员 一级「饮食部」本身 → 不可进（不是分队）')
setSt(false, 'rooms/fo'); eq(run('chDeptAllowed()'), false, '学员 房务部迎宾前台 → 不可进')
setSt(false, 'rooms/spa'); eq(run('chDeptAllowed()'), false, '学员 房务部健身及水疗 → 不可进')
setSt(false, 'all'); eq(run('chDeptAllowed()'), false, '学员 通用/全部 → 不可进')
setSt(false, ''); eq(run('chDeptAllowed()'), false, '学员 未设部门 → 不可进')
setSt(true, ''); eq(run('chDeptAllowed()'), true, '管理员（全部部门视角）→ 可进（要能预览各队）')
setSt(true, 'rooms/fo'); eq(run('chDeptAllowed()'), true, '管理员切片到房务部 → 仍可进（切片是预览工具）')

console.log('=== 四、chDeptBlockReason 文案选择 ===')
setSt(false, ''); eq(run('chDeptBlockReason()'), 'chDeptNeedSet', '未设部门 → 提示先设部门')
setSt(false, 'all'); eq(run('chDeptBlockReason()'), 'chDeptNeedSet', '通用视角 → 提示先设部门')
setSt(false, 'rooms/fo'); eq(run('chDeptBlockReason()'), 'chDeptNotEligible', '房务部 → 提示部门不适用')

console.log('=== 五、i18n 键成对存在 ===')
const zhPart = i18nSrc.slice(0, i18nSrc.indexOf('};\n') > 0 ? i18nSrc.length : i18nSrc.length)
;['chDeptNotEligible', 'chDeptNeedSet', 'chDeptEligibleList', 'chDeptGoSet'].forEach(k => {
  const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
  eq(n, 2, `i18n 键 ${k} 中英成对（出现 2 次）`)
})

console.log('=== 六、入口卡与挑战页均有门禁 ===')
// 入口卡
ok(/function challengeEntryHtml\(\)[\s\S]{0,600}?chDeptAllowed\(\)/.test(appSrc), 'challengeEntryHtml 调用 chDeptAllowed')
ok(/function challengeEntryHtml\(\)[\s\S]{0,900}?return challengeEntryBlockedHtml\(\)/.test(appSrc),
  '入口卡在不可进时返回说明卡')
ok(!!grab(appSrc, 'challengeEntryBlockedHtml'), 'challengeEntryBlockedHtml 已实现')
const blockedCard = grab(appSrc, 'challengeEntryBlockedHtml') || ''
ok(blockedCard.indexOf('onclick="navigate(') < 0 || blockedCard.indexOf('navigate(\'challenge\')') < 0,
  '说明卡不可点击进挑战（没有 navigate(challenge)）')
ok(blockedCard.indexOf('dashed') > 0, '说明卡用虚线边框（与非锁定态的可点击卡区分）')
// 挑战页深链接兜底
ok(/function renderChallenge\(\)[\s\S]{0,900}?chDeptAllowed\(\)/.test(chSrc), 'renderChallenge 调用 chDeptAllowed（深链接兜底）')
ok(/function renderChallenge\(\)[\s\S]{0,1200}?chDeptBlockedPageHtml\(\)/.test(chSrc), '挑战页在不可进时渲染说明页')
ok(!!grab(chSrc, 'chDeptBlockedPageHtml'), 'chDeptBlockedPageHtml 已实现')
// 挑战页门禁必须在「进入 quiz 阶段」之前（否则深链接 / 部门被改后仍能继续作答）
const rcIdx = chSrc.indexOf('function renderChallenge()')
const rcBody = chSrc.slice(rcIdx, rcIdx + 2000)
const quizIdx = rcBody.indexOf("chs.phase === 'quiz'")
const gateIdx = rcBody.indexOf('chDeptAllowed()')
ok(gateIdx > 0 && quizIdx > 0 && gateIdx < quizIdx, '门禁置于 quiz 阶段分支之前（深链接兜底有效）')

console.log('=== 七、无 navigate(profile) 之类的无效路由 ===')
ok(chSrc.indexOf("navigate('profile')") < 0, 'challenge.js 无无效路由 navigate(profile)')
ok(appSrc.indexOf("navigate('profile')") < 0, 'app.js 无无效路由 navigate(profile)')
ok(/openProfileSetup\(\)/.test(grab(chSrc, 'chDeptBlockedPageHtml') || '') ||
   /openProfileSetup\(\)/.test(grab(appSrc, 'challengeEntryBlockedHtml') || ''),
  '「去设置部门」按钮调用真实存在的 openProfileSetup()')

console.log('=== 八、题库部门下拉不含三级部门 ===')
// ADMIN_DEPT_TABS 是 editDept / importDept 两个下拉的数据源
const mTabs = appSrc.match(/const ADMIN_DEPT_TABS = \[([^\]]*)\]/)
ok(!!mTabs, 'ADMIN_DEPT_TABS 已定义')
if (mTabs) {
  const tabs = mTabs[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  console.log('  ADMIN_DEPT_TABS =', tabs.join(' | '))
  ok(tabs.indexOf('dining/sig') >= 0 && tabs.indexOf('dining/yan') >= 0 &&
     tabs.indexOf('dining/bar') >= 0 && tabs.indexOf('dining/ird') >= 0, '四个二级分队在列表内')
  ok(tabs.indexOf('dining') < 0, '一级 dining 不在下拉（避免上传题挂到一级）')
  ok(tabs.every(t => !/woobar|wetbar|liquid/i.test(t)), '三级部门不在下拉')
}
ok(/id="editDept"[\s\S]{0,120}adminDeptOptionsHtml/.test(appSrc), 'editDept 下拉用 adminDeptOptionsHtml（走 ADMIN_DEPT_TABS）')
ok(/id="importDept"[\s\S]{0,220}ADMIN_DEPT_TABS\.map/.test(appSrc), 'importDept 下拉用 ADMIN_DEPT_TABS')

console.log('')
console.log(`PASS ${PASS} / FAIL ${FAIL}`)
if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
process.exit(FAIL ? 1 : 0)
