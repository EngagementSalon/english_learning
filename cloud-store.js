// ====== Cloud Sync（跨终端数据收集）======
// 使用 textdb.dev 免费云存储：所有终端共享同一份数据文档
// 文档结构：{ v: 1, base: { <username>: 聚合统计 }, events: [最近事件] }
// 事件格式（紧凑键名）：{ id, u:用户名, n:姓名, ty:类型, ts:时间戳, d:数据 }
// 事件类型：register / login / duration / practice / exam / placement / delete / rename / role / dept
// 平台级配置（如品牌 Logo）存于文档顶层字段 logo / logoAt，不随事件折叠
// 说明：密码不进入云端，仍保存在各终端本地（账号只能在注册它的设备上登录）

const CLOUD_SYNC_URL = 'https://textdb.dev/api/data/eq-quiz-sync-8bbbde30cfb569c6'

// ====== v88 七天挑战「营次（Round）」=====
// 背景：v77-v87 的挑战是单期制——平台级 chOpen/chExamOpen 一把开关，学员进度只有一份存档
//   （localStorage eq_challenge_v2）。管理员再开一期会覆盖上一期数据，所以每期都得改代码发版。
// v88 起支持多期营次：管理员在后台自助新建营次（可设起止时间 → 到点自动开放、到期自动关闭），
//   每期有独立的存档键、题序种子与云端开关，历史期次数据完整保留、互不干扰。
// 云端 doc 结构（向下兼容，旧字段保留用于「上线时的当期」迁移）：
//   chRounds: [{ id, name, open, examOpen, examStartAt, examEndAt, startAt, endAt, at }]
//     id      营次 ID（'r1'、'r2'… 递增；上线迁移动作为 'r1'）
//     name    营次名称（如「第一期」）
//     open    手动开关（自动排期未命中时的兜底；startAt/endAt 均缺省时完全由它决定，与 v87 行为一致）
//     startAt 自动开放时间（毫秒时间戳，0 = 不限）→ 到点自动算作开放
//     endAt   自动关闭时间（毫秒时间戳，0 = 不限）→ 到期自动算作结束
//     examOpen/examStartAt/examEndAt  第 7 天期末考试的同款三件套（缺省 = 跟随手动值）
//   chRoundLevels: { <营次>: { chResets, chResetModes } }  按营次隔离的管理员重置标记
//   chRoundCur: 'r1'  当前营次 id（学员端只读写这一期；管理员可切换查看其它期）
// 自动排期口径（两侧同源：本文件 roundOpenState/roundExamState，看板 renderDashRoundBlock 同逻辑副本）：
//   任一时刻先看时间窗——未到 startAt → 未开始；已过 endAt → 已结束；
//   在窗口内（或无时间限制）→ 以手动开关 open 为准。
const ROUND_LEVEL_FIELDS = ['chOpen', 'chOpenAt', 'chExamOpen', 'chExamAt', 'chResets', 'chResetModes']

// ====== v95：管理员上传题库的云端同步（doc.upq + doc.upqAt）======
// 管理员在「批量导入 / 手动新增」写入的题只存在本机 localStorage（eq_uploaded），
// 学员端永远看不到 —— v95 起整库随同步文档走：
//   推送（管理员设备）：setUploadedBank(本地全量) → 读-改-写 doc.upq（压缩格式）+ upqAt 时间戳
//   吸收（所有设备）：_getDoc 每次拉取后 Store.absorbCloudUploaded(unpack(doc.upq), upqAt)
// 压缩格式（省容量：同步文档 1MB 上限）：{i:id, d:dept, c:category_id, t:type, f:difficulty,
//   q:question, o:options, a:answer, e:explanation}
function _upqPack(list) {
  return (Array.isArray(list) ? list : []).filter(q => q && q.id != null).map(q => ({
    i: String(q.id),
    d: q.dept || 'all',
    c: Number(q.category_id) || 1,
    t: q.type || 'single',
    f: Number(q.difficulty) || 1,
    q: String(q.question || ''),
    o: Array.isArray(q.options) ? q.options : [],
    a: Array.isArray(q.answer) ? q.answer : [],
    e: String(q.explanation || '')
  }))
}
function _upqUnpack(arr) {
  return (Array.isArray(arr) ? arr : []).filter(x => x && x.i != null).map(x => ({
    id: String(x.i),
    dept: x.d || 'all',
    category_id: Number(x.c) || 1,
    type: x.t || 'single',
    difficulty: Number(x.f) || 1,
    question: String(x.q || ''),
    options: Array.isArray(x.o) ? x.o : [],
    answer: Array.isArray(x.a) ? x.a : [],
    explanation: String(x.e || '')
  }))
}

// 归一化营次数组（脏数据兜底；无营次时返回空数组，由读取路径兜底成「默认期」）
function _roundsNorm(doc) {
  const arr = Array.isArray(doc && doc.chRounds) ? doc.chRounds : []
  const out = []
  arr.forEach((r, i) => {
    if (!r || typeof r !== 'object') return
    const id = String(r.id || '').trim()
    if (!id) return
    out.push({
      id,
      name: String(r.name || ('第 ' + (i + 1) + ' 期')),
      // v89：适用部门（空数组 = 全部部门；元素为分部门 slug 如 'dining/bar'）
      depts: Array.isArray(r.depts) ? r.depts.filter(x => typeof x === 'string' && x) : [],
      open: r.open === true,
      examOpen: r.examOpen === true,
      examStartAt: Number(r.examStartAt) || 0,
      examEndAt: Number(r.examEndAt) || 0,
      startAt: Number(r.startAt) || 0,
      endAt: Number(r.endAt) || 0,
      at: Number(r.at) || 0,
    })
  })
  return out
}
// 当前营次：doc.chRoundCur 命中则用它，否则取最后一个（最新一期）。
function _roundCurrent(doc) {
  const arr = _roundsNorm(doc)
  if (!arr.length) return null
  const cur = String((doc && doc.chRoundCur) || '')
  return arr.find(r => r.id === cur) || arr[arr.length - 1]
}
// 「上线时的当期」（v87 及更早的单期制数据）：没建过任何营次时，平台级字段就是全部状态。
function _roundLegacy(doc) {
  return {
    id: 'r1', name: '第一期',
    depts: [],
    open: (doc && doc.chOpen) === true,
    examOpen: (doc && doc.chExamOpen) === true,
    examStartAt: 0, examEndAt: 0,
    startAt: 0, endAt: 0,
    at: Number(doc && doc.chOpenAt) || 0,
  }
}
// 学员端/管理端渲染共用的已见营次 id 列表（localStorage；旧版单期进度视同 'r1'）
function _roundsSeenIds() {
  try {
    const raw = JSON.parse(localStorage.getItem('eq_ch_rounds_seen') || '[]')
    let ids = Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x) : []
    if (localStorage.getItem('eq_challenge_v2') && ids.indexOf('r1') < 0) ids = ['r1'].concat(ids)
    return ids
  } catch (e) { return [] }
}

// 某营次的重置标记与模式（v88：按营次隔离存于 doc.chRoundLevels[营次]；
// 老数据（v87 及更早）在 doc 顶层 —— 顶层即上线时的当期，只有 'r1'/'第一期' 会回落到它）。
function _roundLevels(doc, id) {
  const box = (doc && doc.chRoundLevels && typeof doc.chRoundLevels === 'object') ? doc.chRoundLevels : {}
  const lv = (box && typeof box[id] === 'object' && box[id]) || {}
  const legacy = (id === 'r1' || id === '第一期')
  const resets = (lv.chResets && typeof lv.chResets === 'object') ? lv.chResets
    : (legacy && doc && doc.chResets && typeof doc.chResets === 'object' ? doc.chResets : {})
  const modes = (lv.chResetModes && typeof lv.chResetModes === 'object') ? lv.chResetModes
    : (legacy && doc && doc.chResetModes && typeof doc.chResetModes === 'object' ? doc.chResetModes : {})
  return { chResets: resets, chResetModes: modes }
}

