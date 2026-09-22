// ====== 标帜餐厅七天英文挑战（v68 引入；v70 入口移入练习页 + Day1/7 双阶段；v71 难度递增+时间锁+防作弊+看板上报；
//        v72 每日 30 题 + 测试每次随机 + 练习错题当天刷到全对 + 前一天错题次日额外复习 + 听音题醒目注解；
//        v77 挑战整体需管理员手动开放（chOpen）：未开放/已结束时全部环节灰掉锁定；
//        v79 练习题序改为人手一套：种子按登录用户名派生，每人随机序列不同（难度配比与逐日递增不变）；
//        v83 管理员可重置某学员挑战；v84 重置收窄为只清考试成绩（两场水平测试），练习进度/打卡/错题保留 ======
//        v88 多期营次（Round）：管理员后台自助新建营次（可设起止时间 → 到点自动开放、到期自动关闭），
//             每期独立存档键 / 独立题序种子 / 独立云端开关与重置标记，历史期次数据完整保留。
//             ⚠️ v88 没有「关闭期次开关」，管理员改为「新建下一期」——故本期结束后看板仍按营次分别统计 ======
// 题源：分类 12「标帜餐厅常见词汇」（684 题 = 456 listen + 228 single，v71 起无 voicematch）。
// 营次（v88）：存档键 = eq_challenge_v2 / eq_challenge_v2_<营次id>（'第一期'/r1 用原名，旧存档直接沿用）；
//   题序种子混入营次哈希 → 同一学员不同期题目也不同；云端 doc.chRounds 数组 + chRoundCur 指明当前期。
// 练习序列（每人一套，v79）：按难度分桶（1/2/3）按天配比抽取（CHALLENGE_DIFF_PLAN），Day1 均值 1.0 → Day7 均值 2.2；
//   Day1 巩固练习 10 题 → Day2-6 每日练习 30 题 → Day7 巩固练习 10 题，共 170 题；
//   种子 = CHALLENGE_SEED + 用户名哈希 + 营次哈希 → 不同学员/不同期序不同，同一学员同期固定（重练同题、选项每次重洗）。
// 水平测试（v80 起考已刷题）：Day1/Day7 各 20 题，每次进入分层随机（难度1×10 + 难度2×7 + 难度3×3）；
//   题源 = 本人已刷过的练习题（个人序列中已完成练习阶段覆盖的前缀）；Day1 摸底时还没刷过题 → 回退全库随机。
//   每次进入题目都不同；仍仅一次判分机会。
// 错题闭环（v72）：每日练习首次答错的题必须进入「错题回顾」轮刷到全对，该天才算完成；
//   前一天所有环节（练习+测试）的错题会在次日开始时额外追加到练习题末尾（不占每日 30 题配额），滚动复习。
// 入口在练习页底部（app.js renderPractice 挂入口卡片，navigate('challenge') 打开本页）。
// 进度存 localStorage 按营次隔离（绑定登录用户；v72 就地扩展 stage.wrong 字段，旧进度兼容）；
// 每题经 Store.addProgress(mode:'practice', challenge:true) 与 Store.trackPractice 汇入进度页/数据看板。
// 阶段完成经 Store.reportChallengeStage 上报云端（chy 事件，correct/total 为首次作答口径，不含回顾轮）。
// 时间锁（v71）：Day N 解锁需 Day N-1 全部完成且已过完成日次日 0 点（本地时区）——每天只能推进一天。
// 防作弊（v71）：水平测试接入 AntiCheat（切屏 3 次强制交卷计分，与在线考试同口径；管理员自动豁免）。
// 复用 app.js 工具：shuffleOptions / checkAnswer / quizTitleHtml / vmOptionsHtml / autoplayListen。

const CHALLENGE_SEED = 20260912
const CHALLENGE_KEY = 'eq_challenge_v2'          // 第一期存档键（v88 前的唯一键，保持原名以便旧存档直接沿用）
const CHALLENGE_KEY_PREFIX = 'eq_challenge_v2_'  // v88：第 N 期存档键（N≥2）
const CHALLENGE_ROUND_SEEN_KEY = 'eq_ch_seen_rounds'
const CHALLENGE_DAYS = [
  { day: 1, stages: [ { kind: 'test', count: 20 }, { kind: 'practice', count: 10 } ] },
  { day: 2, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 3, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 4, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 5, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 6, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 7, stages: [ { kind: 'practice', count: 10 }, { kind: 'test', count: 20 } ] },
]
// 挑战总题量（不含次日额外错题复习；进度条分母）
const CHALLENGE_TOTAL = CHALLENGE_DAYS.reduce((s, d) => s + d.stages.reduce((x, y) => x + y.count, 0), 0)   // 210
// 练习序列难度配比 [难度1, 难度2, 难度3]，与各天 practice 阶段一一对应（10/30/30/30/30/30/10，共 170 题）。
// 合计 82/82/6，均在题库容量 408/252/24 内；Day1 均值 1.0 → Day7 均值 2.2，难度逐日递增。
const CHALLENGE_DIFF_PLAN = [
  [10, 0, 0], [24, 6, 0], [19, 11, 0], [14, 16, 0], [9, 20, 1], [5, 23, 2], [1, 6, 3],
]
// 水平测试分层随机配比：难度1×10 + 难度2×7 + 难度3×3 = 20 题（保证测试覆盖全部难度）
const CHALLENGE_TEST_PLAN = [10, 7, 3]

// v89：当前学员所属分部门（'dining/bar' 等 slug）；管理员/其他部门返回 ''（=不限部门，看全库）
// v97：管理员跟随练习页「题目部门」切片 —— 切艳中即以艳中视角看挑战（标题/题库/营次/进度整体切换），
//      切「全部部门」= 全库视角（与旧行为一致）。非管理员仍按本人 session 部门，切片对其无效。
function chDeptKey() {
  try {
    if (typeof Store !== 'undefined' && Store.isAdmin && Store.isAdmin()
        && typeof PRACTICE_DEPT_TABS !== 'undefined' && typeof practiceDept !== 'undefined'
        && PRACTICE_DEPT_TABS.indexOf(practiceDept) >= 0) {
      return practiceDept
    }
    if (typeof sessionDeptSlug === 'function') return sessionDeptSlug()
  } catch (e) {}
  return ''
}
// v89：挑战题库 = 分类 12 中「本部门 + 通用」的题（未登录/其他部门 → 全库，兼容旧行为）
// 兼容 v89 前的历史题：只有 'dining'（大部门）或空 dept 的题，对饮食部四分队全部可见。
function chBankQuestions() {
  const all = Store.getQuestions().filter(q => Number(q.category_id) === 12)
  const k = chDeptKey()
  if (!k) return all
  const major = k.split('/')[0]
  return all.filter(q => {
    const d = q.dept || ''
    if (!d || d === 'all') return true
    if (d === k || d === major) return true        // 本分部门题 / 本大部门整包题
    // 学员本身就是大部门 key（如 'dining'）→ 该大部门下所有分部门的题都可见
    if (k.indexOf('/') < 0 && d.indexOf(major + '/') === 0) return true
    return false                                   // 其他部门（含同大部门其他分部门）的题不给
  })
}
// v89：本部门题库题目数（入口页文案用）
function chBankCount() { return chBankQuestions().length }
// v89：本部门题库是否够跑完七天（Day7 需 170 练习 + 20 测试；不足时入口页提示管理员补题）
const CHALLENGE_MIN_BANK = 190
function chBankShort() { const n = chBankCount(); return n > 0 && n < CHALLENGE_MIN_BANK }
// v89：题目 id 集合（本地进度里的 qid 需按当前部门题库过滤，避免跨部门串题）
function chBankIdSet() {
  const set = new Set()
  chBankQuestions().forEach(q => set.add(String(q.id)))
  return set
}

// v89：挑战标题 —— 有分部门时用「<部门>七天英文挑战」，否则回退通用标题
// v97：「all」（通用视角）也没有部门名 → 回落通用标题（避免出现「all七天英文挑战」）
function chDeptName() {
  const k = chDeptKey()
  if (!k || k === 'all') return ''
  try { return (typeof deptSlugName === 'function' && deptSlugName(k)) || '' } catch (e) { return '' }
}
function chTitleText() {
  const d = chDeptName()
  return d ? t('chTitleDept', d) : t('chTitle')
}

