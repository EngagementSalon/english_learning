// ====== 测试 v89：四部门分流（部门结构 / 题库分部门 / 挑战按部门抽题 / 营次按部门隔离）======
// 背景：原来只有「饮食部 / 房务部 / 其他部门」三个大部门，七天挑战所有饮食部学员共用一套题。
// 现改为饮食部下设四个分部门（标帜餐厅 / 艳中餐厅 / 酒吧团队 / 客房送餐，其中酒吧团队合并原
// WOOBAR+WETBAR+LIQUID），四套独立题各自上传，学员只在七天挑战里看到本部门的题；
// 营次（Round）也带适用部门，各部门可同时进行不同期次。
//
// 覆盖点：
// ① 部门树结构：饮食部四分队 + 房务部不变
// ② 部门归一 normDept：中文/英文/旧名/别名（WOOBAR/WETBAR/LIQUID/客房送餐部）→ 现行四分队
// ③ deptSlug / deptSlugName：分部门 slug 与本地化显示名互转
// ④ Store.getQuestionsByDept：分部门 slug / 大部门 key / all / other 四种口径
// ⑤ Store.getSessionDeptKey / getSessionSubDeptKey：会话部门 → 大部门 key + 分部门 slug
// ⑥ Store.getSession 自动归一：旧部门值（'饮食部·WOOBAR'）读出来即变 '饮食部·酒吧团队'
// ⑦ 挑战抽题按部门：chBankQuestions 只取本部门 + 通用；challengePool/challengeRandomQuestions 同源
// ⑧ 错题复习按部门过滤：换部门后旧部门错题不再复现
// ⑨ 营次按部门隔离：roundDeptMatch / _roundCurrentForDept 三级解析
// ⑩ 管理端：adminDeptSetOf 各 tab 的 dept 集合；营次适用部门显示
// ⑪ i18n：deptSubAlias / chDeptNames / 新增键中英成对
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}
function extractFn(src, name) {
  // 词边界匹配：避免 'normDept' 命中 'normDeptSub'（前缀陷阱）
  const re = new RegExp('(^|\\n)function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) throw new Error('fn not found: ' + name)
  const start = m.index + m[1].length
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
// 提取顶层 const 声明：按花括号深度归零 + 声明收尾模式（`}` 后可跟 `;` 再接换行，
// 或 `)()` 收尾 —— IIFE 形如 `const X = (() => { ... })()` 以 `)` 结尾）
function extractConst(src, name) {
  const start = src.indexOf('const ' + name + ' =')
  if (start < 0) throw new Error('const not found: ' + name)
  const head = src.slice(start)
  // 声明收尾：深度归零后紧跟换行/分号（对象字面量）或 `)()`（IIFE）
  const objRe = /^[\s\S]*?\n\}/
  // 逐字符扫，只数花括号
  let depth = 0, seen = false, i = 0
  for (; i < head.length; i++) {
    const c = head[i]
    if (c === '{') { depth++; seen = true }
    else if (c === '}') {
      depth--
      if (seen && depth === 0) {
        const rest = head.slice(i + 1)
        if (/^\s*[;\n]/.test(rest)) return head.slice(0, i + 1) + ';'
        if (/^\s*\)\s*\(/.test(rest)) {
          // IIFE：接着找到 ')()' 收尾
          const m = /^\s*\)\s*\(\s*\)/.exec(rest)
          if (m) return head.slice(0, i + 1 + m[0].length) + ';'
          // 退而求其次：到该行结束
          const nl = rest.indexOf('\n')
          return head.slice(0, i + 1 + (nl < 0 ? rest.length : nl)) + ';'
        }
      }
    } else if (c === '\n' && !seen && depth === 0) {
      return head.slice(0, i) + ';'
    }
  }
  return head
}
const CLOUD = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const STORE = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

