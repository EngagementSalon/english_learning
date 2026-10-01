// ====== 测试 v137：管理员合并同名账号 ======
// 场景：同一名学员注册了两次，数据被劈成两条 → 需要把「被合并账号」的全部数据并入「保留账号」。
// 本测试锁死五件事：
// ① _apply 的 rename 合并**字段齐全**（旧实现漏 placement / chReset，且会让源账号名字覆盖保留账号）
// ② 合并**幂等**：源记录消失后重放同一条 rename 不会把计数翻倍（重复执行安全）
// ③ doc.merges 不灭标记 + _absorbMerges：源账号设备的**迟到事件**也会被吸收，不产生幽灵账号
// ④ 本机侧吸收 Store.mergeUsersLocal：删本机源账号、日志/定级历史重挂，**不产生云端 delete 事件**
// ⑤ pullCloudChanges 在「目标已存在」时**删除本机源账号**（旧实现在此分支什么都不做 → 重复账号残留）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const CLOUD_SRC = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const STORE_SRC = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
const I18N_SRC = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const BANK_SRC = fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8')
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')

// ---------- 云端沙箱（整载 cloud-store.js，mock fetch） ----------
function makeCloudSandbox(docRef) {
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
  vm.runInContext(CLOUD_SRC + '\n;CloudSync', sb)
  sb.__docRef = docRef
  return sb
}

// 线上真实形状：同名两个人（张三 两次注册），数据分别在两条账号上
function dupDoc() {
  return {
    v: 1,
    base: {
      张三: {
        username: '张三', name: '张三', dept: 'dining/sig', role: 'student',
        loginCount: 3, loginSec: 1800,
        practiceCount: 20, practiceCorrect: 15, practiceTotal: 20,
        examCount: 1, examScoreSum: 88, examBest: 88, examPassCount: 1,
        placementLevel: 0, createdAt: 100, lastActive: 200,
        ph: 'HASH_TGT', salt: 'SALT_TGT',
        perQ: { '1': { correct: 0, total: 2 } },
        chQ: { '9': { correct: 0, total: 1 } },
        chy: [{ day: 1, si: 0, kind: 'test', correct: 18, total: 20, usedSec: 200, at: 150, rd: '' }],
      },
      张三_2: {
        username: '张三_2', name: '张三', dept: 'dining/sig', role: 'student',
        loginCount: 5, loginSec: 3600,
        practiceCount: 30, practiceCorrect: 24, practiceTotal: 30,
        examCount: 2, examScoreSum: 170, examBest: 90, examPassCount: 2,
        placementLevel: 3, placementPerLevel: { 1: 1, 2: 1, 3: 1 }, placementScore: 42, placementTotal: 50,
        createdAt: 50, lastActive: 500,
        ph: 'HASH_SRC', salt: 'SALT_SRC',
        perQ: { '1': { correct: 0, total: 3 }, '2': { correct: 0, total: 1 } },
        chQ: { '9': { correct: 0, total: 2 } },
        chy: [{ day: 7, si: 1, kind: 'test', correct: 15, total: 20, usedSec: 300, at: 480, rd: '' }],
        chResetAt: 900, chResetMode: 'exam',
      },
    },
    events: [],
  }
}