// mulberry32 伪随机（v79：种子按登录用户名派生 → 每人一套专属序列，同账号可复现）
function challengeRng(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- v88 营次（Round）解析 ----
// 当前营次 = 云端 doc.chRoundCur 指向的一期（经 CloudSync._chRoundCurId 侧信道到达）。
// 云端不可达/尚无营次时兜底为「第一期」，其存档键就是 v88 之前的 eq_challenge_v2 → 老数据无缝沿用。
function chRoundSlug(id) {
  const s = String(id || '第一期').trim()
  return s === 'r1' ? '第一期' : s
}
// v97：按当前视角部门（chDeptKey()）实时解析「本部门当前营次」记录。
// 云端侧信道 _chRoundCurId/_chRoundCurName 是 _getDoc 拉取时按登录部门（CloudSync._deptSlug）算好的缓存；
// 管理员切换练习部门切片后 chDeptKey() 立即变化，若仍读侧信道会出现「标题已切艳中、营次还停在别队」的错位。
// 此处用与云端 _roundCurrentForDept 完全相同的四级口径在本地重算，学员端结果与侧信道一致（同一套函数、同一部门）。
function chRoundRecForDept() {
  try {
    if (typeof CloudSync === 'undefined' || !Array.isArray(CloudSync._chRounds) || !CloudSync._chRounds.length) return null
    if (typeof roundDeptMatch !== 'function' || typeof roundOpenState !== 'function') return null
    const k = chDeptKey()
    const arr = CloudSync._chRounds
    const cur = arr.find(r => r && r.id === CloudSync._chRoundCurId)
    if (cur && roundDeptMatch(cur, k)) return cur                                                        // ① 指针适用本部门
    for (let i = arr.length - 1; i >= 0; i--) {                                                          // ② 本部门已开放
      if (roundDeptMatch(arr[i], k) && roundOpenState(arr[i], Date.now()).on) return arr[i]
    }
    for (let i = arr.length - 1; i >= 0; i--) {                                                          // ③ 本部门最新一期
      if (roundDeptMatch(arr[i], k)) return arr[i]
    }
    return k ? null : cur                                                                                // ④ 无适用营次
  } catch (e) { return null }
}
// 学员端当前营次 id（'' 表示云端未拉取到营次信息 → 视同第一期）
// v97：优先取按视角部门实时解析的营次（管理员切片联动），无营次数据时回落云端侧信道
function chCurrentRound() {
  try {
    const rec = chRoundRecForDept()
    if (rec && rec.id) return String(rec.id)
    const id = (typeof CloudSync !== 'undefined' && CloudSync._chRoundCurId)
    return id ? String(id) : '第一期'
  } catch (e) { return '第一期' }
}
// 当前营次存档键：第一期沿用 CHALLENGE_KEY（兼容旧存档），其余期加后缀
function chStorageKeyFor(round) {
  const slug = chRoundSlug(round)
  return slug === '第一期' ? CHALLENGE_KEY : CHALLENGE_KEY_PREFIX + slug
}
function chStorageKey() { return chStorageKeyFor(chCurrentRound()) }
// 本地「已见营次」列表：渲染期次切换器用（无云端时也能列出历史期）
function chSeenRounds() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHALLENGE_ROUND_SEEN_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x) : []
  } catch (e) { return [] }
}
function chSeenRoundsAdd(round) {
  const id = String(round || '')
  if (!id) return
  const list = chSeenRounds()
  if (list.indexOf(id) < 0) {
    list.push(id)
    try { localStorage.setItem(CHALLENGE_ROUND_SEEN_KEY, JSON.stringify(list)) } catch (e) {}
  }
}
// 管理员在云端切换当前营次后：把学员端本地进度指针切到新营次（换键重新装载）
function chEnsureRound() {
  const id = chCurrentRound()
  if (_chRoundLoaded === id) return false
  chSeenRoundsAdd(id)
  const uid = challengeUid()
  let st = null
  try { st = JSON.parse(localStorage.getItem(chStorageKey()) || 'null') } catch (e) { st = null }
  if (!st || typeof st !== 'object' || !st.days || st.uid !== uid) {
    st = { uid, days: {} }
    try { localStorage.setItem(chStorageKey(), JSON.stringify(st)) } catch (e) {}
  }
  challengeState = st
  _chRoundLoaded = id
  _chLbCache = { at: 0, top: null }   // 营次变了 → 积分榜缓存作废
  return true
}
let _chRoundLoaded = ''    // 已装载的营次 id（切换判断用）

// v79：练习题序种子 = CHALLENGE_SEED + FNV-1a(登录用户名)。
// 不同用户名 → 不同序列（人人题目不同）；未登录/测试环境兜底 'anon'（行为与 v78 固定种子一致）。
// v88：再混入营次哈希 → 同一学员不同期题目也不同（各期独立出题，避免跨期背题）。
function chUserSeed() {
  const str = challengeUid()
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  const rid = chRoundSlug(chCurrentRound())
  let h2 = 0
  if (rid !== '第一期') {
    h2 = 2166136261
    for (let i = 0; i < rid.length; i++) { h2 ^= rid.charCodeAt(i); h2 = Math.imul(h2, 16777619) }
  }
  return (CHALLENGE_SEED + (h >>> 0) + (h2 >>> 0)) >>> 0
}

// 练习序列：本部门题库（id 去重防御）→ 按难度分桶（桶内按用户名派生种子洗牌）→ 按档配比抽取 170 题。
// 返回数组即练习序列：Day1 巩固练习 10 题在前，依次到 Day7 巩固练习 10 题在后（测试题不占序列，见下）。
// 难度逐日递增：Day1 均值 1.0 → Day7 均值 2.2；题库总量不足配比时自动顺延到下一个难度桶。
// v89：题源收窄为 chBankQuestions()（本部门 + 通用），七天挑战不再跨部门串题。
function challengePool() {
  const all = chBankQuestions()
  const seen = new Set()
  const uniq = []
  for (const q of all) {
    const k = String(q.id)
    if (!seen.has(k)) { seen.add(k); uniq.push(q) }
  }
  const buckets = { 1: [], 2: [], 3: [] }
  for (const q of uniq) {
    const d = Math.min(3, Math.max(1, Number(q.difficulty) || 1))
    buckets[d].push(q)
  }
  ;[1, 2, 3].forEach(d => {
    const rng = challengeRng(chUserSeed() + d * 7919)
    for (let i = buckets[d].length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = buckets[d][i]; buckets[d][i] = buckets[d][j]; buckets[d][j] = tmp
    }
  })
  const out = []
  const cur = { 1: 0, 2: 0, 3: 0 }
  for (const plan of CHALLENGE_DIFF_PLAN) {
    ;[[plan[0], 1], [plan[1], 2], [plan[2], 3]].forEach(([n, d]) => {
      for (let k = 0; k < n; k++) {
        const q = buckets[d][cur[d]++]
        if (q) out.push(q)
      }
    })
  }
  return out
}

// 全部阶段的扁平元数据（切片起点 = 前面各 practice 阶段题数累加；test 随机抽题不占固定序列）
function challengeStageMeta() {
  let start = 0
  const out = []
  for (const d of CHALLENGE_DAYS) {
    d.stages.forEach((s, si) => {
      out.push({ day: d.day, si, kind: s.kind, count: s.count, start })
      if (s.kind === 'practice') start += s.count
    })
  }
  return out
}
function challengeStageInfo(day, si) {
  return challengeStageMeta().find(x => x.day === day && x.si === si)
}
// 分层随机抽题核心（v80 重构）：从给定题源按 CHALLENGE_TEST_PLAN 分层随机（难度1×10 + 难度2×7 + 难度3×3）
// 抽 total 题（id 去重，库存不足时自动少抽），选项重洗。
function challengeStratifiedDraw(source, total) {
  const seen = new Set()
  const buckets = { 1: [], 2: [], 3: [] }
  for (const q of source) {
    const k = String(q.id)
    if (!seen.has(k)) {
      seen.add(k)
      const d = Math.min(3, Math.max(1, Number(q.difficulty) || 1))
      buckets[d].push(q)
    }
  }
  const out = []
  ;[1, 2, 3].forEach((d, i) => {
    const b = buckets[d].slice()
    for (let k = b.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1))
      const tmp = b[k]; b[k] = b[j]; b[j] = tmp
    }
    for (let k = 0; k < CHALLENGE_TEST_PLAN[i] && out.length < total && k < b.length; k++) out.push(b[k])
  })
  return out.map(shuffleOptions)
}
// 全库随机抽题（v80 前 test 唯一题源；现保留给 Day1 摸底——尚无已刷题时回退使用）
// v89：题源收窄为本部门题库
function challengeRandomQuestions(total) {
  return challengeStratifiedDraw(chBankQuestions(), total)
}
// v80：考试题目出自本人已刷过的练习题——题源 = 个人练习序列中「已完成练习阶段」覆盖的前缀
//（线性解锁 → 已完成阶段恰为个人序列的前缀），从中分层随机抽 20 题；
// Day1 摸底时还没有已刷题（前缀不足一场考试）→ 回退全库随机。
function challengeTestQuestions() {
  const pool = challengePool()
  let k = 0
  challengeStageMeta().forEach(m => {
    if (m.kind === 'practice' && chStageDone(m.day, m.si)) k = Math.max(k, m.start + m.count)
  })
  if (k < 20) return challengeRandomQuestions(20)
  return challengeStratifiedDraw(pool.slice(0, k), 20)
}
// 前一天所有环节的错题（v72）：汇总 stages[].wrong（qid 去重）→ 取回题目 → 选项重洗。
// 旧进度记录无 wrong 字段时返回空数组（兼容 v71 及更早的已完成阶段）。
// v89：只取本部门题库内的题——学员换部门后，旧部门错题不再复现。
function chPrevDayWrongQuestions(prevDay) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === prevDay)
  if (!cfg) return []
  const bankIds = chBankIdSet()
  const seen = new Set()
  const out = []
  cfg.stages.forEach((_, si) => {
    const r = chStageRec(prevDay, si)
    const ws = r && Array.isArray(r.wrong) ? r.wrong : []
    ws.forEach(qid => {
      const k = String(qid)
      if (seen.has(k)) return
      if (bankIds.size && !bankIds.has(k)) return   // 已不属于本部门题库 → 跳过
      seen.add(k)
      const q = Store.getQuestion(Number(k)) || Store.getQuestion(k)
      if (q) out.push(shuffleOptions(q))
    })
  })
  return out
}
// 第 N 天第 si 阶段题目：
//   test → 从本人已刷题（v80；Day1 摸底尚无已刷题时回退全库）分层随机抽 20 题；
//   practice → 本人专属序列切片（v79 人手一套）+ （Day N≥2 首环节）追加前一天错题（额外，不占配额）。
//   选项顺序每次进入重洗，答案位置不固定。
function challengeStageQuestions(day, si) {
  const m = challengeStageInfo(day, si)
  if (m.kind === 'test') return challengeTestQuestions()
  const qs = challengePool().slice(m.start, m.start + m.count).map(shuffleOptions)
  if (day > 1 && si === 0) {
    const extra = chPrevDayWrongQuestions(day - 1)
    return qs.concat(extra)
  }
  return qs
}
function challengeKindOf(day, si) {
  const m = challengeStageInfo(day, si)
  return m ? m.kind : 'practice'
}