// ---- v88 自动排期结算（学员端与看板共用同一口径，看板 renderDashRoundBlock 内联同逻辑）----
// 时间窗（本地时区）三态：
//   endAt>0 且 now>=endAt                    → 'ended'    已结束（无视手动开关）
//   startAt>0 且 now<startAt                 → 'upcoming' 未开始
//   其余（窗口内 / 无时间限制）               → 以手动开关 open 为准
// 返回 { state, on, locked, everOpen }：
//   state     给 UI 选文案（未开始 / 进行中 / 已结束）
//   on        有效开放态（学员端门禁 chOpenLocked 用的就是它）
//   everOpen  是否「曾开放过」——决定锁定文案是「未开放」还是「已结束」
function roundOpenState(r, now) {
  const t = Number(now) || Date.now()
  const startAt = Number(r && r.startAt) || 0
  const endAt = Number(r && r.endAt) || 0
  const manual = !!(r && r.open)
  if (endAt > 0 && t >= endAt) return { state: 'ended', on: false, locked: true, everOpen: true }
  if (startAt > 0 && t < startAt) return { state: 'upcoming', on: false, locked: true, everOpen: false }
  return { state: manual ? 'open' : 'closed', on: manual, locked: !manual, everOpen: manual || !!(Number(r && r.at) > 0) }
}
// 期末考试开关：单独一道开关（v76 语义不变）——营次是否开放由 chOpenLocked 另行拦截，
// 这里不再叠加营次门禁，否则「挑战开着但考试开关开着」的 v87 存量数据会被误判为锁定。
// 有营次且填了考试时间窗时，时间窗仍然生效。
function roundExamState(r, now, openState) {
  const t = Number(now) || Date.now()
  const s = Number(r && r.examStartAt) || 0
  const e = Number(r && r.examEndAt) || 0
  if (e > 0 && t >= e) return { on: false, locked: true, everOpen: true }
  if (s > 0 && t < s) return { on: false, locked: true, everOpen: false }
  return { on: !!(r && r.examOpen), locked: !(r && r.examOpen), everOpen: !!(r && r.examOpen) }
}
// 营次「记录键」归一：chy 记录里的 rd 与 chreset 事件的 d.round 必须同口径才能对上。
//   'r1' / '' / 缺省 → ''（第一期：v87 及更早的 chy 记录本就没有 rd 字段，重置事件也走 '' 分支）
//   其余营次 → 原样（营次 id 或旧版营次名称）
// ⚠️ v102 关键约束：本函数**只做「第一期」归一，绝不能依赖营次名称**。
//   历史事故：v88 首次实现时「记录键 = 营次名称」，而 v90 把第一期从「第一期」改名成
//   「标帜餐厅七天挑战第一期」→ 所有存量记录的 rd="第一期" 与看板 wantSlug="标帜餐厅七天挑战第一期"
//   对不上，学员考完的成绩在看板全部丢失（呈现为「成绩没同步过来」）。
//   **营次名称是可变的显示字段，永远不能作为数据键**。
function _roundSlugKey(id) {
  const s = String(id == null ? '' : id).trim()
  if (!s) return ''
  if (s === 'r1' || s === '第一期') return ''   // '第一期' 是 chRoundSlug('r1') 的产物，与 r1 同键
  return s
}
// 营次 id 生成：'rN' 递增（N 取已有序号最大值 +1，避免删除后重号）
function _roundNextId(arr) {  let mx = 0
  ;(arr || []).forEach(r => {
    const m = /^r(\d+)$/.exec(String((r && r.id) || ''))
    if (m) mx = Math.max(mx, Number(m[1]))
  })
  return 'r' + (mx + 1)
}
// 新营次默认名称：序号按数组长度 +1（显示用，可被管理员覆盖）
function _roundDefaultName(arr) {
  return '第 ' + ((arr || []).length + 1) + ' 期'
}
// ---- v89 营次 × 部门 ----
// 营次适用部门匹配：r.depts 为空 → 全部部门适用（兼容 v88 存量营次）；
// 否则要求学员分部门 slug 精确命中，或其大部门命中（营次设 'dining' 时饮食部四分队都适用）。
function roundDeptMatch(r, deptSlug) {
  const list = Array.isArray(r && r.depts) ? r.depts.filter(x => x) : []
  if (!list.length) return true                 // 未限定部门 → 全部适用
  const k = String(deptSlug || '')
  if (!k) return true                           // 未登录/管理员/其他部门 → 不因部门被挡住
  if (list.indexOf(k) >= 0) return true
  const major = k.split('/')[0]
  if (list.indexOf(major) >= 0) return true     // 营次设的是大部门
  // 营次设了某个分部门、学员是同一大部门其他分部门 → 不匹配
  return false
}
// 学员端「我这一期」解析（v89）：
//   ① 优先尊重管理员的当前指针 chRoundCur —— 只要它部门匹配，就用它（v88 语义不变；
//      管理员切到哪一期，学员端就跟随哪一期，含「已切换但未到开放时间」的 upcoming 态）。
//   ② 当前指针不适用本部门（例如它是给别的分部门开的）时，退而取「本部门适用且已开放」的最新一期。
//   ③ 都不满足 → 取本部门适用的最新一期（哪怕未开放，学员端会显示对应锁定文案）。
//   ④ 本部门压根没有适用营次 → 返回 null（学员端显示「本部门暂无开营」，不再回落到别部门的期）。
// deptSlug 为空（管理员/未登录/其他部门）→ ① 永远命中，行为与 v88 完全一致。
function _roundCurrentForDept(doc, deptSlug) {
  const arr = _roundsNorm(doc)
  if (!arr.length) return _roundLegacy(doc)
  const cur = _roundCurrent(doc)
  if (cur && roundDeptMatch(cur, deptSlug)) return cur          // ①
  for (let i = arr.length - 1; i >= 0; i--) {                    // ②
    if (roundDeptMatch(arr[i], deptSlug) && roundOpenState(arr[i], Date.now()).on) return arr[i]
  }
  for (let i = arr.length - 1; i >= 0; i--) {                    // ③
    if (roundDeptMatch(arr[i], deptSlug)) return arr[i]
  }
  // ④ 无任何本部门适用营次。
  //   未登录/管理员（deptSlug 空）不可能走到这里（① 必命中），故回落 cur 仅为防御性兜底。
  //   有明确分部门却无适用期 → 返回 null，_getDoc 据此清空营次侧信道，学员端显示「暂无开营」。
  return String(deptSlug || '') ? null : cur
}
const CLOUD_EVENTS_MAX = 1500            // 云端保留的最近事件数（更早的折叠进 base 聚合）
const CLOUD_DURATION_CHUNK = 5 * 60      // 登录时长按 5 分钟分块上报（秒）
const CLOUD_PUSH_INTERVAL = 5 * 60 * 1000 // 定期推送间隔（毫秒）
const CLOUD_TIMEOUT = 8000               // fetch 超时（ms），避免永久挂起

// 带超时的 fetch：超时后 reject，不卡死
function _cloudFetch(url, options, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms || CLOUD_TIMEOUT)
  return fetch(url, Object.assign({ signal: ctrl.signal }, options))
    .finally(() => clearTimeout(timer))
}