;(async () => {
  console.log('\n🧪 v137 管理员合并同名账号')

  // ---------- [1] _apply 合并字段齐全 ----------
  console.log('\n[1] _apply(rename) 合并字段齐全（计数/明细/定级/重置标记/身份归属）')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    const doc = dupDoc()
    vm.runInContext('window.__d = ' + JSON.stringify(doc), sb)
    vm.runInContext(`CloudSync._apply(window.__d.base, { u:'张三_2', n:'张三', ty:'rename', ts: 1000, d:{ nu:'张三', merge:true } })`, sb)
    const t = vm.runInContext('window.__d.base["张三"]', sb)
    const srcLeft = vm.runInContext('window.__d.base["张三_2"]', sb)
    assert('源账号记录已被移除', srcLeft === undefined || srcLeft === null, JSON.stringify(srcLeft))
    assert('登录次数相加（3+5=8）', t.loginCount === 8, String(t.loginCount))
    assert('登录时长相加（1800+3600=5400）', t.loginSec === 5400, String(t.loginSec))
    assert('刷题次数相加（20+30=50）', t.practiceCount === 50, String(t.practiceCount))
    assert('考试次数相加（1+2=3）', t.examCount === 3, String(t.examCount))
    assert('考试最高分取较大（max(88,90)=90）', t.examBest === 90, String(t.examBest))
    assert('createdAt 取较早（min(100,50)=50）', t.createdAt === 50, String(t.createdAt))
    assert('lastActive 取较晚（max(200,500)=500）', t.lastActive === 500, String(t.lastActive))
    assert('每题明细合并（qid 1 错次 2+3=5）', t.perQ['1'].total === 5, JSON.stringify(t.perQ))
    assert('每题明细并入源账号独有的题（qid 2）', t.perQ['2'] && t.perQ['2'].total === 1, JSON.stringify(t.perQ))
    assert('挑战错题明细合并（qid 9 错次 1+2=3）', t.chQ['9'].total === 3, JSON.stringify(t.chQ))
    assert('七天挑战记录拼接（1+1=2 条）', t.chy.length === 2, JSON.stringify(t.chy))
    assert('[v137] 保留账号的定级优先（自身 0 级 → 继承源的 L3 三元组）',
      t.placementLevel === 3 && t.placementScore === 42 && t.placementTotal === 50 && !!t.placementPerLevel,
      JSON.stringify({ l: t.placementLevel, s: t.placementScore, pt: t.placementTotal }))
    assert('[v137] 挑战重置标记取较晚的一次（源 900 > 目标 无 → 900/exam）',
      t.chResetAt === 900 && t.chResetMode === 'exam', JSON.stringify({ at: t.chResetAt, m: t.chResetMode }))
    assert('[v137] 保留账号凭据不被源账号覆盖', t.ph === 'HASH_TGT' && t.salt === 'SALT_TGT', t.ph + '/' + t.salt)
  }

  // ---------- [2] 保留账号身份优先（名字/部门/角色） ----------
  console.log('\n[2] [v137] 身份归属：保留账号的名字/部门/角色不被源账号覆盖')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext('window.__d = { base: {' +
      '"李四":{username:"李四",name:"李四（正名）",dept:"dining/yan",role:"student",loginCount:1,loginSec:10,perQ:{}},' +
      '"lisi":{username:"lisi",name:"lisi",dept:"",role:"student",loginCount:2,loginSec:20,perQ:{}}' +
      '} }', sb)
    vm.runInContext(`CloudSync._apply(window.__d.base, { u:'lisi', n:'lisi', ty:'rename', ts: 10, d:{ nu:'李四', merge:true } })`, sb)
    const t = vm.runInContext('window.__d.base["李四"]', sb)
    assert('名字保留目标的「李四（正名）」', t.name === '李四（正名）', t.name)
    assert('部门保留目标的 dining/yan', t.dept === 'dining/yan', t.dept)
    assert('角色保持 student（源是管理员也不提权）', t.role === 'student', t.role)
    assert('计数仍然合并（1+2=3）', t.loginCount === 3, String(t.loginCount))
  }
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext('window.__d = { base: {' +
      '"王五":{username:"王五",name:"",dept:"",role:"student",loginCount:1,loginSec:1,perQ:{}},' +
      '"wangwu":{username:"wangwu",name:"王五",dept:"rooms",role:"admin",loginCount:1,loginSec:1,perQ:{}}' +
      '} }', sb)
    vm.runInContext(`CloudSync._apply(window.__d.base, { u:'wangwu', n:'王五', ty:'rename', ts: 10, d:{ nu:'王五', merge:true } })`, sb)
    const t = vm.runInContext('window.__d.base["王五"]', sb)
    assert('目标缺名字/部门时继承源（name=王五, dept=rooms）', t.name === '王五' && t.dept === 'rooms', JSON.stringify({ n: t.name, d: t.dept }))
    assert('角色仍取目标（student），不因源是 admin 而提权', t.role === 'student', t.role)
  }

  // ---------- [3] 幂等 ----------
  console.log('\n[3] 幂等：同一条 rename 重放两次不翻倍（重复执行/重复投递安全）')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext('window.__d = ' + JSON.stringify(dupDoc()), sb)
    const ev = `{ u:'张三_2', n:'张三', ty:'rename', ts: 1000, d:{ nu:'张三', merge:true } }`
    vm.runInContext(`CloudSync._apply(window.__d.base, ${ev})`, sb)
    const first = vm.runInContext('JSON.stringify(window.__d.base["张三"])', sb)
    vm.runInContext(`CloudSync._apply(window.__d.base, ${ev})`, sb)
    const second = vm.runInContext('JSON.stringify(window.__d.base["张三"])', sb)
    assert('第二次应用结果与第一次完全一致（计数未翻倍）', first === second, 'differ')
    const t = JSON.parse(second)
    assert('刷题次数仍是 50（不是 80）', t.practiceCount === 50, String(t.practiceCount))
    assert('挑战记录仍是 2 条（不是 4 条）', t.chy.length === 2, String(t.chy.length))
  }

  // ---------- [4] _absorbMerges 幽灵吸收 ----------
  console.log('\n[4] doc.merges 不灭标记 + _absorbMerges：吸收残留的源账号')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext('window.__d = ' + JSON.stringify(dupDoc()), sb)
    vm.runInContext('window.__doc = { merges: { "张三_2": { to: "张三", at: 1 } } }', sb)
    vm.runInContext('CloudSync._absorbMerges(window.__d.base, window.__doc)', sb)
    const t = vm.runInContext('window.__d.base["张三"]', sb)
    const gone = vm.runInContext('window.__d.base["张三_2"]', sb)
    assert('残留源账号被吸收', gone === undefined || gone === null)
    assert('计数并入保留账号（3+5=8）', t.loginCount === 8, String(t.loginCount))
    assert('挑战记录合并（1+1=2 条）', t.chy.length === 2, String(t.chy.length))
    // 再跑一次：源已不存在 → 必须完全不动（幂等）
    const snap = vm.runInContext('JSON.stringify(window.__d.base["张三"])', sb)
    vm.runInContext('CloudSync._absorbMerges(window.__d.base, window.__doc)', sb)
    assert('重复吸收无副作用（记录未变化）', vm.runInContext('JSON.stringify(window.__d.base["张三"])', sb) === snap)
  }
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext('window.__d = { base: { a:{username:"a",loginCount:1,perQ:{}} } }', sb)
    assert('无 doc.merges 时是零成本空操作',
      vm.runInContext('(function(){ CloudSync._absorbMerges(window.__d.base, {}); return window.__d.base.a.loginCount })()', sb) === 1)
  }

  // ---------- [5] mergeAccounts 端到端 ----------
  console.log('\n[5] mergeAccounts 端到端：写标记 + 发事件 + 回读校验')
  {
    const doc = dupDoc()
    const sb = makeCloudSandbox(doc)
    const res = await vm.runInContext('CloudSync.mergeAccounts("张三_2", "张三")', sb)
    assert('返回 ok:true（回读校验通过）', res && res.ok === true, JSON.stringify(res))
    assert('doc.merges 已写入（不灭标记）',
      !!(doc.merges && doc.merges['张三_2'] && doc.merges['张三_2'].to === '张三'), JSON.stringify(doc.merges))
    const evs = (doc.events || []).filter(e => e.ty === 'rename')
    assert('推送了 1 条 rename 事件', evs.length === 1, '实际 ' + evs.length)
    assert('事件 d.nu = 保留账号，并带 merge 审计标记',
      evs[0] && evs[0].d && evs[0].d.nu === '张三' && evs[0].d.merge === true, JSON.stringify(evs[0] && evs[0].d))
    assert('事件 id 固定（重复执行不会堆多条）', evs[0] && evs[0].id === 'merge_张三_2__张三', evs[0] && evs[0].id)
    // 再执行一次：不得产生第二条事件
    const res2 = await vm.runInContext('CloudSync.mergeAccounts("张三_2", "张三")', sb)
    assert('重复执行仍返回 ok', res2 && res2.ok === true, JSON.stringify(res2))
    assert('重复执行后 rename 事件仍只有 1 条',
      (doc.events || []).filter(e => e.ty === 'rename').length === 1,
      String((doc.events || []).filter(e => e.ty === 'rename').length))
    // 非法参数
    const bad = await vm.runInContext('CloudSync.mergeAccounts("x", "x")', sb)
    assert('源=目标 → 拒绝（same-user）', bad && bad.ok === false && bad.reason === 'same-user', JSON.stringify(bad))
  }

  // ---------- [6] 看板：合并后源账号消失 + 迟到事件不产生幽灵 ----------
  console.log('\n[6] 看板口径：合并后源账号消失；源设备迟到事件被吸收（不产生幽灵）')
  {
    const doc = dupDoc()
    const sb = makeCloudSandbox(doc)
    await vm.runInContext('CloudSync.mergeAccounts("张三_2", "张三")', sb)
    const rows = await vm.runInContext('CloudSync.getDashboardData()', sb)
    const names = rows.map(r => r.username).sort()
    assert('看板不再出现源账号', names.indexOf('张三_2') < 0, names.join(','))
    const tgt = rows.find(r => r.username === '张三')
    assert('保留账号承接全部数据（登录次数 3+5=8）', tgt && tgt.loginCount === 8, JSON.stringify(tgt && tgt.loginCount))
    // 模拟源账号那台设备仍留着旧会话/未上报队列 → 迟到事件
    await vm.runInContext(`CloudSync.enqueue({ u:'张三_2', n:'张三', ty:'duration', d:{ sec: 600 } })`, sb)
    await vm.runInContext(`CloudSync.enqueue({ u:'张三_2', n:'张三', ty:'login', d:{} })`, sb)
    const rows2 = await vm.runInContext('CloudSync.getDashboardData()', sb)
    const names2 = rows2.map(r => r.username).sort()
    assert('迟到事件没有长出幽灵账号', names2.indexOf('张三_2') < 0, names2.join(','))
    const tgt2 = rows2.find(r => r.username === '张三')
    assert('迟到事件的时长被并入保留账号（5400+600=6000）', tgt2 && tgt2.loginSec === 6000, String(tgt2 && tgt2.loginSec))
    assert('迟到事件的登录次数被并入（8+1=9）', tgt2 && tgt2.loginCount === 9, String(tgt2 && tgt2.loginCount))
  }

  // ---------- [7] 源码级守卫：读路径必须调用吸收 ----------
  console.log('\n[7] 源码级守卫')
  {
    const pick = (from, to) => { const i = CLOUD_SRC.indexOf(from); const j = to ? CLOUD_SRC.indexOf(to, i) : CLOUD_SRC.length; return CLOUD_SRC.slice(i, j) }
    assert('fetchSyncSummary 调用 _absorbMerges', pick('async fetchSyncSummary', 'async getDashboardData').indexOf('_absorbMerges(map, doc)') > 0)
    assert('getDashboardData 调用 _absorbMerges', pick('async getDashboardData', '// ---------- 旧版本本地数据迁移').indexOf('_absorbMerges(map, doc)') > 0)
    assert('recalcCloudPlacementLevels 调用 _absorbMerges', pick('async recalcCloudPlacementLevels', 'async clearCloudPlacements').indexOf('_absorbMerges(map, doc)') > 0)
    assert('clearCloudPlacements 调用 _absorbMerges', pick('async clearCloudPlacements').indexOf('_absorbMerges(map, doc)') > 0)
    assert('合并事件通过 rename 通道（不改动 _apply 的事件类型白名单）', CLOUD_SRC.indexOf("ty: 'rename', d: { nu: tgt, merge: true }") > 0)
    // ⚠️ 断言「旧写法已清除」必须先剥离注释行 —— 本次就踩到过：新代码旁边那句
    //   「旧写法 `if (ev.n) tgt.name = ev.n` 会让源账号名字覆盖保留账号」的**说明性注释**
    //   本身就是该字面量，全文件 indexOf 会命中注释 → 假失败。
    const codeOnly = CLOUD_SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    assert('[v137 反转] 新规则「保留账号名字优先」已生效',
      codeOnly.indexOf('if (!tgt.name && ev.n) tgt.name = ev.n') > 0)
    assert('[v137 反转] 旧写法「源账号名字覆盖保留账号」已从代码中清除（注释不计）',
      codeOnly.indexOf('if (ev.n) tgt.name = ev.n') < 0)
  }

  // ---------- [8] store.js：本机侧吸收 ----------
  console.log('\n[8] Store.mergeUsersLocal：本机侧吸收（不发云端 delete）')
  {
    const sb = {
      console, JSON, Object, Array, String, Number, Math, Date, Promise, Set, Map, Boolean,
      localStorage: {
        store: {
          eq_users: JSON.stringify([
            { id: 1, username: 'admin', name: '管理员', role: 'admin', password: 'x', createdAt: 1 },
            { id: 2, username: '张三', name: '张三', role: 'student', password: 'y', createdAt: 2 },
            { id: 3, username: '张三_2', name: '张三', role: 'student', password: 'z', createdAt: 3 },
          ]),
          eq_activity: JSON.stringify([
            { userId: 2, username: '张三', type: 'login', timestamp: 10 },
            { userId: 3, username: '张三_2', type: 'login', timestamp: 20 },
            { userId: 3, username: '张三_2', type: 'practice', timestamp: 30, data: { correct: 1, total: 2 } },
          ]),
          eq_placement_history: JSON.stringify([
            { username: '张三', level: 1, at: 5 },
            { username: '张三_2', level: 2, at: 6 },
          ]),
        },
        getItem(k) { return this.store[k] == null ? null : this.store[k] },
        setItem(k, v) { this.store[k] = String(v) },
        removeItem(k) { delete this.store[k] },
      },
      document: { addEventListener() {}, getElementById() { return null }, querySelector() { return null }, querySelectorAll() { return [] }, body: { appendChild() {} } },
      window: { addEventListener() {}, dispatchEvent() {}, speechSynthesis: { cancel() {}, speak() {} } },
      addEventListener() {}, removeEventListener() {},
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
      Event: function () {}, SpeechSynthesisUtterance: function () {},
      navigator: { onLine: true },
    }
    sb.window = sb
    const enq = []
    sb.CloudSync = { enqueue(e) { enq.push(e) }, pushPending: async () => {}, setUser() {}, status: 'online' }
    sb.BANK = { version: 1, questions: [] }
    vm.createContext(sb)
    vm.runInContext(STORE_SRC + ';globalThis.__Store = Store;', sb)
    const S = sb.__Store
    const r = S.mergeUsersLocal('张三_2', '张三')
    assert('返回 ok:true', r && r.ok === true, JSON.stringify(r))
    assert('本机源账号已被移除（剩余 2 个账号）', S.getUsers().length === 2, String(S.getUsers().length))
    assert('保留账号仍在', S.getUsers().some(u => u.username === '张三'))
    assert('removedLocal = 1', r.removedLocal === 1, String(r.removedLocal))
    assert('活动日志全部重挂到保留账号',
      S.getActivity().every(a => a.username !== '张三_2') && S.getActivity().filter(a => a.username === '张三').length === 3,
      JSON.stringify(S.getActivity().map(a => a.username)))
    assert('定级历史重挂到保留账号',
      S.getPlacementHistory().every(h => h.username !== '张三_2') && S.getPlacementHistory().length === 2,
      JSON.stringify(S.getPlacementHistory()))
    assert('未产生云端 delete 事件（刻意不发，避免吞掉已合并的数据）', enq.length === 0, JSON.stringify(enq))
    const bad = S.mergeUsersLocal('张三', '张三')
    assert('源=目标 → 拒绝', bad && bad.ok === false, JSON.stringify(bad))
  }

  // ---------- [9] pullCloudChanges：目标已存在时删除本机源账号 ----------
  console.log('\n[9] pullCloudChanges：合并（目标已存在）删除本机源账号；普通改名行为不变')
  {
    const mkSb = () => {
      const sb = {
        console, JSON, Object, Array, String, Number, Math, Date, Promise, Set, Map, Boolean,
        localStorage: {
          store: {
            eq_users: JSON.stringify([
              { id: 1, username: 'admin', name: '管理员', role: 'admin', password: 'x', createdAt: 1 },
              { id: 2, username: '张三', name: '张三', role: 'student', password: 'y', createdAt: 2 },
              { id: 3, username: '张三_2', name: '张三', role: 'student', password: 'z', createdAt: 3 },
            ]),
          },
          getItem(k) { return this.store[k] == null ? null : this.store[k] },
          setItem(k, v) { this.store[k] = String(v) },
          removeItem(k) { delete this.store[k] },
        },
        document: { addEventListener() {}, getElementById() { return null }, querySelector() { return null }, querySelectorAll() { return [] }, body: { appendChild() {} } },
        window: { addEventListener() {}, dispatchEvent() {}, speechSynthesis: { cancel() {}, speak() {} } },
        addEventListener() {}, removeEventListener() {},
        setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
        Event: function () {}, SpeechSynthesisUtterance: function () {},
        navigator: { onLine: true },
      }
      sb.window = sb
      sb.CloudSync = { enqueue() {}, pushPending: async () => {}, setUser() {}, status: 'online' }
      sb.BANK = { version: 1, questions: [] }
      vm.createContext(sb)
      vm.runInContext(STORE_SRC + ';globalThis.__Store = Store;', sb)
      return sb
    }
    // 合并：目标「张三」本机已存在
    {
      const sb = mkSb()
      const S = sb.__Store
      S.getSession = () => ({ id: 1, username: 'admin', role: 'admin' })
      S.CloudSync = sb.CloudSync
      sb.CloudSync.fetchSyncSummary = async () => ({
        ok: true,
        doc: {
          logo: '', merges: { '张三_2': { to: '张三', at: 1 } },
          events: [
            { id: 'merge_张三_2__张三', u: '张三_2', n: '', ty: 'rename', ts: Date.now(), d: { nu: '张三', merge: true } },
          ],
        },
        map: { 张三: { username: '张三', name: '张三', dept: 'dining/sig', role: 'student' }, admin: { username: 'admin', role: 'admin' } },
      })
      await S.pullCloudChanges()
      const names = S.getUsers().map(u => u.username).sort()
      assert('[v137] 本机源账号被吸收删除', names.indexOf('张三_2') < 0, names.join(','))
      assert('保留账号仍在（未被删）', names.indexOf('张三') >= 0, names.join(','))
      assert('管理员账号不受影响', names.indexOf('admin') >= 0, names.join(','))
    }
    // 普通改名（目标本机不存在）→ 行为不变（回归保护）
    {
      const sb = mkSb()
      const S = sb.__Store
      S.getSession = () => ({ id: 1, username: 'admin', role: 'admin' })
      S.CloudSync = sb.CloudSync
      sb.CloudSync.fetchSyncSummary = async () => ({
        ok: true,
        doc: { logo: '', events: [{ id: 'r1', u: '张三_2', n: '张三', ty: 'rename', ts: Date.now(), d: { nu: '张三三' } }] },
        map: { 张三三: { username: '张三三', name: '张三', dept: '', role: 'student' }, admin: { username: 'admin', role: 'admin' } },
      })
      await S.pullCloudChanges()
      const names = S.getUsers().map(u => u.username).sort()
      assert('普通改名：本机账号改名为新用户名（未删除）', names.indexOf('张三三') >= 0 && names.indexOf('张三_2') < 0, names.join(','))
      const renamed = S.getUsers().find(u => u.username === '张三三')
      assert('改名保留原 id（password 未被清空）', renamed && renamed.id === 3 && renamed.password === 'z', JSON.stringify(renamed))
    }
  }

  // ---------- [10] app.js：仅管理员 + 界面入口 ----------
  console.log('\n[10] app.js：管理员闸门与入口')
  {
    assert('合并入口位于账号管理页工具栏', APP_SRC.indexOf("onclick=\"openMergeModal()\"") > 0)
    assert('renderUsers 本身即为管理员专用', /async function renderUsers\(\)\s*\{\s*if \(!Store\.isAdmin\(\)\) return/.test(APP_SRC))
    assert('openMergeModal 有管理员闸门', /async function openMergeModal\(\)\s*\{\s*if \(!Store\.isAdmin\(\)\) return/.test(APP_SRC))
    assert('mergeUsersRun 有管理员闸门', /async function mergeUsersRun\(\)\s*\{\s*if \(!Store\.isAdmin\(\)\) return alert/.test(APP_SRC))
    assert('管理员账号被拒绝参与合并', APP_SRC.indexOf("if (srcRow.role === 'admin' || tgtRow.role === 'admin') return alert(t('mergeNoAdminAccount'))") > 0)
    assert('执行前必须逐字输入被合并账号名', APP_SRC.indexOf('mergeConfirmMismatch') > 0 && APP_SRC.indexOf("!== src) return alert(t('mergeConfirmMismatch', src))") > 0)
    assert('执行前留云端快照备份', APP_SRC.indexOf("'eq_merge_backup_' + Date.now()") > 0)
    assert('备份最多保留 3 份', APP_SRC.indexOf('while (keys.length > 3)') > 0)
    assert('复用改名通道迁移线下课成绩', APP_SRC.indexOf('applyCourseRename(src, tgt)') > 0)
    assert('调用云端合并归一入口', APP_SRC.indexOf('CloudSync.mergeAccounts(src, tgt)') > 0)
  }

  // ---------- [11] 同名分组（纯函数） ----------
  console.log('\n[11] mergeDupGroups：同名账号分组')
  {
    const sb = makeCloudSandbox({ v: 1, base: {}, events: [] })
    vm.runInContext('window.__rows = ' + JSON.stringify([
      { username: 'admin', name: '管理员', role: 'admin' },
      { username: '张三', name: '张三', role: 'student' },
      { username: '张三_2', name: '张三', role: 'student' },
      { username: '张三_3', name: ' 张三 ', role: 'student' },
      { username: '李四', name: '李四', role: 'student' },
      { username: '王五', name: '', role: 'student' },
    ]), sb)
    const groups = vm.runInContext(`
      (function(){
        const rows = window.__rows
        const norm = (u) => { const n = String((u && u.name) || '').trim().toLowerCase(); return n || ('@' + String((u && u.username) || '').trim().toLowerCase()) }
        const g = {}
        rows.forEach(u => { if (!u || u.role === 'admin') return; const k = norm(u); (g[k] = g[k] || []).push(u) })
        return Object.keys(g).map(k => g[k]).filter(l => l.length > 1).map(l => l.map(u => u.username))
      })()
    `, sb)
    assert('识别出 1 组同名账号（3 个「张三」，含前后空格）', groups.length === 1 && groups[0].length === 3, JSON.stringify(groups))
    assert('同名分组剔除管理员账号', !JSON.stringify(groups).includes('admin'), JSON.stringify(groups))
  }

  // ---------- [12] 刻意不迁移「挑战重置标记」（防合并误清保留账号的本机成绩） ----------
  console.log('\n[12] 挑战重置标记**不迁移**（它是发给设备的指令，不是学习数据）')
  {
    const doc = dupDoc()
    doc.chRounds = [{ id: 'r1', name: '第一期', depts: [], open: true }]
    doc.chRoundCur = 'r1'
    doc.chRoundLevels = { r1: { chResets: { '张三_2': 999 }, chResetModes: { '张三_2': 'exam' } } }
    doc.chResets = { '张三_2': 999 }
    doc.chResetModes = { '张三_2': 'exam' }
    const sb = makeCloudSandbox(doc)
    await vm.runInContext('CloudSync.mergeAccounts("张三_2", "张三")', sb)
    assert('[v137] 营次级重置标记保持原样（未搬到保留账号名下）',
      doc.chRoundLevels.r1.chResets['张三_2'] === 999 && doc.chRoundLevels.r1.chResets['张三'] === undefined,
      JSON.stringify(doc.chRoundLevels.r1.chResets))
    assert('[v137] 第一期顶层重置标记同样未被搬走',
      doc.chResets['张三_2'] === 999 && doc.chResets['张三'] === undefined,
      JSON.stringify(doc.chResets))
    assert('[v137] 重置模式未被搬迁', doc.chRoundLevels.r1.chResetModes['张三'] === undefined)
    // 侧信道 = _roundLevels().chResets → 保留账号必须在侧信道里「没有条目」，
    //   否则他一打开挑战页就会读到「比自己本地水位更新」的时间戳 → 本机 Day1/Day7 成绩被清空
    const CS = vm.runInContext('CloudSync', sb)
    await vm.runInContext('CloudSync._getDoc()', sb)
    const side = CS._chResets || {}
    assert('[v137] 重置侧信道里保留账号无条目（不会被误清本机记录）', !side['张三'], JSON.stringify(side))
    assert('[v137] 聚合里的「已重置」元数据仍照常合并（看板可显示）',
      (function () {
        const m = {}
        Object.keys(doc.base).forEach(u => { m[u] = Object.assign({}, doc.base[u]) })
        ;(doc.events || []).forEach(ev => CS._apply(m, ev))
        CS._absorbMerges(m, doc)
        return !!(m['张三'] && m['张三'].chResetAt === 900)
      })(), 'r.chResetAt 未合并')
  }

  console.log(testFailed ? '\n❌ v137 存在失败断言' : '\n✅ v137 全部通过')
  process.exit(testFailed ? 1 : 0)
})()
