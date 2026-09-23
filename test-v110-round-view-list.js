// ====== 测试：v110 一级部门视角汇总下属各部门的挑战 ======
// 用户口径：「饮食部点开来应该能看到所有饮食部下属部门的挑战啦」
// 背景：v109 实现了「一级行只留 全部/饮食部/房务部/通用 + 点开展开分部门」，但营次判定仍用
//   「单一主营次」口径（chRoundRecForDept → roundDeptMatch），而 roundDeptMatch 对 'dining'
//   大部门视角**不匹配**挂在 'dining/sig'/'dining/yan' 的营次 → 饮食部被误判「暂无挑战」。
// v110 修法：新增「视角营次列表」chRoundListForView()（大部门展开其下全部子部门 slug 逐个匹配），
//   并让入口门禁（chNoRoundForDept）/营次名（chRoundName）/装载判定（chEnsureRound）/积分榜
//   （chLbAggregate）/重渲染 shape 全部改走该列表。
// 覆盖：
//   1. chRoundViewSlugs 三分支（空=全库 / 'all'=无分队 / 大部门=展开子部门 / 分部门=自身）
//   2. chRoundListForView：饮食部汇总两期、分部门单期、房务部空、全库全部
//   3. chNoRoundForDept 语义演进（饮食部有营次 → false；房务部/通用 → true）
//   4. 挑战页 chRoundListHtml：多期渲染 / 单期不渲染 / 含部门标签与期名
//   5. chRoundName / chCurrentRound / chRoundViewKey（大部门取最新一期作代表 + 集合标识）
//   6. chEnsureRound 纳入视角营次集合（大部门下营次增减触发重载）
//   7. chLbAggregate 大部门视角汇总下属营次成绩；显式传 round 时行为不变
//   8. 入口卡（app.js）内嵌下属挑战预览 + i18n 成对 + 源码护栏
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
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
  alert() {}, confirm() { return true }, prompt() { return null },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }
const run = code => vm.runInContext(code, sandbox)

// ---- cloud-store.js 提取 roundDeptMatch / roundOpenState ----
const csSrc = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const grabFn = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{'))
  if (!m) return null
  let i = m.index + m[0].length, depth = 1
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(m.index, i)
}
;['roundDeptMatch', 'roundOpenState'].forEach(n => {
  const fn = grabFn(csSrc, n)
  assert(`cloud-store 提取 ${n}`, !!fn)
  if (fn) vm.runInContext(fn, sandbox)
})

const R1 = '标帜餐厅七天挑战第一期'
const R2 = '艳中餐厅七天挑战第一期'
const mkRounds = (extra) => {
  const base = [
    { id: 'r1', name: R1, depts: ['dining/sig'], open: true, examOpen: true },
    { id: 'r2', name: R2, depts: ['dining/yan'], open: true, examOpen: true },
  ]
  return extra ? base.concat(extra) : base
}
const setRounds = (extra) => {
  sandbox.CloudSync = { _chRounds: mkRounds(extra), _chRoundCurId: 'r1', _chRoundCurName: R1 }
}
setRounds()

const setStudent = dept => {
  Store.getSession = () => ({ role: 'student', name: 's1', username: 's1', dept })
  Store.getUser = () => ({ name: 's1', dept })
}
const setAdmin = () => {
  Store.getSession = () => ({ role: 'admin', username: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })
}
const setView = k => { setAdmin(); run(`setPracticeDept(${JSON.stringify(k)})`) }
const ids = () => run('chRoundListForView().map(r => r.id)')

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