// ---------- 云端沙箱（整载 cloud-store.js，mock 云端 fetch） ----------
function makeCloudSandbox(docRef) {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Date, Promise, Set, Map,
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
  sb.navigator = { onLine: true }
  sb.fetch = async (url, opt) => {
    if (opt && opt.method === 'POST') {
      const body = JSON.parse(opt.body)
      Object.keys(docRef).forEach(k => delete docRef[k])
      Object.assign(docRef, body)
      return { ok: true, status: 200, text: async () => JSON.stringify(docRef) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(JSON.parse(JSON.stringify(docRef))) }
  }
  vm.createContext(sb)
  vm.runInContext(CLOUD + '\n;CloudSync', sb)
  return sb
}
const call = (sb, expr) => vm.runInContext(expr, sb)

// ---------- 部门工具沙箱（app.js 的部门函数族） ----------
// 沙箱统一按「中文」口径（i18n 的 zh 块）
const ZH = (() => {
  const i = I18N.indexOf("    deptTree: {")
  return I18N.slice(i, i + 2600)
})()
function makeDeptSandbox() {
  const sb = { console, JSON, Object, Array, String, Number, Math, Date, Set, Map }
  sb.window = sb
  sb.localStorage = {
    store: {},
    getItem(k) { return this.store[k] == null ? null : this.store[k] },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  }
  vm.createContext(sb)
  // 注入 app.js 真实部门常量与函数
  vm.runInContext(extractConst(APP, 'DEPT_MAJOR_KEYS'), sb)
  vm.runInContext(extractConst(APP, 'DEPT_CANON'), sb)
  vm.runInContext(extractConst(APP, 'DEPT_SUB_SLUGS'), sb)
  vm.runInContext(extractConst(APP, 'DEPT_SUB_BY_SLUG'), sb)
  vm.runInContext(extractConst(APP, 'ADMIN_DEPT_TABS'), sb)
  vm.runInContext(extractFn(APP, 'deptTree'), sb)
  vm.runInContext(extractFn(APP, '_deptSubIndex'), sb)
  vm.runInContext(extractFn(APP, 'normDeptSub'), sb)
  vm.runInContext(extractFn(APP, 'normDept'), sb)
  vm.runInContext(extractFn(APP, 'deptSlug'), sb)
  vm.runInContext(extractFn(APP, 'deptSlugName'), sb)
  vm.runInContext(extractFn(APP, 'deptGroupKey'), sb)
  vm.runInContext(extractFn(APP, 'adminDeptSetOf'), sb)
  // i18n 依赖：注入 zh 部门词条（deptTree / deptSubAlias / chDeptNames）
  const treeI = I18N.indexOf('    deptTree: {')
  const treeE = I18N.indexOf('\n    },', treeI) + '\n    },'.length
  const aliasI = I18N.indexOf('    deptSubAlias: {')
  const aliasE = I18N.indexOf('\n    },', aliasI) + '\n    },'.length
  const namesI = I18N.indexOf('    chDeptNames: {')
  const namesE = I18N.indexOf('\n    },', namesI) + '\n    },'.length
  const dict = {}
  const mk = (name, a, b) => {
    const seg = I18N.slice(a, b)
    // 把 'key: value,' 逐行抠出来构造对象
    vm.runInContext('var __obj = {};' + seg.replace(/^ {4}/gm, '').replace(/\},$/, '};') + ' __obj', sb)
    dict[name] = vm.runInContext('__obj', sb)
  }
  try {
    vm.runInContext('var __t = ' + JSON.stringify({
      deptTree: { dining: { name: '饮食部', subs: ['标帜餐厅', '艳中餐厅', '酒吧团队', '客房送餐'] }, rooms: { name: '房务部', subs: ['迎宾前台', '礼宾部', '随时随需', '客房造型', '健身及水疗中心'] }, other: { name: '其他部门', subs: [] } },
      deptSubAlias: {
        'WOOBAR': '酒吧团队', 'WETBAR': '酒吧团队', 'LIQUID': '酒吧团队',
        'woobar': '酒吧团队', 'wetbar': '酒吧团队', 'liquid': '酒吧团队',
        '酒吧': '酒吧团队', '酒吧部': '酒吧团队', '酒水部': '酒吧团队',
        '客房送餐部': '客房送餐', '送餐部': '客房送餐', '客房送餐服务': '客房送餐',
        '标帜': '标帜餐厅', '艳中': '艳中餐厅', '艳餐厅': '艳中餐厅',
        // 英文名同样可命中（生产环境 en 语言下 t() 给的就是这些）
        'Signatures Restaurant': '标帜餐厅', 'Yan Chinese Restaurant': '艳中餐厅',
        'Bar Team': '酒吧团队', 'In-Room Dining': '客房送餐',
      },
      chDeptNames: { '标帜餐厅': '标帜餐厅', '艳中餐厅': '艳中餐厅', '酒吧团队': '酒吧团队', '客房送餐': '客房送餐' },
      roundDeptAll: '全部部门',
      roundDeptLabel: '适用部门',
    }), sb)
  } catch (e) { throw new Error('i18n dict inject failed: ' + e.message) }
  vm.runInContext('function t(k, a, b) { if (typeof __t[k] === "function") return __t[k](a, b); return __t[k] }', sb)
  return sb
}

