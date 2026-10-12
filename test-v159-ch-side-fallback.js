// ====== 测试 v159：营次侧信道「离线兜底」—— 修「七天挑战进度被从头开始」的假象 ======
// 背景（2026-10-12 排查 Cloud / 艳中餐厅）：
//   cloud-store.js 的 _getDoc() 拉取失败**直接 throw**，而 CloudSync._chRounds / _chRoundCurId
//   等营次侧信道**只在成功路径赋值、不做任何持久化**。页面一刷新内存即清空；若此时云端不可达
//   （textdb.dev 托管境外、长期被墙），侧信道恒空 →
//   challenge.js 的 chRoundRecForDept() / chRoundListForView() 因 _chRounds 为 undefined 双双返空 →
//   chCurrentRound() 回落 '第一期' → chStorageKey() 指向**第一期存档键 eq_challenge_v2** →
//   处在非第一期营次的学员（艳中 r2 等）读到第一期（多半是空的）
//   → **表现为「七天挑战进度被从头开始了」**。
//   ⚠️ 这是假象：真进度仍在 eq_challenge_v2_r2 键里，云端恢复后自动回来。
//      标帜(r1)学员因存档键本就是第一期键 → 毫无异常，所以此前只在艳中暴露。
//
// v159 修法：新增 _chSideHydrateFromCache(obj)，在 _getDoc() 入口与 setDeptSlug() 里各调一次，
//   用「上次成功拉取的完整 doc」（成功路径本就在写 eq_cloud_cache）按当前部门重算侧信道兜底。
//   幂等（侧信道非空即跳过），在线成功路径随后原样覆盖 → 在线行为零变化。
//
// 覆盖点：
//   [1] 契约与护栏：hydrate 存在 / 两处接线（且顺序正确）/ 在线赋值路径一字未动 / 同口径
//   [2] 核心兜底：缓存 → 侧信道（分部门命中 / 管理员空部门 / 无匹配部门 → _chNoRound）
//   [3] ★ 反证：不兜底就回落第一期（重演 bug + 端到端「读得到进度 vs 读不到」）
//   [4] 幂等：侧信道已非空 → 不覆盖、返回 false
//   [5] 健壮性：无缓存 / 非法 JSON / 非 doc / 空营次 / null 入参 → false 且不抛、不污染
//   [6] 真实链路：fetch 失败（reject）→ 仍抛错（既有行为不变），但侧信道已被兜底
//   [7] 版本契约：index.html ?v= 恰好 12 处且唯一、不低于 159
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}

const CLOUD = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

// ---- 取函数体（与 v153 同构的括号配平）----
function grabFn(src, name) {
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

// ---- 沙箱：整载 cloud-store.js（拿到真实 CloudSync / _getDoc / setDeptSlug），
//      再注入 challenge.js 的营次解析家族（真实源码），以便端到端断言存档键 ----
function makeSandbox() {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Date, Promise, Set, Map, Boolean,
    AbortController,
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] == null ? null : this.store[k] },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: { addEventListener() {}, visibilityState: 'visible', getElementById() { return null } },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  }
  sb.window = sb
  sb.globalThis = sb
  sb.navigator = { onLine: true }
  sb.fetch = async () => { throw new Error('offline') }
  vm.createContext(sb)
  vm.runInContext(CLOUD + '\n;CloudSync', sb)
  // challenge.js：营次解析家族 + 存档键常量（真源码，不重写）
  const FNS = ['chRoundSlug', 'chRoundViewSlugs', 'chRoundRecForDept', 'chRoundListForView',
    'chCurrentRound', 'chStorageKeyFor', 'chStorageKey', 'chDeptKey']
  FNS.forEach(n => {
    const fn = grabFn(CH, n)
    if (fn) vm.runInContext(fn, sb)
  })
  ;['CHALLENGE_KEY', 'CHALLENGE_KEY_PREFIX'].forEach(n => {
    const m = CH.match(new RegExp('const ' + n + '\\s*=\\s*[^\\n]+'))
    if (m) vm.runInContext(m[0], sb)
  })
  // 学员身份：chDeptKey() 经 sessionDeptSlug()（app.js）→ 沙箱里直接给死值
  vm.runInContext("sessionDeptSlug = () => __DEPT__", sb)
  return sb
}
// 注意：sandbox 里 sessionDeptSlug 用 __DEPT__ 注入（见 setDept）
function setDept(sb, slug) { vm.runInContext('__DEPT__ = ' + JSON.stringify(slug), sb) }
const run = (sb, code) => vm.runInContext(code, sb)

