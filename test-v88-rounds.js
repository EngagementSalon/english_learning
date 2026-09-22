// ====== 测试 v88：七天挑战「营次（Round）」多期管理 ======
// 背景：管理员需要自助开办新一期七天挑战（不依赖改代码发版），且一期建好后能到点自动开放、到期自动关闭。
//
// 覆盖点：
// ① 云端营次模型：chRounds 数组 + chRoundCur 当前营次指针 + chRoundLevels[营次] 按营次隔离的重置标记
// ② 向下兼容三层兜底：无 chRounds → 顶层字段合成「第一期」；第一期镜像到顶层；第一期存档键沿用原名
// ③ 自动排期三态结算 roundOpenState：upcoming（未到 startAt）/ open / closed（手动关）/ ended（已过 endAt 优先）
// ④ 考试开关 roundExamState：独立结算，不叠加营次门禁（v87 存量数据不被误锁）
// ⑤ 侧信道：_getDoc 把 _chOpen/_chExamOpen/_chResets/_chResetModes 从「当前营次」派生（v76/v77/v83/v84 零改动跟随）
// ⑥ CRUD：addChallengeRound（首次自动迁 legacy）/ setChallengeRound / setChallengeRoundCurrent / deleteChallengeRound
// ⑦ 按营次隔离：事件 d.rd、重置按 d.round 过滤、chRoundSlug/_roundSlugKey 口径一致（'' 与 'r1' 等价）
// ⑧ 学员端：chRoundSlug / chCurrentRound / chStorageKeyFor / chUserSeed 按营次派生（第一期种子与 v87 一致）
// ⑨ 看板：dashRoundSlug / dashRoundOpenState / 按营次筛选统计
// ⑩ i18n 双语文案成对
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}
function extractFn(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
const CLOUD = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
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

;(async () => {
  console.log('\n🧪 v88 七天挑战营次（多期）测试')

  // ================= ① 营次数据模型与向下兼容 =================
  console.log('\n[1] 营次模型与向下兼容兜底')
  {
    // v87 单期云端布局：只有顶层 chOpen/chExamOpen/chOpenAt，没有 chRounds
    const docRef = { users: {}, events: [], chOpen: true, chExamOpen: true, chOpenAt: 111, chResets: { alice: 5 } }
    const sb = makeCloudSandbox(docRef)
    const cur = call(sb, `(() => { const d = { chOpen: true, chExamOpen: true, chOpenAt: 111 };
      const l = _roundLegacy(d); return JSON.stringify(l) })()`)
    const legacy = JSON.parse(cur)
    assert('无 chRounds：_roundLegacy 把顶层字段合成「第一期」', legacy.id === 'r1' && legacy.name === '第一期', cur)
    assert('legacy 继承顶层 open / examOpen / at', legacy.open === true && legacy.examOpen === true && legacy.at === 111, cur)
    assert('legacy 无起止时间（老数据没有排期概念）', !legacy.startAt && !legacy.endAt, cur)

    // 第一期始终镜像到顶层：v87 旧客户端只认顶层字段
    assert('第一期镜像顶层：_roundLevels 对 r1/第一期 回落顶层 chResets',
      /const legacy = \(id === 'r1' \|\| id === '第一期'\)/.test(extractFn(CLOUD, '_roundLevels')) &&
      /legacy && doc && doc\.chResets/.test(extractFn(CLOUD, '_roundLevels')),
      extractFn(CLOUD, '_roundLevels'))
    // _roundSlugKey 归一：'' / 'r1' 等价（chy 记录 rd 与 chreset 事件 d.round 必须同口径）
    const keys = JSON.parse(call(sb, `JSON.stringify([_roundSlugKey('r1'), _roundSlugKey(''), _roundSlugKey(null), _roundSlugKey('第二期')])`))
    assert("_roundSlugKey：'' / 'r1' / null → ''（第一期同口径）", keys[0] === '' && keys[1] === '' && keys[2] === '', JSON.stringify(keys))
    assert('_roundSlugKey：其他营次原样保留', keys[3] === '第二期', JSON.stringify(keys))
  }

  // ================= ② 自动排期三态 =================
  console.log('\n[2] 自动排期结算（到点开放 / 到期关闭）')
  {
    const sb = makeCloudSandbox({})
    const T = 1_700_000_000_000
    const st = (r, now) => JSON.parse(call(sb, `JSON.stringify(roundOpenState(${JSON.stringify(r)}, ${now}))`))
    // 无排期 → 以手动开关为准
    const a = st({ open: true }, T)
    assert('无排期 + open:true → open（on）', a.state === 'open' && a.on === true && a.locked === false, JSON.stringify(a))
    const b = st({ open: false }, T)
    assert('无排期 + open:false → closed（锁定）', b.state === 'closed' && b.on === false && b.locked === true, JSON.stringify(b))
    // 未到 startAt → upcoming（无视手动 open）
    const c = st({ open: true, startAt: T + 1000 }, T)
    assert('startAt 未到 → upcoming（且 on:false，即使手动已开）', c.state === 'upcoming' && c.on === false && c.everOpen === false, JSON.stringify(c))
    // 窗口内 + 手动开 → open
    const d = st({ open: true, startAt: T - 1000, endAt: T + 1000 }, T)
    assert('窗口内 + open → open', d.state === 'open' && d.on === true, JSON.stringify(d))
    // 窗口内 + 手动关 → closed
    const e = st({ open: false, startAt: T - 1000, endAt: T + 1000 }, T)
    assert('窗口内 + 未开 → closed', e.state === 'closed' && e.on === false, JSON.stringify(e))
    // 已过 endAt → ended（优先级最高，无视手动 open）
    const f = st({ open: true, startAt: T - 5000, endAt: T }, T)
    assert('已到 endAt → ended（on:false，且无视手动 open）', f.state === 'ended' && f.on === false && f.everOpen === true, JSON.stringify(f))
    // 边界：now 恰好等于 endAt → ended（>= 语义，不留半开窗口）
    const g = st({ open: true, startAt: T - 5000, endAt: T }, T)
    assert('边界 now === endAt → ended（>= 语义）', g.state === 'ended', JSON.stringify(g))
    // 边界：now 恰好等于 startAt → 不再是 upcoming
    const h = st({ open: true, startAt: T, endAt: T + 5000 }, T)
    assert('边界 now === startAt → 进入窗口（open）', h.state === 'open', JSON.stringify(h))
    // endAt 优先于 startAt（排期填反了也不至于永久开放）
    const i2 = st({ open: true, startAt: T + 9000, endAt: T - 1000 }, T)
    assert('endAt 优先于 startAt（排期冲突时按已结束）', i2.state === 'ended', JSON.stringify(i2))
  }

  // ================= ③ 考试开关独立结算 =================
  console.log('\n[3] 期末考试开关（不叠加营次门禁）')
  {
    const sb = makeCloudSandbox({})
    const T = 1_700_000_000_000
    const ex = (r, now) => JSON.parse(call(sb, `JSON.stringify(roundExamState(${JSON.stringify(r)}, ${now}))`))
    // v87 存量数据：营次未开放，但考试开关开着 → 考试仍算开（营次拦截由 chOpenLocked 另行负责）
    const a = ex({ open: false, examOpen: true }, T)
    assert('v87 存量：营次关闭但考试开关开着 → exam on（不叠加门禁）', a.on === true, JSON.stringify(a))
    const b = ex({ examOpen: false }, T)
    assert('考试开关关闭 → 锁定', b.on === false && b.locked === true, JSON.stringify(b))
    const c = ex({ examOpen: true, examEndAt: T }, T)
    assert('考试已过 examEndAt → 锁定', c.on === false && c.locked === true, JSON.stringify(c))
    const d = ex({ examOpen: true, examStartAt: T + 1000 }, T)
    assert('考试未到 examStartAt → 锁定', d.on === false && d.locked === true, JSON.stringify(d))
    const e = ex({ examOpen: true, examStartAt: T - 1000, examEndAt: T + 1000 }, T)
    assert('考试窗口内 → 开放', e.on === true, JSON.stringify(e))
  }

  // ================= ④ 侧信道从当前营次派生 =================
  console.log('\n[4] 侧信道：既有读取方零改动跟随当前营次')
  {
    const docRef = {
      users: {}, events: [],
      chRounds: [
        { id: 'r1', name: '第一期', open: false, examOpen: false, at: 100 },
        { id: 'r2', name: '第二期', open: true, examOpen: true, at: 200 },
      ],
      chRoundCur: 'r2',
      chRoundLevels: { r1: { chResets: { bob: 7 }, chResetModes: { bob: 'exam' } }, r2: { chResets: {}, chResetModes: {} } },
    }
    // _getDoc 是 async（内部 await fetch）→ 必须在外层 await 才能拿到侧信道；沙箱各用一份 doc 副本避免串味
    const s2 = makeCloudSandbox(JSON.parse(JSON.stringify(docRef)))
    const got2 = JSON.parse(await call(s2, `(async () => { await CloudSync._getDoc(); return JSON.stringify({
      cur: CloudSync._chRoundCurId, name: CloudSync._chRoundCurName,
      open: CloudSync._chOpen, exam: CloudSync._chExamOpen, locked: CloudSync._chOpenLocked,
      has: CloudSync._chHasRounds, rounds: (CloudSync._chRounds || []).length,
      lvResets: CloudSync._chResets, lvModes: CloudSync._chResetModes,
    }) })()`))
    assert('侧信道 _chRoundCurId / _chRoundCurName 指向当前营次', got2.cur === 'r2' && got2.name === '第二期', JSON.stringify(got2))
    assert('侧信道 _chRounds 归一化出全部营次（含 legacy 补齐）', got2.has === true && got2.rounds === 2, JSON.stringify(got2))
    assert('侧信道 _chOpen/_chExamOpen 从当前营次派生（r2 开着）', got2.open === true && got2.exam === true, JSON.stringify(got2))
    assert('侧信道 _chOpenLocked 同步派生（不再单独读顶层）', got2.locked === false, JSON.stringify(got2))
    assert('侧信道 _chResets/_chResetModes 取当前营次的 chRoundLevels', JSON.stringify(got2.lvResets) === '{}' && JSON.stringify(got2.lvModes) === '{}', JSON.stringify(got2))

    // 切到 r1（未开放）→ 侧信道跟随，且重置标记变成 r1 的
    const r1Doc = JSON.parse(JSON.stringify(docRef))
    r1Doc.chRoundCur = 'r1'
    const sb1 = makeCloudSandbox(r1Doc)
    const got1 = JSON.parse(await call(sb1, `(async () => { await CloudSync._getDoc(); return JSON.stringify({
      cur: CloudSync._chRoundCurId, open: CloudSync._chOpen, locked: CloudSync._chOpenLocked,
      resets: CloudSync._chResets,
    }) })()`))
    assert('切营次后 _chOpen 跟随（r1 关着 → false）', got1.cur === 'r1' && got1.open === false, JSON.stringify(got1))
    assert('切营次后 _chResets 跟随（r1 的 bob:7）', Number(got1.resets.bob) === 7, JSON.stringify(got1))

    // _chResets 必须无条件出侧信道：重置标记只有到达学员端才能同步清本地存档，
    // 不能因为「本期未开放」就吞掉（曾因此破坏 v83 断言）
    assert('_chResets 不受营次开放态影响（无条件出侧信道）',
      !/this\._chResets\s*=\s*effOpen\.on\s*\?/.test(CLOUD),
      '侧信道不得按 effOpen.on 三元剔除 chResets')
  }

  // ================= ⑤ CRUD =================
  console.log('\n[5] 营次 CRUD（管理员自助开期）')
  {
    // 每个沙箱都吃同一个可变 doc 对象（makeCloudSandbox 的 GET/POST 都写它），
    // 之后换沙箱只需把最新状态「灌回」同一个对象，断言就能读到真实结果。
    const live = {}
    const load = (state) => { Object.keys(live).forEach(k => delete live[k]); Object.assign(live, JSON.parse(JSON.stringify(state))) }
    const sandboxOn = (state) => { load(state); const sbx = makeCloudSandbox(live); return { sbx, doc: live } }

    // 空云端（无 chRounds）→ 新建第一期时自动把 legacy 迁成「第一期」，再追加新期
    load({ users: {}, events: [], chOpen: true, chExamOpen: false })
    const sb = makeCloudSandbox(live)
    const r1 = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.addChallengeRound({ name: '2026 秋季营' })))()`))
    assert('首次建营次：自动补齐 legacy「第一期」+ 追加新期', r1.ok === true && r1.id === 'r2', JSON.stringify(r1))
    const d1 = live
    assert('chRounds 含 2 期（第一期 legacy + 新建）', Array.isArray(d1.chRounds) && d1.chRounds.length === 2, JSON.stringify(d1.chRounds))
    assert('legacy 期保留顶层 open:true 语义', d1.chRounds[0].id === 'r1' && d1.chRounds[0].open === true, JSON.stringify(d1.chRounds[0]))
    assert('新建期默认未开放（避免误点把全班推进新一期）', d1.chRounds[1].open === false, JSON.stringify(d1.chRounds[1]))
    assert('新建即设为当前营次 chRoundCur', d1.chRoundCur === 'r2', String(d1.chRoundCur))
    assert('自定义名称生效', d1.chRounds[1].name === '2026 秋季营', d1.chRounds[1].name)

    // 第四期：默认名称 + 排期（沿用当前 live 状态，保持同一个 doc 引用）
    const snap1 = JSON.parse(JSON.stringify(d1))
    load(snap1)
    const r2 = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.addChallengeRound({ startAt: 1700000000000, endAt: 1700100000000 })))()`))
    assert('id 递增（已有 r1/r2 → 新建 r3）', r2.ok === true && r2.id === 'r3', JSON.stringify(r2))
    const rec3 = live.chRounds.find(x => x.id === 'r3')
    assert('默认名称「第 3 期」（按已有期数 +1）', rec3 && rec3.name === '第 3 期', JSON.stringify(rec3))
    assert('排期 startAt/endAt 写入', !!rec3 && rec3.startAt === 1700000000000 && rec3.endAt === 1700100000000, JSON.stringify(rec3))

    // setChallengeRound：按字段 patch
    load(snap1)
    const r3 = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.setChallengeRound('r2', { name: '第二期（改名）', open: true, examOpen: true, startAt: 1, endAt: 2 })))()`))
    assert('setChallengeRound 返回 ok', r3.ok === true, JSON.stringify(r3))
    const rec2 = live.chRounds.find(x => x.id === 'r2')
    assert('patch 生效（name / open / examOpen / 排期）',
      rec2.name === '第二期（改名）' && rec2.open === true && rec2.examOpen === true && rec2.startAt === 1 && rec2.endAt === 2, JSON.stringify(rec2))
    assert('open 置 true 时记录 at（「曾开放过」判定依据）', Number(rec2.at) > 0, JSON.stringify(rec2))
    // 不存在的营次 → noround
    const rNo = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.setChallengeRound('rX', { open: true })))()`))
    assert('setChallengeRound 未知营次 → noround', rNo.ok === false && rNo.reason === 'noround', JSON.stringify(rNo))

    // setChallengeRoundCurrent
    load(snap1)
    const rc = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.setChallengeRoundCurrent('r1')))()`))
    assert('setChallengeRoundCurrent 切换当前营次', rc.ok === true && live.chRoundCur === 'r1', JSON.stringify({ rc, cur: live.chRoundCur }))
    const rcNo = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.setChallengeRoundCurrent('rZ')))()`))
    assert('切换未知营次 → noround', rcNo.ok === false && rcNo.reason === 'noround', JSON.stringify(rcNo))

    // deleteChallengeRound：顺带清 chRoundLevels；当前期被删则回落
    // snap1 里只有 r1/r2 → 删 r2 验证「当前期被删回落」；chRoundLevels 里塞一个已不存在的 r3 验证顺带清理
    const delState = JSON.parse(JSON.stringify(snap1))
    delState.chRoundLevels = { r1: { chResets: { a: 1 } }, r2: { chResets: { b: 2 } }, r3: { chResets: { c: 3 } } }
    delState.chRoundCur = 'r2'
    const { sbx: sb5, doc: docDel } = sandboxOn(delState)
    const rd = JSON.parse(await call(sb5, `(async () => JSON.stringify(await CloudSync.deleteChallengeRound('r2')))()`))
    assert('删除营次 ok', rd.ok === true, JSON.stringify(rd))
    assert('删除后从 chRounds 移除', !docDel.chRounds.some(x => x.id === 'r2'), JSON.stringify(docDel.chRounds.map(x => x.id)))
    assert('删除时顺带清 chRoundLevels[营次]', !docDel.chRoundLevels || !docDel.chRoundLevels.r2, JSON.stringify(docDel.chRoundLevels))
    assert('当前营次被删 → 回落到剩余营次', docDel.chRoundCur === 'r1', String(docDel.chRoundCur))
    const rdNo = JSON.parse(await call(sb5, `(async () => JSON.stringify(await CloudSync.deleteChallengeRound('rNope')))()`))
    assert('删除未知营次 → noround', rdNo.ok === false && rdNo.reason === 'noround', JSON.stringify(rdNo))
  }

  // ================= ⑥ 按营次隔离（事件 + 重置） =================
  console.log('\n[6] 按营次隔离：事件 rd / 重置 round 过滤')
  {
    // 资源侧：事件带 rd
    assert("chy 事件写入 rd = _roundSlugKey(d.rd)（'' 与 'r1' 同口径）", /rd:\s*_roundSlugKey\(d\.rd\)/.test(CLOUD))
    // v103：setChallengeReset 改为「按学员实际拥有的营次逐条落刀」——事件在循环里产出，
    // 写的是已归一的记录键 k（不再对 round 变量重复归一）。契约断言：每个目标营次推一条事件。
    assert('chreset 事件按目标营次逐条产出（d.round = 记录键）', /targets\.forEach\(k\s*=>\s*\{[\s\S]{0,220}?ty:\s*'chreset'[\s\S]{0,120}?round:\s*k/.test(CLOUD))
    assert('_apply(chreset) 用 _roundSlugKey 双端归一后比对', /const inRound = x => _roundSlugKey\(x && x\.rd\) === rids/.test(CLOUD))

    // 行为侧：两期各有考试成绩，重置只清当前期
    const sb = makeCloudSandbox({})
    const apply = (map, ev) => call(sb, `(() => { const m = ${JSON.stringify(map)}; CloudSync._apply(m, ${JSON.stringify(ev)}); return JSON.stringify(m) })()`)
    const base = {
      u: { username: 'u', chy: [
        { day: 1, si: 0, kind: 'test', correct: 20, total: 20, at: 100, usedSec: 10, rd: '' },       // 第一期考试
        { day: 1, si: 1, kind: 'practice', correct: 10, total: 10, at: 110, usedSec: 10, rd: '' },
        { day: 1, si: 0, kind: 'test', correct: 18, total: 20, at: 200, usedSec: 10, rd: '第二期' },  // 第二期考试
      ], chQ: { q1: [1, 2] } },
    }
    // 重置第一期（round='' / 'r1' 等价）
    const m1 = JSON.parse(apply(base, { u: 'u', ty: 'chreset', ts: 500, d: { mode: 'exam', round: 'r1' } }))
    const chy1 = m1.u.chy
    assert('重置第一期：第一期考试被降级为已重置存根（分数清零）', chy1[0].cleared === true && chy1[0].correct === 0 && chy1[0].total === 0, JSON.stringify(chy1[0]))
    assert('重置第一期：第一期练习记录保留', chy1[1].cleared !== true && chy1[1].correct === 10, JSON.stringify(chy1[1]))
    assert('重置第一期：第二期考试不受影响', chy1[2].cleared !== true && chy1[2].correct === 18, JSON.stringify(chy1[2]))
    assert('重置第一期：chQ 保留（exam 模式不动错题库）', !!m1.u.chQ && !!m1.u.chQ.q1, JSON.stringify(m1.u.chQ))

    // 反向：重置第二期不动第一期
    const m2 = JSON.parse(apply(base, { u: 'u', ty: 'chreset', ts: 500, d: { mode: 'exam', round: '第二期' } }))
    assert('重置第二期：只降级第二期考试', m2.u.chy[2].cleared === true && m2.u.chy[0].cleared !== true, JSON.stringify(m2.u.chy))

    // 幂等：重放同一事件不重复清除（只清 at <= ev.ts 的记录）
    const after = JSON.parse(apply(base, { u: 'u', ty: 'chreset', ts: 150, d: { mode: 'exam', round: '' } }))
    assert('幂等：只清「重置时刻之前」的成绩（at=100 清、at=200 留）',
      after.u.chy[0].cleared === true && after.u.chy[2].cleared !== true, JSON.stringify(after.u.chy.map(x => x.cleared)))

    // v83 旧事件（无 mode）→ 整表清空该期；第一期时一并清 chQ
    const m3 = JSON.parse(apply(base, { u: 'u', ty: 'chreset', ts: 500, d: {} }))
    assert('v83 旧事件（无 mode）：清空该期全部 chy 记录', m3.u.chy.length === 1 && m3.u.chy[0].rd === '第二期', JSON.stringify(m3.u.chy.map(x => x.rd)))
    assert("v83 旧事件：rd='' 时一并清 chQ（错题库未按营次存）", !m3.u.chQ || Object.keys(m3.u.chQ).length === 0, JSON.stringify(m3.u.chQ))
    const m4 = JSON.parse(apply(base, { u: 'u', ty: 'chreset', ts: 500, d: { round: '第二期' } }))
    assert('v83 旧事件 + 非首期：不动 chQ（避免清一期误伤另一期错题排行）', !!m4.u.chQ && !!m4.u.chQ.q1, JSON.stringify(m4.u.chQ))

    // 重置标记写入按营次：doc.chRoundLevels[当前营次]
    const live6 = {}
    const load6 = (st) => { Object.keys(live6).forEach(k => delete live6[k]); Object.assign(live6, st) }
    load6({ users: {}, events: [], chRounds: [{ id: 'r1', name: '第一期', open: true }, { id: 'r2', name: '第二期', open: true }], chRoundCur: 'r2' })
    const sbR = makeCloudSandbox(live6)
    const rr = JSON.parse(await call(sbR, `(async () => JSON.stringify(await CloudSync.setChallengeReset('alice', 'Alice')))()`))
    assert('setChallengeReset 返回目标营次（无记录学员 → 回落当前营次 r2）', rr.ok === true && rr.round === 'r2', JSON.stringify(rr))
    assert('重置标记写入 chRoundLevels[r2].chResets', Number(((live6.chRoundLevels || {}).r2 || {}).chResets.alice) > 0, JSON.stringify(live6.chRoundLevels))
    const ev = (live6.events || []).filter(e => e.ty === 'chreset').pop()
    // 记录键口径（v102 修正）：chy 的 rd 存的是「营次记录键」而不是营次名称。
    // v88 最初用营次名称作键，v90 改名后存量记录全变孤儿（学员成绩在看板消失）→ v102 起
    // 记录键只由营次 id 派生（'r1'/''/'第一期' → ''，其余原样），名称永不参与。
    assert("重置事件 d.round = 营次记录键（r2 → 'r2'）", !!ev && ev.d.round === 'r2', JSON.stringify(ev && ev.d))
    // 第一期镜像到顶层（v87 客户端只认顶层）
    load6({ users: {}, events: [], chRounds: [{ id: 'r1', name: '第一期', open: true }], chRoundCur: 'r1' })
    const sbR1 = makeCloudSandbox(live6)
    await call(sbR1, `(async () => JSON.stringify(await CloudSync.setChallengeReset('bob')))()`)
    assert('第一期重置：镜像到顶层 chResets（v87 兼容）', Number((live6.chResets || {}).bob) > 0, JSON.stringify(live6.chResets))
    assert('第一期重置：同时写 chRoundLevels.r1', Number(((live6.chRoundLevels || {}).r1 || {}).chResets.bob) > 0, JSON.stringify(live6.chRoundLevels))
    const ev1 = (live6.events || []).filter(e => e.ty === 'chreset').pop()
    assert("第一期重置事件 d.round = ''（与 chy 记录 rd 缺省对齐）", !!ev1 && ev1.d.round === '', JSON.stringify(ev1 && ev1.d))
  }

  // ================= ⑦ 学员端按营次派生 =================
  console.log('\n[7] 学员端：存档键 / 题序种子 / 门禁按营次派生')
  {
    // v102：口径固化为「显式处理 第一期 族」，不再依赖旧的单行三元写法
    assert('chRoundSlug 存在且 r1 / 第一期 均归第一期', /function chRoundSlug/.test(CH) && /'第一期'/.test(extractFn(CH, 'chRoundSlug')))
    // 存档键：第一期沿用原名（兼容旧存档），第 N 期加后缀
    const sb = {
      console,
      localStorage: { store: { 'eq_challenge_v2': JSON.stringify({ day: 3, stages: {} }) },
        getItem(k) { return this.store[k] == null ? null : this.store[k] },
        setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    }
    vm.createContext(sb)
    vm.runInContext(`const CHALLENGE_KEY = 'eq_challenge_v2'; const CHALLENGE_KEY_PREFIX = 'eq_challenge_v2_';
      const CHALLENGE_ROUND_SEEN_KEY = 'eq_ch_seen_rounds';`, sb)
    vm.runInContext(extractFn(CH, 'chRoundSlug'), sb)
    vm.runInContext(extractFn(CH, 'chStorageKeyFor'), sb)
    const k1 = call(sb, `chStorageKeyFor('r1')`)
    const k2 = call(sb, `chStorageKeyFor('第二期')`)
    assert('第一期存档键 = eq_challenge_v2（旧存档无缝沿用）', k1 === 'eq_challenge_v2', k1)
    assert('第 N 期存档键加后缀（各期进度互不覆盖）', k2 === 'eq_challenge_v2_第二期', k2)
    assert('未指定营次 → 回落第一期键', call(sb, `chStorageKeyFor('')`) === 'eq_challenge_v2', '')

    // 题序种子：第一期必须与 v87 完全一致（否则老学员题序全变）
    const seedSb = {
      console,
      Store: { getSession: () => ({ username: 'alice' }) },
      localStorage: { store: {}, getItem(k) { return this.store[k] == null ? null : this.store[k] },
        setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    }
    vm.createContext(seedSb)
    vm.runInContext(`const CHALLENGE_SEED = 20260915; let CloudSync;`, seedSb)
    vm.runInContext(extractFn(CH, 'challengeUid'), seedSb)
    vm.runInContext(extractFn(CH, 'chRoundSlug'), seedSb)
    // v97：chCurrentRound 新增依赖 chRoundRecForDept（→ chDeptKey），注入清单同步
    vm.runInContext(extractFn(CH, 'chDeptKey'), seedSb)
    vm.runInContext(extractFn(CH, 'chRoundRecForDept'), seedSb)
    vm.runInContext(extractFn(CH, 'chCurrentRound'), seedSb)
    vm.runInContext(extractFn(CH, 'chUserSeed'), seedSb)
    // 无云端营次 → chCurrentRound 回落 '第一期' → 种子就是 v87 的 FNV-1a(username) + SEED
    const sFirst = call(seedSb, `chUserSeed()`)
    const sExpect = call(seedSb, `(() => { let h = 2166136261; const s = 'alice';
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
      return (20260915 + (h >>> 0) + 0) >>> 0 })()`)
    assert('第一期种子 = v87 原值（SEED + FNV1a(username)，营次贡献 0）', sFirst === sExpect, sFirst + ' vs ' + sExpect)

    // 切到第二期 → 种子必须变化（否则两期拿到同一套题序）
    const seedSb2 = {
      console,
      Store: { getSession: () => ({ username: 'alice' }) },
      localStorage: { store: {}, getItem(k) { return this.store[k] == null ? null : this.store[k] },
        setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    }
    vm.createContext(seedSb2)
    vm.runInContext(`const CHALLENGE_SEED = 20260915; let CloudSync = { _chRoundCurId: '第二期' };`, seedSb2)
    vm.runInContext(extractFn(CH, 'challengeUid'), seedSb2)
    vm.runInContext(extractFn(CH, 'chRoundSlug'), seedSb2)
    vm.runInContext(extractFn(CH, 'chDeptKey'), seedSb2)
    vm.runInContext(extractFn(CH, 'chRoundRecForDept'), seedSb2)
    vm.runInContext(extractFn(CH, 'chCurrentRound'), seedSb2)
    vm.runInContext(extractFn(CH, 'chUserSeed'), seedSb2)
    const sSecond = call(seedSb2, `chUserSeed()`)
    assert('第二期种子不同（各期题序独立洗牌）', sSecond !== sFirst, sSecond + ' vs ' + sFirst)
    // 同一期重复调用必须稳定（题序不能每次刷新都变）
    assert('同一营次种子稳定（可重复调用）', call(seedSb2, `chUserSeed()`) === sSecond, '')
    // 换 username → 种子变化（每人专属题序）
    const seedSb3 = {
      console,
      Store: { getSession: () => ({ username: 'bob' }) },
      localStorage: { store: {}, getItem: () => null, setItem() {}, removeItem() {} },
    }
    vm.createContext(seedSb3)
    vm.runInContext(`const CHALLENGE_SEED = 20260915; let CloudSync;`, seedSb3)
    vm.runInContext(extractFn(CH, 'challengeUid'), seedSb3)
    vm.runInContext(extractFn(CH, 'chRoundSlug'), seedSb3)
    vm.runInContext(extractFn(CH, 'chDeptKey'), seedSb3)
    vm.runInContext(extractFn(CH, 'chRoundRecForDept'), seedSb3)
    vm.runInContext(extractFn(CH, 'chCurrentRound'), seedSb3)
    vm.runInContext(extractFn(CH, 'chUserSeed'), seedSb3)
    assert('不同学员种子不同（每人专属题序）', call(seedSb3, `chUserSeed()`) !== sFirst, '')

    // 门禁三态文案
    assert('chOpenLocked 优先取侧信道 _chOpenLocked', /_chOpenLocked/.test(extractFn(CH, 'chOpenLocked')))
    // v97：结算入口改为按视角部门实时解析（chRoundRecForDept），底层仍从 _chRounds + _chRoundCurId 结算
    assert('chRoundOpenState 从 _chRounds + _chRoundCurId 结算（v97 经 chRoundRecForDept）',
      /_chRounds/.test(extractFn(CH, 'chRoundOpenState')) && /chRoundRecForDept/.test(extractFn(CH, 'chRoundOpenState')) &&
      /_chRounds/.test(extractFn(CH, 'chRoundRecForDept')) && /_chRoundCurId/.test(extractFn(CH, 'chRoundRecForDept')))
    assert('upcoming 时 chOpenEverOpened 恒 false（文案为「未开放」而非「已结束」）', /upcoming/.test(extractFn(CH, 'chOpenEverOpened')))
    assert('chFinalExamLocked 按营次 roundExamState 结算', /roundExamState|examOpen/.test(extractFn(CH, 'chFinalExamLocked')))
    assert('chReset 标记键含营次（各期只处理一次自己的重置）', /eq_ch_reset_seen_.*rnd|'eq_ch_reset_seen_' \+ uid \+ '_' \+ rnd/.test(CH))
  }

  // ================= ⑧ 看板：营次面板与筛选 =================
  console.log('\n[8] 管理端：营次面板与按营次筛选')
  {
    const names = ['dashRoundOpenState', 'dashRoundStateTag', 'dashRoundWindowText', 'dashRoundList',
      'dashRoundCurId', 'dashRoundSlug', 'dashRoundsPanelHtml', 'dashToggleRoundForm',
      'dashParseLocalDT', 'dashCreateRound', 'dashSetRoundCur', 'dashDelRound', 'dashViewRound']
    const missing = names.filter(n => !APP.includes('function ' + n))
    assert('营次面板函数族齐备', missing.length === 0, missing.join(','))
    assert("看板营次归一与学员端同口径（空串 / 'r1' / '第一期' → 第一期）",
      /function dashRoundSlug/.test(APP) && /'第一期'/.test(extractFn(APP, 'dashRoundSlug')))
    assert('renderDashboard 渲染营次面板（取代原手动开关行）', APP.includes('dashRoundsPanelHtml()') && APP.includes('id="dashRoundsPanel"'))
    assert('renderDashChallengeBlock 按营次筛选 chy', /const recSlug = x => dashRoundSlug/.test(APP) && /matchRound|x => recSlug\(x\) === wantSlug/.test(APP) ||
      /recSlug\(x\) === wantSlug/.test(APP))
    assert('多期并存时出营次筛选按钮组（单期不出，避免噪音）', /rdList\.length > 1/.test(APP) && /dashViewRound\(this\)/.test(APP))
    assert('营次面板状态标签三态（open/upcoming/ended/closed）',
      /dashRoundOpenTag/.test(APP) && /dashRoundUpcomingTag/.test(APP) && /dashRoundEndedTag/.test(APP) && /dashRoundClosedTag/.test(APP))
    assert('新建表单用 datetime-local（管理员本地时区填排期）', /datetime-local/.test(APP) && /function dashParseLocalDT/.test(APP))
    assert('删除营次有二次确认', /dashRoundDelConfirm|confirm\(/.test(APP))
    assert('看板排期结算与云端 roundOpenState 同口径（endAt 优先）',
      /const endAt = Number\(r && r\.endAt\) \|\| 0/.test(extractFn(APP, 'dashRoundOpenState')) &&
      /if \(endAt > 0 && t0 >= endAt\) return 'ended'/.test(extractFn(APP, 'dashRoundOpenState')))

    // 行为：dashRoundOpenState 与云端 roundOpenState 三态结果一致
    const sbA = { console, Date, Number, String, JSON, Object, Array, Math, document: { getElementById: () => null } }
    vm.createContext(sbA)
    vm.runInContext(extractFn(APP, 'dashRoundOpenState'), sbA)
    const T = 1_700_000_000_000
    const cases = [
      [{ open: true }, 'open'],
      [{ open: false }, 'closed'],
      [{ open: true, startAt: T + 1 }, 'upcoming'],
      [{ open: false, startAt: T + 1 }, 'upcoming'],
      [{ open: true, endAt: T }, 'ended'],
      [{ open: true, startAt: T - 1, endAt: T + 1 }, 'open'],
      [{ open: false, startAt: T - 1, endAt: T + 1 }, 'closed'],
      [{ open: true, startAt: T + 9, endAt: T - 1 }, 'ended'],
    ]
    const bad = cases.filter(([r, want]) => call(sbA, `dashRoundOpenState(${JSON.stringify(r)}, ${T})`) !== want)
    assert('看板三态结算 8 个用例全部命中（含边界与冲突）', bad.length === 0, JSON.stringify(bad.map(([r]) => r)))

    // 云端 / 看板 同口径交叉验证（同一输入 → 同一状态）
    const sbC = makeCloudSandbox({})
    const mismatched = cases.filter(([r, want]) => JSON.parse(call(sbC, `JSON.stringify(roundOpenState(${JSON.stringify(r)}, ${T}))`)).state !== want)
    assert('云端 roundOpenState 与看板同口径', mismatched.length === 0, JSON.stringify(mismatched.map(([r]) => r)))
  }

  // ================= ⑨ i18n =================
  console.log('\n[9] i18n 双语文案')
  {
    const keys = ['chRoundLabel', 'chRoundUpcoming', 'chRoundUpcomingHint', 'chRoundWindow', 'chRoundStartAt', 'chRoundEndAt',
      'dashRoundTitle', 'dashRoundHint', 'dashRoundAddBtn', 'dashRoundNewTitle', 'dashRoundCreate',
      'dashRoundCurrent', 'dashRoundView', 'dashRoundMakeCur', 'dashRoundDel', 'dashRoundDelConfirm',
      'dashRoundOpenTag', 'dashRoundUpcomingTag', 'dashRoundEndedTag', 'dashRoundClosedTag',
      'dashRoundNoWindow', 'dashRoundCreated', 'dashRoundSwitched', 'dashRoundDeleted',
      'dashRoundFilterLabel', 'dashRoundAll', 'dashRoundStatHint', 'dashRoundScheduleHint']
    const bad = keys.filter(k => I18N.split(k + ':').length - 1 !== 2)
    assert('营次相关 i18n 键 zh/en 成对（' + keys.length + ' 个）', bad.length === 0, bad.join(','))
    // 带参数的键在两边都要有函数签名
    assert('dashRoundDelConfirm 中英均为函数（带营次名）', /dashRoundDelConfirm:\s*\(?n\)?\s*=>/.test(I18N) && (I18N.match(/dashRoundDelConfirm:/g) || []).length === 2)
  }

  console.log(testFailed ? '\n❌ v88 营次测试有断言失败' : '\n✅ v88 七天挑战营次（多期）测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