// ---- 挑战进度（localStorage，绑定登录用户；v88 按营次隔离） ----
let challengeState = null
function challengeUid() {
  let s = null
  try { s = Store.getSession() } catch (e) {}
  return String((s && (s.username || s.id || s.name)) || 'anon')
}
// v88：营次变化 → 先切键，再按需重置 uid；返回营次是否刚切换（渲染层据此重取题序/积分榜）
function challengeLoad() {
  const switched = chEnsureRound()
  try { challengeState = JSON.parse(localStorage.getItem(chStorageKey()) || 'null') } catch (e) { challengeState = null }
  if (!challengeState || typeof challengeState !== 'object' || !challengeState.days) challengeState = null
  const uid = challengeUid()
  if (!challengeState || challengeState.uid !== uid) {
    challengeState = { uid, days: {} }
    challengeSave() // 换号重置立即落盘，避免上一账号数据残留 localStorage
  }
  // v83/v84：管理员重置检测（云端标记比本地已处理的新 → 按模式处理本地记录；考试成绩模式只清测试成绩）
  const reset = chCheckRemoteReset()
  return switched || reset
}

// v83 管理员重置：云端 doc.chResets[本人] 存着最近一次重置时间戳（经 CloudSync._chResets 侧信道到达），
// doc.chResetModes[本人] 记录重置口径（v84：'exam'）。本地按用户记录「已处理到的重置时间戳」，
// 云端更新则按模式处理本地记录（本地记录是解锁与计分的权威，只清云端会让本机仍显示已完成）：
//   'exam' → 只删两场水平测试（Day1 摸底 / Day7 期末）的阶段记录，可重新参加考试；练习进度 / 打卡 / 错题保留
//   其余（v83 旧数据无模式记录）→ 整表清空，回到 Day1
// 返回 true 表示本次刚发生重置（渲染层据此提示学员）。
let _chResetNotice = false
let _chResetNoticeMode = ''   // v84：提示文案按模式区分（'exam' 考试成绩 / 'all' 整表）
let _chResetNoticeAt = 0
// 重置提示在 10 分钟内保持可见（渲染后不清除，避免被紧随其后的重渲染吞掉）
function chResetNoticeActive() {
  return !!_chResetNoticeAt && (Date.now() - _chResetNoticeAt) < 10 * 60 * 1000
}
function chResetNoticeIsExam() {
  return _chResetNoticeMode === 'exam'
}
// v84：只清考试成绩 —— 把本地记录中的测试阶段（kind==='test'）降级为「已重置存根」：
// 清掉分数（done/correct/wrong → 可重新参加考试），保留完成时间 at 与题量 total，
// 使当天「已完成」判定、进度条与天数链不受影响（挑战别的内容照旧）。
// 返回处理掉的阶段数（0 = 该学员还没有考试成绩，无需打扰）。
function chClearExamStageRecs() {
  let n = 0
  if (!challengeState || !challengeState.days) return 0
  CHALLENGE_DAYS.forEach(d => {
    const rec = challengeState.days[d.day]
    if (!rec || !rec.stages) return
    d.stages.forEach((s, si) => {
      const r = rec.stages[si]
      if (s.kind === 'test' && r && !r.cleared) {
        rec.stages[si] = { cleared: true, at: r.at || Date.now(), total: r.total || 0 }
        n++
      }
    })
  })
  if (n) challengeSave()
  return n
}
function chCheckRemoteReset() {
  let at = 0
  let mode = 'all'
  let rnd = ''
  try {
    const uid = challengeUid()
    at = Number((CloudSync._chResets || {})[uid]) || 0
    mode = ((CloudSync._chResetModes || {})[uid] === 'exam') ? 'exam' : 'all'
    rnd = chRoundSlug(chCurrentRound())
  } catch (e) { return false }
  if (!at) return false
  // v88：已处理标记按营次隔离（换期后同一重置时间戳在新期不生效）
  const key = 'eq_ch_reset_seen_' + challengeUid() + '_' + rnd
  let seen = 0
  try { seen = Number(localStorage.getItem(key)) || 0 } catch (e) {}
  if (at <= seen) return false
  try { localStorage.setItem(key, String(at)) } catch (e) {}
  if (mode === 'exam') {
    if (!chClearExamStageRecs()) return false   // 无考试成绩可清 → 静默处理（标记已落盘，不再重复检查）
    // 停留在测试结果页（成绩已作废）→ 丢弃该会话；答题中的会话不打断，交卷后按新成绩上报
    if (chs && chs.kind === 'test' && chs.phase === 'result') chs = null
  } else {
    challengeState = { uid: challengeUid(), days: {} }
    challengeSave()
    chs = null            // 丢弃可能残留的答题会话
  }
  _chResetNotice = true
  _chResetNoticeMode = mode
  _chResetNoticeAt = Date.now()
  return true
}
function challengeSave() {
  try { localStorage.setItem(chStorageKey(), JSON.stringify(challengeState)) } catch (e) {}
}
function chStageRec(day, si) {
  const d = challengeState && challengeState.days[day]
  return d && d.stages ? d.stages[si] : null
}
function chStageDone(day, si) {
  const r = chStageRec(day, si)
  return !!(r && r.done)
}
// v84：该阶段是否是「成绩已被管理员重置」的存根（完成过但分数已清空，可重新参加考试）
function chStageCleared(day, si) {
  const r = chStageRec(day, si)
  return !!(r && r.cleared)
}
// v84：进度/解锁判定用——已完成 或 完成过但成绩被重置，都算「走到过这一步」，
// 保证重置考试成绩不会影响当日打卡、进度条与次日解锁链
function chStageCounted(day, si) {
  const r = chStageRec(day, si)
  return !!(r && (r.done || r.cleared))
}
// 一天完成 = 当天全部阶段完成（或被重置过）
function chDayDone(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  return !!cfg && cfg.stages.every((_, si) => chStageCounted(day, si))
}
// 某天全部完成的时间（当天各阶段完成时间的最大值；未完成返回 0）
function chDayLastDoneAt(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  if (!cfg) return 0
  let t = 0
  cfg.stages.forEach((_, si) => {
    const r = chStageRec(day, si)
    if (r && (r.done || r.cleared) && r.at) t = Math.max(t, r.at)
  })
  return t
}
// v71 时间锁：Day N 解锁需 Day N-1 全部完成，且已过完成日的次日 0 点（本地时区）——
// 保证每天只能推进一天，防止学员一天内把七天全部刷完。
function chDayUnlocked(day) {
  if (day === 1) return true
  if (!chDayDone(day - 1)) return false
  const lastAt = chDayLastDoneAt(day - 1)
  if (!lastAt) return false
  const done = new Date(lastAt)
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    > new Date(done.getFullYear(), done.getMonth(), done.getDate()).getTime()
}
// 阶段解锁：首阶段随天解锁；后续阶段需前一阶段完成
function chStageUnlocked(day, si) {
  return si === 0 ? chDayUnlocked(day) : chStageDone(day, si - 1)
}