const CloudSync = {
  status: 'offline',    // 'offline' | 'syncing' | 'online'
  _pushing: false,
  _timer: null,
  _pushTimer: null,
  _listeners: [],
  _durAcc: 0,           // 未上报的登录时长累计（毫秒）
  _user: null,          // 当前登录用户 { u, n }
  // v89：当前登录学员的分部门 slug（'dining/bar' 等）。由 app.js 在登录/切部门时写入，
  // _getDoc 据此为学员挑选「本部门适用的那一期」营次；为空（管理员/未登录/其他部门）时行为与 v88 一致。
  _deptSlug: '',

  init() {
    this._migrateLegacy()
    // 定期推送未上报事件
    this._timer = setInterval(() => this.pushPending(), CLOUD_PUSH_INTERVAL)
    // 启动后尽快推送一次（含迁移的历史数据）
    this._schedulePush(2000)
    // 页面关闭 / 切到后台：把累计时长落盘进待上报队列（下次打开自动补传）
    window.addEventListener('beforeunload', () => this.flushDuration(30000))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushDuration(30000)
        this.pushPending()
      }
    })
  },

  onStatus(cb) { this._listeners.push(cb) },
  _setStatus(s) {
    if (this.status === s) return
    this.status = s
    this._listeners.forEach(cb => { try { cb(s) } catch (e) { /* ignore */ } })
  },

  // ---------- 当前登录用户（时长归属） ----------
  setUser(u, n) { this._user = { u, n } },
  // v89：设置当前学员分部门 slug（'dining/bar'）。登录/切部门/退出时由 app.js 调用；
  // 传空字符串即「不按部门挑营次」（管理员/未登录/其他部门）。
  setDeptSlug(s) { this._deptSlug = String(s || '') },

  // ---------- 待上报队列（localStorage 持久化，断网不丢） ----------
  _queue() {
    try { return JSON.parse(localStorage.getItem('eq_pending') || '[]') } catch (e) { return [] }
  },
  _saveQueue(q) { localStorage.setItem('eq_pending', JSON.stringify(q)) },

  enqueue(ev) {
    if (!ev || !ev.u) return
    if (!ev.id) ev.id = 'ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    if (!ev.ts) ev.ts = Date.now()
    const q = this._queue()
    q.push(ev)
    if (q.length > 800) q.splice(0, q.length - 800)
    this._saveQueue(q)
    this._schedulePush(3000)
  },
  _schedulePush(delay) {
    if (this._pushTimer) clearTimeout(this._pushTimer)
    this._pushTimer = setTimeout(() => { this._pushTimer = null; this.pushPending() }, delay)
  },

  // ---------- 登录时长分块累计 ----------
  addDuration(ms, u, n) {
    if (u) this._user = { u, n }
    this._durAcc += ms
    if (this._durAcc >= CLOUD_DURATION_CHUNK * 1000) this.flushDuration(0)
  },
  flushDuration(minMs) {
    if (this._durAcc >= (minMs || 0) && this._user && this._user.u) {
      this.enqueue({ u: this._user.u, n: this._user.n, ty: 'duration', d: { sec: Math.round(this._durAcc / 1000) } })
      this._durAcc = 0
    }
  },

  // ---------- 云端读写 ----------
  async _getDoc() {
    const r = await _cloudFetch(CLOUD_SYNC_URL, { cache: 'no-store' })
    if (!r.ok) throw new Error('cloud GET ' + r.status)
    const txt = await r.text()
    const doc = JSON.parse(txt)
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.events)) throw new Error('bad cloud doc')
    // v95：管理员上传题库吸收（doc.upq）。所有拉取路径都经此处 → 学员端/其他管理设备
    // 都能拿到最新上传题；幂等由 Store.absorbCloudUploaded 内部的 upqAt 判断保证。
    if (doc.upq && typeof Store !== 'undefined' && typeof Store.absorbCloudUploaded === 'function') {
      try { Store.absorbCloudUploaded(_upqUnpack(doc.upq), doc.upqAt) } catch (e) { /* 吸收失败不阻断拉取 */ }
    }
    // v88 侧信道：七天挑战「营次」。所有拉取路径（周期探测 / fetchSyncSummary / getDashboardData /
    // 开关写后校验）都经此处，学员端/管理端读 CloudSync._chRounds / _chRoundCurId 即得最新状态。
    const rounds = _roundsNorm(doc)
    // v89：学员端按「自己的分部门」挑营次（各分部门可同时进行不同期次）；
    // 管理端/未登录/其他部门 → deptSlug 为空 → _roundCurrentForDept 行为与 v88 完全一致。
    const depSlug = (typeof this._deptSlug === 'string') ? this._deptSlug : ''
    const cur = _roundCurrentForDept(doc, depSlug)
    this._chRounds = rounds
    this._chHasRounds = rounds.length > 0
    // v89：本部门无任何适用营次 → cur 为 null。此时清空全部营次侧信道 = 「本部门暂无开营」，
    // 学员端挑战入口显示未开放（chOpenLocked 为 true），且不携带别部门的期次信息。
    this._chNoRound = !cur
    const curId = cur ? cur.id : ''
    const curName = cur ? cur.name : ''
    const curDepts = cur && Array.isArray(cur.depts) ? cur.depts : []
    const curAt = cur ? (cur.at || 0) : 0
    const curStartAt = cur ? cur.startAt : 0
    const curEndAt = cur ? cur.endAt : 0
    this._chRoundCurId = curId
    this._chRoundCurName = curName
    this._chRoundCurDepts = curDepts
    this._chRoundSeen = _roundsSeenIds()
    // v88：以下平台级侧信道统一取自「当前营次」——v76/v77/v83 的读取方（challenge.js 门禁、
    // 挑战重置检测、看板徽章）无需改动即自动跟随营次；自动排期在此结算为有效值。
    const effOpen = cur ? roundOpenState(cur, Date.now()) : { state: 'closed', on: false, locked: true, everOpen: false }
    const effExam = cur ? roundExamState(cur, Date.now(), effOpen) : { on: false, locked: true, everOpen: false }
    // v76 侧信道：七天挑战期末考试开关（默认缺省=关闭）
    this._chExamOpen = effExam.on
    // v77 侧信道：七天挑战整体开关（默认缺省=关闭）+ 最近一次开放时间。
    // 关闭时保留 chOpenAt → 学员端据「曾开放过」区分「未开放 / 已结束」两种锁定文案。
    this._chOpen = effOpen.on
    this._chOpenAt = curAt
    this._chOpenLocked = effOpen.locked
    this._chStartAt = curStartAt
    this._chEndAt = curEndAt
    // v83 侧信道：七天挑战重置标记（按营次存于 doc.chRoundLevels[营次]；无营次容器时回落到 doc 顶层，
    // 即 v87 的布局 —— 顶层字段永远是「第一期」的家）。
    // 管理员重置后，该学员端读到比本地已处理标记更新的值 → 按模式处理本地记录：
    //   chResetModes[用户名] === 'exam'（v84 起唯一模式）→ 只清两场水平测试成绩，练习进度保留
    //   无模式记录（v83 旧数据）→ 兼容为整表清空（回到 Day1）
    // 注意：这里不做营次开放判定 —— 重置标记终须到达学员端，才能保证其本地存档同步清理；
    //   挑战是否可进入另由 _chOpenLocked 拦截，两者互不干扰。
    const lv = _roundLevels(doc, curId)
    this._chResets = lv.chResets
    this._chResetModes = lv.chResetModes
    try { localStorage.setItem('eq_cloud_cache', txt) } catch (e) { /* ignore */ }
    return doc
  },
  async _putDoc(doc) {
    const body = JSON.stringify(doc)
    const r = await _cloudFetch(CLOUD_SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
    if (!r.ok) throw new Error('cloud PUT ' + r.status)
    try { localStorage.setItem('eq_cloud_cache', body) } catch (e) { /* ignore */ }
  },

  // 推送待上报事件到云端（读-合并-写，写后校验，最多重试 2 次）
  async pushPending() {
    if (this._pushing) return
    const q0 = this._queue()
    if (!q0.length) {
      // 空队列也顺手探测一次云端可达性（静默）
      try { await this._getDoc(); this._setStatus('online') } catch (e) { this._setStatus('offline') }
      return
    }
    this._pushing = true
    this._setStatus('syncing')
    try {
      let remaining = q0.slice()
      for (let attempt = 0; attempt < 3 && remaining.length; attempt++) {
        const pushStart = Date.now()
        const doc = await this._getDoc()
        const exist = new Set(doc.events.map(e => e.id))
        const fresh = remaining.filter(e => !exist.has(e.id))
        if (fresh.length) {
          doc.events.push(...fresh)
          // 事件过多时把旧事件折叠进 base 聚合（计数不丢失）
          if (doc.events.length > CLOUD_EVENTS_MAX) {
            const cut = doc.events.length - Math.floor(CLOUD_EVENTS_MAX / 2)
            doc.base = doc.base || {}
            doc.events.slice(0, cut).forEach(ev => this._apply(doc.base, ev))
            doc.events = doc.events.slice(cut)
            doc.trimmedAt = Date.now()
          }
          await this._putDoc(doc)
          // 写后校验：抽查最新事件是否还在（被并发覆盖则重试；
          // 若刚发生过折叠 trimmedAt 会更新，说明数据已进聚合，视为成功）
          const check = await this._getDoc()
          const probe = fresh[fresh.length - 1].id
          const ok = check.events.some(e => e.id === probe)
            || (check.trimmedAt && check.trimmedAt >= pushStart - 10000)
          if (!ok) continue
        }
        const pushed = new Set(fresh.map(e => e.id))
        remaining = this._queue().filter(e => !pushed.has(e.id))
        break
      }
      this._saveQueue(remaining)
      this._setStatus('online')
    } catch (e) {
      this._setStatus('offline')
    } finally {
      this._pushing = false
    }
  },

  // ---------- 平台品牌 Logo（全平台同步）----------
  // 说明：Logo 存于云文档顶层字段 logo（小尺寸 dataURL，上传前已压缩至 ~100KB 内）。
  // 采用 读-改-写 + 写后校验重试 循环：若与其他设备的并发写互相覆盖，未生效的一方会自动重试；
  // 普通事件推送同样基于「读最新文档再合并」，不会把 logo 字段冲掉。
  // 写入成功后启动守护定时复查：即使随后被其它设备的「读旧文档写回」覆盖，也会在数十秒内自动修复。
  // dataUrl 为空字符串 → 删除云端 Logo（恢复默认）。
  _logoGuardTimer: null,
  _logoGuardDelay: 5000,   // 守护首次延迟（ms）；测试可改小
  // ---------- v95：管理员上传题库推送（doc.upq） ----------
  // 本地全量上传库 → 云端。读-改-写 + 写后校验重试（同 setCloudLogo 模式）；
  // 合并语义：本地为权威（正在编辑的设备），但保留远端独有的题（其他管理设备上传的），
  // 避免两台管理设备互相清掉对方的题。成功返回 { ok:true }；网络失败返回 { ok:false }。
  async setUploadedBank(localList) {
    const local = Array.isArray(localList) ? localList : []
    let saved = false
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try {
        const doc = await this._getDoc()
        const remote = _upqUnpack(doc.upq)
        const have = new Set(local.map(q => String(q.id)))
        const merged = local.concat(remote.filter(q => !have.has(String(q.id))))
        doc.upq = _upqPack(merged)
        doc.upqAt = Date.now()
        await this._putDoc(doc)
        const check = await this._getDoc()
        if (check && Number(check.upqAt) === doc.upqAt) saved = true
      } catch (e) { /* 网络波动 → 重试 */ }
    }
    return saved ? { ok: true } : { ok: false, reason: 'network' }
  },

  async setCloudLogo(dataUrl) {
    const val = String(dataUrl || '')
    let saved = false
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try {
        const doc = await this._getDoc()
        if (val) {
          doc.logo = val
          doc.logoAt = Date.now()
        } else {
          delete doc.logo
          delete doc.logoAt
        }
        await this._putDoc(doc)
        const check = await this._getDoc()
        if (String(check.logo || '') === val) saved = true
      } catch (e) { /* 网络波动等 → 重试 */ }
    }
    if (saved && val) this._scheduleLogoGuard(val)
    return saved ? { ok: true } : { ok: false, reason: 'network' }
  },

  // 平台 Logo 守护：上传后数次复查云端，若被并发设备覆盖（读旧文档写回）则自动重写修复
  _scheduleLogoGuard(val) {
    if (this._logoGuardTimer) clearTimeout(this._logoGuardTimer)
    let tries = 0
    const heal = async () => {
      tries++
      try {
        const doc = await this._getDoc()
        if (String(doc.logo || '') !== val) {
          doc.logo = val
          doc.logoAt = Date.now()
          await this._putDoc(doc)
        }
      } catch (e) { /* 网络波动 → 下次再试 */ }
      if (tries < 3) this._logoGuardTimer = setTimeout(heal, Math.max(1000, this._logoGuardDelay))
    }
    this._logoGuardTimer = setTimeout(heal, Math.max(50, this._logoGuardDelay))
  },

  // ---------- 七天挑战期末考试开关（v76；v88 起按营次） ----------
  // 说明：开关存于当前营次的 examOpen 字段（缺省 = 关闭）；v88 前存于 doc 顶层 chExamOpen，
  // 由 _roundLegacy 兜底为「第一期」读取，故旧数据行为不变。
  // 管理员开启后，学员端才可进入第 7 天期末考试（Day1 摸底测试不受影响）。
  // 读-改-写 + 写后校验重试；成功后立即同步本地侧信道，无需等待下次拉取。
  // open 可传布尔值，或 { open, startAt, endAt } 对象（排期设置，见 setChallengeRound）。
  async setChallengeExamOpen(open) {
    const spec = (open && typeof open === 'object') ? open : { open: open }
    const val = spec.open === true
    const setAt = Number(spec.startAt) || 0
    const setEnd = Number(spec.endAt) || 0
    const hasSchedule = ('startAt' in spec) || ('endAt' in spec)
    let saved = false
    let wantId = ''      // v101：写后校验按营次记录读回（v88 起开关存在营次里，读顶层会永远失配）
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try {
        const doc = await this._getDoc()
        const cur = _roundCurrent(doc)
        if (cur) {
          const arr = _roundsNorm(doc)
          const rec = arr.find(r => r.id === cur.id)
          if (!rec) throw new Error('round missing')
          rec.examOpen = val
          if (hasSchedule) { rec.examStartAt = setAt; rec.examEndAt = setEnd }
          rec.at = rec.at || Date.now()
          doc.chRounds = arr
          wantId = cur.id
        } else {
          // 兼容路径（尚无营次）：维持 v87 的顶层字段写法
          doc.chExamOpen = val
          doc.chExamAt = Date.now()
          wantId = ''
        }
        await this._putDoc(doc)
        const check = await this._getDoc()
        // v101 修复：有营次时校验营次记录的 examOpen（原代码恒定读顶层 chExamOpen → 永远 false → 恒报「失败」）
        if (wantId) {
          const chk = _roundsNorm(check).find(r => r.id === wantId)
          if (chk && chk.examOpen === val) saved = true
        } else if (check.chExamOpen === val) saved = true
      } catch (e) { /* 网络波动等 → 重试 */ }
    }
    if (saved) {
      this._chExamOpen = val
      if (this._chRounds && this._chRounds.length) {
        const rec = this._chRounds.find(r => r.id === this._chRoundCurId)
        if (rec) {
          rec.examOpen = val
          if (hasSchedule) { rec.examStartAt = setAt; rec.examEndAt = setEnd }
        }
      }
    }
    return saved ? { ok: true } : { ok: false, reason: 'network' }
  },

  // ---------- 七天挑战开放开关（v77；v88 起按营次） ----------
  // 说明：开关存于当前营次的 open 字段（缺省 = 关闭）；v88 前存于 doc 顶层 chOpen，
  // 由 _roundLegacy 兜底为「第一期」读取，故旧数据行为不变。
  // 开放时写 at=now；关闭时保留 at（学员端据此显示「已结束」而非「未开放」）。
  // open 可传布尔值，或 { open, startAt, endAt } 对象（排期设置：到点自动开放、到期自动关闭）。
  // 读-改-写 + 写后校验重试；成功后立即同步本地侧信道，无需等待下次拉取。
  async setChallengeOpen(open) {
    const spec = (open && typeof open === 'object') ? open : { open: open }
    const val = spec.open === true
    const setAt = Number(spec.startAt) || 0
    const setEnd = Number(spec.endAt) || 0
    const hasSchedule = ('startAt' in spec) || ('endAt' in spec)
    let saved = false
    let wantId = ''      // v101：写后校验按营次记录读回（同 setChallengeExamOpen 的失配问题）
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try {
        const doc = await this._getDoc()
        const cur = _roundCurrent(doc)
        if (cur) {
          const arr = _roundsNorm(doc)
          const rec = arr.find(r => r.id === cur.id)
          if (!rec) throw new Error('round missing')
          rec.open = val
          if (hasSchedule) { rec.startAt = setAt; rec.endAt = setEnd }
          if (val) rec.at = Date.now()
          doc.chRounds = arr
          wantId = cur.id
        } else {
          doc.chOpen = val
          if (val) doc.chOpenAt = Date.now()
          wantId = ''
        }
        await this._putDoc(doc)
        const check = await this._getDoc()
        // v101 修复：有营次时校验营次记录的 open（原读顶层 chOpen → 恒失配 → 恒报「失败」）
        if (wantId) {
          const chk = _roundsNorm(check).find(r => r.id === wantId)
          if (chk && chk.open === val) saved = true
        } else if (check.chOpen === val) saved = true
      } catch (e) { /* 网络波动等 → 重试 */ }
    }
    if (saved) {
      this._chOpen = val
      const rec = (this._chRounds || []).find(r => r.id === this._chRoundCurId)
      if (rec) {
        rec.open = val
        if (hasSchedule) { rec.startAt = setAt; rec.endAt = setEnd }
        if (val) rec.at = Date.now()
        this._chOpenAt = rec.at
      } else if (val) {
        this._chOpenAt = Date.now()
      }
    }
    return saved ? { ok: true } : { ok: false, reason: 'network' }
  },

  // ---------- 营次管理（v88） ----------
  // 所有写操作统一走 _roundWrite：读-改-写 + 写后校验重试 4 次。
  // mutator(doc, rounds) 直接改 rounds 数组（及任意 doc 字段），返回 false 表示校验失败条件。
  async _roundWrite(mutator, verify) {
    let saved = false
    let detail = null
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try {
        const doc = await this._getDoc()
        const rounds = _roundsNorm(doc)
        const r = mutator(doc, rounds)
        if (r === false) return { ok: false, reason: 'invalid' }
        detail = r || null
        doc.chRounds = rounds
        await this._putDoc(doc)
        const check = await this._getDoc()
        if (typeof verify === 'function' ? verify(check) : true) saved = true
      } catch (e) { /* 网络波动等 → 重试 */ }
    }
    if (!saved) return { ok: false, reason: 'network' }
    return { ok: true, doc: detail }
  },
  _roundSeenAdd(id) {
    try {
      const ids = _roundsSeenIds()
      if (id && ids.indexOf(id) < 0) { ids.push(id); localStorage.setItem('eq_ch_rounds_seen', JSON.stringify(ids)) }
    } catch (e) { /* ignore */ }
    this._chRoundSeen = _roundsSeenIds()
  },
  // 新建营次。opts = { name, open, examOpen, startAt, endAt, examStartAt, examEndAt, makeCurrent }
  // 新营次默认「未开放」（除非显式 open:true）——避免误点把全班推进新一期。
  async addChallengeRound(opts) {
    const o = opts || {}
    let newId = ''
    const res = await this._roundWrite((doc, rounds) => {
      // 首次建营次时，先把 v87 之前的单期状态迁成「第一期」，历史数据不丢
      if (!rounds.length) {
        const legacy = _roundLegacy(doc)
        rounds.push(legacy)
        if (!doc.chRoundCur) doc.chRoundCur = legacy.id
      }
      newId = _roundNextId(rounds)
      const startAt = Number(o.startAt) || 0
      const endAt = Number(o.endAt) || 0
      const manual = o.open === true
      rounds.push({
        id: newId,
        name: String(o.name || '').trim() || _roundDefaultName(rounds),
        depts: Array.isArray(o.depts) ? o.depts.filter(x => typeof x === 'string' && x) : [],
        open: manual,
        examOpen: o.examOpen === true,
        examStartAt: Number(o.examStartAt) || 0,
        examEndAt: Number(o.examEndAt) || 0,
        startAt, endAt,
        at: manual ? Date.now() : 0,
      })
      doc.chRoundCur = newId   // 新建即设为当前营次（学员端切换依据）
      return { id: newId }
    }, check => {
      const arr = _roundsNorm(check)
      return arr.some(r => r.id === newId)
    })
    if (res.ok) this._roundSeenAdd(newId)
    return res.ok ? { ok: true, id: newId } : res
  },
  // 更新某营次字段。patch = { name, open, examOpen, startAt, endAt, examStartAt, examEndAt }
  // 注意：这里 open/examOpen 一律按布尔值写入（不带 startAt/endAt 的排期修改请用 setChallengeOpen）。
  async setChallengeRound(id, patch) {
    const rid = String(id || '')
    if (!rid) return { ok: false, reason: 'noround' }
    const p = patch || {}
    let applied = false
    const res = await this._roundWrite((doc, rounds) => {
      const rec = rounds.find(r => r.id === rid)
      if (!rec) return false
      if ('name' in p) rec.name = String(p.name || '').trim() || rec.name
      if ('depts' in p) rec.depts = Array.isArray(p.depts) ? p.depts.filter(x => typeof x === 'string' && x) : []
      if ('open' in p) { rec.open = p.open === true; if (rec.open) rec.at = Date.now() }
      if ('examOpen' in p) rec.examOpen = p.examOpen === true
      if ('startAt' in p) rec.startAt = Number(p.startAt) || 0
      if ('endAt' in p) rec.endAt = Number(p.endAt) || 0
      if ('examStartAt' in p) rec.examStartAt = Number(p.examStartAt) || 0
      if ('examEndAt' in p) rec.examEndAt = Number(p.examEndAt) || 0
      applied = true
      return { id: rid }
    }, check => {
      if (!applied) return true
      const arr = _roundsNorm(check)
      return arr.some(r => r.id === rid)
    })
    return applied ? (res.ok ? { ok: true, id: rid } : res) : { ok: false, reason: 'noround' }
  },
  // 切换当前营次（chRoundCur）——学员端只读写这一期。
  async setChallengeRoundCurrent(id) {
    const rid = String(id || '')
    if (!rid) return { ok: false, reason: 'noround' }
    let existed = false
    const res = await this._roundWrite((doc, rounds) => {
      if (!rounds.some(r => r.id === rid)) return false
      existed = true
      doc.chRoundCur = rid
      return { id: rid }
    }, check => String(check.chRoundCur || '') === rid)
    if (!existed) return { ok: false, reason: 'noround' }
    if (res.ok) this._roundSeenAdd(rid)
    return res.ok ? { ok: true, id: rid } : res
  },
  // 删除营次。顺带清掉该营次的考试重置标记（doc.chRoundLevels[营次]）。
  // 不清理学员浏览器里该期的本地存档（换机器不可控），但当前营次被删时会回落到最新一期。
  async deleteChallengeRound(id) {
    const rid = String(id || '')
    if (!rid) return { ok: false, reason: 'noround' }
    let existed = false
    const res = await this._roundWrite((doc, rounds) => {
      const i = rounds.findIndex(r => r.id === rid)
      if (i < 0) return false
      existed = true
      rounds.splice(i, 1)
      if (doc.chRoundLevels && typeof doc.chRoundLevels === 'object') delete doc.chRoundLevels[rid]
      if (String(doc.chRoundCur || '') === rid) doc.chRoundCur = rounds.length ? rounds[rounds.length - 1].id : ''
      return { id: rid }
    }, check => !_roundsNorm(check).some(r => r.id === rid))
    return existed ? (res.ok ? { ok: true, id: rid } : res) : { ok: false, reason: 'noround' }
  },

  // ---------- 重置某学员的七天挑战考试成绩（管理员触发，v83 引入 / v84 收窄口径 / v88 按营次） ----------
  // v84 起只重置「考试」：Day1 摸底 + Day7 期末考试（kind==='test' 的水平测试）成绩清零、可重新参加考试；
  // 练习进度（Day1-7 巩固练习）、每日打卡、挑战错题、练习部分积分全部保留。
  // v88：重置标记按营次隔离（doc.chRoundLevels[当前营次]），重置只作用于当前营次，不影响其他期。
  // 两件事一起做，缺一不可：
  //   ① doc.chRoundLevels[当前营次].chResets[<用户名>] = 时间戳 + chResetModes[<用户名>] = 'exam'
  //      （当前营次为 'r1' 且尚无该容器时，兼容写回 doc 顶层 chResets/chResetModes —— v87 布局）
  //      → 该学员端读到更新标记后只删本地测试阶段记录（练习阶段记录是解锁权威，必须同步处理）
  //   ② 推送 chreset 事件（d.mode='exam' + d.round=当前营次）→ 云端聚合表过滤掉该学员该营次
  //      chy 中 kind==='test' 的记录，看板等所有读取路径都是 base + events 重放，于是自然生效；
  //      事件按时间顺序重放，重置之后重新考试提交的 chy 会正常累计（不会误删新成绩）。
  // 不清：题库级全局聚合 __q、普通练习明细 perQ、挑战错题 chQ（非考试成绩数据）。
  async setChallengeReset(username, name) {
    const u = String(username || '')
    if (!u) return { ok: false, reason: 'nouser' }
    const at = Date.now()
    let round = ''
    let saved = false
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try {
        const doc = await this._getDoc()
        const cur = _roundCurrent(doc)
        round = cur ? cur.id : ''
        if (round) {
          doc.chRoundLevels = (doc.chRoundLevels && typeof doc.chRoundLevels === 'object') ? doc.chRoundLevels : {}
          const box = doc.chRoundLevels[round] || (doc.chRoundLevels[round] = {})
          box.chResets = box.chResets || {}
          box.chResets[u] = at
          box.chResetModes = box.chResetModes || {}
          box.chResetModes[u] = 'exam'
          // 第一期始终镜像到顶层（v87 及更早的学员端/看板只认顶层字段）
          if (round === 'r1') {
            doc.chResets = box.chResets
            doc.chResetModes = box.chResetModes
          }
        } else {
          doc.chResets = doc.chResets || {}
          doc.chResets[u] = at
          doc.chResetModes = doc.chResetModes || {}
          doc.chResetModes[u] = 'exam'
        }
        await this._putDoc(doc)
        const check = await this._getDoc()
        const box = (check.chRoundLevels && check.chRoundLevels[round]) || {}
        const got = round ? Number((box.chResets || {})[u]) : Number((check.chResets || {})[u])
        const mode = round ? (box.chResetModes || {})[u] : (check.chResetModes || {})[u]
        if (got === at && mode === 'exam') saved = true
      } catch (e) { /* 网络波动等 → 重试 */ }
    }
    if (!saved) return { ok: false, reason: 'network' }
    // 聚合表清考试成绩（事件进队列；推送失败也不影响，队列留待下次周期推送）
    this.enqueue({ u, n: name || u, ty: 'chreset', ts: at, d: { mode: 'exam', round: _roundSlugKey(round) } })
    try { await this.pushPending() } catch (e) { /* 保留在队列 */ }
    return { ok: true, at, round }
  },

  // ---------- 聚合 ----------
  // 把一条事件应用到用户聚合表 map（可直接用于云端 base 或本地聚合）
  _apply(map, ev) {
    if (!ev || !ev.u) return
    if (ev.ty === 'delete') { delete map[ev.u]; return }
    // 用户名迁移：把旧用户名的聚合记录搬到新用户名下（同名已存在则合并计数）
    if (ev.ty === 'rename') {
      const nu = ev.d && ev.d.nu
      if (!nu || nu === ev.u) return
      const r = map[ev.u]
      if (r) {
        const tgt = map[nu]
        if (tgt) {
          // 新旧用户名都有记录：合并（计数相加、取非空字段）
          tgt.loginCount = (tgt.loginCount || 0) + (r.loginCount || 0)
          tgt.loginSec = (tgt.loginSec || 0) + (r.loginSec || 0)
          tgt.practiceCount = (tgt.practiceCount || 0) + (r.practiceCount || 0)
          tgt.practiceCorrect = (tgt.practiceCorrect || 0) + (r.practiceCorrect || 0)
          tgt.practiceTotal = (tgt.practiceTotal || 0) + (r.practiceTotal || 0)
          tgt.examCount = (tgt.examCount || 0) + (r.examCount || 0)
          tgt.examScoreSum = (tgt.examScoreSum || 0) + (r.examScoreSum || 0)
          tgt.examBest = Math.max(tgt.examBest || 0, r.examBest || 0)
          tgt.examPassCount = (tgt.examPassCount || 0) + (r.examPassCount || 0)
          tgt.createdAt = Math.min(tgt.createdAt || ev.ts, r.createdAt || ev.ts)
          tgt.lastActive = Math.max(tgt.lastActive || 0, r.lastActive || 0)
          if (ev.n) tgt.name = ev.n
          // 合并每道题答题明细
          if (r.perQ) {
            tgt.perQ = tgt.perQ || {}
            Object.keys(r.perQ).forEach(qid => {
              const a = r.perQ[qid], b = tgt.perQ[qid]
              tgt.perQ[qid] = {
                correct: (b ? b.correct : 0) + a.correct,
                total: (b ? b.total : 0) + a.total
              }
            })
          }
          // 合并七天挑战错题明细
          if (r.chQ) {
            tgt.chQ = tgt.chQ || {}
            Object.keys(r.chQ).forEach(qid => {
              const a = r.chQ[qid], b = tgt.chQ[qid]
              tgt.chQ[qid] = {
                correct: (b ? b.correct : 0) + a.correct,
                total: (b ? b.total : 0) + a.total
              }
            })
          }
          // 合并七天挑战阶段完成记录
          if (r.chy && r.chy.length) tgt.chy = (tgt.chy || []).concat(r.chy)
        } else {
          map[nu] = Object.assign({}, r, { username: nu })
        }
        delete map[ev.u]
      }
      return
    }
    const r = map[ev.u] || (map[ev.u] = {
      username: ev.u, name: '', dept: '', role: 'student', createdAt: 0,
      loginCount: 0, loginSec: 0,
      practiceCount: 0, practiceCorrect: 0, practiceTotal: 0,
      examCount: 0, examScoreSum: 0, examBest: 0, examPassCount: 0,
      placementLevel: 0, lastActive: 0,
      perQ: {}   // 每道题答题明细：perQ[qid] = { correct, total }
    })
    if (ev.n) r.name = ev.n
    if (ev.ts > (r.lastActive || 0)) r.lastActive = ev.ts
    const d = ev.d || {}
    switch (ev.ty) {
      case 'register':
        if (d.name) r.name = d.name
        if (d.dept) r.dept = d.dept
        if (d.role) r.role = d.role
        if (!r.createdAt) r.createdAt = ev.ts
        if (d.level && !r.placementLevel) r.placementLevel = d.level
        // —— 密码哈希凭据（不可逆）同步到云端 map，供其他设备离线校验登录 ——
        if (d.ph) r.ph = d.ph
        if (d.salt) r.salt = d.salt
        break
      case 'role':
        // 管理员权限变更（设为管理员 / 取消管理员）
        if (d.role) r.role = d.role
        break
      case 'dept':
        // 管理员调整学员所属部门（空串 = 清除部门）
        if (d.dept !== undefined) r.dept = String(d.dept || '')
        break
      case 'perq':
        // 单题答题对错上报。v75 瘦身（200 人规模容量优化）：
        //   全局每题正确率聚合 map.__q[qid] = [correct, total]（跨学员合并、随 base 折叠保留，
        //   正确率看板数据源）；个人明细只记错题：普通作答答错 → r.perQ[qid] = {correct:0, total:错次}，
        //   答对不再逐题记录（整体正确率由 __q 支撑，个人体积降为 O(错题数)）；
        //   七天挑战错答（d.ch）→ r.chQ[qid]（不变，不进全局正确率）
        if (d.qid != null) {
          const qid = String(d.qid)
          if (d.ch) {
            const t2 = (r.chQ = r.chQ || {})
            const rec2 = t2[qid] || (t2[qid] = { correct: 0, total: 0 })
            rec2.total += 1
            if (d.correct) rec2.correct += 1
          } else {
            const q = (map.__q = map.__q || {})
            const agg = q[qid] || (q[qid] = [0, 0])
            agg[1] += 1
            if (d.correct) agg[0] += 1
            if (!d.correct) {
              // 兜底：base 里的老用户记录可能没有 perQ 字段（早期版本折叠产物），必须先补空表
              const t3 = (r.perQ = r.perQ || {})
              const rec3 = t3[qid] || (t3[qid] = { correct: 0, total: 0 })
              rec3.total += 1
            }
          }
        }
        break
      case 'chy':
        // v71 七天挑战阶段完成上报：保留每次完成记录（练习重练多条；水平测试仅一条）
        // v73：usedSec = 阶段净用时秒（积分榜用；旧事件无此字段按 0，不影响积分）
        // v88：rd = 营次 id（缺省 '' = 第一期/单期制旧数据）
        r.chy = r.chy || []
        r.chy.push({
          day: Number(d.day) || 0, si: Number(d.si) || 0, kind: String(d.kind || 'practice'),
          correct: Number(d.correct) || 0, total: Number(d.total) || 0,
          usedSec: Number(d.usedSec) || 0, at: ev.ts, rd: _roundSlugKey(d.rd),
        })
        break
      case 'chreset':
        // 管理员重置该学员的挑战记录：v84 起默认只清「考试成绩」——把 chy 中的水平测试记录
        //（kind==='test'：Day1 摸底 / Day7 期末）降级为「已重置存根」：保留 day/si/kind/at 供进度与每日打卡统计，
        // 清零 correct/total/usedSec（看板两列成绩显示「—」，积分不再计入该场考试；重考后写入的新记录正常计分）。
        // d.mode 缺省 / 'all'（v83 旧事件）→ 兼容为整表清空（chy 与挑战错题 chQ）。
        // v88：d.round = 营次 id；只作用于该营次的 chy 记录（'' = 第一期/单期制旧数据，与 x.rd 缺省对齐）。
        // 题库级全局聚合 __q 与普通练习明细 perQ 不受影响（非挑战数据）。
        const rids = _roundSlugKey(d.round)
        const inRound = x => _roundSlugKey(x && x.rd) === rids
        if (d.mode === 'exam') {
          // 只降级「重置之前」的测试记录（x.at <= ev.ts）→ 事件重放幂等，重考产生的新成绩不会被重复清除
          r.chy = (r.chy || []).map(x => (x && x.kind === 'test' && !x.cleared && inRound(x) && (x.at || 0) <= ev.ts)
            ? { day: x.day, si: x.si, kind: 'test', correct: 0, total: 0, usedSec: 0, at: x.at, rd: _roundSlugKey(x.rd), cleared: true }
            : x)
        } else {
          // v83 旧口径（整表清空）：该营次的挑战阶段记录；挑战错题 chQ 未按营次存储，
          // 仅在「第一期/单期制」（rd=''）时一并清空，避免清一期误伤另一期的错题排行。
          r.chy = (r.chy || []).filter(x => !inRound(x))
          if (rids === '') r.chQ = {}
        }
        r.chResetAt = ev.ts
        r.chResetMode = d.mode === 'exam' ? 'exam' : 'all'
        break
      case 'perqfix':
        // v38 看字选音发音修复：无效错答从每题统计的分母中剔除（correct 不变——错答本就未计入）
        if (d.qid != null) {
          const qidF = String(d.qid)
          // v75：全局聚合分母同步剔除（不低于已答对数）
          if (map.__q && map.__q[qidF]) {
            map.__q[qidF][1] = Math.max(map.__q[qidF][0], map.__q[qidF][1] - (d.wrongFix || 1))
          }
          // 个人错题明细：错次回退（答对者无条目，自然跳过）；清零即移除条目（v75 省体积）
          const recF = r.perQ && r.perQ[qidF]
          if (recF) {
            recF.total = Math.max(recF.correct || 0, recF.total - (d.wrongFix || 1))
            if (recF.total <= 0) delete r.perQ[qidF]
          }
        }
        break
      case 'examfix':
        // v38 考试分数修正：无效看字选音错题补回后重算（examCount 不变；best 只升不降）
        {
          const oldS = Number(d.scoreOld) || 0
          const newS = Number(d.scoreNew) || 0
          if (newS !== oldS) r.examScoreSum = (r.examScoreSum || 0) + (newS - oldS)
          if ((r.examBest || 0) < newS) r.examBest = newS
          if (!d.passedOld && d.passedNew) r.examPassCount = (r.examPassCount || 0) + 1
        }
        break
      case 'login': r.loginCount++; break
      case 'duration': r.loginSec += Math.round(d.sec || 0); break
      case 'practice':
        r.practiceCount++
        r.practiceCorrect += d.correct || 0
        r.practiceTotal += d.total || 0
        break
      case 'exam':
        r.examCount++
        r.examScoreSum += d.score || 0
        r.examBest = Math.max(r.examBest || 0, d.score || 0)
        if (d.passed) r.examPassCount++
        break
      case 'placement':
        if (d.level != null) r.placementLevel = d.level
        if (d.perLevel) r.placementPerLevel = d.perLevel
        if (d.score != null) r.placementScore = d.score
        if (d.total != null) r.placementTotal = d.total
        // 清空标记：清除 perLevel/score/total
        if (d.level === 0) {
          delete r.placementPerLevel
          delete r.placementScore
          delete r.placementTotal
        }
        break
    }
  },

  // ---------- 拉取云端 events 并应用到本地 users 表（跨设备角色/改名/删除同步） ----------
  // 调用方应负责把 CloudSync 暴露的字段名（username）映射回本地的账号表主键（id）
  // 返回结构：{ ok, doc, base, appliedUsers, appliedRole, appliedRename, appliedDelete, appliedRegister }
  async fetchSyncSummary() {
    let doc
    try {
      doc = await this._getDoc()
    } catch (e) {
      try {
        const cached = localStorage.getItem('eq_cloud_cache')
        if (cached) {
          doc = JSON.parse(cached)
          if (!doc || !Array.isArray(doc.events)) doc = null
        }
      } catch (e2) {}
      if (!doc) return { ok: false, reason: 'offline' }
    }
    // 重新构建包含 base + events 的聚合表（与看板同样的合并方式）
    const map = {}
    Object.keys(doc.base || {}).forEach(u => {
      // v75：__q 等内部聚合键不是用户，原样放入（不加 username，避免混进看板名单）
      if (u.charAt(0) === '_') { map[u] = doc.base[u]; return }
      map[u] = Object.assign({}, doc.base[u], { username: u })
    })
    const events = (doc.events || []).concat(this._queue())
    events.forEach(ev => this._apply(map, ev))
    return { ok: true, doc, map }
  },

  // 管理员看板数据：云端 base + 云端事件 + 本机未上报事件
  // 云端不可达时回退本地缓存
  async getDashboardData() {
    let doc
    try {
      doc = await this._getDoc()
    } catch (e) {
      // 超时/网络错误：尝试本地缓存
      try {
        const cached = localStorage.getItem('eq_cloud_cache')
        if (cached) {
          doc = JSON.parse(cached)
          if (!doc || !Array.isArray(doc.events)) doc = null
        }
      } catch (e2) {}
      if (!doc) return null  // 无缓存 → 调用方走本地统计
    }
    const map = {}
    Object.keys(doc.base || {}).forEach(u => {
      // v75：__q 等内部聚合键不是用户，原样放入（不加 username，避免混进看板名单）
      if (u.charAt(0) === '_') { map[u] = doc.base[u]; return }
      map[u] = Object.assign({}, doc.base[u], { username: u })
    })
    const events = (doc.events || []).concat(this._queue())
    events.forEach(ev => this._apply(map, ev))
    // v75：缓存全局每题聚合与云端文档体积（正确率看板/存储用量指示条用；
    // 挂在实例上而不改返回结构——学员端挑战页也复用本方法取数组）
    this._lastQStats = map.__q || {}
    try { this._lastDocBytes = JSON.stringify(doc).length } catch (e) { /* ignore */ }
    return Object.keys(map).map(u => map[u]).filter(r => r.username)
  },

  // ---------- 旧版本本地数据迁移（每台终端仅一次） ----------
  _migrateLegacy() {
    if (localStorage.getItem('eq_cloud_migrated')) return
    try {
      const users = JSON.parse(localStorage.getItem('eq_users') || '[]')
      const acts = JSON.parse(localStorage.getItem('eq_activity') || '[]')
      const q = this._queue()
      // 注册信息
      users.forEach(u => {
        if (!u || !u.username) return
        q.push({
          id: 'mig_u_' + u.username,
          u: u.username, n: u.name || u.username, ty: 'register',
          ts: u.createdAt || Date.now(),
          d: { name: u.name, dept: u.dept, role: u.role, level: u.level || 0 }
        })
      })
      // 历史活动
      acts.forEach((a, i) => {
        if (!a || !a.username) return
        if (a.type === 'heartbeat') {
          q.push({
            id: 'mig_h_' + a.userId + '_' + a.timestamp,
            u: a.username, n: a.name || '', ty: 'duration',
            ts: a.timestamp, d: { sec: Math.round((a.data && a.data.duration || 0) / 1000) }
          })
        } else if (['login', 'practice', 'exam', 'placement'].includes(a.type)) {
          q.push({
            id: 'mig_a_' + a.userId + '_' + a.type + '_' + a.timestamp + '_' + i,
            u: a.username, n: a.name || '', ty: a.type,
            ts: a.timestamp, d: a.data || {}
          })
        }
      })
      this._saveQueue(q)
    } catch (e) { /* ignore */ }
    localStorage.setItem('eq_cloud_migrated', '1')
  },

  // ---------- 云端定级重算（管理员设备触发，一次性） ----------
  // 拉取云端文档，对每个有定级记录的学员用新逻辑重算等级
  // 有 perLevel → 精确重算（逐级递进 60%）；无 perLevel → 用 score 启发式上限
  async recalcCloudPlacementLevels() {
    const FLAG = 'eq_cloud_recalc_v2'
    if (localStorage.getItem(FLAG)) return { done: false, reason: 'already' }
    const THRESHOLD = 0.6
    try {
      const doc = await this._getDoc()
      // 构建聚合 map（base + events）
      const map = {}
      Object.keys(doc.base || {}).forEach(u => { map[u] = Object.assign({}, doc.base[u]) })
      ;(doc.events || []).forEach(ev => this._apply(map, ev))

      // 从原始事件流中找每个用户最新的 placement 事件（可能含 score/perLevel）
      const latestEv = {}
      ;(doc.events || []).forEach(ev => {
        if (ev.ty === 'placement' && ev.u) {
          if (!latestEv[ev.u] || ev.ts > latestEv[ev.u].ts) latestEv[ev.u] = ev
        }
      })

      const corrections = []
      Object.keys(map).forEach(u => {
        const r = map[u]
        if (!r || !r.placementLevel || r.placementLevel <= 1) return // 无定级或已 L1

        let newLevel = null

        // ① 优先用 perLevel 精确重算
        const perLevel = r.placementPerLevel || (latestEv[u] && latestEv[u].d && latestEv[u].d.perLevel)
        if (perLevel) {
          newLevel = 1
          for (let l = 1; l <= 4; l++) {
            const s = perLevel[l]
            const acc = s && s.total > 0 ? s.correct / s.total : 0
            if (acc >= THRESHOLD) { newLevel = l } else { break }
          }
        }

        // ② 无 perLevel → 用 score 启发式上限：
        //    每级需 ≥60% 才通过（6 题需对 4 题），逐级递进需 4N 题正确
        //    maxLevel = floor(score / needed_per_level)，不低于 1
        if (newLevel === null) {
          const ev = latestEv[u]
          const score = (ev && ev.d && ev.d.score != null) ? ev.d.score : r.placementScore
          const total = (ev && ev.d && ev.d.total) ? ev.d.total : r.placementTotal
          if (score != null && total) {
            const perLvl = total / 4                              // 每级题数（通常 6）
            const needed = Math.ceil(perLvl * THRESHOLD)          // 每级需对几题（通常 4）
            const maxLevel = Math.max(1, Math.min(4, Math.floor(score / needed)))
            newLevel = Math.min(r.placementLevel, maxLevel)       // 只降不升
          }
        }

        if (newLevel !== null && newLevel < r.placementLevel) {
          corrections.push({ u, n: r.name || u, oldLevel: r.placementLevel, newLevel })
        }
      })

      if (!corrections.length) {
        localStorage.setItem(FLAG, '1')
        return { done: true, changed: 0 }
      }

      // 推送修正事件（幂等 ID）
      corrections.forEach(c => {
        this.enqueue({
          id: 'recalc_v2_' + c.u,
          u: c.u, n: c.n, ty: 'placement',
          d: { level: c.newLevel, corrected: true }
        })
      })
      await this.pushPending()
      localStorage.setItem(FLAG, '1')
      return { done: true, changed: corrections.length, corrections }
    } catch (e) {
      // 网络错误 → 不设 flag，下次重试
      return { done: false, reason: 'network' }
    }
  },

  // ---------- 云端清空所有定级（管理员触发） ----------
  // 为每个有定级记录的学员推送 level:0 事件，使所有终端同步清空
  async clearCloudPlacements() {
    try {
      const doc = await this._getDoc()
      // 构建聚合 map，找出所有有定级的用户
      const map = {}
      Object.keys(doc.base || {}).forEach(u => { map[u] = Object.assign({}, doc.base[u]) })
      ;(doc.events || []).forEach(ev => this._apply(map, ev))

      const targets = []
      Object.keys(map).forEach(u => {
        const r = map[u]
        if (!r || !r.username) return
        if (r.role === 'admin') return
        if (r.placementLevel && r.placementLevel > 0) {
          targets.push({ u: r.username, n: r.name || r.username })
        }
      })

      if (!targets.length) return { done: true, cleared: 0 }

      // 为每个用户推送 level:0 的 placement 事件（幂等 ID）
      targets.forEach(t => {
        this.enqueue({
          id: 'clear_placement_' + t.u,
          u: t.u, n: t.n, ty: 'placement',
          d: { level: 0, cleared: true }
        })
      })
      await this.pushPending()

      // 重置 recalc flag，以便后续重新定级时可正常重算
      localStorage.removeItem('eq_cloud_recalc_v2')

      return { done: true, cleared: targets.length }
    } catch (e) {
      return { done: false, reason: 'network' }
    }
  }
}

CloudSync.init()