// 云端文档夹具：r1 标帜（全局指针）/ r2 艳中
const DOC = {
  base: { Cloud: { name: '姬小钰', dept: '饮食部·艳中餐厅', chy: [], chQ: {} } },
  events: [],
  chRoundCur: 'r1',
  chRounds: [
    { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, at: 1 },
    { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: true, at: 2 },
  ],
  v: 9,
}
const putCache = (sb, doc) => sb.localStorage.setItem('eq_cloud_cache', JSON.stringify(doc == null ? doc : doc))
// 学员本机真实状态：r2 键里有 Day1 进度；第一期键**故意留空**
const seedProgress = sb => sb.localStorage.setItem('eq_challenge_v2_r2',
  JSON.stringify({ uid: 'Cloud', days: { 1: { stages: { 0: { done: true, at: 111 } } } } }))

;(async () => {
  console.log('\n🧪 v159 营次侧信道「离线兜底」测试')

  // ================= [1] 契约与护栏 =================
  console.log('\n[1] 契约与护栏')
  {
    const iGetDoc = CLOUD.indexOf('async _getDoc() {')
    const iPutDoc = CLOUD.indexOf('async _putDoc(')
    const getDocSrc = CLOUD.slice(iGetDoc, iPutDoc)
    const iHydrateInGetDoc = CLOUD.indexOf('_chSideHydrateFromCache(this)', iGetDoc)
    const iCloudFetch = CLOUD.indexOf("_cloudFetch(CLOUD_SYNC_URL, { cache: 'no-store' })", iGetDoc)
    const hydrateSrc = grabFn(CLOUD, '_chSideHydrateFromCache')
    const iSetDept = CLOUD.indexOf('setDeptSlug(s) {')
    const iHydrateInSetDept = CLOUD.indexOf('_chSideHydrateFromCache(this)', iSetDept)

    assert('_chSideHydrateFromCache 函数存在', !!hydrateSrc)
    assert('★ 兜底调用排在 _getDoc 的 _cloudFetch 之前（失败前就得填好）',
      iHydrateInGetDoc > iGetDoc && iHydrateInGetDoc < iCloudFetch,
      `getDoc=${iGetDoc} hydrate=${iHydrateInGetDoc} fetch=${iCloudFetch}`)
    assert('★ setDeptSlug 内也兜底一次（首屏可能早于任何云端拉取）',
      iHydrateInSetDept > iSetDept && iHydrateInSetDept < iSetDept + 800,
      `setDept=${iSetDept} hydrate=${iHydrateInSetDept}`)
    assert('两处接线都用 typeof 守卫（extractFn 沙箱缺函数时不得抛）',
      (CLOUD.match(/typeof _chSideHydrateFromCache === 'function'/g) || []).length === 2,
      String((CLOUD.match(/typeof _chSideHydrateFromCache === 'function'/g) || []).length))

    // 在线成功路径一字未动（v88 契约）
    assert('在线成功路径未被改动（关键赋值原样保留）',
      getDocSrc.includes('this._chRounds = rounds') &&
      getDocSrc.includes('this._chRoundCurId = curId') &&
      getDocSrc.includes('const cur = _roundCurrentForDept(doc, depSlug)') &&
      getDocSrc.includes('this._chResetModes = lv.chResetModes'))
    assert('红线：challenge.js 一字未动（兜底逻辑不得渗进营次解析家族）',
      !CH.includes('_chSideHydrate') && !CH.includes('_chSideOffline'))

    // 同口径：hydrate 必须与成功路径赋同一组字段（防止以后漂移）
    const FIELDS = ['_chRounds', '_chHasRounds', '_chNoRound', '_chRoundCurId', '_chRoundCurName',
      '_chRoundCurDepts', '_chRoundSeen', '_chExamOpen', '_chOpen', '_chOpenAt', '_chOpenLocked',
      '_chStartAt', '_chEndAt', '_chResets', '_chResetModes']
    const missH = FIELDS.filter(f => !hydrateSrc.includes('obj.' + f + ' ='))
    const missG = FIELDS.filter(f => !getDocSrc.includes('this.' + f + ' ='))
    assert('★ 同口径：hydrate 赋值字段与成功路径完全一致（15 个）', missH.length === 0 && missG.length === 0,
      'hydrate 缺 ' + JSON.stringify(missH) + ' / getDoc 缺 ' + JSON.stringify(missG))
    assert('兜底走同一套结算函数（不自己重写排期/开关口径）',
      hydrateSrc.includes('_roundCurrentForDept(doc, depSlug)') &&
      hydrateSrc.includes('roundOpenState(cur, Date.now())') &&
      hydrateSrc.includes('roundExamState(cur, Date.now(), effOpen)') &&
      hydrateSrc.includes('_roundLevels(doc, curId)'))
    assert('带诊断标记 _chSideOffline（在线成功路径不会置它）',
      hydrateSrc.includes('obj._chSideOffline = true') && !getDocSrc.includes('_chSideOffline'))
  }

  // ================= [2] 核心兜底 =================
  console.log('\n[2] 核心兜底：本机缓存 → 侧信道')
  {
    const sb = makeSandbox()
    putCache(sb, DOC)
    setDept(sb, 'dining/yan')
    run(sb, "CloudSync.setDeptSlug('dining/yan')")
    assert('★ 艳中学员：侧信道指针 = r2（不再回落第一期）',
      run(sb, 'CloudSync._chRoundCurId') === 'r2', run(sb, 'CloudSync._chRoundCurId'))
    assert('营次名 = 艳中餐厅七天挑战第一期',
      run(sb, 'CloudSync._chRoundCurName') === '艳中餐厅七天挑战第一期')
    assert('_chRounds 已填充（2 期全量，chRoundListForView 才有数据可用）',
      run(sb, 'CloudSync._chRounds.length') === 2 && run(sb, 'CloudSync._chHasRounds') === true)
    assert('_chNoRound = false（本部门有营次）', run(sb, 'CloudSync._chNoRound') === false)
    assert('开放态按本机时间结算：r2 open → _chOpen = true', run(sb, 'CloudSync._chOpen') === true)
    assert('诊断标记 _chSideOffline = true', run(sb, 'CloudSync._chSideOffline') === true)
    assert('部门 slug 透传：本部门营次的 depts 落库',
      run(sb, 'CloudSync._chRoundCurDepts').join('+') === 'dining/yan')
  }
  {
    const sb = makeSandbox()
    putCache(sb, DOC)
    setDept(sb, '')
    run(sb, 'CloudSync.setDeptSlug("")')
    assert('管理员/未登录（空部门）：指针原样命中 chRoundCur = r1',
      run(sb, 'CloudSync._chRoundCurId') === 'r1', run(sb, 'CloudSync._chRoundCurId'))
  }
  {
    const sb = makeSandbox()
    putCache(sb, DOC)
    setDept(sb, 'rooms/fd')
    run(sb, "CloudSync.setDeptSlug('rooms/fd')")
    assert('无匹配部门（房务部）：_chRoundCurId = 空 且 _chNoRound = true（走「本部门暂无挑战」卡）',
      run(sb, 'CloudSync._chRoundCurId') === '' && run(sb, 'CloudSync._chNoRound') === true,
      run(sb, 'CloudSync._chRoundCurId') + '/' + run(sb, 'CloudSync._chNoRound'))
    assert('但 _chRounds 仍全量填充（列表卡/看板要能列出全部期）',
      run(sb, 'CloudSync._chRounds.length') === 2)
  }

  // ================= [3] ★ 反证：不兜底就回落第一期 =================
  console.log('\n[3] ★ 反证：同一次「云端不可达 + 页面刷新」下，兜底与否的差别')
  {
    const sb = makeSandbox()
    putCache(sb, DOC)
    seedProgress(sb)
    setDept(sb, 'dining/yan')

    // —— 复现修复前：页面刚刷新，侧信道为空（hydrate 尚未跑 / 旧版本没有 hydrate）——
    run(sb, "CloudSync._chRounds = undefined; CloudSync._chRoundCurId = undefined; CloudSync._chRoundCurName = ''; CloudSync._chHasRounds = false; CloudSync._chNoRound = false")
    assert('反证：侧信道为空时 chCurrentRound() 回落「第一期」',
      run(sb, 'chCurrentRound()') === '第一期', run(sb, 'chCurrentRound()'))
    assert('反证：存档键退化成第一期键 eq_challenge_v2',
      run(sb, 'chStorageKey()') === 'eq_challenge_v2', run(sb, 'chStorageKey()'))
    assert('★ 反证：第一期键是空的 → 学员看到「七天挑战从头开始」（这就是用户报的现象）',
      run(sb, 'localStorage.getItem(chStorageKey())') === null)
    assert('反证：真进度其实还在 r2 键里（数据没丢）',
      !!JSON.parse(sb.localStorage.getItem('eq_challenge_v2_r2')).days['1'])

    // —— 修复生效：兜底一次（等价于 v159 的 _getDoc/setDeptSlug 入口调用）——
    run(sb, '_chSideHydrateFromCache(CloudSync)')
    assert('修复后：chCurrentRound() = r2', run(sb, 'chCurrentRound()') === 'r2', run(sb, 'chCurrentRound()'))
    assert('★ 修复后：存档键 = eq_challenge_v2_r2', run(sb, 'chStorageKey()') === 'eq_challenge_v2_r2',
      run(sb, 'chStorageKey()'))
    assert('★ 修复后：能读到真实的 Day1 进度（「从头开始」的假象消失）',
      (JSON.parse(run(sb, 'localStorage.getItem(chStorageKey())')) || {}).days['1'].stages['0'].done === true)
  }

  // ================= [4] 幂等 =================
  console.log('\n[4] 幂等：绝不覆盖已有的（尤其是在线拉到的）侧信道')
  {
    const sb = makeSandbox()
    putCache(sb, DOC)
    setDept(sb, 'dining/yan')
    run(sb, "CloudSync.setDeptSlug('dining/yan')")       // 首次填充 → r2
    run(sb, "CloudSync._chRoundCurId = 'rZ'; CloudSync._chOpen = false")   // 模拟在线拉到的新状态
    const again = run(sb, '_chSideHydrateFromCache(CloudSync)')
    assert('侧信道已非空 → 返回 false（跳过）', again === false, String(again))
    assert('★ 不覆盖已有值（在线结果优先）',
      run(sb, 'CloudSync._chRoundCurId') === 'rZ' && run(sb, 'CloudSync._chOpen') === false)
    assert('再次调 setDeptSlug 也不覆盖',
      (run(sb, "CloudSync.setDeptSlug('dining/yan'), CloudSync._chRoundCurId") === 'rZ'))
  }

  // ================= [5] 健壮性 =================
  console.log('\n[5] 健壮性：降级路径一律安全返回，不抛、不污染')
  {
    const bad = []
    // 无缓存
    { const sb = makeSandbox(); setDept(sb, 'dining/yan')
      if (run(sb, '_chSideHydrateFromCache(CloudSync)') !== false || run(sb, 'CloudSync._chRounds') !== undefined) bad.push('无缓存') }
    // 非法 JSON
    { const sb = makeSandbox(); sb.localStorage.setItem('eq_cloud_cache', '{bad json'); setDept(sb, 'dining/yan')
      if (run(sb, '_chSideHydrateFromCache(CloudSync)') !== false || run(sb, 'CloudSync._chRounds') !== undefined) bad.push('非法JSON') }
    // 非 doc（无 events）
    { const sb = makeSandbox(); putCache(sb, { a: 1 }); setDept(sb, 'dining/yan')
      if (run(sb, '_chSideHydrateFromCache(CloudSync)') !== false) bad.push('无events') }
    // 空营次
    { const sb = makeSandbox(); putCache(sb, { events: [], chRounds: [] }); setDept(sb, 'dining/yan')
      if (run(sb, '_chSideHydrateFromCache(CloudSync)') !== false || run(sb, 'CloudSync._chRounds') !== undefined) bad.push('空营次') }
    // null / undefined 入参
    { const sb = makeSandbox()
      if (run(sb, '_chSideHydrateFromCache(null)') !== false || run(sb, '_chSideHydrateFromCache()') !== false) bad.push('null入参') }
    assert('全部降级路径返回 false 且不污染侧信道', bad.length === 0, bad.join(', '))
  }

  // ================= [6] 真实链路：_getDoc 失败 =================
  console.log('\n[6] 真实链路：云端不可达（fetch reject）时')
  {
    const sb = makeSandbox()
    putCache(sb, DOC)
    seedProgress(sb)
    // 绕过 setDeptSlug 直接设部门 → 只让 _getDoc 入口那处兜底生效（验证接线，而非巧合）
    run(sb, "CloudSync._deptSlug = 'dining/yan'")
    assert('前置：兜底前侧信道还是空的', run(sb, 'CloudSync._chRounds') === undefined)
    const res = await run(sb, "CloudSync._getDoc().then(() => 'ok').catch(() => 'err')")
    assert('既有行为不变：拉不到时 _getDoc 依然抛错（调用方的 offline 分支照旧）', res === 'err', res)
    assert('★ 但侧信道已被入口兜底填上：_chRoundCurId = r2',
      run(sb, 'CloudSync._chRoundCurId') === 'r2', run(sb, 'CloudSync._chRoundCurId'))
    assert('★ 挑战存档键仍指向本部门那一期（不再假清零）',
      run(sb, 'chStorageKey()') === 'eq_challenge_v2_r2', run(sb, 'chStorageKey()'))
  }

  // ================= [7] 版本契约 =================
  console.log('\n[7] 版本契约：index.html 的 ?v=')
  {
    const vers = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
    const uniq = [...new Set(vers)]
    assert('恰好 12 处', vers.length === 12, '实得 ' + vers.length)
    assert('取值唯一', uniq.length === 1, uniq.join(','))
    assert('不低于 159（弹性断言：bump 不会咬）', uniq[0] >= 159, String(uniq[0]))
    assert('所有 ?v= 均不低于当前值（无旧值残留）', vers.every(v => v >= uniq[0]), JSON.stringify(vers))
  }

  console.log('')
  if (testFailed) { console.log('❌ v159 测试失败'); process.exit(1) }
  console.log('✅ v159 测试全部通过')
})()