// v77 挑战门禁：整个七天挑战需当前营次处于开放态（自动排期结算见 cloud-store roundOpenState，
// 经 _getDoc 侧信道 _chOpen/_chOpenLocked/_chOpenAt 到达）。云端不可达/未拉取时视为未开放。
// v88：三态文案 —— 未开始（未到 startAt）/ 进行中 / 已结束（已过 endAt 或管理员关闭过）。
function chOpenLocked() {
  try {
    if (typeof CloudSync === 'undefined') return true
    // v97：按视角部门实时结算排期锁（管理员切片联动）；无营次数据时回退侧信道/手动开关口径
    if (typeof roundOpenState === 'function' && Array.isArray(CloudSync._chRounds) && CloudSync._chRounds.length) {
      const rec = chRoundRecForDept()
      if (rec) return roundOpenState(rec, Date.now()).locked
      if (chDeptKey()) return true
    }
    // 侧信道带 _chOpenLocked 时以它为准（排期结算结果）；否则回退 v87 的手动开关口径
    if (typeof CloudSync._chOpenLocked === 'boolean') return CloudSync._chOpenLocked
    return CloudSync._chOpen !== true
  } catch (e) { return true }
}
function chOpenEverOpened() {
  try {
    if (typeof CloudSync === 'undefined') return false
    const st = chRoundOpenState()
    if (st.state === 'upcoming') return false
    return st.everOpen || (Number(CloudSync._chOpenAt) || 0) > 0
  } catch (e) { return false }
}
// 当前营次的排期态：优先按视角部门实时解析（v97 管理员切片联动），缺失时按本地兜底（无排期信息 → 手动值）
function chRoundOpenState() {
  try {
    if (typeof CloudSync === 'undefined') return { state: 'closed', on: false, locked: true, everOpen: false }
    if (typeof roundOpenState === 'function' && Array.isArray(CloudSync._chRounds)) {
      const rec = chRoundRecForDept()
      if (rec) return roundOpenState(rec, Date.now())
      if (chDeptKey() && CloudSync._chRounds.length) return { state: 'closed', on: false, locked: true, everOpen: false }
    }
    const at = Number(CloudSync._chOpenAt) || 0
    const on = CloudSync._chOpen === true
    return { state: on ? 'open' : (at > 0 ? 'ended' : 'closed'), on, locked: !on, everOpen: on || at > 0 }
  } catch (e) { return { state: 'closed', on: false, locked: true, everOpen: false } }
}
// v89：本部门是否压根没有适用营次 → 显示「本部门暂无开营」
// v97：本地实时判定（管理员切片立即生效）；无营次数据时回退云端侧信道 _chNoRound
function chNoRoundForDept() {
  try {
    if (typeof CloudSync === 'undefined') return false
    if (typeof roundDeptMatch === 'function' && Array.isArray(CloudSync._chRounds) && CloudSync._chRounds.length) {
      const k = chDeptKey()
      if (k) return !chRoundRecForDept()
      return false      // 全库视角（管理员「全部部门」/无部门）指针必命中，不存在「无营次」
    }
    return CloudSync._chNoRound === true
  } catch (e) { return false }
}
// 当前营次名称（横幅显示，如「第一期」）；优先按视角部门实时解析，云端未拉取时兜底「第一期」
function chRoundName() {
  try {
    const rec = chRoundRecForDept()
    if (rec && rec.name) return String(rec.name)
    if (typeof CloudSync !== 'undefined' && CloudSync._chRoundCurName) return String(CloudSync._chRoundCurName)
  } catch (e) {}
  return '第一期'
}
// 当前营次是否有起止时间（横幅提示用）
function chRoundHasSchedule() {
  try {
    const rec = chRoundRecForDept()
    if (rec) return !!((Number(rec.startAt) || 0) > 0 || (Number(rec.endAt) || 0) > 0)
    if (typeof CloudSync !== 'undefined' && Array.isArray(CloudSync._chRounds)) {
      const r = CloudSync._chRounds.find(x => x && x.id === CloudSync._chRoundCurId)
      return !!(r && ((Number(r.startAt) || 0) > 0 || (Number(r.endAt) || 0) > 0))
    }
    return false
  } catch (e) { return false }
}
// v76 期末考试门禁：仅 Day7 的水平测试需当前营次开放考试（营次 examOpen 或排期命中）；
// Day1 摸底测试不受影响；已完成的期末考试仍显示成绩。云端不可达/未拉取时视为未开放。
// v97：营次记录按视角部门实时解析（管理员切片联动）
function chIsFinalExam(day, si) {
  return day === 7 && challengeKindOf(day, si) === 'test'
}
// v88：期末考试门禁按营次结算（营次未开放 → 一律锁定；侧信道缺失时回退 v76 口径）
function chFinalExamLocked() {
  try {
    if (typeof CloudSync === 'undefined') return true
    if (typeof roundExamState === 'function' && Array.isArray(CloudSync._chRounds)) {
      const rec = chRoundRecForDept()
      if (rec) return roundExamState(rec, Date.now()).locked
      if (chDeptKey() && CloudSync._chRounds.length) return true
    }
    return CloudSync._chExamOpen !== true
  } catch (e) { return true }
}
// v99 期末考试提前开放：考试开关（营次 examOpen / 侧信道 _chExamOpen）开着时，
// 第七天期末考试对未完成 Day1-6 的学员也直接开放——跳过 v71 天锁与阶段链锁，仅限考试阶段本身
//（Day7 每日练习仍按正常进度解锁）；v77 挑战全局门禁不在豁免范围（挑战未开放仍全拦）。
function chExamEarlyOpen() {
  try { return !chFinalExamLocked() } catch (e) { return false }
}
// v78 积分权重：第七天期末考试（day 7 的 test）答对每题按 3 倍计分，其余环节 1 倍。
// 看板 app.js dashChStageWeight 与之同口径（test-v78 断言两侧对同一输入得分一致）；管理员不参加排名。
function chLbStageWeight(day, kind) {
  return (Number(day) === 7 && kind === 'test') ? 3 : 1
}
function chStageScore(day, si) {
  const r = chStageRec(day, si)
  if (!r || !r.done || !r.total) return null
  return Math.round(r.correct / r.total * 100)
}
// 当天合并正确率（报告条形图用）
function chDayScore(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  if (!cfg) return null
  let c = 0, t = 0
  cfg.stages.forEach((_, si) => {
    const r = chStageRec(day, si)
    if (r && r.done) { c += r.correct; t += r.total }
  })
  return t ? Math.round(c / t * 100) : null
}
// 某天水平测试的正确率（进步报告对比用；无测试的天返回 null）
function chTestScoreOfDay(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  if (!cfg) return null
  const si = cfg.stages.findIndex(s => s.kind === 'test')
  return si >= 0 ? chStageScore(day, si) : null
}

// ---- 挑战会话（内存态，切页保留，退出丢弃） ----
let chs = null

function chStartStage(day, si) {
  challengeLoad()
  // v77：挑战未开放（管理员未开启/已结束）→ 全局拦截（入口已灰掉，此处二次拦截防控制台调用）
  if (chOpenLocked()) {
    alert(t('chNotOpenAlert'))
    return
  }
  // v99：期末考试开关开启时，未走完 Day1-6 的学员也可直接参加第七天期末考试（豁免天锁/阶段锁）
  const examEarly = chIsFinalExam(day, si) && !chStageDone(day, si) && chExamEarlyOpen()
  if (!chStageUnlocked(day, si) && !examEarly) return
  // v76：期末考试需管理员开启（入口已锁，此处二次拦截防控制台/旧 DOM 调用）
  if (chIsFinalExam(day, si) && !chStageDone(day, si) && chFinalExamLocked()) {
    alert(t('chExamLockedAlert'))
    return
  }
  if (challengeKindOf(day, si) === 'test' && chStageDone(day, si)) return // 水平测试仅一次
  const qs = challengeStageQuestions(day, si)
  if (!qs.length) return
  const m = challengeStageInfo(day, si)
  chs = {
    day, si, kind: challengeKindOf(day, si),
    questions: qs,
    answers: qs.map(() => -1),
    index: 0, phase: 'quiz', submitted: false, correctCount: 0,
    firstWrong: [],                       // v72：首轮答错的题（错题回顾 + 次日追加复习的数据源）
    extraCount: Math.max(0, qs.length - m.count),   // v72：次日追加的前一天错题数
    startedAt: Date.now(),                // v73：阶段开始时间 → chy usedSec（积分榜速度分）
  }
  if (chs.kind === 'test') {
    // v71：水平测试启用防作弊 —— 切屏 3 次强制交卷（按已答判分计次，与在线考试同口径）；管理员自动豁免
    AntiCheat.start({ maxViolations: 3, onSubmit: chCheatSubmit })
  } else {
    AntiCheat.stop() // 每日练习不启用；保险清理上一场残留
  }
  renderChallengeQuiz()
}

// 防作弊强制交卷（AntiCheat 达到切屏上限后回调；会话已不在则忽略）
function chCheatSubmit() {
  if (chs && chs.phase === 'quiz' && chs.kind === 'test') finishChallengeTest()
}

function chQuit() {
  if (chs && (chs.phase === 'quiz' || chs.phase === 'review') && !confirm(t('chQuitConfirm'))) return
  AntiCheat.stop()
  chs = null
  renderChallenge()
}
function chBack() { AntiCheat.stop(); chs = null; renderChallenge() }

function isChAnswered(i) {
  const a = chs && chs.answers[i]
  return a !== -1 && a !== undefined && a !== null
}

