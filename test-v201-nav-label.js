// v201：顶栏挑战导航命名提前到「营次数据落地 / 切部门」时机 —— 修复
// 「首页顶栏一直显示七天挑战，点进挑战页才变 21天挑战」（v196 只在挑战页渲染时改名）
const fs = require('fs')
const vm = require('vm')

let pass = 0, fail = 0, fails = []
function ok(name, cond) { if (cond) { pass++; console.log('  \u2713 ' + name) } else { fail++; fails.push(name); console.log('  \u2717 ' + name) } }
function eq(name, a, b) { ok(name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）', a === b) }

function braceSlice(src, i) {
  let d = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1) }
  }
  return null
}
function grabFn(src, name) {
  const a = src.indexOf('function ' + name + '(')
  return a < 0 ? null : braceSlice(src, a)
}

const chSrc = fs.readFileSync('challenge.js', 'utf8')
const csSrc = fs.readFileSync('cloud-store.js', 'utf8')
const appSrc = fs.readFileSync('app.js', 'utf8')
const idxSrc = fs.readFileSync('index.html', 'utf8')

console.log('=== 组一 源码契约 ===')
ok('challenge.js 定义全局 refreshChallengeNavLabel（function 声明）', /^function refreshChallengeNavLabel\(/m.test(chSrc))
ok('旧内联实现已移除（navChallengeCh21 仅剩函数内 1 处引用）', (chSrc.match(/navChallengeCh21/g) || []).length === 1) // v196 内联处已删，只剩 refreshChallengeNavLabel 内
ok('renderChallengeIntro 末尾调用 refreshChallengeNavLabel', /chLoadLeaderboard\(\)[\s\S]{0,200}refreshChallengeNavLabel\(\)/.test(chSrc))
ok('cloud-store 两处落地均调用（typeof 守卫）', (csSrc.match(/typeof refreshChallengeNavLabel === 'function'/g) || []).length === 2)
ok('cloud-store 调用带 try/catch', (csSrc.match(/try \{ refreshChallengeNavLabel\(\) \} catch \(e\) \{\}/g) || []).length === 2)
ok('app.js refreshDeptAwarePages 首行调用', /function refreshDeptAwarePages\(\) \{\s*\n\s*try \{\s*\n\s*\/\/ v201[^\n]*\n\s*if \(typeof refreshChallengeNavLabel === 'function'\) refreshChallengeNavLabel\(\)/.test(appSrc))
ok('index.html 静态默认仍是「七天挑战」（未登录/无营次回落）', idxSrc.indexOf('>🏅 七天挑战</a>') >= 0)

console.log('=== 组二 行为沙箱 ===')
const fnSrc = grabFn(chSrc, 'refreshChallengeNavLabel')
ok('成功抽取 refreshChallengeNavLabel 函数体', !!fnSrc)

function runNav(opts) {
  const sb = {
    console,
    document: { getElementById: (id) => (id === 'navChallenge' ? opts.nav : null) },
    t: (k) => (k === 'navChallengeCh21' ? '🏅 21天挑战' : (k === 'navChallengeCh' ? '🏅 七天挑战' : k)),
    chPlanIsV3: opts.chPlanIsV3,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fnSrc, sb)
  sb.refreshChallengeNavLabel()
  return sb
}
const r1 = { nav: { textContent: '🏅 七天挑战' } }
{
  const sb = {
    console,
    document: { getElementById: (id) => (id === 'navChallenge' ? r1.nav : null) },
    t: (k) => (k === 'navChallengeCh21' ? '🏅 21天挑战' : (k === 'navChallengeCh' ? '🏅 七天挑战' : k)),
    chPlanIsV3: () => true,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fnSrc, sb)
  sb.refreshChallengeNavLabel()
  eq('v3 营次 → 显示 21天挑战', r1.nav.textContent, '🏅 21天挑战')
}
const r2 = { nav: { textContent: '🏅 21天挑战' } }
{
  const sb = {
    console,
    document: { getElementById: () => r2.nav },
    t: (k) => (k === 'navChallengeCh21' ? '🏅 21天挑战' : '🏅 七天挑战'),
    chPlanIsV3: () => false,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fnSrc, sb)
  sb.refreshChallengeNavLabel()
  eq('非 v3 营次 → 显示 七天挑战（含 v1/v2 与数据未就绪）', r2.nav.textContent, '🏅 七天挑战')
}
const r3 = { nav: { textContent: '🏅 七天挑战' } }
{
  const sb = {
    console,
    document: { getElementById: () => r3.nav },
    t: (k) => (k === 'navChallengeCh21' ? '🏅 21天挑战' : '🏅 七天挑战'),
    // chPlanIsV3 缺失（加载顺序/裁剪环境）→ 走默认文案且不抛错
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fnSrc, sb)
  let threw = false
  try { sb.refreshChallengeNavLabel() } catch (e) { threw = true }
  ok('chPlanIsV3 缺失 → 不抛错、回落默认文案', !threw && r3.nav.textContent === '🏅 七天挑战')
}
ok('nav 元素缺失 → 不抛错', (function () {
  const sb = { console, document: { getElementById: () => null }, t: (k) => k, chPlanIsV3: () => true }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fnSrc, sb)
  try { sb.refreshChallengeNavLabel(); return true } catch (e) { return false }
})())

console.log('=== 组三 既有契约不回归 ===')
ok('v196 注释仍在（营次结构动态命名设计未回退）', chSrc.indexOf('顶栏挑战导航按营次结构动态命名') >= 0)
ok('i18n 两把 key 均在（中英）', (fs.readFileSync('i18n.js', 'utf8').match(/navChallengeCh21:/g) || []).length === 2)
ok('v199 收口仍在（saveProfile setUserDept）', appSrc.indexOf('await Store.setUserDept(s.id, dept)') >= 0)
ok('v200 豁免仍在（anti-cheat 日照同位分支）', fs.readFileSync('anti-cheat.js', 'utf8').indexOf('if (isAdminUser() || isRizhaoUser()) { stop(); return }') >= 0)

console.log('')
console.log(pass + ' 通过, ' + fail + ' 失败' + (fail ? ' ❌' : ' ✅'))
if (fail) fails.forEach(f => console.log('  ✗ ' + f))
process.exit(fail ? 1 : 0)
