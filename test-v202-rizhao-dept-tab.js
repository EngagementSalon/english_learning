// v202：挑战成绩统计部门筛选条新增「日照」大类按钮（rizhao）
// 用户诉求：管理员成绩看板给一个大类叫「日照」，和普通学员分开处理；
// 拍板：改挑战成绩统计（当期 + 总账）两处筛选条；大类 + 两个分部按钮都保留。
// 断言面：
//   A 源码契约 —— 两处 deptBarOptions 都含 rizhao 大类且紧跟其分部；ADMIN_DEPT_TABS 不动（题库 tab 面不受影响）；adminTabLabel 有 rizhao 分支
//   B 标签行为 —— adminTabLabel('rizhao') 走 deptTree 名（沙箱注入），缺 deptTree 回落「日照」
//   C 端到端筛选 —— 用真实 normDept 链路（i18n deptTree + DEPT_SUB_SLUGS）验证：
//       '日照·日照-餐饮'/'日照·日照-房务' → majorKey 'rizhao' → 大类筛选两分部全进；
//       本部学员（饮食部/房务部/其他）在大类筛选下全部排除；分部筛选互不串。
'use strict'
const fs = require('fs')
const vm = require('vm')
const APP = fs.readFileSync('app.js', 'utf-8')
const I18N = fs.readFileSync('i18n.js', 'utf-8')

let PASS = 0, FAIL = 0
const fails = []
function ok(msg, cond) { if (cond) { PASS++ } else { FAIL++; fails.push(msg); console.log('  ✗ ' + msg) } }
function eq(msg, actual, expected) { ok(msg + '（实际 ' + JSON.stringify(actual) + '）', JSON.stringify(actual) === JSON.stringify(expected)) }

// ---------- 源码切片工具 ----------
function braceSlice(s, i) { let d = 0; for (let j = i; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (d === 0) return s.slice(i, j + 1) } } return null }
function grabTopFn(src, name) {
  const m = src.match(new RegExp('(?:async )?function ' + name + '\\('))
  return m ? braceSlice(src, m.index) : null
}
function grabConst(src, name) {
  const m = src.match(new RegExp('const ' + name + ' = (\\[[^\\n]*\\])'))
  return m ? m[1] : null
}
function grabObjLiteral(src, anchor) {
  const i = src.indexOf(anchor)
  if (i < 0) return null
  return braceSlice(src, src.indexOf('{', i))
}
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ============================================================
console.log('=== 组A 源码契约 ===')
// ============================================================
const ap = APP.replace(/\/\/[^\n]*/g, '')
const NEW_BAR = "['all', 'rizhao', 'rizhao/canyin', 'rizhao/fangwu'].concat("
ok('A1 新筛选条清单存在', ap.indexOf(NEW_BAR) >= 0)
eq('A2 新清单出现次数 = 2（当期 + 总账，不抽公共函数）', (ap.match(new RegExp(escRe(NEW_BAR), 'g')) || []).length, 2, 'A2')
ok("A3 旧清单 ['all'].concat( 不复现", ap.indexOf("['all'].concat(") < 0)
eq('A4 ADMIN_DEPT_TABS 原样（题库 tab 不动）',
  grabConst(APP, 'ADMIN_DEPT_TABS'),
  "['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird', 'rizhao/canyin', 'rizhao/fangwu', 'rooms', 'all']", 'A4')
ok('A5 adminTabLabel 含 rizhao 分支 + typeof deptTree 守卫',
  /if \(tab === 'rizhao'\) return \(typeof deptTree === 'function' && deptTree\(\)\.rizhao && deptTree\(\)\.rizhao\.name\) \|\| '日照'/.test(ap))
eq("A6 筛选条排除条件 String(k).indexOf('rizhao/') !== 0 出现 2 次",
  (ap.match(/String\(k\)\.indexOf\('rizhao\/'\) !== 0/g) || []).length, 2, 'A6')

// ============================================================
console.log('=== 组B 标签行为沙箱 ===')
// ============================================================
function runLabel(opts) {
  const sb = {
    console,
    ADMIN_DEPT_TAB_LABELS: { 'rizhao/canyin': 'canyin', 'rizhao/fangwu': 'fangwu' },
    // DEPT_SUB_BY_SLUG 值 = 中文名（DEPT_SUB_SLUGS 的键），chDeptNames 也按中文名键
    DEPT_SUB_BY_SLUG: { 'rizhao/canyin': '日照-餐饮', 'rizhao/fangwu': '日照-房务' },
    t: k => (k === 'bankRooms' ? '房务部'
      : k === 'chDeptNames' ? { '日照-餐饮': '日照-餐饮', '日照-房务': '日照-房务' } : k),
  }
  if (opts.deptTree !== undefined) sb.deptTree = opts.deptTree
  vm.createContext(sb)
  vm.runInContext(grabTopFn(APP, 'adminTabLabel'), sb)
  return sb.adminTabLabel(opts.tab)
}
eq("B1 zh 环境 adminTabLabel('rizhao') = 日照", runLabel({ tab: 'rizhao', deptTree: () => ({ rizhao: { name: '日照' } }) }), '日照', 'B1')
eq("B2 en 环境 adminTabLabel('rizhao') = Rizhao", runLabel({ tab: 'rizhao', deptTree: () => ({ rizhao: { name: 'Rizhao' } }) }), 'Rizhao', 'B2')
eq('B3 缺 deptTree（切片沙箱）→ 回落「日照」不炸', runLabel({ tab: 'rizhao' }), '日照', 'B3')
eq('B4 分部标签不回归（chDeptNames 链路）', runLabel({ tab: 'rizhao/canyin', deptTree: () => ({ rizhao: { name: '日照' } }) }), '日照-餐饮', 'B4')
eq('B5 rooms 标签不回归', runLabel({ tab: 'rooms', deptTree: () => ({ rizhao: { name: '日照' } }) }), '房务部', 'B5')