// ====== 概览页 ======
// 学员总进度卡（v71）：7 天格子（✓ 完成 / 数字 可做 / 🔒 未解锁）+ 环节与题数总进度条（v72 分母 = CHALLENGE_TOTAL 210）
function chProgressHtml() {
  const meta = challengeStageMeta()
  // v84：被重置成绩的测试阶段仍计入进度（chStageCounted），避免「只重置考试成绩」影响进度显示
  const doneStages = meta.filter(m => chStageCounted(m.day, m.si)).length
  const doneQ = meta.reduce((s, m) => chStageCounted(m.day, m.si) ? s + m.count : s, 0)
  const pct = Math.round(doneQ / CHALLENGE_TOTAL * 100)
  const cells = CHALLENGE_DAYS.map(d => {
    const done = chDayDone(d.day)
    const unlocked = chDayUnlocked(d.day)
    const examOpenCell = d.day === 7 && !done && !unlocked && chExamEarlyOpen()   // v99：期末考试已开放给未走到的学员
    const bg = done ? '#059669' : unlocked ? '#f59e0b' : examOpenCell ? '#10b981' : '#e5e7eb'
    const fg = done || unlocked || examOpenCell ? '#fff' : '#9ca3af'
    const top = done ? '✓' : unlocked ? String(d.day) : examOpenCell ? '🎓' : '🔒'
    return `<div style="flex:1;min-width:0">
      <div style="height:34px;border-radius:8px;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800">${top}</div>
      <div style="font-size:11px;color:#6b7280;text-align:center;margin-top:3px;white-space:nowrap">${t('chDay', d.day)}</div>
    </div>`
  }).join('')
  return `
    <div class="card" style="border:2px solid #f59e0b;margin-bottom:16px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
        <h3 style="margin:0">🎯 ${t('chProgressTitle')}</h3>
        <span style="font-size:13px;color:#6b7280">${t('chProgressStages', doneStages)} · ${t('chProgressQ', doneQ)}</span>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:12px">${cells}</div>
      <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#f59e0b,#059669);border-radius:5px"></div>
      </div>
    </div>`
}