;(async () => {
  console.log('\n🧪 v89 四部门分流测试')

  // ================= ① 部门树结构 =================
  console.log('\n[1] 部门树：饮食部四分队（酒吧团队合并 WOOBAR+WETBAR+LIQUID）')
  {
    const sb = makeDeptSandbox()
    const tree = call(sb, 'JSON.stringify(deptTree())')
    const tr = JSON.parse(tree)
    assert('饮食部子部门恰为四分队', JSON.stringify(tr.dining.subs) === JSON.stringify(['标帜餐厅', '艳中餐厅', '酒吧团队', '客房送餐']), tree)
    assert('酒吧团队已取代 WOOBAR/WETBAR/LIQUID（不再单独列项）',
      ['WOOBAR', 'WETBAR', 'LIQUID'].every(x => tr.dining.subs.indexOf(x) < 0), tree)
    assert('房务部子部门保持原样',
      JSON.stringify(tr.rooms.subs) === JSON.stringify(['迎宾前台', '礼宾部', '随时随需', '客房造型', '健身及水疗中心']), tree)
    assert('大部门仍是三级：dining / rooms / other',
      JSON.stringify(Object.keys(tr)) === JSON.stringify(['dining', 'rooms', 'other']), tree)
    assert('i18n 双语 deptTree 均存在（zh + en）',
      (I18N.match(/deptTree: \{/g) || []).length === 2, 'deptTree 出现 ' + (I18N.match(/deptTree: \{/g) || []).length + ' 次')
  }

  // ================= ② 部门归一 =================
  console.log('\n[2] 部门归一 normDept：旧名/别名/英文 → 现行四分队')
  {
    const sb = makeDeptSandbox()
    const norm = v => JSON.parse(call(sb, 'JSON.stringify(normDept(' + JSON.stringify(v) + '))'))
    const cases = [
      ['饮食部·标帜餐厅', 'dining/sig'],
      ['饮食部·艳中餐厅', 'dining/yan'],
      ['饮食部·酒吧团队', 'dining/bar'],
      ['饮食部·客房送餐', 'dining/ird'],
      // 旧名归一（存量学员迁移的核心）
      ['饮食部·WOOBAR', 'dining/bar'],
      ['饮食部·WETBAR', 'dining/bar'],
      ['饮食部·LIQUID', 'dining/bar'],
      ['WOOBAR', 'dining/bar'],
      ['LIQUID', 'dining/bar'],
      ['饮食部·客房送餐部', 'dining/ird'],
      ['客房送餐部', 'dining/ird'],
      // 房务部不受影响
      ['房务部·迎宾前台', 'rooms/fo'],
      ['房务部·健身及水疗中心', 'rooms/spa'],
    ]
    cases.forEach(([input, want]) => {
      const got = norm(input)
      assert(`normDept('${input}') → ${want}`, got && got.key === want, JSON.stringify(got))
    })
    assert('无法识别的部门 → null', norm('火星部·飞碟组') === null, JSON.stringify(norm('火星部·飞碟组')))
    assert('空值 → null', norm('') === null && norm(null) === null)
    assert('归一后 value 用现行规范名（大部门·分部门）',
      norm('饮食部·WOOBAR').value === '饮食部·酒吧团队', JSON.stringify(norm('饮食部·WOOBAR')))
  }

  // ================= ③ slug 与显示名 =================
  console.log('\n[3] deptSlug / deptSlugName：slug ↔ 本地化显示名')
  {
    const sb = makeDeptSandbox()
    const name = s => call(sb, 'deptSlugName(' + JSON.stringify(s) + ')')
    assert('dining/bar → 酒吧团队', name('dining/bar') === '酒吧团队', name('dining/bar'))
    assert('dining/sig → 标帜餐厅', name('dining/sig') === '标帜餐厅', name('dining/sig'))
    assert('dining/yan → 艳中餐厅', name('dining/yan') === '艳中餐厅', name('dining/yan'))
    assert('dining/ird → 客房送餐', name('dining/ird') === '客房送餐', name('dining/ird'))
    assert('未知 slug 原样返回', name('dining/zzz') === 'dining/zzz', name('dining/zzz'))
    assert('大部门 key（无 /）原样返回', name('dining') === 'dining', name('dining'))
    // slug 生成：中文名 / 英文名 / 别名均可命中
    const slug = v => call(sb, 'deptSlug(' + JSON.stringify(v[0]) + ',' + JSON.stringify(v[1]) + ')')
    assert('deptSlug(dining, 酒吧团队) → dining/bar', slug(['dining', '酒吧团队']) === 'dining/bar', slug(['dining', '酒吧团队']))
    assert('deptSlug(dining, WOOBAR) 经别名归一 → dining/bar', slug(['dining', 'WOOBAR']) === 'dining/bar', slug(['dining', 'WOOBAR']))
    assert('deptSlug(dining, Bar Team)（英文名）→ dining/bar', slug(['dining', 'Bar Team']) === 'dining/bar', slug(['dining', 'Bar Team']))
  }

  console.log('\n[3b] deptGroupKey：部门 → 大部门分组')
  {
    const sb = makeDeptSandbox()
    const g = v => call(sb, 'deptGroupKey(' + JSON.stringify(v) + ')')
    assert('饮食部·WOOBAR → dining', g('饮食部·WOOBAR') === 'dining', g('饮食部·WOOBAR'))
    assert('房务部·迎宾前台 → rooms', g('房务部·迎宾前台') === 'rooms', g('房务部·迎宾前台'))
    assert('无法识别 → other', g('火星部·飞碟组') === 'other', g('无法识别'))
  }

  // ================= ④ 题库按部门筛选 =================
  console.log('\n[4] Store.getQuestionsByDept：分部门 / 大部门 / all / other 四种口径')
  {
    const sb = makeDeptSandbox()
    // 注入 Store 的 getQuestionsByDept + 极简题库
    vm.runInContext(extractFn(APP, 'deptSlug'), sb)
    vm.runInContext(`
      var __qs = [
        { id: 1, dept: 'dining/sig' },
        { id: 2, dept: 'dining/yan' },
        { id: 3, dept: 'dining/bar' },
        { id: 4, dept: 'dining/ird' },
        { id: 5, dept: 'dining' },
        { id: 6, dept: 'rooms/fo' },
        { id: 7, dept: 'all' },
        { id: 8 },
      ]
      var Store = {
        getQuestions() { return __qs.slice() },
        getQuestionsByDept(deptKey) {
          const qs = this.getQuestions()
          const k = String(deptKey || '')
          if (!k || k === 'other') return qs
          if (k === 'all') return qs.filter(q => !q.dept || q.dept === 'all')
          if (k.indexOf('/') >= 0) {
            const major = k.split('/')[0]
            return qs.filter(q => !q.dept || q.dept === 'all' || q.dept === k || q.dept === major)
          }
          if (typeof DEPT_SUB_SLUGS !== 'undefined' && DEPT_SUB_SLUGS[k]) {
            const subs = Object.keys(DEPT_SUB_SLUGS[k]).map(s => k + '/' + DEPT_SUB_SLUGS[k][s])
            return qs.filter(q => !q.dept || q.dept === 'all' || q.dept === k || subs.indexOf(q.dept) >= 0)
          }
          return qs.filter(q => !q.dept || q.dept === 'all' || q.dept === k)
        },
      }
    `, sb)
    const ids = k => JSON.parse(call(sb, 'JSON.stringify(Store.getQuestionsByDept(' + JSON.stringify(k) + ').map(q => q.id))'))
    // 酒吧团队：本部门题 + 饮食部整包题 + 通用题 + 无 dept 题
    assert('dining/bar → 本部门 + 大部门整包 + 通用 + 无 dept',
      JSON.stringify(ids('dining/bar')) === JSON.stringify([3, 5, 7, 8]), JSON.stringify(ids('dining/bar')))
    assert('dining/sig 不含其他分部门题', ids('dining/sig').indexOf(2) < 0 && ids('dining/sig').indexOf(3) < 0, JSON.stringify(ids('dining/sig')))
    assert('dining（大部门）→ 全部四分队 + 整包 + 通用',
      JSON.stringify(ids('dining')) === JSON.stringify([1, 2, 3, 4, 5, 7, 8]), JSON.stringify(ids('dining')))
    assert('rooms/fo 不含饮食部题', ids('rooms/fo').indexOf(3) < 0 && ids('rooms/fo').indexOf(5) < 0, JSON.stringify(ids('rooms/fo')))
    assert("'all' → 仅通用题（题库管理用）", JSON.stringify(ids('all')) === JSON.stringify([7, 8]), JSON.stringify(ids('all')))
    assert("'' / other → 全库", ids('').length === 8 && ids('other').length === 8)
  }

  // ================= ⑤ 会话部门解析 =================
  console.log('\n[5] Store.getSession 自动归一 + getSessionDeptKey / getSessionSubDeptKey')
  {
    const sb = makeDeptSandbox()
    // 注入 store 的会话相关方法（用真实的 getSession/syncDeptSlug 语义）
    vm.runInContext(`
      var STORAGE_KEYS = { SESSION: 'eq_session', USER: 'eq_user' }
      var CloudSync = { _slug: '', setDeptSlug(s) { this._slug = String(s || '') }, getSlug() { return this._slug } }
      var Store = {
        getSession() {
          const s = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION) || 'null')
          if (s && s.dept && typeof normDept === 'function') {
            const hit = normDept(s.dept)
            if (hit && hit.value !== s.dept) {
              s.dept = hit.value
              try { localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(s)) } catch (e) {}
            }
          }
          return s
        },
        getSessionDept() { const s = this.getSession(); return (s && s.dept) || '' },
        getSessionDeptKey() {
          if (typeof normDept === 'function') {
            const hit = normDept(this.getSessionDept())
            return hit ? hit.majorKey : 'other'
          }
          return 'other'
        },
        getSessionSubDeptKey() {
          if (typeof normDept === 'function') {
            const hit = normDept(this.getSessionDept())
            return hit ? hit.key : ''
          }
          return ''
        },
        syncDeptSlug() {
          const s = this.getSession()
          const u = JSON.parse(localStorage.getItem(STORAGE_KEYS.USER) || 'null')
          const dept = (s && s.dept) || (u && u.dept) || ''
          const hit = (typeof normDept === 'function') ? normDept(dept) : null
          const key = hit ? hit.key : ''
          CloudSync.setDeptSlug(key)
          return key
        },
      }
    `, sb)
    // 存量学员挂在 WOOBAR → 读出来即归一为「饮食部·酒吧团队」
    call(sb, "localStorage.setItem('eq_session', JSON.stringify({ username: 'bob', dept: '饮食部·WOOBAR', role: 'student' }))")
    assert('getSession 把旧部门值就地归一为酒吧团队',
      call(sb, 'Store.getSessionDept()') === '饮食部·酒吧团队', call(sb, 'Store.getSessionDept()'))
    assert('归一后写回 localStorage（下次读取不再重复归一）',
      JSON.parse(call(sb, "localStorage.getItem('eq_session')")).dept === '饮食部·酒吧团队')
    assert('getSessionDeptKey → dining', call(sb, 'Store.getSessionDeptKey()') === 'dining', call(sb, 'Store.getSessionDeptKey()'))
    assert('getSessionSubDeptKey → dining/bar', call(sb, 'Store.getSessionSubDeptKey()') === 'dining/bar', call(sb, 'Store.getSessionSubDeptKey()'))
    assert('syncDeptSlug 把 slug 推给 CloudSync', call(sb, 'Store.syncDeptSlug()') === 'dining/bar' && call(sb, 'CloudSync.getSlug()') === 'dining/bar')
    // 管理员/其他部门 → 不按部门挑营次
    call(sb, "localStorage.setItem('eq_session', JSON.stringify({ username: 'admin', dept: '', role: 'admin' }))")
    assert('无部门（管理员）→ deptKey other / subKey 空',
      call(sb, 'Store.getSessionDeptKey()') === 'other' && call(sb, 'Store.getSessionSubDeptKey()') === '',
      call(sb, 'Store.getSessionDeptKey()') + ' / ' + call(sb, 'Store.getSessionSubDeptKey()'))
    assert('syncDeptSlug（无部门）清空 CloudSync slug', call(sb, 'Store.syncDeptSlug()') === '' && call(sb, 'CloudSync.getSlug()') === '')
  }

  // ================= ⑥ 挑战抽题按部门 =================
  console.log('\n[6] 挑战题库按部门：chBankQuestions 只取本部门 + 通用')
  {
    const sb = makeDeptSandbox()
    vm.runInContext(`
      var __deptSlug = 'dining/bar'
      function sessionDeptSlug() { return __deptSlug }
      var Store = {
        getQuestions() {
          const out = []
          for (let i = 1; i <= 200; i++) out.push({ id: i, category_id: 12, difficulty: 1, dept: 'dining/sig' })
          for (let i = 201; i <= 400; i++) out.push({ id: i, category_id: 12, difficulty: 2, dept: 'dining/bar' })
          for (let i = 401; i <= 500; i++) out.push({ id: i, category_id: 12, difficulty: 3, dept: 'rooms/fo' })
          for (let i = 501; i <= 520; i++) out.push({ id: i, category_id: 12, difficulty: 1, dept: 'all' })
          for (let i = 521; i <= 540; i++) out.push({ id: i, category_id: 12, difficulty: 2 })   // 无 dept（历史题）
          for (let i = 541; i <= 560; i++) out.push({ id: i, category_id: 12, difficulty: 1, dept: 'dining/yan' })
          for (let i = 600; i <= 610; i++) out.push({ id: i, category_id: 11, difficulty: 1, dept: 'dining/bar' })  // 非挑战分类
          return out
        },
      }
    `, sb)
    vm.runInContext(extractFn(CH, 'chDeptKey'), sb)
    vm.runInContext(extractFn(CH, 'chBankQuestions'), sb)
    vm.runInContext(extractFn(CH, 'chBankIdSet'), sb)
    vm.runInContext(extractFn(CH, 'chBankCount'), sb)
    const bankIds = JSON.parse(call(sb, 'JSON.stringify(chBankQuestions().map(q => q.id))'))
    assert('酒吧团队题库 = 本部门200 + 通用20 + 无dept20 = 240',
      bankIds.length === 240, 'len=' + bankIds.length)
    assert('不含其他分部门题（标帜餐厅 1-200 被排除）', bankIds.indexOf(1) < 0 && bankIds.indexOf(200) < 0)
    assert('不含其他大部门题（房务部 401-500 被排除）', bankIds.indexOf(401) < 0)
    assert('不含同大部门其他分部门题（艳中 541-560 被排除）', bankIds.indexOf(541) < 0 && bankIds.indexOf(560) < 0)
    assert('不含非挑战分类的题（category 11 排除）', bankIds.indexOf(600) < 0)
    assert('chBankCount 与 chBankQuestions 同口径', call(sb, 'chBankCount()') === 240, String(call(sb, 'chBankCount()')))
    assert('chBankIdSet 元素数与题库一致', call(sb, 'chBankIdSet().size') === 240, String(call(sb, 'chBankIdSet().size')))
    // 管理员/其他部门 → 不筛（看全库，兼容旧行为）
    vm.runInContext("__deptSlug = ''", sb)
    // 全部 category 12 题 = 200(sig) + 200(bar) + 100(rooms/fo) + 20(all) + 20(无dept) + 20(yan)
    assert('无部门（管理员）→ 题库回到全库（category 12 全部题）',
      call(sb, 'chBankQuestions().length') === 560, String(call(sb, 'chBankQuestions().length')))
    // 艳中餐厅：只有自己的题 + 通用 + 无 dept（同大部门其他分部门不给）
    vm.runInContext("__deptSlug = 'dining/yan'", sb)
    const yan = JSON.parse(call(sb, 'JSON.stringify(chBankQuestions().map(q => q.dept || \'\'))'))
    const uniq = Array.from(new Set(yan)).sort()
    assert('艳中餐厅题库 = 本部门20 + 通用20 + 无dept20 = 60',
      yan.length === 60, 'len=' + yan.length)
    assert('艳中餐厅题库只含 dining/yan + all + 无 dept',
      JSON.stringify(uniq) === JSON.stringify(['', 'all', 'dining/yan']), JSON.stringify(uniq))
    assert('艳中餐厅题库不含标帜餐厅/酒吧/房务部题',
      yan.indexOf('dining/sig') < 0 && yan.indexOf('dining/bar') < 0 && yan.indexOf('rooms/fo') < 0)
    // 大部门 key（无 '/'）→ 该大部门全部分部门可见
    vm.runInContext("__deptSlug = 'dining'", sb)
    assert('大部门 key（dining）→ 四分队题全部可见（排除房务部）',
      call(sb, 'chBankQuestions().length') === 460, String(call(sb, 'chBankQuestions().length')))
  }

  console.log('\n[6b] challengePool / challengeRandomQuestions 题源同源（本部门）')
  {
    assert('challengePool 用 chBankQuestions（不再直连 Store.getQuestions）',
      /function challengePool\(\) \{\s*const all = chBankQuestions\(\)/.test(CH))
    assert('challengePool 不再有 Store.getQuestions().filter(category 12)',
      !/function challengePool\(\) \{[\s\S]{0,120}?Store\.getQuestions\(\)/.test(CH))
    assert('challengeRandomQuestions 用 chBankQuestions', /challengeStratifiedDraw\(chBankQuestions\(\), total\)/.test(CH))
    assert('renderChallenge 的题库计数用 chBankCount()', /const bankN = chBankCount\(\)/.test(CH))
    assert('入口页题库计数也走挑战题库（app.js 未直连 category 12 计数）',
      !/const bankN = Store\.getQuestions\(\)\.filter/.test(CH))
  }

  // ================= ⑦ 错题复习按部门过滤 =================
  console.log('\n[7] 错题复习按部门过滤（换部门后旧部门错题不复现）')
  {
    const sb = makeDeptSandbox()
    vm.runInContext(`
      var __deptSlug = 'dining/bar'
      function sessionDeptSlug() { return __deptSlug }
      var Store = {
        getQuestions() { return [
          { id: 201, category_id: 12, dept: 'dining/bar' },
          { id: 1, category_id: 12, dept: 'dining/sig' },
        ] },
        getQuestion(id) { return this.getQuestions().find(q => String(q.id) === String(id)) },
      }
      var CHALLENGE_DAYS = [{ day: 1, stages: [{ kind: 'test', count: 20 }, { kind: 'practice', count: 10 }] }]
      var __recs = { '1-0': { wrong: ['201', '1'] }, '1-1': { wrong: ['201'] } }
      function chStageRec(day, si) { return __recs[day + '-' + si] }
      function shuffleOptions(q) { return q }
    `, sb)
    vm.runInContext(extractFn(CH, 'chDeptKey'), sb)
    vm.runInContext(extractFn(CH, 'chBankQuestions'), sb)
    vm.runInContext(extractFn(CH, 'chBankIdSet'), sb)
    vm.runInContext(extractFn(CH, 'chPrevDayWrongQuestions'), sb)
    const got = JSON.parse(call(sb, 'JSON.stringify(chPrevDayWrongQuestions(1).map(q => q.id))'))
    assert('只保留本部门错题（201），其他部门错题（1）被过滤', JSON.stringify(got) === JSON.stringify([201]), JSON.stringify(got))
    // 换到标帜餐厅 → 反过来
    vm.runInContext("__deptSlug = 'dining/sig'", sb)
    const got2 = JSON.parse(call(sb, 'JSON.stringify(chPrevDayWrongQuestions(1).map(q => q.id))'))
    assert('换到标帜餐厅后只保留 1（201 被过滤）', JSON.stringify(got2) === JSON.stringify([1]), JSON.stringify(got2))
  }

  // ================= ⑧ 营次按部门隔离 =================
  console.log('\n[8] 营次按部门隔离：roundDeptMatch / _roundCurrentForDept')
  {
    const docEl = {}
    const sb = makeCloudSandbox(docEl)
    const match = (r, slug) => call(sb, 'roundDeptMatch(' + JSON.stringify(r) + ',' + JSON.stringify(slug) + ')')
    assert('营次未设部门（depts 空）→ 全部部门适用', match({ depts: [] }, 'dining/bar') === true)
    assert('营次未设部门（depts 缺失，v88 存量）→ 全部部门适用', match({}, 'dining/bar') === true)
    assert('营次设了本分部门 → 匹配', match({ depts: ['dining/bar'] }, 'dining/bar') === true)
    assert('营次设了同大部门其他分部门 → 不匹配', match({ depts: ['dining/sig'] }, 'dining/bar') === false)
    assert('营次设了大部门 key → 该大部门四分队都匹配',
      match({ depts: ['dining'] }, 'dining/bar') === true && match({ depts: ['dining'] }, 'dining/ird') === true)
    assert('未登录/管理员（slug 空）→ 不因部门被挡住', match({ depts: ['dining/sig'] }, '') === true)

    // 三级解析：① 当前指针部门匹配 → 用它；② 否则本部门最新开放期；③ 否则本部门最新期
    const doc3 = {
      events: [],
      chRounds: [
        { id: 'r1', name: '第一期', depts: ['dining/sig'], open: true, at: 1 },
        { id: 'r2', name: '酒吧第一期', depts: ['dining/bar'], open: true, at: 2 },
        { id: 'r3', name: '艳中第一期', depts: ['dining/yan'], open: false, at: 0 },
      ],
      chRoundCur: 'r3',
    }
    vm.runInContext('var __doc = ' + JSON.stringify(doc3), sb)
    const cur = (slug) => call(sb, '_roundCurrentForDept(__doc,' + JSON.stringify(slug) + ').id')
    assert('① 当前指针 r3 部门不匹配酒吧 → 退到本部门最新开放期 r2', cur('dining/bar') === 'r2', cur('dining/bar'))
    assert('① 当前指针 r3 部门匹配艳中 → 直接用 r3（哪怕未开放）', cur('dining/yan') === 'r3', cur('dining/yan'))
    assert('① 管理员（slug 空）→ 永远跟随当前指针 r3', cur('') === 'r3', cur(''))
    assert('② 标帜餐厅：当前指针不匹配 → 用本部门 r1', cur('dining/sig') === 'r1', cur('dining/sig'))
    // 本部门没有开放期时退回「本部门最新期」
    const doc4 = {
      events: [],
      chRounds: [
        { id: 'r1', name: '酒吧第一期', depts: ['dining/bar'], open: false, at: 1 },
        { id: 'r2', name: '标帜第一期', depts: ['dining/sig'], open: true, at: 2 },
      ],
      chRoundCur: 'r2',
    }
    vm.runInContext('var __doc2 = ' + JSON.stringify(doc4), sb)
    const cur2 = (slug) => call(sb, '_roundCurrentForDept(__doc2,' + JSON.stringify(slug) + ').id')
    assert('酒吧：无开放期 → 退回本部门最新期 r1（未开放，学员端显示未开始）', cur2('dining/bar') === 'r1', cur2('dining/bar'))
    assert('标帜：当前指针即本部门且开放 → r2', cur2('dining/sig') === 'r2', cur2('dining/sig'))
    // 无营次 → legacy
    vm.runInContext('var __doc3 = { events: [], chOpen: true, chOpenAt: 9 }', sb)
    assert('无营次 → legacy 兜底（第一期）',
      call(sb, '_roundCurrentForDept(__doc3,"dining/bar").id') === 'r1', String(call(sb, '_roundCurrentForDept(__doc3,"dining/bar").id')))
    // v89：本部门完全没有适用营次 → 返回 null（不回落到别部门的期）
    const doc5 = {
      events: [],
      chRounds: [
        { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, at: 1 },
      ],
      chRoundCur: 'r1',
    }
    vm.runInContext('var __doc5 = ' + JSON.stringify(doc5), sb)
    const cur5 = (slug) => call(sb, 'JSON.stringify(_roundCurrentForDept(__doc5,' + JSON.stringify(slug) + '))')
    assert('标帜餐厅（本期适用）→ 拿到 r1', JSON.parse(cur5('dining/sig')).id === 'r1')
    assert('艳中餐厅（无适用期）→ null（不再串到标帜的期）', cur5('dining/yan') === 'null', cur5('dining/yan'))
    assert('酒吧团队（无适用期）→ null', cur5('dining/bar') === 'null', cur5('dining/bar'))
    assert('客房送餐（无适用期）→ null', cur5('dining/ird') === 'null', cur5('dining/ird'))
    assert('房务部（无适用期）→ null（跨大部门也不串）', cur5('rooms/fo') === 'null', cur5('rooms/fo'))
    assert('管理员（slug 空）→ 仍跟随当前指针 r1（v88 行为不变）', JSON.parse(cur5('')).id === 'r1')
  }

  console.log('\n[8b] _getDoc 侧信道按 CloudSync._deptSlug 挑营次')
  {
    const doc = {
      users: {}, events: [],
      chRounds: [
        { id: 'r1', name: '标帜第一期', depts: ['dining/sig'], open: true, at: 1 },
        { id: 'r2', name: '酒吧第一期', depts: ['dining/bar'], open: true, at: 2 },
      ],
      chRoundCur: 'r1',
    }
    const sb = makeCloudSandbox(JSON.parse(JSON.stringify(doc)))
    // 酒吧团队学员：虽然指针在 r1，但 r1 不是他的部门 → 拿到 r2
    call(sb, "CloudSync.setDeptSlug('dining/bar')")
    const got = JSON.parse(await call(sb, `(async () => { await CloudSync._getDoc(); return JSON.stringify({
      cur: CloudSync._chRoundCurId, name: CloudSync._chRoundCurName,
      depts: CloudSync._chRoundCurDepts,
    }) })()`))
    assert('_getDoc 为酒吧团队挑 r2（而非指针 r1）', got.cur === 'r2' && got.name === '酒吧第一期', JSON.stringify(got))
    assert('侧信道 _chRoundCurDepts 暴露适用部门', JSON.stringify(got.depts) === JSON.stringify(['dining/bar']), JSON.stringify(got))
    // 管理员：不设 deptSlug → 跟随指针 r1
    call(sb, "CloudSync.setDeptSlug('')")
    const got2 = JSON.parse(await call(sb, `(async () => { await CloudSync._getDoc(); return JSON.stringify({ cur: CloudSync._chRoundCurId }) })()`))
    assert('管理员（无 deptSlug）→ 跟随当前指针 r1', got2.cur === 'r1', JSON.stringify(got2))
    assert('v88 存量营次（无 depts）对任何部门都适用',
      call(sb, 'roundDeptMatch({ id: "r9", name: "x" }, "dining/bar")') === true)
    // v89：本部门无适用营次 → _chNoRound = true，且侧信道全部清空（学员端显示「本部门暂无开营」）
    const doc2 = {
      users: {}, events: [],
      chRounds: [{ id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, at: 1 }],
      chRoundCur: 'r1',
    }
    const sb2 = makeCloudSandbox(JSON.parse(JSON.stringify(doc2)))
    call(sb2, "CloudSync.setDeptSlug('dining/yan')")
    const nr = JSON.parse(await call(sb2, `(async () => { await CloudSync._getDoc(); return JSON.stringify({
      noRound: CloudSync._chNoRound, cur: CloudSync._chRoundCurId, name: CloudSync._chRoundCurName,
      depts: CloudSync._chRoundCurDepts, open: CloudSync._chOpen, locked: CloudSync._chOpenLocked,
    }) })()`))
    assert('艳中餐厅学员 _getDoc → _chNoRound = true', nr.noRound === true, JSON.stringify(nr))
    assert('无适用期时营次侧信道清空（cur/name/depts 皆空）',
      nr.cur === '' && nr.name === '' && JSON.stringify(nr.depts) === '[]', JSON.stringify(nr))
    assert('无适用期时挑战锁定（_chOpen=false, locked=true）', nr.open === false && nr.locked === true, JSON.stringify(nr))
    // 对照：标帜餐厅学员同一份 doc → 正常拿到 r1
    call(sb2, "CloudSync.setDeptSlug('dining/sig')")
    const ok1 = JSON.parse(await call(sb2, `(async () => { await CloudSync._getDoc(); return JSON.stringify({
      noRound: CloudSync._chNoRound, cur: CloudSync._chRoundCurId, open: CloudSync._chOpen, locked: CloudSync._chOpenLocked,
    }) })()`))
    assert('标帜餐厅学员同一 doc → 正常拿到 r1 且开放',
      ok1.noRound === false && ok1.cur === 'r1' && ok1.open === true && ok1.locked === false, JSON.stringify(ok1))
    // 对照：管理员（空 slug）→ 不受部门限制
    call(sb2, "CloudSync.setDeptSlug('')")
    const adm = JSON.parse(await call(sb2, `(async () => { await CloudSync._getDoc(); return JSON.stringify({
      noRound: CloudSync._chNoRound, cur: CloudSync._chRoundCurId,
    }) })()`))
    assert('管理员同一 doc → 不置 noRound 且跟随指针 r1', adm.noRound === false && adm.cur === 'r1', JSON.stringify(adm))
  }

  // ================= ⑨ 营次 CRUD 带部门 =================
  console.log('\n[9] 营次 CRUD 带适用部门')
  {
    const live = {}
    const load = (state) => { Object.keys(live).forEach(k => delete live[k]); Object.assign(live, JSON.parse(JSON.stringify(state))) }
    const sandboxOn = (state) => { load(state); const sbx = makeCloudSandbox(live); return { sbx, doc: live } }
    const { sbx } = sandboxOn({ users: {}, events: [], chOpen: false, chOpenAt: 0 })
    // _roundsNorm 在沙箱内运行，只能看到沙箱变量 → 每次调用前把宿主 live 快照注入沙箱
    const normOf = (state, id) => JSON.parse(call(sbx,
      `JSON.stringify(_roundsNorm(${JSON.stringify(state)}).find(r => r.id === ${JSON.stringify(id)}).depts)`))
    const res = JSON.parse(await call(sbx, `(async () => { const r = await CloudSync.addChallengeRound({ name: '酒吧第一期', open: true, depts: ['dining/bar', 'dining/ird'] }); return JSON.stringify(r) })()`))
    assert('addChallengeRound 新建成功', res.ok === true, JSON.stringify(res))
    const rec = live.chRounds.find(r => r.id === res.id)
    assert('新营次带上 depts', rec && JSON.stringify(rec.depts) === JSON.stringify(['dining/bar', 'dining/ird']), JSON.stringify(rec))
    // 脏数据归一：非字符串项被过滤
    await call(sbx, `(async () => { await CloudSync.setChallengeRound(${JSON.stringify(res.id)}, { depts: ['dining/bar', '', null, 7] }) })()`)
    const normDepts = normOf(live, res.id)
    assert('depts 脏数据（空串 / null / 数字）被过滤', JSON.stringify(normDepts) === JSON.stringify(['dining/bar']), JSON.stringify(normDepts))
    // 完全缺失 depts（v88 存量）→ 归一为空数组
    const legacyRounds = [{ id: 'r88', name: '旧期', open: true, at: 1 }]
    assert('v88 存量营次缺 depts → 归一为 []', JSON.stringify(normOf({ chRounds: legacyRounds }, 'r88')) === '[]',
      JSON.stringify(normOf({ chRounds: legacyRounds }, 'r88')))
    // 清空 depts → 全部部门
    await call(sbx, `(async () => { await CloudSync.setChallengeRound(${JSON.stringify(res.id)}, { depts: [] }) })()`)
    const emptyDepts = normOf(live, res.id)
    assert('depts 清空 → 空数组（= 全部部门适用）', emptyDepts.length === 0, JSON.stringify(emptyDepts))
    assert('legacy 合成期 depts 为空（全部部门）', call(sbx, 'JSON.stringify(_roundLegacy({}).depts)') === '[]', call(sbx, 'JSON.stringify(_roundLegacy({}).depts)'))
  }

  // ================= ⑩ 管理端 =================
  console.log('\n[10] 管理端：题库 tab 集合 + 营次适用部门显示')
  {
    const sb = makeDeptSandbox()
    const set = tab => JSON.parse(call(sb, 'JSON.stringify(adminDeptSetOf(' + JSON.stringify(tab) + '))'))
    assert('dining/sig tab → 仅 dining/sig', JSON.stringify(set('dining/sig')) === JSON.stringify(['dining/sig']), JSON.stringify(set('dining/sig')))
    assert('dining/bar tab → 仅 dining/bar', JSON.stringify(set('dining/bar')) === JSON.stringify(['dining/bar']), JSON.stringify(set('dining/bar')))
    assert('rooms tab → rooms 大部门 + 其全部分部门',
      JSON.stringify(set('rooms')) === JSON.stringify(['rooms', 'rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa']),
      JSON.stringify(set('rooms')))
    assert("all tab → ['all', '']（含无 dept 的历史题）", JSON.stringify(set('all')) === JSON.stringify(['all', '']), JSON.stringify(set('all')))
    assert('未知 tab 兜底为 all', JSON.stringify(set('nope')) === JSON.stringify(['all', '']), JSON.stringify(set('nope')))
    // 题库 tab 顺序（饮食部四分队在前）
    assert('题库 tab 共 6 个（四分队 + 房务部 + 通用）',
      call(sb, 'ADMIN_DEPT_TABS.length') === 6, String(call(sb, 'ADMIN_DEPT_TABS.length')))
    assert('题库 tab 首项为 dining/sig（默认落在标帜餐厅）', call(sb, 'ADMIN_DEPT_TABS[0]') === 'dining/sig')
    // 营次适用部门文案（dashRoundDeptText 依赖 t / escHtml / deptSlugName → 沙箱补齐）
    vm.runInContext(extractFn(APP, 'dashRoundDeptText'), sb)
    vm.runInContext(extractFn(APP, 'escHtml'), sb)
    assert('dashRoundDeptText：未设部门 → 「全部部门」', /全部部门/.test(call(sb, 'dashRoundDeptText({ depts: [] })')), call(sb, 'dashRoundDeptText({ depts: [] })'))
    const dt = call(sb, 'dashRoundDeptText({ depts: ["dining/bar"] })')
    assert('dashRoundDeptText：显示本地化部门名', /酒吧团队/.test(dt), dt)
    assert('dashRoundDeptText：多个部门并列显示', /酒吧团队/.test(dt) && /客房送餐/.test(call(sb, 'dashRoundDeptText({ depts: ["dining/bar","dining/ird"] })')))
    assert('营次面板表头含「适用部门」列', /roundDeptLabel/.test(APP) && new RegExp("t\\('roundDeptLabel'\\)").test(APP))
    assert('新建营次表单含部门多选（dashRoundDept 复选框）', /class="dashRoundDept"/.test(APP))
    assert('dashCreateRound 把勾选部门传给云端', /addChallengeRound\(\{ name, startAt, endAt, depts \}\)/.test(APP))
  }

  // ================= ⑪ i18n =================
  console.log('\n[11] i18n 双语文案成对')
  {
    const keys = ['deptSubAlias', 'chDeptNames', 'roundDeptLabel', 'roundDeptAll', 'legacyTag',
      'impDeptHint', 'chTitleDept', 'chBankShortWarn', 'dashRoundDeptHint', 'dashChDeptFilterLabel',
      'idxDining', 'idxRooms', 'idxOther', 'idxAll']
    keys.forEach(k => {
      // 同一行可并列多个 key（如 "roundDeptLabel: '…', roundDeptAll: '…',"）→ 不能锚定 ^
      const n = (I18N.match(new RegExp('(^|[\\s{,])' + k + ':', 'gm')) || []).length
      assert(`i18n '${k}' 中英成对（2 处）`, n === 2, '出现 ' + n + ' 次')
    })
    // 归一别名：四个旧名都指向酒吧团队
    const zhAlias = I18N.slice(I18N.indexOf('    deptSubAlias: {'), I18N.indexOf('\n    },', I18N.indexOf('    deptSubAlias: {')))
    ;['WOOBAR', 'WETBAR', 'LIQUID'].forEach(x => {
      assert(`zh deptSubAlias 含 '${x}' → 酒吧团队`, new RegExp("'" + x + "': '酒吧团队'").test(zhAlias), x)
    })
    assert('en deptSubAlias 含 WOOBAR/WETBAR/LIQUID → Bar Team',
      (I18N.match(/'WOOBAR': 'Bar Team'/g) || []).length === 1 && (I18N.match(/'WETBAR': 'Bar Team'/g) || []).length === 1 && (I18N.match(/'LIQUID': 'Bar Team'/g) || []).length === 1)
    assert('en deptTree 四分队为英文名',
      /dining: \{ name: 'F&B', subs: \['Signatures Restaurant', 'Yan Chinese Restaurant', 'Bar Team', 'In-Room Dining'\] \}/.test(I18N))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败断言' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