// ============================================================
console.log('=== 组C 端到端筛选（真实 normDept 链路） ===')
// ============================================================
const treeLiteral = grabObjLiteral(I18N, 'deptTree:')
ok('C0 i18n deptTree 抽取成功', !!treeLiteral && treeLiteral.indexOf('日照-餐饮') >= 0)
const sb = { console, t: k => (k === 'deptTree' ? sb.__tree : {}) }
vm.createContext(sb)
vm.runInContext('__tree = ' + treeLiteral, sb)
// 函数与模块常量注入（顺序无关，调用时才解析）
vm.runInContext('DEPT_MAJOR_KEYS=' + grabConst(APP, 'DEPT_MAJOR_KEYS'), sb)
vm.runInContext('DEPT_CANON=' + grabObjLiteral(APP, 'const DEPT_CANON = {'), sb)
vm.runInContext('DEPT_SUB_SLUGS=' + grabObjLiteral(APP, 'const DEPT_SUB_SLUGS = {'), sb)
;['function deptTree', 'function _deptSubIndex', 'function normDeptSub', 'function normDept', 'function deptSlug', 'function deptSlugName'].forEach(fn => {
  const i = APP.indexOf(fn + '(')
  if (i < 0) throw new Error('缺函数：' + fn)
  const bodyStart = APP.indexOf('{', i)
  // 注意：必须连「function 名称(参数)」一起注入 —— 只注 {body} 会变成对象字面量语法错
  vm.runInContext(APP.slice(i, bodyStart) + braceSlice(APP, bodyStart), sb)
})
const hitCy = vm.runInContext('normDept("日照·日照-餐饮")', sb)
eq('C1 日照-餐饮 → majorKey rizhao', hitCy && hitCy.majorKey, 'rizhao', 'C1')
eq('C2 日照-餐饮 → key rizhao/canyin', hitCy && hitCy.key, 'rizhao/canyin', 'C2')
eq('C3 大部门名核对 = 日照', hitCy && hitCy.majorName, '日照', 'C3')
const hitFw = vm.runInContext('normDept("日照·日照-房务")', sb)
eq('C4 日照-房务 → key rizhao/fangwu', hitFw && hitFw.key, 'rizhao/fangwu', 'C4')
// 大类筛选判定（与 deptFilter 同口径：'/' 有无分大部门/分部）
const inMajor = (dept, sel) => {
  const h = vm.runInContext('normDept(' + JSON.stringify(dept) + ')', sb)
  if (!h) return false
  return sel.indexOf('/') >= 0 ? h.key === sel : h.majorKey === sel
}
ok('C5 大类 rizhao：日照-餐饮 进入', inMajor('日照·日照-餐饮', 'rizhao'))
ok('C6 大类 rizhao：日照-房务 进入', inMajor('日照·日照-房务', 'rizhao'))
ok('C7 大类 rizhao：饮食部·标帜餐厅 排除', !inMajor('饮食部·标帜餐厅', 'rizhao'))
ok('C8 大类 rizhao：房务部·礼宾部 排除', !inMajor('房务部·礼宾部', 'rizhao'))
ok('C9 大类 rizhao：其他/空/未知 全排除', !inMajor('其他部门', 'rizhao') && !inMajor('', 'rizhao') && !inMajor('未知部门', 'rizhao'))
ok('C10 分部 canyin：日照-餐饮 进入', inMajor('日照·日照-餐饮', 'rizhao/canyin'))
ok('C11 分部 canyin：日照-房务 排除（不串）', !inMajor('日照·日照-房务', 'rizhao/canyin'))
ok('C12 分部 fangwu：日照-房务 进入', inMajor('日照·日照-房务', 'rizhao/fangwu'))
ok('C13 分部 fangwu：饮食部 排除', !inMajor('饮食部·艳中餐厅', 'rizhao/fangwu'))
ok('C14 rooms 大类：房务部学员 进入（既有行为不回归）', inMajor('房务部·礼宾部', 'rooms'))
ok('C15 rooms 大类：日照学员 排除（日照 ≠ 房务部）', !inMajor('日照·日照-房务', 'rooms'))

// ============================================================
console.log('=== 组D v199–v201 契约不回归 ===')
// ============================================================
ok('D1 refreshChallengeNavLabel 仍在（v201，challenge.js）', /^function refreshChallengeNavLabel\(/m.test(fs.readFileSync('challenge.js', 'utf-8')))
ok('D2 cloud-store 两处接线仍在（v201）', fs.readFileSync('cloud-store.js', 'utf-8').split("typeof refreshChallengeNavLabel === 'function'").length === 3)
ok('D3 v199 setUserDept 收口仍在', APP.indexOf('await Store.setUserDept(s.id, dept)') >= 0)
ok('D4 v200 日照防作弊豁免仍在', fs.readFileSync('anti-cheat.js', 'utf-8').indexOf('isAdminUser() || isRizhaoUser()') >= 0)

// ============================================================
console.log('')
console.log(PASS + ' 通过, ' + FAIL + ' 失败' + (FAIL ? ' ❌' : ' ✅'))
if (FAIL) fails.forEach(f => console.log('  ✗ ' + f))
process.exit(FAIL ? 1 : 0)