// ====== 积分榜前三（v74）======
// 与管理员看板 renderDashChallengeBlock 同口径：每环节按首次完成计（day-si 去重取 at 最早的 chy，
// 重练不刷分），积分 = Σ(答对×100×环节权重) − Σ用时秒；v78：第七天期末考试 3 倍权重，管理员不参加排名。
// v84：被管理员重置成绩的测试记录（cleared 存根）不计分——重考后的新记录才计入。
// v88：只看当前营次的记录（rd 缺省 = 第一期/单期制旧数据）；round 省略时用当前营次。
// v88：只看当前营次的记录（rd 缺省 = 第一期/单期制旧数据）；round 省略时用当前营次。
function chLbAggregate(rows, round) {
  const want = String(round == null ? chCurrentRound() : round)
  const matchRound = x => chRoundSlug(String((x && x.rd) || '')) === chRoundSlug(want)
  // v78：管理员账号不参加排名（学员端前三同样剔除）
  const list = (rows || []).filter(r => r && r.role !== 'admin' && r.chy && r.chy.length).map(r => {
    const first = {}
    ;(r.chy || []).forEach(x => {
      if (x && x.cleared) return   // v84：成绩已重置的考试记录不计分
      if (!matchRound(x)) return   // v88：别的营次的记录不计入本期
      const k = x.day + '-' + x.si
      if (!first[k] || (x.at || 0) < (first[k].at || 0)) first[k] = x
    })
    let c = 0, tsec = 0, pts = 0
    Object.keys(first).forEach(k => {
      const x = first[k]
      c += x.correct || 0
      tsec += x.usedSec || 0
      pts += (x.correct || 0) * 100 * chLbStageWeight(x.day, x.kind)
    })
    return { name: r.name || r.username || '', username: r.username, correct: c, sec: tsec, score: pts - tsec }
  })
  list.sort((a, b) => (b.score - a.score) || (a.sec - b.sec) || (b.correct - a.correct))
  return list.slice(0, 3)
}
function chLbRowsHtml(top) {
  if (!top || !top.length) return `<div style="color:#9ca3af;font-size:13px;padding:2px 0">${t('chLbEmpty')}</div>`
  const medal = i => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1))
  return top.map((p, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:${i < top.length - 1 ? '1px solid #f3f4f6' : 'none'}">
      <span style="font-size:18px;width:28px;text-align:center;flex-shrink:0">${medal(i)}</span>
      <span style="flex:1;min-width:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</span>
      <span style="color:#6b7280;font-size:12px;flex-shrink:0">${t('dashChThCorrect')} ${p.correct}</span>
      <span style="font-weight:800;color:#b45309;flex-shrink:0">${p.score} ${t('scoreUnit')}</span>
    </div>`).join('')
}
let _chLbCache = { at: 0, top: null }
let _chGateRendered = null   // v76：挑战页渲染时的期末考试锁定态（拉取后变化则重渲染入口）
function chLbFill(top) {
  const el = document.getElementById('chLbBody')
  if (el) el.innerHTML = chLbRowsHtml(top)
}
async function chLoadLeaderboard() {
  const now = Date.now()
  if (_chLbCache.top && now - _chLbCache.at < 60000) {
    chLbFill(_chLbCache.top)
    // v83：缓存命中不代表重置侧信道旧（周期探测仍会刷新 _chResets）→ 仍检查一次
    try { if (_chGateRendered !== null && chCheckRemoteReset()) renderChallenge() } catch (e) { /* ignore */ }
    return
  }
  let top = null
  try {
    if (typeof CloudSync !== 'undefined' && CloudSync.getDashboardData) {
      top = chLbAggregate(await CloudSync.getDashboardData(), chCurrentRound())
    }
  } catch (e) { /* 网络失败保留旧缓存或显示空态 */ }
  if (top) _chLbCache = { at: now, top }
  chLbFill(_chLbCache.top)
  // v76/v77：积分榜拉取顺带刷新了开关侧信道（_getDoc）→ 管理员刚开/关挑战或考试时重渲染入口；
  // v83：同一拉取也刷新了重置侧信道（_chResets）→ 刚被重置则清空本地进度并重渲染入口；
  // v88：营次切换（管理员新建/切换当前营次）也在此感知 → 换键重新装载本地进度；
  // 仅概览页响应（答题中 renderChallenge 会走会话分支，不打断作答）
  try {
    if (typeof CloudSync !== 'undefined' && _chGateRendered !== null) {
      const cur = { open: chOpenLocked(), exam: chFinalExamLocked(), round: chCurrentRound() }
      if (cur.open !== _chGateRendered.open || cur.exam !== _chGateRendered.exam) { renderChallenge(); return }
      if (cur.round !== _chGateRendered.round) { chEnsureRound(); renderChallenge(); return }
      if (chCheckRemoteReset()) renderChallenge()
    }
  } catch (e) { /* ignore */ }
}

function renderChallenge() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  challengeLoad()
  if (chs && (chs.phase === 'quiz' || chs.phase === 'review' || chs.phase === 'result')) { renderChallengeQuiz(); return }
  // v77：记录本次渲染的门禁态（挑战开关 + 考试开关），拉取后变化则重渲染入口
  // v88：营次切换也会改变门禁与进度 → 一并纳入比较
  _chGateRendered = { open: chOpenLocked(), exam: chFinalExamLocked(), round: chCurrentRound() }
  // v89：题源/标题按本部门题库（各分部门一套题、各自上传）
  const bankN = chBankCount()
  const rows = CHALLENGE_DAYS.map(d => chDayBlockHtml(d)).join('')
  // v77 挑战未开放/已结束横幅（进度/积分榜/报告仍可查看）；v88 三态 + 营次名与起止时间
  const st = chRoundOpenState()
  const rName = chRoundName()
  const rMeta = chRoundMetaText()
  let bannerTitle = ''
  let bannerHint = ''
  let bannerBorder = '#9ca3af'
  // v89：本部门无任何适用营次 → 专属文案（优先于其它三态，因为此时压根没有「期」可谈）
  if (chNoRoundForDept()) {
    bannerTitle = '📭 ' + t('chNoRoundForDept')
    bannerHint = t('chNoRoundForDeptHint', chDeptName() || '')
    bannerBorder = '#9ca3af'
  } else if (st.state === 'upcoming') {
    bannerTitle = '⏳ ' + t('chRoundUpcoming', rName)
    bannerHint = t('chRoundUpcomingHint')
    bannerBorder = '#f59e0b'
  } else if (st.state === 'ended') {
    bannerTitle = '🏁 ' + t('chEnded') + ' · ' + escHtml(rName)
    bannerHint = t('chEndedHint')
  } else {
    bannerTitle = '🔒 ' + t('chNotOpen')
    bannerHint = t('chNotOpenHint')
    bannerBorder = '#f59e0b'
  }
  const chClosedBanner = chOpenLocked()
    ? `<div class="card" style="border:2px solid ${bannerBorder};margin-bottom:16px;text-align:center;padding:18px">
        <div style="font-size:15px;font-weight:800;margin-bottom:4px">${bannerTitle}</div>
        <div style="font-size:12px;color:#6b7280">${bannerHint}</div>
        ${rMeta ? `<div style="font-size:12px;color:#9ca3af;margin-top:6px">${rMeta}</div>` : ''}
      </div>`
    : ''
  // v82/v88 营次标识条：让学员随时知道自己在哪一期（多期并存时尤其重要）
  // v89：加部门标识 —— 各分部门题不同，学员需明确自己在哪个部门的挑战里
  // v89：本部门无适用营次时不显示此条（没有「期」可标），只保留上面的「暂无开营」提示
  const chDeptTag = chDeptName()
    ? `<span style="font-size:11px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:999px;padding:2px 8px">🏷️ ${escHtml(chDeptName())}</span>`
    : ''
  const chRoundBar = chNoRoundForDept() ? '' : `<div class="card" style="margin-bottom:16px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="font-size:13px;font-weight:700">🎯 ${t('chRoundLabel')}：<span style="color:#2563eb">${escHtml(rName)}</span>${st.state === 'open' ? ` <span style="font-size:11px;color:#059669">● ${t('chRoundOpenTag')}</span>` : ''} ${chDeptTag}</div>
      ${rMeta ? `<div style="font-size:12px;color:#6b7280">${rMeta}</div>` : ''}
    </div>`
  // v83/v84：管理员重置本学员记录后的一次性提示（10 分钟内保持可见）；考试成绩模式文案不同
  const chResetIsExam = chResetNoticeIsExam()
  const chResetBanner = chResetNoticeActive()
    ? `<div class="card" style="border:2px solid #6366f1;margin-bottom:16px;text-align:center;padding:18px">
        <div style="font-size:15px;font-weight:800;margin-bottom:4px">🔄 ${chResetIsExam ? t('chResetExamNotice') : t('chResetNotice')}</div>
        <div style="font-size:12px;color:#6b7280">${chResetIsExam ? t('chResetExamNoticeHint') : t('chResetNoticeHint')}</div>
      </div>`
    : ''
  el.innerHTML = `
    ${chResetBanner}
    ${chRoundBar}
    ${chClosedBanner}
    ${chProgressHtml()}
    <div class="card" style="border:2px solid #f59e0b;margin-bottom:16px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:4px">
        <h3 style="margin:0">🏆 ${t('chLbTitle')}</h3>
        <span style="font-size:11px;color:#9ca3af">${t('chLbRule')}</span>
      </div>
      <div id="chLbBody" style="color:#9ca3af;font-size:13px">${t('cloudLoading')}</div>
      <p class="form-hint" style="margin:6px 0 0">🏆 ${t('dashChPrizeHint')}</p>
    </div>
    ${chReportHtml()}
    <div class="card">
      <h3>${escHtml(chTitleText())}</h3>
      <p class="form-hint" style="margin-bottom:8px">${t('chIntro')}</p>
      <p style="font-size:12px;color:#9ca3af;margin-bottom:12px">${t('chPoolInfo', bankN)}</p>
      ${chBankShort() ? `<div class="feedback" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;margin-bottom:10px">⚠️ ${t('chBankShortWarn', bankN, CHALLENGE_MIN_BANK)}</div>` : ''}
      ${Store.isAdmin() ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-primary btn-sm" onclick="openImportModal(12,'${escAttr(chDeptKey() || 'all')}')">📤 ${t('chUploadBtn')}</button>
        <span class="form-hint" style="margin:0">${t('chUploadHint')}</span>
      </div>` : ''}
      <div>${rows}</div>
    </div>
  `
  chLoadLeaderboard()
}

function chRoundMetaText() {
  try {
    if (typeof CloudSync === 'undefined' || !Array.isArray(CloudSync._chRounds)) return ''
    // v97：按视角部门实时解析（管理员切片联动）
    const rec = chRoundRecForDept()
    if (!rec) return ''
    const s = Number(rec.startAt) || 0
    const e = Number(rec.endAt) || 0
    const f = ts => new Date(ts).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    if (s && e) return t('chRoundWindow', f(s), f(e))
    if (s) return t('chRoundStartAt', f(s))
    if (e) return t('chRoundEndAt', f(e))
  } catch (err) { /* ignore */ }
  return ''
}

function chDayBlockHtml(cfg) {
  const done = chDayDone(cfg.day)
  const unlocked = chDayUnlocked(cfg.day)
  const rows = cfg.stages.map((s, si) => chStageRowHtml(cfg.day, si, s)).join('')
  return `
    <div style="padding:12px 0;border-bottom:1px solid #e5e7eb">
      <div style="font-weight:800;margin-bottom:4px;color:${done ? '#059669' : unlocked ? '#111827' : '#9ca3af'}">${t('chDay', cfg.day)}${done ? ' <span style="font-size:12px;color:#059669">✓</span>' : ''}</div>
      ${rows}
    </div>`
}

function chStageRowHtml(day, si, s) {
  const done = chStageDone(day, si)
  const unlocked = chStageUnlocked(day, si)
  const isTest = s.kind === 'test'
  const score = chStageScore(day, si)
  const tag = isTest ? t('chTestTag') : t('chPracticeTag')
  const tagCls = isTest ? 'tag tag-type' : 'tag tag-category'
  let right = ''
  // v77：挑战未开放/已结束 → 全部入口灰掉（已完成测试仍显示分数，不给重练/开始）
  // v88：三态文案（未开始 / 未开放 / 已结束）
  if (chOpenLocked() && !(done && isTest)) {
    const st = chRoundOpenState()
    const closedTxt = st.state === 'upcoming' ? t('chRoundUpcomingShort') : (st.state === 'ended' ? t('chEnded') : t('chNotOpenShort'))
    right = `<span style="font-size:12px;color:#9ca3af;flex-shrink:0">🔒 ${closedTxt}</span>`
  } else if (done) {
    if (isTest) {
      const color = score >= 80 ? '#059669' : score >= 60 ? '#d97706' : '#dc2626'
      right = `<div style="text-align:right;flex-shrink:0">
        <div style="font-weight:800;font-size:20px;color:${color}">${score}<span style="font-size:12px"> ${t('scoreUnit')}</span></div>
        <div style="font-size:11px;color:#9ca3af">${t('chOnceOnly')}</div>
      </div>`
    } else {
      right = `<button class="btn btn-ghost btn-sm" onclick="chStartStage(${day},${si})" style="flex-shrink:0">${t('chRetake')}</button>`
    }
  } else if (unlocked) {
    // v76：期末考试未开放（管理员未开启）→ 锁定文案，不给开始按钮
    if (chIsFinalExam(day, si) && chFinalExamLocked()) {
      right = `<span style="font-size:12px;color:#9ca3af;flex-shrink:0">🔒 ${t('chExamLocked')}</span>`
    } else {
      right = `<button class="btn btn-primary btn-sm" onclick="chStartStage(${day},${si})" style="flex-shrink:0">${t('chStart')}</button>`
    }
  } else if (chIsFinalExam(day, si) && chExamEarlyOpen()) {
    // v99：考试已开放但学员尚未走到 Day7（天锁/阶段锁未满足）→ 直接给入口 + 开放标记
    right = `<button class="btn btn-primary btn-sm" onclick="chStartStage(${day},${si})" style="flex-shrink:0">${t('chStart')}</button>`
  } else {
    // 锁定文案：阶段锁（si>0）= 完成上方环节；天锁 = 前置天未完成 → chLocked，已完成但未到次日 → chTomorrow
    const lockText = si > 0 ? t('chStageLocked')
      : (day > 1 && chDayDone(day - 1) ? t('chTomorrow') : t('chLocked'))
    right = `<span style="font-size:12px;color:#9ca3af;flex-shrink:0">🔒 ${lockText}</span>`
  }
  const rec = done ? chStageRec(day, si) : null
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <div style="flex:1;min-width:0">
        <span class="${tagCls}" style="margin-right:6px">${tag}</span>
        <span style="font-size:13px;color:#6b7280">${t('questionsUnit', s.count)}</span>
        ${rec && !isTest ? `<span style="font-size:12px;color:#059669;margin-left:8px">✓ ${rec.correct}/${rec.total}</span>` : ''}
        ${chStageCleared(day, si) ? `<span style="font-size:12px;color:#6366f1;margin-left:8px">🔁 ${t('chResetExamRetake')}</span>` : ''}
        ${!done && isTest && day === 7 && chExamEarlyOpen() ? `<span style="font-size:12px;color:#059669;margin-left:8px">${t('chExamEarlyTag')}</span>` : ''}
      </div>
      ${right}
    </div>`
}

// 七天进步报告（Day1 与 Day7 的水平测试均完成后显示；对比测试分，条形图展示每天合并正确率）
function chReportHtml() {
  if (!challengeState) return ''
  const s1 = chTestScoreOfDay(1), s7 = chTestScoreOfDay(7)
  if (s1 == null || s7 == null) return ''
  const bars = CHALLENGE_DAYS.map(({ day }) => {
    const s = chDayScore(day)
    if (s == null) return ''
    const color = s >= 80 ? '#059669' : s >= 60 ? '#d97706' : '#dc2626'
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="width:52px;font-size:12px;color:#6b7280;flex-shrink:0">${t('chDay', day)}</div>
        <div style="flex:1;height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden">
          <div style="width:${s}%;height:100%;background:${color}"></div>
        </div>
        <div style="width:44px;text-align:right;font-size:12px;font-weight:700">${s}%</div>
      </div>`
  }).join('')
  return `
    <div class="card" style="border:2px solid #059669;margin-bottom:16px">
      <h3>🏆 ${t('chReportTitle')}</h3>
      <p style="font-size:14px;margin-bottom:10px"><strong>${t('chDay', 1)}：${s1} ${t('scoreUnit')}</strong> → <strong>${t('chDay', 7)}：${s7} ${t('scoreUnit')}</strong><br><span style="color:#059669;font-weight:700">${t('chDelta', s7 - s1)}</span></p>
      <p style="font-size:12px;color:#6b7280;margin-bottom:8px">${t('chReportHint')}</p>
      ${bars}
    </div>`
}