;(async () => {
  console.log('\n🧪 v110 一级部门视角汇总下属各部门的挑战')

  // ============ 一、chRoundViewSlugs 三分支 ============
  console.log('\n=== 一、chRoundViewSlugs（视角 → 子部门 slug 集合）===')
  setView('')
  assert('全库视角（""）→ null（不过滤）', run('chRoundViewSlugs()') === null)
  setView('all')
  assert("通用视角（'all'）→ 空数组（无分队可汇总）", JSON.stringify(run('chRoundViewSlugs()')) === '[]',
    JSON.stringify(run('chRoundViewSlugs()')))
  setView('dining')
  const sl = run('chRoundViewSlugs()')
  assert('饮食部大部门 → 展开 4 个分队 slug', Array.isArray(sl) && sl.length === 4, JSON.stringify(sl))
  ;['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird'].forEach(k => {
    assert(`饮食部展开含 ${k}`, sl.indexOf(k) >= 0)
  })
  setView('rooms')
  const sr = run('chRoundViewSlugs()')
  assert('房务部大部门 → 展开 5 个分部门 slug', Array.isArray(sr) && sr.length === 5, JSON.stringify(sr))
  assert('房务部展开不含饮食部 slug', sr.indexOf('dining/sig') < 0)
  setView('dining/sig')
  assert("分部门视角 → 仅自身 ['dining/sig']", JSON.stringify(run('chRoundViewSlugs()')) === '["dining/sig"]')

  // ============ 二、chRoundListForView ============
  console.log('\n=== 二、chRoundListForView（视角营次列表）===')
  setView('')
  assert('全库视角 → 全部两期', JSON.stringify(ids()) === '["r1","r2"]', JSON.stringify(ids()))
  setView('dining')
  assert('★ 饮食部 → 汇总下属两期（r1 标帜 + r2 艳中）', JSON.stringify(ids()) === '["r1","r2"]', JSON.stringify(ids()))
  setView('dining/sig')
  assert('标帜分队 → 仅 r1', JSON.stringify(ids()) === '["r1"]', JSON.stringify(ids()))
  setView('dining/yan')
  assert('艳中分队 → 仅 r2', JSON.stringify(ids()) === '["r2"]', JSON.stringify(ids()))
  setView('dining/bar')
  assert('酒吧团队 → 空（无专属营次）', JSON.stringify(ids()) === '[]', JSON.stringify(ids()))
  setView('rooms')
  assert('房务部 → 空（下属无营次）', JSON.stringify(ids()) === '[]', JSON.stringify(ids()))
  setView('all')
  assert('通用 → 空', JSON.stringify(ids()) === '[]', JSON.stringify(ids()))

  // 大部门下新增一队营次 → 列表自动纳入
  setRounds([{ id: 'r3', name: '客房送餐七天挑战第一期', depts: ['dining/ird'], open: true }])
  setView('dining')
  assert('★ 饮食部新增客房送餐营次 → 汇总三期', JSON.stringify(ids()) === '["r1","r2","r3"]', JSON.stringify(ids()))
  setView('dining/ird')
  assert('客房送餐分队 → r3（新营次生效）', JSON.stringify(ids()) === '["r3"]', JSON.stringify(ids()))
  setRounds()   // 复位

  // ============ 三、chNoRoundForDept 语义演进 ============
  console.log('\n=== 三、chNoRoundForDept（v110 语义演进）===')
  setView('dining')
  assert('★ 饮食部有下属营次 → 不算「暂无营次」', run('chNoRoundForDept()') === false)
  setView('dining/sig')
  assert('标帜 → 有营次', run('chNoRoundForDept()') === false)
  setView('dining/bar')
  assert('酒吧团队 → 暂无营次', run('chNoRoundForDept()') === true)
  setView('rooms')
  assert('房务部 → 暂无营次', run('chNoRoundForDept()') === true)
  setView('all')
  assert('通用 → 暂无营次', run('chNoRoundForDept()') === true)
  setView('')
  assert('全库视角 → 不算暂无营次', run('chNoRoundForDept()') === false)
  setStudent('饮食部·标帜餐厅')
  assert('学员（标帜）→ 按本人部门，有营次', run('chNoRoundForDept()') === false)
  setStudent('饮食部·客房送餐')
  assert('学员（客房送餐）→ 暂无营次', run('chNoRoundForDept()') === true)
  setStudent('房务部·迎宾前台')
  assert('学员（房务部）→ 暂无营次', run('chNoRoundForDept()') === true)

  // ============ 四、chRoundName / chCurrentRound / chRoundViewKey ============
  console.log('\n=== 四、代表营次与集合标识 ===')
  setView('dining')
  assert('★ 饮食部无单一主营次（chRoundRecForDept 为 null）', run('chRoundRecForDept()') === null)
  assert('饮食部营次名 → 取列表最新一期（艳中第一期）', run('chRoundName()') === R2, run('chRoundName()'))
  assert('饮食部 chCurrentRound → 最新一期 r2', run('chCurrentRound()') === 'r2', run('chCurrentRound()'))
  setView('dining/sig')
  assert('标帜仍按主营次（r1）', run('chRoundName()') === R1 && run('chCurrentRound()') === 'r1')
  setView('dining')
  assert('chRoundViewKey 饮食部 = "r1,r2"', run('chRoundViewKey()') === 'r1,r2', run('chRoundViewKey()'))
  setView('dining/bar')
  assert('chRoundViewKey 酒吧团队 = "none:dining/bar"', run('chRoundViewKey()') === 'none:dining/bar', run('chRoundViewKey()'))
  setView('')
  assert('chRoundViewKey 全库 = "r1,r2"', run('chRoundViewKey()') === 'r1,r2', run('chRoundViewKey()'))

  console.log('\n=== 四b、chEnsureRound 纳入视角营次集合 ===')
  // ⚠️ _chRoundLoaded 在整载后可能已被调用过（沙箱内初值非空），故不断言「首次装载 true」，
  //    只断言真正要保的性质：同视角幂等 + 视角营次集合变化触发重载。
  setView('dining')
  run('chEnsureRound()')
  const vkDining = run('chRoundViewKey()')
  assert('同视角再调 → false（幂等）', run('chEnsureRound()') === false)
  assert('装载标识已记录视角集合', run('_chRoundViewLoaded') === vkDining, run('_chRoundViewLoaded'))
  // 大部门下新增营次 → 集合变化 → 必须触发重载
  setRounds([{ id: 'r3', name: '客房送餐七天挑战第一期', depts: ['dining/ird'], open: true }])
  assert('★ 饮食部新增下属营次 → 触发重载', run('chEnsureRound()') === true)
  assert('装载标识已更新为新集合', run('_chRoundViewLoaded') === 'r1,r2,r3', run('_chRoundViewLoaded'))
  assert('新集合后再调 → 幂等', run('chEnsureRound()') === false)
  setRounds()

  // ============ 五、挑战页营次列表卡 ============
  console.log('\n=== 五、chRoundListHtml（挑战页列表卡）===')
  setView('dining')
  const hList = run('chRoundListHtml()')
  assert('饮食部（两期）→ 渲染列表卡', hList.length > 0 && hList.includes(R1) && hList.includes(R2))
  assert('列表卡含部门标签（标帜餐厅/艳中餐厅）', hList.includes('标帜餐厅') && hList.includes('艳中餐厅'))
  assert('列表卡含标题键（本部门下设 N 期）', hList.includes(run('t("chRoundListTitle", 2)').replace(/2/g, '2')))
  setView('dining/sig')
  assert('标帜（单期）→ 不渲染列表卡（避免与营次条重复）', run('chRoundListHtml()') === '')
  setView('')
  assert('全库视角（两期）→ 渲染列表卡', run('chRoundListHtml()').includes(R1))

  console.log('\n=== 五b、renderChallenge 接线 ===')
  setView('dining')
  getEl('page-challenge').innerHTML = ''
  run('renderChallenge()')
  const pageDining = getEl('page-challenge').innerHTML
  assert('★ 饮食部挑战页渲染两期列表', pageDining.includes(R1) && pageDining.includes(R2))
  assert('饮食部挑战页不显示「暂无挑战」', !pageDining.includes(run('t("chDeptNoRound")')))
  setView('dining/bar')
  getEl('page-challenge').innerHTML = ''
  run('renderChallenge()')
  const pageBar = getEl('page-challenge').innerHTML
  assert('酒吧团队挑战页 → 仍为「暂无挑战」说明页', pageBar.includes(run('t("chDeptNoRound")')))
  assert('酒吧团队说明页不渲染别队营次名', !pageBar.includes(R1) && !pageBar.includes(R2))
  assert('列表卡接线在挑战页模板中',
    /el\.innerHTML = `[\s\S]{0,200}?\$\{chRoundListHtml\(\)\}/.test(chSrc))

  // ============ 六、积分榜口径 ============
  console.log('\n=== 六、chLbAggregate（大部门汇总下属营次成绩）===')
  const rows = [
    { username: 'u1', name: '甲', role: 'student', chy: [
      { day: 7, si: 1, kind: 'test', correct: 20, total: 20, usedSec: 60, at: 1, rd: 'r1' },
    ] },
    { username: 'u2', name: '乙', role: 'student', chy: [
      { day: 7, si: 1, kind: 'test', correct: 10, total: 20, usedSec: 30, at: 2, rd: 'r2' },
    ] },
    { username: 'u3', name: '丙', role: 'student', chy: [
      { day: 7, si: 1, kind: 'test', correct: 5, total: 20, usedSec: 10, at: 3, rd: 'r9' },
    ] },
  ]
  // ⚠️ 沙箱的 window 是普通字面量对象、不是宿主 sandbox 的别名（window !== globalThis），
  //   宿主挂 sb.__rows 后用 window.__rows 读**读不到**；globalThis 才是宿主 sandbox。
  //   故先挂到宿主 sb 上，再在沙箱内用 globalThis 表达式取。（v105/v108 同族坑）
  // ⚠️ 口径：chLbAggregate 的 .map() **不剔除无本视角记录者**（v88 既有行为，v74/v78 测试依赖），
  //   零记录者仍在榜上但 correct=0 / score<=0。故断言按「有效成绩者」判定，而非「是否出现」。
  sandbox.__rowsRef = rows
  const agg = expr => run(expr.replace(/__X__/g, 'globalThis.__rowsRef'))
  const withScore = list => list.filter(x => x.correct > 0)
  setView('dining')
  const topDining = agg('chLbAggregate(__X__)')
  const scoreDining = withScore(topDining)
  assert('★ 饮食部视角 → 有效成绩者 = 甲(r1) + 乙(r2)（丙 r9 无本视角成绩）', scoreDining.length === 2,
    JSON.stringify(topDining.map(x => x.name + ':' + x.correct)))
  assert('饮食部视角含标帜（甲）与艳中（乙）',
    scoreDining.some(x => x.name === '甲') && scoreDining.some(x => x.name === '乙'))
  assert('饮食部视角丙（r9 别期）成绩为 0', topDining.filter(x => x.name === '丙').every(x => x.correct === 0))
  setView('dining/sig')
  const topSig = agg('chLbAggregate(__X__)')
  const scoreSig = withScore(topSig)
  assert('标帜视角 → 有效成绩者仅 r1（甲）', scoreSig.length === 1 && scoreSig[0].name === '甲',
    JSON.stringify(topSig.map(x => x.name + ':' + x.correct)))
  assert('标帜视角乙（r2）成绩为 0', topSig.filter(x => x.name === '乙').every(x => x.correct === 0))
  const topExplicit = agg('chLbAggregate(__X__, "r2")')
  assert('显式传 round="r2" → 有效成绩者仅 r2（乙）',
    withScore(topExplicit).length === 1 && withScore(topExplicit)[0].name === '乙',
    JSON.stringify(topExplicit.map(x => x.name + ':' + x.correct)))

  // ============ 七、入口卡预览 + i18n + 护栏 ============
  console.log('\n=== 七、入口卡预览 / i18n / 源码护栏 ===')
  setView('dining')
  const entryDining = run('challengeEntryHtml()')
  assert('★ 饮食部入口卡：正常卡（可点击）', entryDining.includes("navigate('challenge')")
    && !entryDining.includes(run('t("chDeptNoRound")')))
  assert('★ 饮食部入口卡内嵌下属两期预览', entryDining.includes(R1) && entryDining.includes(R2))
  assert('入口卡预览含分队标签', entryDining.includes('标帜餐厅') && entryDining.includes('艳中餐厅'))
  setView('dining/sig')
  const entrySig = run('challengeEntryHtml()')
  assert('标帜入口卡不含预览块（单期）', !entrySig.includes(run('t("chRoundListTitle", 2)').split('{')[0] || '本部门下设'))
  setView('dining/bar')
  assert('酒吧团队入口卡 → noRound 卡（v109 保持）',
    run('challengeEntryHtml()').includes(run('t("chDeptNoRound")')))

  assert('app.js 有 challengeEntryRoundPreviewHtml', /function challengeEntryRoundPreviewHtml\(\)/.test(appSrc))
  assert('入口卡调用预览函数', /\$\{challengeEntryRoundPreviewHtml\(\)\}/.test(appSrc))
  assert('challenge.js 有 chRoundListForView/chRoundViewSlugs/chRoundListHtml',
    /function chRoundListForView\(\)/.test(chSrc) && /function chRoundViewSlugs\(\)/.test(chSrc)
      && /function chRoundListHtml\(\)/.test(chSrc))
  assert('chNoRoundForDept 改用 chRoundListForView',
    /function chNoRoundForDept\(\)[\s\S]{0,600}?chRoundListForView\(\)/.test(chSrc))
  assert('chEnsureRound 纳入 _chRoundViewLoaded',
    /function chEnsureRound\(\)[\s\S]{0,700}?_chRoundViewLoaded = vk/.test(chSrc))
  assert('重渲染 shape 含 chRoundViewKey',
    /shape:[\s\S]{0,200}?chRoundViewKey\(\)/.test(chSrc))
  assert('zh 有新键', i18nSrc.includes("chRoundUpcomingTag: '未开始'")
    && i18nSrc.includes("chRoundAllDepts: '全部部门'") && i18nSrc.includes('chRoundListTitle:'))
  assert('en 有新键', /chRoundUpcomingTag: 'Upcoming'/.test(i18nSrc)
    && /chRoundAllDepts: 'All departments'/.test(i18nSrc) && /chRoundListTitle:/.test(i18nSrc))

  // ============ 八、回落健壮性（v110 补丁：函数缺失不得吞掉整个回落链）============
  // 背景（本套件开发中真实撞到）：chCurrentRound() 原本是「直接调用 chRoundListForView() + 外层 try」，
  //   当该函数不存在时（部分加载 / 旧缓存片段 / extractFn 沙箱）会抛 ReferenceError 被外层 catch 吞掉，
  //   **整个函数**回落 '第一期'，连后面的侧信道都不再读 → 学员营次莫名变回第一期、题序与存档键全错。
  //   修法：每级回落都先 typeof 守卫。本组用「只注入部分函数」的独立沙箱验证回落链仍然完整。
  console.log('\n=== 八、回落健壮性（chRoundListForView 缺失时仍能读到侧信道）===')
  {
    const CH = chSrc
    const extractFn = (src, name) => {
      const start = src.indexOf('function ' + name)
      if (start < 0) return null
      let i = src.indexOf('{', start), depth = 0
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') { depth--; if (depth === 0) break }
      }
      return src.slice(start, i + 1)
    }
    const mkPartial = () => {
      const sb = {
        console,
        Store: { getSession: () => ({ username: 'alice' }) },
        localStorage: {
          store: {}, getItem(k) { return this.store[k] == null ? null : this.store[k] },
          setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] },
        },
      }
      vm.createContext(sb)
      // 只给侧信道营次，且**不注入** chRoundListForView —— 正是出问题的场景
      vm.runInContext('const CHALLENGE_SEED = 20260915; let CloudSync = { _chRoundCurId: "r2", _chRoundCurName: "艳中餐厅七天挑战第一期" };', sb)
      ;['challengeUid', 'chRoundSlug', 'chDeptKey', 'chRoundRecForDept', 'chCurrentRound', 'chRoundName'].forEach(n => {
        const f = extractFn(CH, n)
        if (f) vm.runInContext(f, sb)
      })
      return sb
    }
    const sb = mkPartial()
    assert('chRoundListForView 确实未注入（场景构造正确）',
      vm.runInContext('typeof chRoundListForView === "undefined"', sb))
    assert('★ chRoundListForView 缺失时 chCurrentRound 仍回落到侧信道（不再变回第一期）',
      vm.runInContext('chCurrentRound()', sb) === 'r2', vm.runInContext('chCurrentRound()', sb))
    assert('★ chRoundListForView 缺失时 chRoundName 仍回落到侧信道',
      vm.runInContext('chRoundName()', sb) === '艳中餐厅七天挑战第一期', vm.runInContext('chRoundName()', sb))
    // 对照：连侧信道都没有 → 才回落 '第一期'
    const sb2 = mkPartial()
    vm.runInContext('CloudSync._chRoundCurId = ""; CloudSync._chRoundCurName = ""', sb2)
    assert('侧信道也为空 → 兜底第一期', vm.runInContext('chCurrentRound()', sb2) === '第一期'
      && vm.runInContext('chRoundName()', sb2) === '第一期')

    // 源码护栏：关键回落点必须是「typeof 守卫」而非裸调用
    assert('chCurrentRound 对 chRoundListForView 加了 typeof 守卫',
      /function chCurrentRound\(\)[\s\S]{0,700}?typeof chRoundListForView === 'function'/.test(chSrc))
    assert('chRoundName 对 chRoundRecForDept / chRoundListForView 加了 typeof 守卫',
      /function chRoundName\(\)[\s\S]{0,500}?typeof chRoundRecForDept === 'function'/.test(chSrc)
        && /function chRoundName\(\)[\s\S]{0,900}?typeof chRoundListForView === 'function'/.test(chSrc))
    assert('chNoRoundForDept 对 chRoundListForView 加了 typeof 守卫',
      /function chNoRoundForDept\(\)[\s\S]{0,900}?typeof chRoundListForView === 'function'/.test(chSrc))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败断言' : '✅ v110 全部断言通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