// ====== 答题页 ======
function renderChallengeQuiz() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  if (!chs) { el.innerHTML = ''; return }
  if (chs.phase === 'review') { renderChallengeReview(); return }
  if (chs.phase === 'result') { chRenderResult(); return }
  const q = chs.questions[chs.index]
  const isTest = chs.kind === 'test'
  const submitted = !!chs.submitted

  let feedbackHtml = ''
  if (submitted && !isTest) {
    const isCorrect = checkAnswer(q, chs.answers[chs.index])
    feedbackHtml = `<div class="feedback ${isCorrect ? 'correct' : 'wrong'}">
      <strong>${isCorrect ? t('correctFeedback') : t('wrongFeedback')}</strong>
      <div class="explanation">${q.explanation || t('noExplanation')}</div>
      <div class="explanation">${t('correctAnswer')}：${q.answer.map(i => LETTERS[i]).join(', ')}</div>
    </div>`
  }

  const dots = chs.questions.map((_, i) => {
    let cls = 'exam-nav-dot'
    if (i === chs.index) cls += ' current'
    else if (isTest ? isChAnswered(i) : i < chs.index) cls += ' answered'
    const click = isTest ? ` onclick="chGoto(${i})"` : ''
    return `<div class="${cls}"${click}>${i + 1}</div>`
  }).join('')

  let footerBtns = ''
  if (isTest) {
    footerBtns = `
      ${chs.index > 0 ? `<button class="btn btn-ghost" onclick="chGoto(${chs.index - 1})">${t('prevQuestion')}</button>` : ''}
      ${chs.index < chs.questions.length - 1
        ? `<button class="btn btn-primary" onclick="chGoto(${chs.index + 1})">${t('nextQuestion')}</button>`
        : `<button class="btn btn-danger" onclick="chSubmitTest()">${t('chSubmitTest')}</button>`}`
  } else {
    footerBtns = !submitted
      ? `<button class="btn btn-primary" onclick="chSubmitAnswer()">${t('submitAnswer')}</button>`
      : chs.index < chs.questions.length - 1
        ? `<button class="btn btn-primary" onclick="chNext()">${t('nextQuestion')}</button>`
        : `<button class="btn btn-success" onclick="chFinishPractice()">${t('finishPractice')}</button>`
  }

  el.innerHTML = `
    <div class="exam-timer" style="margin-bottom:12px">
      <div>
        <strong>${t('chDay', chs.day)}</strong>
        <span class="tag ${isTest ? 'tag-type' : 'tag-category'}" style="margin-left:8px">${isTest ? t('chTestTag') : t('chPracticeTag')}</span>
      </div>
      <div style="display:flex;gap:8px">
        ${isTest ? `<button class="btn btn-danger btn-sm" onclick="chSubmitTest()">${t('chSubmitTest')}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="chQuit()" title="✕">✕</button>
      </div>
    </div>
    ${isTest ? `<div class="exam-nav" style="margin-bottom:16px">${dots}</div>` : ''}
    <div class="card">
      <div class="q-meta">
        <span class="tag tag-type">${TYPE_LABELS[q.type] || q.type}</span>
      </div>
      ${quizTitleHtml(q)}
      ${q.type === 'listen' ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:13px;color:#92400e;margin-bottom:12px">🔊 ${t('listenHint')}</div>` : ''}
      <div class="options-list">${chOptionsHtml(q, submitted, chs.answers[chs.index], 'chPick')}</div>
      ${feedbackHtml}
      <div class="quiz-footer">
        <div class="quiz-progress">${t('questionOf', chs.index + 1, chs.questions.length)}</div>
        <div style="display:flex;gap:8px">${footerBtns}</div>
      </div>
    </div>
  `
  if (!submitted) autoplayListen(q)
}

// 单选题型（listen/single/voicematch）+ 填空（v72 参数化：练习/回顾轮共用）
// v87：题型判定走 safeQType —— 选项不足 2 个的畸形选择题按填空渲染，避免出现「没有可点选项」的题。
function chOptionsHtml(q, submitted, ans, pickFn) {
  const qt = safeQType(q)
  if (qt === 'voicematch') {
    return vmOptionsHtml(q, ans, submitted ? 'review' : 'live', pickFn)
  }
  if (qt === 'fill' || qt === 'translate') {
    const val = (ans === undefined || ans === null || ans === -1) ? '' : String(ans)
    return `<input type="text" class="input-answer" placeholder="${t('answerPlaceholder')}" value="${escAttr(val)}"
      oninput="chTextInput(this.value)" ${submitted ? 'disabled' : ''} />`
  }
  return q.options.map((opt, i) => {
    let cls = 'option-item'
    if (submitted) {
      if (q.answer.includes(i)) cls += ' correct'
      else if (ans === i) cls += ' wrong'
    } else if (ans === i) {
      cls += ' selected'
    }
    const badge = submitted && q.answer.includes(i) ? '✓' : LETTERS[i]
    return `<div class="${cls}" onclick="${submitted ? '' : `${pickFn}(${i})`}">
      <div class="option-badge">${badge}</div>
      <div class="option-text">${opt}</div>
    </div>`
  }).join('')
}

// v87：填空作答（题型自洽兜底后可能出现填空形态）
function chTextInput(v) {
  if (!chs || chs.phase !== 'quiz') return
  chs.answers[chs.index] = v
}

function chPick(i) {
  if (!chs || chs.phase !== 'quiz') return
  chs.answers[chs.index] = i
  renderChallengeQuiz()
}

// 完成记录写入 days[day].stages[si]；并上报云端（chy 事件 → 数据看板挑战统计）。
// v72：stage 记录追加 wrong = 首轮答错的 qid 列表（供次日额外复习）；chy 的 correct/total 为首次作答口径（不含回顾轮）。
// v73：chy 增加 usedSec = 阶段净用时秒（从进入环节到完成；退出重进会重置 startedAt，无法借重练刷速度分）
function chRecordStage(correct, total, wrongQids) {
  if (!challengeState.days[chs.day]) challengeState.days[chs.day] = { stages: {} }
  const d = challengeState.days[chs.day]
  if (!d.stages) d.stages = {}
  d.stages[chs.si] = { done: true, at: Date.now(), correct, total, wrong: (wrongQids || []).map(String) }
  challengeSave()
  Store.trackPractice(correct, total)
  const usedSec = chs.startedAt ? Math.max(0, Math.round((Date.now() - chs.startedAt) / 1000)) : 0
  // v88：带上营次 id → 看板可按营次分别统计、管理员重置考试只作用于该营次
  try { Store.reportChallengeStage(chs.day, chs.si, chs.kind, correct, total, usedSec, chCurrentRound()) } catch (e) {}
}

// ---- 每日练习（逐题反馈） ----
function chSubmitAnswer() {
  const q = chs.questions[chs.index]
  const ans = chs.answers[chs.index]
  if (ans === undefined || ans === -1) return
  chs.submitted = true
  const correct = checkAnswer(q, ans)
  if (correct) chs.correctCount++
  else chs.firstWrong.push(q)   // v72：首轮错题记录（当天回顾轮 + 次日额外复习）
  Store.addProgress({
    question_id: q.id,
    category_id: q.category_id,
    dept: q.dept || '',
    type: q.type,
    correct,
    mode: 'practice',
    challenge: true,
  })
  renderChallengeQuiz()
}
function chNext() {
  if (chs.index < chs.questions.length - 1) {
    chs.index++
    chs.submitted = false
    renderChallengeQuiz()
  }
}
function chFinishPractice() {
  const total = chs.questions.length
  if (chs.firstWrong.length) {
    // v72：当天错题必须刷到全对才算完成 —— 进入错题回顾轮（只做答错的题，循环至全对）
    chs.phase = 'review'
    chs.reviewQs = chs.firstWrong.slice()
    chs.reviewRound = 1
    chs.reviewIdx = 0
    chs.reviewAnswers = chs.reviewQs.map(() => -1)
    chs.reviewSubmitted = false
    chs.reviewWrongNow = []
    renderChallengeReview()
    return
  }
  chRecordStage(chs.correctCount, total, [])
  chs.phase = 'result'
  renderChallengeQuiz()
}

// ---- 错题回顾轮（v72）：只抽本轮仍错的题，全对即完成该阶段 ----
function chReviewPick(i) {
  if (!chs || chs.phase !== 'review') return
  chs.reviewAnswers[chs.reviewIdx] = i
  renderChallengeReview()
}
function chReviewSubmit() {
  const q = chs.reviewQs[chs.reviewIdx]
  const ans = chs.reviewAnswers[chs.reviewIdx]
  if (ans === undefined || ans === -1) return
  chs.reviewSubmitted = true
  const correct = checkAnswer(q, ans)
  if (!correct) chs.reviewWrongNow.push(q)
  Store.addProgress({
    question_id: q.id,
    category_id: q.category_id,
    dept: q.dept || '',
    type: q.type,
    correct,
    mode: 'practice',
    challenge: true,
  })
  renderChallengeReview()
}
function chReviewNext() {
  if (chs.reviewIdx < chs.reviewQs.length - 1) {
    chs.reviewIdx++
    chs.reviewSubmitted = false
    renderChallengeReview()
    return
  }
  // 本轮结束
  if (chs.reviewWrongNow.length) {
    chs.reviewQs = chs.reviewWrongNow.slice()
    chs.reviewRound++
    chs.reviewIdx = 0
    chs.reviewAnswers = chs.reviewQs.map(() => -1)
    chs.reviewSubmitted = false
    chs.reviewWrongNow = []
    renderChallengeReview()
    return
  }
  // 全对 → 阶段完成（chy 上报首次作答口径 correct/total）
  chRecordStage(chs.correctCount, chs.questions.length, chs.firstWrong.map(q => q.id))
  chs.phase = 'result'
  renderChallengeQuiz()
}

// 错题回顾轮渲染（练习模式逐题反馈；顶部显示轮次与回顾提示）
function renderChallengeReview() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  if (!chs || chs.phase !== 'review') { el.innerHTML = ''; return }
  const q = chs.reviewQs[chs.reviewIdx]
  const submitted = !!chs.reviewSubmitted

  let feedbackHtml = ''
  if (submitted) {
    const isCorrect = checkAnswer(q, chs.reviewAnswers[chs.reviewIdx])
    feedbackHtml = `<div class="feedback ${isCorrect ? 'correct' : 'wrong'}">
      <strong>${isCorrect ? t('correctFeedback') : t('wrongFeedback')}</strong>
      <div class="explanation">${q.explanation || t('noExplanation')}</div>
      <div class="explanation">${t('correctAnswer')}：${q.answer.map(i => LETTERS[i]).join(', ')}</div>
    </div>`
  }

  const last = chs.reviewIdx >= chs.reviewQs.length - 1
  const footerBtns = !submitted
    ? `<button class="btn btn-primary" onclick="chReviewSubmit()">${t('submitAnswer')}</button>`
    : last
      ? `<button class="btn btn-success" onclick="chReviewNext()">${chs.reviewWrongNow.length ? t('chReviewNextRound') : t('chReviewFinish')}</button>`
      : `<button class="btn btn-primary" onclick="chReviewNext()">${t('nextQuestion')}</button>`

  el.innerHTML = `
    <div class="exam-timer" style="margin-bottom:12px">
      <div>
        <strong>${t('chDay', chs.day)}</strong>
        <span class="tag tag-category" style="margin-left:8px">${t('chReviewTag')}</span>
        <span style="font-size:12px;color:#6b7280;margin-left:8px">${t('chReviewRound', chs.reviewRound)}</span>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="chQuit()" title="✕">✕</button>
    </div>
    <div class="card">
      <p class="form-hint" style="margin:0 0 10px">✏️ ${t('chReviewHint')}</p>
      <div class="q-meta">
        <span class="tag tag-type">${TYPE_LABELS[q.type] || q.type}</span>
      </div>
      ${quizTitleHtml(q)}
      ${q.type === 'listen' ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:13px;color:#92400e;margin-bottom:12px">🔊 ${t('listenHint')}</div>` : ''}
      <div class="options-list">${chOptionsHtml(q, submitted, chs.reviewAnswers[chs.reviewIdx], 'chReviewPick')}</div>
      ${feedbackHtml}
      <div class="quiz-footer">
        <div class="quiz-progress">${t('questionOf', chs.reviewIdx + 1, chs.reviewQs.length)}</div>
        <div style="display:flex;gap:8px">${footerBtns}</div>
      </div>
    </div>
  `
  if (!submitted) autoplayListen(q)
}

// ---- 水平测试（统一判分） ----
function chGoto(i) {
  if (!chs || chs.phase !== 'quiz') return
  chs.index = i
  chs.submitted = false
  renderChallengeQuiz()
}
function chSubmitTest() {
  const unanswered = chs.answers.filter(a => a === -1 || a === undefined).length
  if (unanswered > 0 && !confirm(t('chConfirmSubmit', unanswered))) return
  finishChallengeTest()
}
function finishChallengeTest() {
  AntiCheat.stop() // 交卷（正常或强制）即停监听
  const total = chs.questions.length
  let correct = 0
  const wrongQids = []
  const review = chs.questions.map((q, i) => {
    const isCorrect = checkAnswer(q, chs.answers[i])
    if (isCorrect) correct++
    else wrongQids.push(q.id)   // v72：测试错题也进入次日额外复习池
    Store.addProgress({
      question_id: q.id,
      category_id: q.category_id,
      dept: q.dept || '',
      type: q.type,
      correct: isCorrect,
      mode: 'practice',
      challenge: true,
    })
    return { q, ans: chs.answers[i], isCorrect }
  })
  chRecordStage(correct, total, wrongQids)
  chs.review = review
  chs.score = Math.round(correct / total * 100)
  chs.phase = 'result'
  renderChallengeQuiz()
}

// ====== 结果页 ======
function chRenderResult() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  const isTest = chs.kind === 'test'
  const total = chs.questions.length
  const correct = isTest ? chs.review.filter(r => r.isCorrect).length : chs.correctCount
  const pct = Math.round(correct / total * 100)
  const hero = isTest ? `
    <div class="result-hero ${pct >= 60 ? 'score-pass' : 'score-fail'}">
      <div class="emoji">${pct >= 80 ? '🎉' : pct >= 60 ? '👍' : '💪'}</div>
      <div class="score">${pct}<span style="font-size:24px">${t('scoreUnit')}</span></div>
      <div class="grade">${t('chTestDone')} · ${correct}/${total}</div>
    </div>` : `
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:12px">${pct >= 80 ? '🎉' : pct >= 60 ? '👍' : '💪'}</div>
      <h2 style="font-size:24px;margin-bottom:8px">${t('chPracticeDone')}</h2>
      <p style="color:#6b7280;margin-bottom:8px">${t('practiceResult', correct, total, pct)}</p>
    </div>`
  const report = isTest && chs.day === 7 ? chReportHtml() : ''
  // v72：练习结果页显示前日错题复习量（本次作答含的额外题数）
  const extraNote = !isTest && chs.extraCount > 0
    ? `<p style="font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;display:inline-block">🔁 ${t('chExtraDone', chs.extraCount)}</p><br>`
    : ''
  const review = isTest ? `
    <h3 class="section-title">${t('reviewTitle')}</h3>
    ${chs.review.map((r, i) => chReviewItemHtml(r, i)).join('')}` : ''
  el.innerHTML = hero + extraNote + report + review + `
    <div style="text-align:center;margin-top:24px">
      <button class="btn btn-primary" onclick="chBack()">${t('chBackToChallenge')}</button>
    </div>`
  window.scrollTo(0, 0)
}

function chReviewItemHtml(r, i) {
  const q = r.q
  const yourAns = r.ans >= 0 ? `${LETTERS[r.ans]}. ${q.options[r.ans] || ''}` : t('notAnswered')
  const correctAns = q.answer.map(a => `${LETTERS[a]}. ${q.options[a]}`).join('；')
  const audioBtns = (q.type === 'listen' || q.type === 'voicematch')
    ? `<button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">${audioIconSvg('up')}</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">${audioIconSvg('down')}</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">${audioIconSvg('globe')}</button> `
    : ''
  return `<div class="review-item ${r.isCorrect ? 'correct' : 'wrong'}">
    <div class="review-q">${i + 1}. ${audioBtns}${escHtml(q.question)}</div>
    <div class="review-ans">${t('yourAnswer')}<span class="${r.isCorrect ? 'review-correct' : 'review-wrong'}">${yourAns}</span></div>
    ${!r.isCorrect ? `<div class="review-ans">${t('correctAnswer')}：<span class="review-correct">${correctAns}</span></div>` : ''}
    ${q.explanation ? `<div class="review-ans" style="color:#6b7280">${q.explanation}</div>` : ''}
  </div>`
}
