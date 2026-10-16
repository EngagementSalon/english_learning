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
// v149 重调：原配比按「题库有完整的 1/2/3 三档」设计（第一期合计 82/82/6），
//   一旦中间档题量为 0，桶2 的 82 个坑位全部轮空 → 序列缩到 88 → Day5 起空题（线上故障根因）。
//   新配比把梯度写成「低档逐日递减、高档逐日递增」的形态，并降低对中间档的依赖：
//   第一期合计 91/0/79（中间档份额交给运行时自适应分摊），Day1 均值 1.00 → Day7 均值 2.80，严格单调递增。
//   ⚠️ 中间档仍可被使用：若题库存在 L2/L3 题，归桶后它们落入桶 2，会按 low:high 比例参与分配。
const CHALLENGE_DIFF_PLAN = [
  [10, 0, 0], [26, 0, 4], [21, 0, 9], [16, 0, 14], [11, 0, 19], [6, 0, 24], [1, 0, 9],
]
// v111：第二期及以后的练习配比 —— 第一期是「摸底巩固」，第二期起是「进阶复训」，难度显著提高。
// v149 重调：合计 33/25/112，Day1 均值 2.00 → Day7 均值 3.00，严格单调递增，
//   且逐日均值均不低于第一期同日（1.00→2.80），符合「进阶复训」口径。
const CHALLENGE_DIFF_PLAN_HARD = [
  [5, 0, 5], [13, 3, 14], [8, 4, 18], [4, 5, 21], [2, 6, 22], [1, 7, 22], [0, 0, 10],
]
// 水平测试分层随机配比：难度1×10 + 难度2×7 + 难度3×3 = 20 题（保证测试覆盖全部难度）
const CHALLENGE_TEST_PLAN = [10, 7, 3]
// v111：第二期及以后的考试配比 —— 难度1 减半、难度2/3 加倍（均值 1.65 → 2.35）。
// 合计 20 题不变（考试题量恒定，只调难度结构）。
const CHALLENGE_TEST_PLAN_HARD = [5, 10, 5]

// v89：当前学员所属分部门（'dining/bar' 等 slug）；管理员/其他部门返回 ''（=不限部门，看全库）
// v97：管理员跟随练习页「题目部门」切片 —— 切艳中即以艳中视角看挑战（标题/题库/营次/进度整体切换），
//      切「全部部门」= 全库视角（与旧行为一致）。非管理员仍按本人 session 部门，切片对其无效。
// v109：校验全集改用 PRACTICE_DEPT_SLUGS（一级 + 二级分部门）—— 一级行层级化后
//      PRACTICE_DEPT_TABS 只剩四个一级栏目，若仍按它校验，管理员切到分部门切片会误判非法而回落 ''，
//      v97 的「切片联动挑战视角」就会断。
function chDeptKey() {
  try {
    if (typeof Store !== 'undefined' && Store.isAdmin && Store.isAdmin()
        && typeof PRACTICE_DEPT_SLUGS !== 'undefined' && typeof practiceDept !== 'undefined'
        && PRACTICE_DEPT_SLUGS.indexOf(practiceDept) >= 0) {
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
// ====== v154：抽题池跟「当前营次」走 —— 做哪期就抽哪期的题 ======
// 背景（2026-10-09 线上实撞）：管理员「题目部门」=饮食部一级切片做 r4（客房送餐）时，
//   chDeptKey()='dining' → chBankQuestions() 走大部门分支 = 全库 1215 题（含艳中 295 道），
//   而营次条经 chCurrentRound() 回落解析到 r4 → 「送餐挑战里出艳中题」（u1827 撞实）。
//   学员身份做题不受影响（分部门视角下 chBankQuestions 已收窄），但管理员/大部门视角试做
//   任何分队挑战都会混题。用户拍板：抽题池跟营次 depts 收窄，与视角/切片解耦。
// 口径：
//   · 当前营次挂了明确 depts（如 r4=['dining/ird']）→ 从**全量 cat12**按营次 depts 收窄
//     （不从 chBankQuestions 出发：管理员切片到艳中做 r4 时，艳中视角题库里根本没有 ird 题）；
//     通用题（dept 空 / 'all'）保留，与分部门可见性口径一致；营次挂大部门（'dining'）时其
//     分部门题整包可见（同 chBankQuestions 的 major 规则）。
//   · 当前营次未挂部门（legacy 全部门营次）或无营次数据（云端未拉到 / '第一期' 兜底）→
//     维持 chBankQuestions() 原视角口径，老行为零变化。
// ⚠️ 只供**抽题链路**使用（challengePool / challengeRandomQuestions / challengeTestQuestions /
//   challengeTestWithWrongQuestions / chBankIdSet / chBankDiffStats / chBankCount）；
//   chBankQuestions 本体不动 —— 它仍是「视角题库」口径（上传默认部门等视角用途继续用它）。
function chRoundRecForCurrent() {
  try {
    if (typeof CloudSync === 'undefined' || !Array.isArray(CloudSync._chRounds) || !CloudSync._chRounds.length) return null
    const id = (typeof chCurrentRound === 'function') ? chCurrentRound() : ''
    if (!id) return null
    return CloudSync._chRounds.find(r => r && String(r.id) === String(id)) || null
  } catch (e) { return null }
}
function chRoundBankQuestions() {
  try {
    const rec = chRoundRecForCurrent()
    const depts = rec && Array.isArray(rec.depts) ? rec.depts.filter(x => x) : []
    if (!depts.length) return chBankQuestions()    // legacy 全部门营次 / 无营次数据 → 视角口径不变
    const all = Store.getQuestions().filter(q => Number(q.category_id) === 12)
    const majors = depts.map(d => String(d).split('/')[0])
    return all.filter(q => {
      const d = q.dept || ''
      if (!d || d === 'all') return true           // 通用题所有人可见（兼容历史题）
      return depts.indexOf(d) >= 0 || majors.indexOf(d) >= 0
    })
  } catch (e) { return chBankQuestions() }
}
// v89：本部门题库题目数（入口页文案用）
// v154：改走 chRoundBankQuestions()——入口文案与 chBankShort 警告都应描述「本期实际可抽的题」，
//   否则管理员大部门视角下文案写 1215、实际抽题却是营次收窄后的池，两数对不上。
function chBankCount() { return chRoundBankQuestions().length }
// v89：本部门题库是否够跑完七天（Day7 需 170 练习 + 20 测试；不足时入口页提示管理员补题）
const CHALLENGE_MIN_BANK = 190
function chBankShort() { const n = chBankCount(); return n > 0 && n < CHALLENGE_MIN_BANK }
// v149：题库「结构性」缺口检测 —— 总题数够（>CHALLENGE_MIN_BANK）但某一难度档过少时，
//   旧口径完全静默（正是 v149 线上故障：295 题总量「够用」，但难度2 档为 0 → 序列缩水 → Day5+ 空题）。
//   返回缺口档位文案片段（如 '难度2'）与建议补题数；无缺口返回 ''。
//   阈值口径：练习序列各档需求（第一期 82/82/6、进阶期 37/127/6）取较大者，留 10% 余量。
function chBankDiffGap() {
  try {
    const st = chBankDiffStats()
    if (!st.total) return ''
    const need = { 1: 82, 2: 127, 3: 6 }
    // 只报「明显不足」的档：低于需求的一半才算结构性缺口（避免边界抖动刷提示）
    const low = []
    ;[1, 2, 3].forEach(d => { if (st[d] < Math.floor(need[d] / 2)) low.push(d + '') })
    return low.length ? low.join(' / ') : ''
  } catch (e) { return '' }
}
// v89：题目 id 集合（本地进度里的 qid 需按当前部门题库过滤，避免跨部门串题）
function chBankIdSet() {
  const set = new Set()
  chRoundBankQuestions().forEach(q => set.add(String(q.id)))
  return set
}

// ====== v149：难度归桶 + 难度容量自适应 ======
// 背景（v149 修的线上故障）：题库实际标了 1~4 四个难度（管理员上传界面就有 L4），
//   而抽取只分 1/2/3 三个桶，且用 Math.min(3, …) 把 L4 一律压进桶3 →
//   「中间档」桶 2 恒空 → 配比里难度2 的坑位全部轮空 → 序列从 170 缩到 88 →
//   Day3 起切片越过数组末尾 → 空题 → chStartStage 里 `if (!qs.length) return` 静默无反应。
// 修法：① 按「题库实际有的难度档数」把难度线性映射到 1/2/3 三档（而非一律压到 3）；
//       ② 抽题按桶容量自适应回填（某桶不足时从相邻桶就近补），保证序列恒为设计长度。

// 难度取值 → 桶（1/2/3）。题库若存在 >3 的难度（如 L4），按「题库实际最大值」线性缩放，
//   使最低档落 1、最高档落 3，中间档不会因上限截断而空缺。
//   例：题库只有 1 和 4 → 1→1、4→3，桶 2 仍空（真实只有两极题）；
//       题库有 1/2/3/4 → 1→1、2→2、3→2、4→3（4 档压成 3 档，各档都有人）。
function chDiffBucketOf(diff, maxDiff) {
  const d = Number(diff) || 1
  const mx = Number(maxDiff) > 0 ? Number(maxDiff) : 3
  if (mx <= 3) return Math.min(3, Math.max(1, Math.round(d)))
  // 线性映射到 1..3：最低 → 1，最高 → 3
  const t = (d - 1) / (mx - 1)          // 0..1
  return Math.min(3, Math.max(1, 1 + Math.round(t * 2)))
}
// 题库里出现过的最大难度（用于归桶缩放）；缺失/异常 → 3（等价旧行为）
function chBankMaxDiff(list) {
  try {
    const arr = Array.isArray(list) ? list : []
    let mx = 1
    arr.forEach(q => { const d = Number(q && q.difficulty) || 1; if (d > mx) mx = d })
    return mx > 0 ? mx : 3
  } catch (e) { return 3 }
}
// 自适应取题：按 need 逐档取，某档不足时从「相邻档」借补，保证序列长度 = Σneed（题池够的前提下）。
//   need   = [n1, n2, n3] 各档期望题数
//   buckets= { 1:[…], 2:[…], 3:[…] } 各档已洗牌的题池
//   ⚠️ 游标记在 buckets.__cur 上（**跨调用累加**）—— challengePool 会逐天连续调用本函数，
//      若每次从 0 开始取，第二天会把第一天的题再取一遍（重复题）。首次调用时惰性初始化。
//   口径：① 先按档取满自己的配额；
//        ② 某档题池取尽 → 借档。★ 借档方向必须「宁可借更难，不可借更易」：
//           借更难的档会让当天更贴合「逐日变难」的设计意图，借更易的档则会把梯度拉平甚至回头
//           （v149 线上题库桶3 只有 24 题，原「距离优先」在 Day5 起改借桶2 → 均值从 1.83 掉到 1.63）。
//           故评分改为「优先同侧更难档，其次同侧更易档，距离越近越优先，距离相同时余量越多越优先」。
//        ③ 题池总量不足时按实际能取到的数量返回（不报错，由上层给提示）。
function chDrawWithBackfill(need, buckets) {
  if (!buckets.__cur) buckets.__cur = { 1: 0, 2: 0, 3: 0 }
  const cur = buckets.__cur
  const order = []
  const total = [1, 2, 3].reduce((s, d) => s + Math.max(0, Number(need[d - 1]) || 0), 0)
  const cap = d => (Array.isArray(buckets[d]) ? buckets[d].length : 0)
  ;[1, 2, 3].forEach(d => {
    const want = Math.max(0, Number(need[d - 1]) || 0)
    for (let k = 0; k < want; k++) {
      if (cur[d] < cap(d)) { order.push(buckets[d][cur[d]++]); continue }
      // 本档取尽 → 在其它档里挑。★ 第一优先级 = 方向（更难优先），第二 = 距离近，第三 = 余量多
      //   dirBonus：alt > d（更难）记 1；alt < d（更易）记 0 → 更难档恒优先于更易档
      let best = null, bestScore = -1
      ;[1, 2, 3].forEach(alt => {
        if (alt === d) return
        const remain = cap(alt) - cur[alt]
        if (remain <= 0) return
        const dirBonus = alt > d ? 1 : 0
        const score = dirBonus * 1000 + remain / (1 + Math.abs(alt - d))
        if (score > bestScore) { bestScore = score; best = alt }
      })
      if (best == null) continue
      order.push(buckets[best][cur[best]++])
    }
  })
  return { list: order, total }
}
// 各档题量统计（题库结构告警用）：返回 { 1:n, 2:n, 3:n, max }
// v154：跟抽题池同源（chRoundBankQuestions）——缺口告警描述的必须是「本期实际会抽的题」
function chBankDiffStats() {
  const buckets = { 1: 0, 2: 0, 3: 0 }
  const list = chRoundBankQuestions()
  const mx = chBankMaxDiff(list)
  list.forEach(q => { buckets[chDiffBucketOf(q && q.difficulty, mx)]++ })
  return { 1: buckets[1], 2: buckets[2], 3: buckets[3], max: mx, total: list.length }
}

// ====== v111：按营次区分难度档（第二期及以后「略难」）======
// ⚠️ v181 改口径：进阶期 = 「本营次在**它自己那个部门组**里的期号 > 1」。
//   旧口径 `chRoundSlug(chCurrentRound()) !== '第一期'` 只把字面量 'r1' / '第一期' 当第一期，
//   于是 r2/r3/r4/r5… **一律**被判为进阶期 —— 2026-10-16 实证：线上除标帜一期外所有营次都在跑
//   CHALLENGE_DIFF_PLAN_HARD，包括本该是「基础缓坡」的艳中一期、客房送餐一期与新建的酒吧第一期。
//   新口径与后台 / 归档的营次期号完全同源（cloud-store.js `_roundSeqOf`）：
//     ① 营次带正整数 `seq` → 直接用它（v152 起新建的营次都有）；
//     ② 存量期（v152 之前建的、字段缺失）→ 按**同部门组**在数组里的出现顺序现算。
//   部门组键 = depts 排序后拼接；depts 为空 → '__all__'（全库组），与 _roundDeptGroupKey 同款。
//   ⚠️ 必须「按部门组」而非「按全库条数」：标帜二期与酒吧一期各自的期号互不影响。
//   ⚠️ 存量的 seq 缺省**绝不可被当成 0/第一期**（v152 铁律：补 seq:0 会让期号全塌）——
//      所以「显式 seq 缺失」一律走 ② 现算，只有连部门组都算不出才回落兜底。
//   兜底（拿不到营次列表 / 期号算不出 —— extractFn 沙箱、部分加载、旧缓存）→ 沿用旧口径。
// 只读营次、不引入新依赖 → 可安全被 challengePool / challengeStratifiedDraw 调用。
function chIsHardRound() {
  try {
    const rid = (typeof chCurrentRound === 'function') ? chCurrentRound() : ''
    if (!rid) return false                                     // 无当前营次 → 视作第一期（保守）
    // ① 主路径：按「本部门组期号」判定
    if (typeof CloudSync !== 'undefined' && CloudSync && Array.isArray(CloudSync._chRounds) && CloudSync._chRounds.length) {
      const arr = CloudSync._chRounds
      const rec = arr.find(r => r && String(r.id) === String(rid))
      if (rec) {
        let seq = Number(rec.seq) > 0 ? Math.floor(Number(rec.seq)) : 0
        if (!seq) {
          const keyOf = (r) => {
            const l = (r && Array.isArray(r.depts)) ? r.depts.filter(x => typeof x === 'string' && x).slice().sort() : []
            return l.length ? l.join('+') : '__all__'
          }
          const key = keyOf(rec)
          let n = 0
          for (const r of arr) {
            if (keyOf(r) !== key) continue
            n++
            if (String(r.id) === String(rec.id)) { seq = n; break }
          }
        }
        if (seq > 0) return seq > 1
      }
    }
    // ② 兜底：无营次数据 / 期号算不出 → 旧口径。缺函数 → 保守回落第一期。
    if (typeof chRoundSlug !== 'function') return false
    return chRoundSlug(rid) !== '第一期'
  } catch (e) { return false }
}
// v111：练习序列难度配比（按营次取）
function chDiffPlan() {
  return chIsHardRound() ? CHALLENGE_DIFF_PLAN_HARD : CHALLENGE_DIFF_PLAN
}
// v111：考试（水平测试 / 期末考试）分层配比（按营次取）
function chTestPlan() {
  return chIsHardRound() ? CHALLENGE_TEST_PLAN_HARD : CHALLENGE_TEST_PLAN
}

// ====== v165：七天挑战「能力等级」动态评定（L1–L4）======
// 需求（用户原话）：「能否按照七天挑战参与后的准确率 自动判定这个是 L1 还是 L4？然后因为准确率
//   动态调整，且调整的时候会出现动画提示」→ 拍板：**累计首答准确率**（含全部天数）+ **每天练习结束后评估**。
//
// 口径（三条，缺一都会误判）：
//   ① 等级按「累计首答准确率」查表 —— 与积分榜 / 累计总览的 accFirst 同源（去重后首次完成记录），
//      绝不用明细表那个含重做的「正确率」（重做就能把等级刷上去）。
//   ② **等级不可高于当天计划的难度档**。这是本功能最关键的一条：准确率是「相对当前难度」的相对量
//      （题容易 → 准确率虚高），单看准确率会让所有人涨到 L4。用 chPlanDayAvg 把等级压回
//      「你实际答到的难度」以内 → Day1 名义均值 1.00 时最好也只能评到 L1，Day5 才可能到 L3。
//   ③ 只许**逐级**变化（每天最多升 1 级或降 1 级）→ 避免一次考试把 L1 直接弹到 L4。
//
// 档位按「基准名义难度均值」分（见 chLevelTierOfBench：<1.5→1 · <2.5→2 · <3.5→3 · ≥3.5→4）。
// ★ v181 复算的真实名义均值（`_v181` 批次用真实 chPlanAllocate 逐日算出）：
//   第一期 1.00/1.27/1.60/1.93/2.27/2.60/2.80 · 进阶期 2.00/2.03/2.33/2.57/2.67/2.70/3.00
//   —— 见 CHALLENGE_DIFF_PLAN[_HARD]。
//   ⚠️ 旧注释里的两串数字（1.00/1.16/1.30/1.47/1.63/1.80/1.90 与 2.00/2.13/…/2.67）是
//     **v149 重调配比之前**的值，「≥0.90 → L4 / ≥0.60 → L3 / ≥0.30 → L2」是 **v165 的旧准确率阈值** ——
//     两者自 v180 起均已作废，勿再引用（引用旧数字会误判「等级不对」）。
// 另有两条压制（缺一会让全班涨到 L4）：① 等级不得高于当天/基准的计划难度档（cap）；
//   ② 进 3 档另需「练到 Day7 且首答准确率 ≥95%」，否则退 2 档（chLevelCapOfBench）。
// 现状对照（2026-10-16，v181 修「进阶期判定」bug 之后）：
//   基础档 = 标帜一期 r1 · 艳中一期 r2 · 客房送餐一期 r4 · 酒吧一期 r5（Day1 名义 1.00 → 基准 <1.5 → 上限 L1）；
//   进阶档 = 标帜二期 r3 · 艳中二期 r6 · 客房送餐二期 r7（Day1 名义 2.00 → 基准 2.0 档 → 上限 L2）。
//   「基础档学员 9 个阶段全对却停在 L1」是**设计**，不是 bug —— 准确率 100% ≠ 能力 L4。
//
// ⚠️ 等级只从**练习阶段**推导（chLevelBench），不吃考试与补录成绩：
//   · 只算 practice：学习测试（test，Day1/Day7）与期末考试不计入（它们是考试，不是练习进度）
//   · cleared 存根跳过（成绩被管理员重置 → 该阶段不再作为评定依据）
//   · 换设备后本地存档恢复之前暂显示 L1，恢复后自动回到正确等级（与挑战进度同生命周期，预期行为）
//
// v180：基准改为「**该学员实际练到的最高难度档**」，且数据源扩到**全量历史**（本机 + 云端 chy）：
//   · 旧口径：maxDay = 本机存档里最高的已完成 practice 天 → 取那天名义均值。
//     问题：① 只看本机（换设备/清缓存 → 基准归 0 → 恒回 L1，等级被无端压低）；
//           ② 只取**单日**名义均值 → 练满七天的人基准仍是 Day7 之前某天的值，压制过紧。
//   · 新口径：从**合并后的全量 day 集合**里取最高 day 的 nominal 均值，再**放宽到该学员
//     实际跨过的难度区间上沿**（见 chLevelBench 实现）。练满七天的人基准直接到 Day7 名义值，
//     不再被前几天的低均值拖住 —— 这正对应「参考过往所有正确率」的诉求。
//   ★ 压制本身保留（题容易 → 准确率虚高，纯准确率会让所有人涨到 L4），只是不再过紧。
// v180：该学员「实际练到过的最高练习日」（1~7；没练过 → 0）。
//   数据源 = 本机存档 ∪ 云端 chy 全量（跨营次），只认 practice（test 不算，与 chLevelBench 同口径）。
//   ★ 抽成独立函数是必需的：chLevelBench（算基准）与 chLevelCapOfBench 的 L3 门槛
//     （判「是否跑满七天」）都要用它，两处必须同源，绝不能各算一份。
function chLevelMaxDay() {
  let maxDay = 0
  try {
    if (challengeState && challengeState.days) {
      CHALLENGE_DAYS.forEach(d => {
        d.stages.forEach((s, si) => {
          if (s.kind !== 'practice') return
          const r = chStageRec(d.day, si)
          if (r && (r.done || r.cleared) && d.day > maxDay) maxDay = d.day
        })
      })
    }
  } catch (e) { /* 本机异常 → 只吃云端 */ }
  try {
    if (Array.isArray(_chCloudChy) && _chCloudChy.length) {
      _chCloudChy.forEach(x => {
        if (!x || x.cleared) return
        if (String(x.kind || 'practice') !== 'practice') return
        const day = Number(x.day) || 0
        if (day > maxDay) maxDay = day
      })
    }
  } catch (e) { /* 云端异常 → 只吃本机 */ }
  return maxDay
}
function chLevelBench() {
  try {
    const maxDay = chLevelMaxDay()
    if (!maxDay) return 0
    const plan0 = (typeof chDiffPlan === 'function') ? chDiffPlan() : CHALLENGE_DIFF_PLAN
    return chPlanDayAvg(plan0, maxDay)
  } catch (e) { return 0 }
}
// 累计首答准确率（0~100 整数；无任何首答记录 → null）
// ★ 只统计**已完成**的阶段（done），与等级评定同源；进行中的阶段里的作答不算。
//   ★★ 不要用 `if (!r || !r.total) continue` —— 旧记录可能缺 total，但 cor 可能仍是有效首答数（同 chLbAggregate）
// v180：本函数改为「**全量历史**」口径 —— 不再只看本机当天存档，而是把
//   ① 本机存档里的已完成 practice 阶段 + ② 云端 chy 里属于本人（跨营次）的全部未重置记录
//   两路合并，按 `day-si` 去重取 at 最早（首次完成口径）后累计。
//   为什么必须这样改：v165 只在本机「完成练习那一刻」触发定级 → v165 上线**之前**练完的
//   学员本机没有等级依据，之后不再练就**永不评定**。实测线上 49 人有练习记录、仅 5 人有等级，
//   44 人的「过往所有正确率」被完全浪费。本函数即把那些历史数据重新纳入评定。
//   ★ 云端 chy 可能为空（未拉取/网络失败）→ 自动退化为纯本机口径，绝不抛错。
//   ★ 换设备场景：本机 days 为空、云端 chy 有记录 → 也能算出准确率（这是本次改动的主要收益）。
function chLevelAcc() {
  try {
    const first = {}
    // ① 本机存档：已完成的阶段（含 practice 与 test —— 这里只算「首答准确率」，
    //    是否作为定级依据由 chLevelBench 把关，准确率本身两者都要，与看板 accFirst 同源）
    try {
      if (challengeState && challengeState.days) {
        Object.keys(challengeState.days).forEach(dayK => {
          const d = challengeState.days[dayK]
          if (!d || !d.stages) return
          Object.keys(d.stages).forEach(siK => {
            const r = d.stages[siK]
            if (!r || !r.done) return
            const q = Number(r.total) || 0
            if (!q) return
            const k = Number(dayK) + '-' + Number(siK)
            const at = Number(r.at) || 0
            if (!first[k] || at < (first[k].at || 0)) first[k] = { at: at, c: Number(r.correct) || 0, t: q }
          })
        })
      }
    } catch (e) { /* 本机存档损坏 → 只吃云端 */ }
    // ② 云端 chy 全量（跨营次；cleared 存根跳过 —— 成绩被重置 → 该阶段不再作为依据）
    try {
      if (Array.isArray(_chCloudChy) && _chCloudChy.length) {
        _chCloudChy.forEach(x => {
          if (!x || x.cleared) return
          const q = Number(x.total) || 0
          if (!q) return
          const day = Number(x.day) || 0
          if (!day) return
          const k = day + '-' + (Number(x.si) || 0)
          const at = Number(x.at) || 0
          const rec = { at: at, c: Number(x.correct) || 0, t: q }
          // 两路同键 → 取 at 最早的那条（首次完成口径；本机与云端内容一致时天然幂等）
          if (!first[k] || at < (first[k].at || 0)) first[k] = rec
        })
      }
    } catch (e) { /* 云端快照异常 → 只吃本机 */ }
    let c = 0, t = 0
    Object.keys(first).forEach(k => { c += first[k].c; t += first[k].t })
    if (!t) return null
    return Math.round(Math.min(1, c / t) * 100)
  } catch (e) { return null }
}
// v180：云端 chy 全量快照（本人、跨营次、未重置）。由 chAbsorbCloudProgress 拉取积分榜时写入。
//   ★ 只做「读取缓存」，不改任何本地进度 —— 定级读它，进度恢复另有 chAbsorbCloudProgress。
//   ★ 页面刚打开还没拉到云端 → 为空数组 → chLevelAcc 自动退化为纯本机口径（不会误判成 0 分）。
let _chCloudChy = []
// ====== v174：线下课成绩并入等级评定 ======
// 需求（用户原话）：「可以把线下课的成绩也放入评定标准」→ 拍板三项口径：
//   ① 只取**有分数的正式考试**：终极大考（coursefinal）+ 随堂考试/水平测试（exam）。
//      排除作业（homework，可反复重做、分数意义弱）、视频小测（video quizScore，题量 3~7 太少）
//      与线下实操（offline 只有 done:true，无分数 → 结构性不可用）。
//   ② 合流 = **加权平均**：合成分 = 挑战首答准确率 × 0.7 + 线下课均分 × 0.3。
//      线下课无分时**退化为纯挑战准确率**（不是当 0 分算 —— 否则没上过线下课的人被无端压级）。
//   ③ **地面压制仍然只压挑战那一部分**：先把挑战准确率按难度档压顶 → 得到「挑战侧等级」，
//      再与线下课均分加权。线下课是另一套标尺（题量、难度、监考都不同），
//      用挑战的地板去压它逻辑上讲不通，故只对挑战侧生效。
//
// ⚠️ 数据源：线下课成绩**不在** eq-quiz-sync 云端文档里（base 无任何 course 字段），
//   只存在于 courseState.doc（course-app.js 载入的课程文档）。所以本函数读的是**本机课程缓存**：
//   · 页面刚打开、课程文档还没拉到 → courseState.doc 为 null → 返回 null（退化为纯挑战口径，
//     不会误判成 0 分；等课程文档到位后评分自动生效）
//   · 换设备 / 清缓存 → 同上，等级暂时只按挑战算，与「挑战进度跨设备」是同一套生命周期（预期行为）
// ★ 沙箱切片注入时 courseState / Store 可能不存在 → 全程 typeof 守卫，缺依赖返回 null。
// ★ 必须 function 声明且位于 chLevelOf 之上（chLevelOf 会调用它；const 会 TDZ）。
function chCourseScore() {
  try {
    if (typeof courseState === 'undefined') return null
    const doc = courseState && courseState.doc
    if (!doc || !Array.isArray(doc.classes)) return null
    const uid = (typeof challengeUid === 'function') ? challengeUid() : ''
    if (!uid) return null
    // 收集「我是成员」的班级（成员名单是小写 username；挑战 uid 亦为小写）
    const myList = []
    doc.classes.forEach(cls => {
      if (!cls) return
      const members = Array.isArray(cls.members) ? cls.members : []
      const isMine = members.some(m => String(m || '').trim().toLowerCase() === uid)
      if (!isMine) return
      ;(cls.assignments || []).forEach(a => {
        if (!a) return
        if (a.type !== 'coursefinal' && a.type !== 'exam') return
        const rs = a.results
        if (!rs || typeof rs !== 'object') return
        // results 有两种形态：对象 map（{uid: {...}}）或数组；统一取「我这个 uid」那条
        let rec = null
        if (Array.isArray(rs)) {
          rec = rs.find(r => r && String(r.u || r.username || '').trim().toLowerCase() === uid) || null
        } else {
          // 键名大小写可能不一致 → 遍历找（班级规模小，成本可忽略）
          const hit = Object.keys(rs).find(k => String(k).trim().toLowerCase() === uid)
          if (hit) rec = rs[hit]
        }
        if (!rec || typeof rec !== 'object') return
        const sc = Number(rec.score)
        if (Number.isFinite(sc)) myList.push(sc)
      })
    })
    if (!myList.length) return null
    const avg = myList.reduce((s, v) => s + v, 0) / myList.length
    return Math.round(Math.max(0, Math.min(100, avg)))
  } catch (e) { return null }
}
// v174：线下课均分（0~100 整数；无人任何正式考试记录 → null）。
//   与 chCourseScore 同源，但**不做加权**，供等级卡 UI 单列展示。
function chCourseAvg() { return chCourseScore() }
// 等级评定（返回 1~4）。输入可省略 → 内部实时计算（渲染入口用）。
//   ★ 回退链：无基准（还没做过练习）或还没做过任何首答 → 恒回 L1。
//     这与「Day1 开始时所有人都是 L1」的产品预期一致，也避免了「还没开始就显示 L3」的荒谬态。
//   ★★ v166：唯独「本机完全没有练习依据」（bench === 0）这一种情况要例外 ——
//     此时说明本机还没恢复出任何阶段记录（换设备第一天 / 云端 chy 被折叠丢失），
//     本机推不出等级**不等于学员没有等级**。这时回落到云端已知等级 chLevelFloor()，
//     避免「换台电脑就从 L3 掉到 L1」的假降级。有依据时一律以本机推导为准（它更精确、更新）。
function chLevelOf(accArg) {
  const acc = (accArg === undefined) ? chLevelAcc() : accArg
  const bench = chLevelBench()
  if (!bench) return (typeof chLevelFloor === 'function') ? chLevelFloor() : 1
  if (acc == null) return (typeof chLevelFloor === 'function') ? chLevelFloor() : 1
  const a = Number(acc) / 100
  const raw = (a >= 0.90) ? 4 : (a >= 0.60) ? 3 : (a >= 0.30) ? 2 : 1
  // v174：先按难度档把**挑战侧**压顶（地板只作用于挑战，不压线下课 —— 见 chCourseScore 注释③）
  // v180：压顶档位由 chLevelCapOfBench() 计算 —— 见该函数注释（关键：Math.round 会
  //   把 Day2 的 1.27 抹回 1、Day5 的 2.27 抹回 2，压制过紧；且 L3 另加「Day7 + ≥95%」质量门槛）。
  //   ★ 必须把 maxDay 与 acc 一并传入 —— L3 门槛判的就是这两项，漏传 = 门槛永不生效（静默失效）。
  const capped = (typeof chLevelCapOfBench === 'function')
    ? chLevelCapOfBench(bench, raw, chLevelMaxDay(), acc)
    : Math.max(1, Math.min(raw, Math.round(bench)))
  // v174：线下课均分并入（加权 70/30）。无分 → 原样返回 capped，行为与 v167 完全一致。
  const cs = (typeof chCourseScore === 'function') ? chCourseScore() : null
  if (cs == null) return capped
  // ★ 用「挑战侧已压顶的等级」反推等效分数，而不是直接用原始准确率 ——
  //   否则地板对挑战的压制会被加权稀释掉（例：准确率 100% 但地板 L1，若用原始 100 加权
  //   再配线下课 100 分会算出高分 → 又跳回 L4，地板形同虚设）。
  const cappedScore = capped >= 4 ? 0.90 : capped >= 3 ? 0.60 : capped >= 2 ? 0.30 : 0
  const blended = cappedScore * 70 + (Number(cs) / 100) * 30
  const b = blended / 100
  const out = (b >= 0.90) ? 4 : (b >= 0.60) ? 3 : (b >= 0.30) ? 2 : 1
  // ★ 合成后不与 capped 取 max —— 否则「线下课计入评定」永远只能升不能降，等于没把线下课当标准。
  //   线下课考砸了就该体现出来（这正符合用户「放入评定标准」的诉求）。
  return Math.max(1, Math.min(4, out))
}
// v180：难度档基准 → 挑战侧等级上限。
//   旧写法 `Math.round(bench)` 在两期计划下都过紧（实测第一期逐日名义均值
//   1.00 / 1.27 / 1.60 / 1.93 / 2.27 / 2.60 / 2.80）：
//     · Day2 = 1.27 → round 1 → 练到第 2 天仍封顶 L1
//     · Day5 = 2.27 → round 2 → 练到第 5 天、准确率再高也封顶 L2
//   新写法按「档位区间」判：名义均值落在区间内即视为「练到了该档」。
//     · bench < 1.5  → 上限 1（Day1 = 1.00 → 仍只 L1，**原有的地板压制完整保留**）
//     · < 2.5 → 上限 2 · < 3.5 → 上限 3 · ≥3.5 → 上限 4
//   为什么用 1.5/2.5/3.5（区间中点）而不是 2.0/3.0/4.0：档位阈值取「是否站稳该档」的语义
//   —— bench=1.27（Day2）仍属难度 1 档偏上（配额 26/0/4，绝大多数是难度 1 题），
//   强行给到 L2 会让「Day1 全对」与「Day2 全对」拿到同样的等级。
//   ★ 上限永不高于 raw（准确率本身决定能力上限）—— 两者取 min，压制与准确率都不失效。
//   ★ 返回值一定是 1~4 的整数（下游 cappedScore 分支依赖整数比较）。
//
// ★★★ v180 补充：L3 另加「质量门槛」（用户拍板 —— 让 L3 真正代表「高质量跑完七天」）。
//   实测线上 49 人：不加门槛时 31 人挤在 L3（都练到 Day6/7 → 基准 2.6~2.8 → cap 3），
//   等级失去区分度。加门槛后分布 L1×11 / L2×27 / L3×11，且 11 位 L3 全是
//   「Day7 完成 + 准确率 ≥95%」—— 分布与语义都立得住。
//   门槛条件：基准已进 3 档（cap ≥ 3）时，还需 **练到 Day7** 且 **准确率 ≥95%**；
//   不满足则退回 2 档（不是退回 1 档 —— 他们确实练到了中后段，不该与 Day1 同档）。
//   ★ 只影响「拿 L3」这一档；L1/L2/L4 的判定不受门槛影响（L4 仍只能靠逐级爬升）。
function chLevelTierOfBench(bench) {
  const b = Number(bench) || 0
  return (b < 1.5) ? 1 : (b < 2.5) ? 2 : (b < 3.5) ? 3 : 4
}
function chLevelCapOfBench(bench, raw, day, acc) {
  const b = Number(bench) || 0
  const r = Number(raw) || 1
  let cap = chLevelTierOfBench(b)
  // L3 质量门槛（见函数头注释）：进 3 档但未「Day7 + ≥95%」→ 退 2 档。
  //   ★ day / acc 省略时**不施加门槛** —— 保持老调用点（只传 bench/raw）的向后兼容语义。
  if (cap >= 3 && day != null && acc != null) {
    const d = Number(day) || 0
    const a = Number(acc) || 0
    if (!(d >= 7 && a >= 95)) cap = 2
  }
  return Math.max(1, Math.min(4, Math.min(r, cap)))
}
// v166：本机存档里记住的「云端已知等级」（1~4；没有 → 1）。
//   写入时机 = chAbsorbCloudLevel()（从 base[u].chLevel 回放）。
//   ★ 只作为「本机无依据时」的地板值，绝不参与有依据时的计算 ——
//     否则云端旧快照会盖住本机刚练出来的新等级（学员当场看到降级）。
function chLevelFloor() {
  try {
    const v = Number(challengeState && challengeState.chLevel)
    return (Number.isInteger(v) && v >= 1 && v <= 4) ? v : 1
  } catch (e) { return 1 }
}
// 当前等级（渲染入口）。challengeLoad() 已保证 challengeState 是本营次的存档。
function chLevel() { return chLevelOf() }
// v165：等级变化 → 差分落盘 + 返回变化信息（渲染层据此播升级/降级动画）。
//   变化记录存在 days[day].lvChg = { from, to, dir, acc, bench, at }，
//   是**按用户 + 营次**隔离的存档字段 → 换号/换期不会串台。
//   ★ 必须在**练习完成那一刻**调用（chRecordStage 之后），此时当天的 stage 记录已写入。
function chLevelApply(day) {
  try {
    if (!challengeState || !challengeState.days) return null
    const acc = chLevelAcc()
    const bench = chLevelBench()
    const to = chLevelOf(acc)
    const dnum = Number(day) || 0
    // 从当天更早的阶段（若有）取上一等级；没有则用存档根部的 lv（首次评定的起点）
    let prev = null
    if (dnum && challengeState.days[dnum]) {
      const d = challengeState.days[dnum]
      if (d.stages) {
        Object.keys(d.stages).forEach(siK => {
          const r = d.stages[siK]
          if (r && r.lv != null) prev = Number(r.lv)
        })
      }
    }
    if (prev == null) prev = (challengeState.lv == null) ? 1 : Number(challengeState.lv)
    challengeState.lv = to
    // v166：本机已知等级地板值同步抬高（只升不降）。作用：万一之后云端回放读到一个更旧的
    //   低等级，地板值不会被它拉下去 —— 学员自己的练习成果永远压得过云端旧快照。
    if (!(Number(challengeState.chLevel) > to)) challengeState.chLevel = to
    if (!dnum) return null
    if (!challengeState.days[dnum]) challengeState.days[dnum] = { stages: {} }
    const d = challengeState.days[dnum]
    if (prev === to) { if (d.lvChg) delete d.lvChg; challengeSave(); return null }
    const dir = to > prev ? 'up' : 'down'
    d.lvChg = { from: prev, to: to, dir: dir, acc: acc, bench: Math.round(bench * 100) / 100, at: Date.now() }
    challengeSave()
    // v166：等级真的有变化 → 上报云端（chlevel 事件 → base[u].chLevel，看板/换设备回放读它）。
    //   ★ 只在「变化」这一支上报，不在函数入口上报：
    //     ① 无变化时 repeated 上报只会白白增加云端事件数（每完成一个阶段一条）；
    //     ② 但首次评定（prev==1 → to==1）也不会触发 —— 那时云端本来就该是空的，
    //        看板「等级」列显示「—」正是想要的语义（还没练出等级）。
    //   ★ 刻意放在 challengeSave() 之后：先保证本机落盘成功，再谈上报（本机才是权威）。
    //   ★ 用 to 而不是 challengeState.lv：两者此刻相等，但用局部变量不依赖后续改动。
    try { if (Store && Store.reportChallengeLevel) Store.reportChallengeLevel(to, chCurrentRound()) } catch (e) {}
    return d.lvChg
  } catch (e) { return null }
}
// v180：存量补评 —— 用「过往所有正确率」（本机 + 云端 chy 全量）重算等级并上报。
//   触发时机 = 积分榜拉取（chLoadLeaderboard）拿到云端数据之后。
//   与 chLevelApply 的分工：
//     · chLevelApply  = **练习当下**评级，负责升降级动画差分（写 days[day].lvChg）
//     · chLevelBackfill = **打开页面时**按全量历史校核一次，负责「补上历史漏评」与「按新口径修正」
//   口径：
//     · 只在 chLevelAcc() 非 null（确有首答记录）时才动手 —— 绝不把「从没练过」的人写成 L1，
//       否则云端会凭空多出一堆假的 L1（看板「等级」列本该显示「—」）。
//     · 算出的等级与云端现值**相同时不重复上报**（避免每 60 秒拉一次积分榜就多一条事件）。
//       ★ 比对基准 = 云端已回放进 challengeState.chLevel 的已知值（chAbsorbCloudLevel 刚写过），
//         它与看板同源，是判断「云端有没有这个等级」的唯一可靠依据。
//     · 上报走 Store.reportChallengeLevel（chlevel 事件，写入端与重放端均为最后写入者胜 → 幂等）。
function chLevelBackfill() {
  try {
    const acc = (typeof chLevelAcc === 'function') ? chLevelAcc() : null
    if (acc == null) return false
    const bench = (typeof chLevelBench === 'function') ? chLevelBench() : 0
    if (!bench) return false
    const to = chLevelOf(acc)
    if (!Number.isInteger(to) || to < 1 || to > 4) return false
    // 与云端已知值相同 → 不重复上报（幂等短路）
    //   ★ 必须在写本机存档**之前**判：否则每次拉积分榜都会白白改写一遍 localStorage。
    const known = Number(_chCloudLevelKnown) || 0
    if (known === to) return false
    // 本机存档同步（等级卡实时推导读的就是它 → 学员刷新即可见新等级）
    //   ★ v180：challengeState 可能为 null（本机存档还没初始化 / 换设备首屏）——
    //     不能只判 truthy 就跳过（那样换设备学员永远等不到等级落盘）。
    //     口径与 challengeLoad() 一致：缺就按当前 uid 新建一个空存档。
    if (!challengeState || typeof challengeState !== 'object') {
      let uid = ''
      try { uid = (typeof challengeUid === 'function') ? challengeUid() : '' } catch (e) { uid = '' }
      challengeState = { uid: uid, days: {} }
    }
    if (!challengeState.days || typeof challengeState.days !== 'object') challengeState.days = {}
    challengeState.lv = to
    if (!(Number(challengeState.chLevel) > to)) challengeState.chLevel = to
    try { if (Store && Store.reportChallengeLevel) Store.reportChallengeLevel(to, chCurrentRound()) } catch (e) {}
    _chCloudLevelKnown = to
    try { if (typeof challengeSave === 'function') challengeSave() } catch (e) {}
    return true
  } catch (e) { return false }
}
// v180：本机记录的「云端当前等级」（chAbsorbCloudLevel 回放时写入）。
//   用途 = chLevelBackfill 的幂等短路（相同则不再上报）；不参与任何等级计算。
let _chCloudLevelKnown = 0
// v165：等级卡（挑战页顶部）。等级徽章 + 准确率/基准 + 最近一次升降的动画提示。
//   ★ 动画只播一次：_chLvAnimAt 与 lvChg.at 比对（内存态，刷新页面即不再播 —— 提示已看过）。
//   ★ 本函数被切片注入的套件直接调用 → 内部所有外部符号都必须 typeof 守卫。
let _chLvAnimAt = 0
function chLevelCardHtml() {
  try {
    const lv = (typeof chLevel === 'function') ? chLevel() : 1
    const acc = (typeof chLevelAcc === 'function') ? chLevelAcc() : null
    const bench = (typeof chLevelBench === 'function') ? chLevelBench() : 0
    // v174：线下课均分（无分 → null），并入后展示在等级卡第二行
    const cs = (typeof chCourseScore === 'function') ? chCourseScore() : null
    const nextNeed = [0, 0.30, 0.60, 0.90, 1.01]
    const need = nextNeed[lv] || 1.01
    const needPct = Math.round(need * 100)
    const canRise = bench >= need - 1e-9     // 基准不够 → 准确率再高也升不上去（见口径②）
    const lvName = (k) => { try { return t('chLevelName' + k) } catch (e) { return 'L' + k } }
    let tip = ''
    if (acc == null) tip = t('chLevelNoData')
    else if (lv >= 4) tip = t('chLevelMax')
    else if (canRise) tip = t('chLevelNeedAcc', needPct)
    else tip = t('chLevelNeedBench', needPct)
    // 等级变化提示（升级 / 降级各一套文案与配色）
    let chg = ''
    let chgAt = 0
    try {
      const days = (challengeState && challengeState.days) || {}
      Object.keys(days).forEach(k => {
        const c = days[k] && days[k].lvChg
        if (c && (Number(c.at) || 0) > chgAt) { chg = c; chgAt = Number(c.at) || 0 }
      })
    } catch (e) { chg = null }
    const up = chg && chg.dir === 'up'
    const fresh = (typeof _chLvAnimAt === 'undefined') || (chgAt > _chLvAnimAt)
    if (chg && fresh && (typeof _chLvAnimAt !== 'undefined')) _chLvAnimAt = chgAt
    const chgHtml = chg
      ? `<div class="ch-lv-chg ${up ? 'ch-lv-up' : 'ch-lv-down'}">
          <span class="ch-lv-ico">${up ? '⬆️' : '⬇️'}</span>
          <span class="ch-lv-txt">${up ? t('chLevelUp', lvName(chg.from), lvName(chg.to)) : t('chLevelDown', lvName(chg.from), lvName(chg.to))}</span>
          ${(chg.acc == null) ? '' : `<span class="ch-lv-acc">${t('chLevelBaseAcc', chg.acc)}</span>`}
        </div>`
      : ''
    // v174：分项展示 —— 让学员看懂等级是怎么算出来的（挑战 70% + 线下课 30%）
    const srcHtml = (cs == null)
      ? `<div class="ch-lv-src">${escHtml(t('chLevelSrcNoCourse'))}</div>`
      : `<div class="ch-lv-src">${escHtml(t('chLevelSrcBlend',
          (acc == null ? 0 : acc), cs, Math.round((acc == null ? 0 : acc) * 0.7 + cs * 0.3)))}</div>`
    return `
    <div class="card ch-lv-card${fresh && chg ? (up ? ' ch-lv-flash-up' : ' ch-lv-flash-down') : ''}" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div class="ch-lv-badge ch-lv-lv${lv}">
          <div class="ch-lv-num">L${lv}</div>
          <div class="ch-lv-sub">${escHtml(t('chLevelTitle'))}</div>
        </div>
        <div style="flex:1;min-width:180px">
          <div style="font-weight:800;font-size:15px">${escHtml(lvName(lv))}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">
            ${(acc == null) ? escHtml(t('chLevelAccNone')) : escHtml(t('chLevelAccNow', acc))}
            · ${escHtml(t('chLevelBenchNow', Math.round(bench * 100) / 100))}
          </div>
          ${srcHtml}
          <div style="font-size:12px;color:#9ca3af;margin-top:4px">${escHtml(tip)}</div>
        </div>
      </div>
      ${chgHtml}
      <div class="ch-lv-bar"><div class="ch-lv-bar-fill ch-lv-bar${lv}" style="width:${lv * 25}%"></div></div>
    </div>`
  } catch (e) { return '' }
}

// v165：等级评定（chLevel / chLevelApply）——**必须定义在 chRecordStage 之上**。
//   chRecordStage（完成练习时）会在函数体里调用 chLevelApply。函数声明本身是提升的，
//   但规则要写死：这两个必须保持 `function` 声明，**绝不能改成 `const fn = () => {}`** ——
//   那样就踩 TDZ（调用先于初始化）→ 直接抛 ReferenceError。放在上方是双保险，也让
//   「谁在什么时候评等级」这条链一眼可见。同理 chPlanDayAvg 在 §v149 段。
// 需求与口径见 chLevelBench / chLevelAcc / chCourseScore / chLevelOf 的注释。

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
// ⚠️ v102：'第一期' 与 'r1' 必须归一到同一个键。'第一期' 是本函数对 'r1' 的输出，
//   而存档键 / chy 记录的 rd 都走这里 → 若不归一，读到的 '第一期' 会派生出一个不存在的营次键。
function chRoundSlug(id) {
  const s = String(id || '第一期').trim()
  return (!s || s === 'r1' || s === '第一期') ? '第一期' : s
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
// ⚠️ v110：本函数只反映**视角内的主营次**（单一）。大部门视角下可能有多个分部门营次并存，
//   需要完整列表请用 chRoundListForView()；本函数取该列表的最后一项（最新一期）作代表。
function chCurrentRound() {
  try {
    // ⚠️ v110 教训：每级回落都必须是「函数存在才调用」而不是「直接调用 + 外层 try 兜底」。
    //   若 chRoundListForView 缺失（部分加载 / 旧缓存片段 / extractFn 沙箱），直接调用会抛
    //   ReferenceError 被外层 catch 吞掉 → **整函数**回落 '第一期'，连后面的侧信道都不再读，
    //   表现为「学员营次莫名变回第一期」。守卫后可继续走下一级回落。
    if (typeof chRoundRecForDept === 'function') {
      const rec = chRoundRecForDept()
      if (rec && rec.id) return String(rec.id)
    }
    if (typeof chRoundListForView === 'function') {
      const list = chRoundListForView()
      if (list && list.length) return String(list[list.length - 1].id)
    }
    const id = (typeof CloudSync !== 'undefined' && CloudSync._chRoundCurId)
    return id ? String(id) : '第一期'
  } catch (e) { return '第一期' }
}
// ====== v110：视角营次列表（一级部门视角汇总其下所有分部门的挑战）======
// 用户口径：「饮食部点开来应该能看到所有饮食部下属部门的挑战」。
//   · 分部门视角（'dining/sig'）→ 本部门适用营次（与 chRoundRecForDept 同口径，最多一个）
//   · 大部门视角（'dining'）    → 其下所有分部门各自适用的营次，逐个列出（标帜第一期 + 艳中第一期…）
//   · 全库视角（'' / 'all'，管理员）→ 全部营次
// 与 chRoundRecForDept 的关系：后者是「单一主营次」（存档键/上报 rd 用），本函数是「视角内营次全集」
//   （列表展示/看板过滤用）。两者必须同源 —— 分部门视角下后者含前者，大部门视角下前者为 null 而本函数非空。
// ⚠️ 不要用 roundDeptMatch(r, 'dining') 判断大部门归属（它语义是「学员适用」，大部门视角不匹配挂分部门的营次），
//   必须显式展开子部门 slug 逐个匹配 —— 这是 v109「暂无挑战」卡的病根。
function chRoundViewSlugs() {
  try {
    const k = chDeptKey()
    if (!k) return null                            // 空 = 全库视角（默认）：null = 不过滤
    if (k === 'all') return []                      // v110：'all' = 仅通用题切片（v92 语义），无下属分队 → 无营次可汇总
    if (k.indexOf('/') >= 0) return [k]           // 分部门视角：只本部门
    // 大部门视角：展开其下全部分部门 slug（DEPT_SUB_SLUGS 键为显示名、值为 slug）
    const m = (typeof DEPT_SUB_SLUGS !== 'undefined') && DEPT_SUB_SLUGS[k]
    if (!m) return [k]
    return Object.keys(m).map(name => k + '/' + m[name])
  } catch (e) { return null }
}
// 视角内营次列表（保持云端数组原顺序；同一营次不会重复入列）
function chRoundListForView() {
  try {
    if (typeof CloudSync === 'undefined' || !Array.isArray(CloudSync._chRounds) || !CloudSync._chRounds.length) return []
    if (typeof roundDeptMatch !== 'function') return []
    const slugs = chRoundViewSlugs()
    const arr = CloudSync._chRounds
    if (slugs === null) return arr.filter(r => r && r.id)      // 全库视角：全部营次
    if (!slugs.length) return []                               // 'all'（仅通用题）：无分队可汇总
    const seen = {}
    const out = []
    arr.forEach(r => {
      if (!r || !r.id || seen[r.id]) return
      // 任一子部门匹配即归属本视角（这解决了「饮食部看不到下属部门挑战」）
      if (slugs.some(s => roundDeptMatch(r, s))) { seen[r.id] = 1; out.push(r) }
    })
    return out
  } catch (e) { return [] }
}
// ====== v153：营次列表卡专用取数（汇总视角只显示「登录账号自己部门」的营次）======
// 用户口径（v153）：「本部门不是应该也只显示自己部门了么」—— v110 的「大部门/全库汇总所有下属营次」
//   总览卡在 v152 按部门独立编号后反而误导（标题写「本部门」、列的却是别队的期）。
//   · 分部门视角（'dining/sig' 等）→ 视角本身已是单一部门 → 维持原口径（chRoundListForView）
//   · 汇总视角（'' 全库 / 'dining' 等大部门 / 'all' 通用）→ 回落**登录账号自己部门**（sessionDeptSlug()）
//     · 未设部门（典型：管理员账号 dept 为空）→ 空 → 整卡不渲染；要看全队请切「题目部门」到具体分队
//   ⚠️ 只供「列表卡」使用，绝不动 chRoundListForView 本体 —— 它还被 chCurrentRound 回落、
//      chRoundViewKey（重载判据）、chRoundMetaText / chHardRoundHtml 回落消费，改了会连坐主链路。
function chRoundCardList() {
  try {
    const k = (typeof chDeptKey === 'function') ? chDeptKey() : ''
    if (k && k !== 'all' && k.indexOf('/') >= 0) return chRoundListForView()
    const mine = (typeof sessionDeptSlug === 'function') ? sessionDeptSlug() : ''
    if (!mine) return []
    const list = (typeof chRoundListForView === 'function') ? chRoundListForView() : []
    if (typeof roundDeptMatch !== 'function') return []
    return list.filter(r => r && r.id && roundDeptMatch(r, mine))
  } catch (e) { return [] }
}
// 视角营次集合的稳定标识：并入「已装载营次」判定 → 大部门视角下营次增减能触发重载/重渲染
function chRoundViewKey() {
  try {
    const list = (typeof chRoundListForView === 'function') ? chRoundListForView() : []
    if (list.length) return list.map(r => r.id).join(',')
    const k = (typeof chDeptKey === 'function') ? chDeptKey() : ''
    return k ? 'none:' + k : 'all'
  } catch (e) { return 'all' }
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
// v110：装载标识从「单一主营次 id」改为「视角营次集合 chRoundViewKey()」——
//   大部门视角（饮食部）下主营次不随分部门营次增减而变，只比 id 会漏掉这类变化。
function chEnsureRound() {
  const id = chCurrentRound()
  const vk = (typeof chRoundViewKey === 'function') ? chRoundViewKey() : ''
  if (_chRoundLoaded === id && _chRoundViewLoaded === vk) return false
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
  _chRoundViewLoaded = vk
  _chLbCache = { at: 0, top: null }   // 营次变了 → 积分榜缓存作废
  return true
}
let _chRoundLoaded = ''    // 已装载的营次 id（切换判断用）
let _chRoundViewLoaded = '' // v110：已装载时的视角营次集合标识（大部门视角下营次增减也要重载）

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
// v154：题源再收窄为 chRoundBankQuestions()（当前营次挂了 depts 时按营次收窄）——
//   管理员/大部门视角试做某期挑战时，抽的也是该期自己的题（见 chRoundBankQuestions 注释）。
function challengePool() {
  const all = chRoundBankQuestions()
  const seen = new Set()
  const uniq = []
  for (const q of all) {
    const k = String(q.id)
    if (!seen.has(k)) { seen.add(k); uniq.push(q) }
  }
  // v149：难度归桶按「题库实际最大难度」缩放，避免 L4 题一律被 Math.min(3,…) 压进桶3 而掏空桶2
  const maxDiff = chBankMaxDiff(uniq)
  const buckets = { 1: [], 2: [], 3: [] }
  for (const q of uniq) {
    buckets[chDiffBucketOf(q && q.difficulty, maxDiff)].push(q)
  }
  ;[1, 2, 3].forEach(d => {
    const rng = challengeRng(chUserSeed() + d * 7919)
    for (let i = buckets[d].length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = buckets[d][i]; buckets[d][i] = buckets[d][j]; buckets[d][j] = tmp
    }
  })
  const out = []
  // v111：配比按营次取（第二期及以后用 CHALLENGE_DIFF_PLAN_HARD，难度2/3 占比更高）
  const plan = (typeof chDiffPlan === 'function') ? chDiffPlan() : CHALLENGE_DIFF_PLAN
  // v149：先「全局配额求解」，再逐天取题 —— 两步缺一不可。
  //   为什么不能只靠 chDrawWithBackfill 的运行时借档：它是**逐天顺序执行**的，
  //   稀缺档（如桶3 只有 24 题）会被前几天先吃掉，后面几天只能借到更易的档 →
  //   日均难度中途回落（线上题库实测 1.83 → 1.63）。正确做法是先算出「每天实际用哪档几题」，
  //   让稀缺的高档优先留给后面的天，保证梯度单调。
  const needMatrix = chPlanAllocate(plan, buckets)
  for (const need of needMatrix) {
    const drew = chDrawWithBackfill(need, buckets)
    drew.list.forEach(q => out.push(q))
  }
  return out
}

// v165：某一天练习序列的「计划难度均值」= 该天各档配额 × 档位 / 总题数（档位 1/2/3）。
//   ⚠️ 刻意不加「真实题库抽题」的兜底改判 —— 本函数只认名义计划难度（与 chDiffPlan 同源）。
//      理由：真实均值要跑一遍全量抽题（challengePool 很重），而且题库结构一变，学员等级就会
//      集体漂移（v149「桶2 恒空」的同类风险）。名义计划是设计意图、稳定可复现，适合做等级基线。
//      另外 challengeStratifiedDraw 把桶索引 2 提升为「实际档位 3」（4 档题库线性映射所致），
//      真实均值天然高于名义均值 —— 所以等级阈值必须按名义口径标定，绝不能混用。
function chPlanDayAvg(plan, day) {
  try {
    const arr = Array.isArray(plan) ? plan : []
    const idx = (Number(day) || 1) - 1
    const p = arr[idx]
    if (!Array.isArray(p)) return 0
    const n = [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0]
    const sum = n[0] + n[1] + n[2]
    if (!sum) return 0
    return (n[0] * 1 + n[1] * 2 + n[2] * 3) / sum
  } catch (e) { return 0 }
}

// v149：全局配额求解 —— 把 plan（逐天各档需求）与实际桶容量对齐，返回逐天的「实际取题构成」。
//   目标（按优先级）：
//     ① 每天题量恒等于 plan 当天总量（题池总量够时）→ 保证切片不越界、不出现空题；
//     ② 尽量满足 plan 的逐档需求；
//     ③ 缺口**优先从更高档补**（绝不从更低档补），这样「逐日变难」的梯度不会被拉平/回头；
//     ④ 高档容量不足时，把稀缺名额**优先留给后面的天**（后面的天本就该更难）。
//   算法：先把「高档需求」按天从后往前分配（稀缺资源优先给后排天），再逐档处理剩余缺口。
//   返回 number[][]，长度与 plan 一致，每项 = [n1, n2, n3]。
function chPlanAllocate(plan, buckets) {
  const cap = d => (Array.isArray(buckets[d]) ? buckets[d].length : 0)
  const avail = { 1: cap(1), 2: cap(2), 3: cap(3) }
  const days = plan.map(p => [Math.max(0, Number(p[0]) || 0), Math.max(0, Number(p[1]) || 0), Math.max(0, Number(p[2]) || 0)])
  const out = days.map(() => [0, 0, 0])
  // 第 1 轮：逐档（从高到低）满足需求，**同档内从后往前**分配 —— 稀缺的高档名额优先给后面的天
  for (let d = 3; d >= 1; d--) {
    for (let i = days.length - 1; i >= 0; i--) {
      const want = days[i][d - 1]
      const take = Math.min(want, avail[d])
      out[i][d - 1] += take
      avail[d] -= take
    }
  }
  // 第 2 轮：若有档位没满足（该档容量耗尽），缺口从**更高档**借；更高档也没有 → 从更低档补（保底，不空题）
  for (let i = 0; i < days.length; i++) {
    for (let d = 1; d <= 3; d++) {
      let miss = days[i][d - 1] - out[i][d - 1]
      if (miss <= 0) continue
      // 先向上借（更难）
      for (let up = d + 1; up <= 3 && miss > 0; up++) {
        const take = Math.min(miss, avail[up])
        if (take > 0) { out[i][up - 1] += take; avail[up] -= take; miss -= take }
      }
      // 再向下借（更易，仅作保底）
      for (let dn = d - 1; dn >= 1 && miss > 0; dn--) {
        const take = Math.min(miss, avail[dn])
        if (take > 0) { out[i][dn - 1] += take; avail[dn] -= take; miss -= take }
      }
    }
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
// 分层随机抽题核心（v80 重构）：从给定题源按分层配比随机抽 total 题
//（v111：配比按营次取 —— 第一期 难度1×10 + 难度2×7 + 难度3×3；
//  第二期及以后 难度1×5 + 难度2×10 + 难度3×5，明显更偏难）。id 去重，选项重洗。
// v149：① 归桶按题源实际最大难度缩放（不再是 Math.min(3,…)，避免 L4 题掏空中间档）；
//       ② 某档不足时经 chDrawWithBackfill 从相邻档就近补，保证取满 total（题源总量够的前提下）。
function challengeStratifiedDraw(source, total) {
  const seen = new Set()
  const uniq = []
  for (const q of source) {
    const k = String(q.id)
    if (!seen.has(k)) { seen.add(k); uniq.push(q) }
  }
  const maxDiff = chBankMaxDiff(uniq)
  const buckets = { 1: [], 2: [], 3: [] }
  for (const q of uniq) {
    buckets[chDiffBucketOf(q && q.difficulty, maxDiff)].push(q)
  }
  ;[1, 2, 3].forEach(d => {
    const b = buckets[d]
    for (let k = b.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1))
      const tmp = b[k]; b[k] = b[j]; b[j] = tmp
    }
  })
  const plan = (typeof chTestPlan === 'function') ? chTestPlan() : CHALLENGE_TEST_PLAN
  // 按 total 收敛各档配额（配比之和可能 > total 时，逐档削到 total 为止）
  const need = [plan[0], plan[1], plan[2]]
  let sum = need.reduce((a, b) => a + b, 0)
  for (let i = 2; i >= 0 && sum > total; i--) {
    const cut = Math.min(need[i], sum - total)
    need[i] -= cut; sum -= cut
  }
  const drew = chDrawWithBackfill(need, buckets)
  return drew.list.slice(0, total).map(shuffleOptions)
}
// 全库随机抽题（v80 前 test 唯一题源；现保留给 Day1 摸底——尚无已刷题时回退使用）
// v89：题源收窄为本部门题库
// v154：题源跟营次走（chRoundBankQuestions）
function challengeRandomQuestions(total) {
  return challengeStratifiedDraw(chRoundBankQuestions(), total)
}
// v80：考试题目出自本人已刷过的练习题——题源 = 个人练习序列中「已完成练习阶段」覆盖的前缀
//（线性解锁 → 已完成阶段恰为个人序列的前缀），从中分层随机抽 20 题；
// Day1 摸底时还没有已刷题（前缀不足一场考试）→ 回退全库随机。
// v111：第二期及以后的考试**先塞入本人第一期的错题**（challengeTestWithWrongQuestions），
//   再用上述题源补齐到 20 题 —— 用户口径「每个人要有自己第一期的错题在里面」。
//   第一期行为完全不变（仍是纯分层随机），保证老学员第一期成绩可复现。
function challengeTestQuestions() {
  const pool = challengePool()
  let k = 0
  challengeStageMeta().forEach(m => {
    if (m.kind === 'practice' && chStageDone(m.day, m.si)) k = Math.max(k, m.start + m.count)
  })
  const source = (k < 20) ? chRoundBankQuestions() : pool.slice(0, k)
  if (chIsHardRound()) return challengeTestWithWrongQuestions(source, 20)
  if (k < 20) return challengeRandomQuestions(20)
  return challengeStratifiedDraw(source, 20)
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
// v111：读取**上一营次（第一期）**的全部错题 —— 第二期考试的「专属错题」来源。
// 与 chPrevDayWrongQuestions 的区别：后者读**当前营次**进度里前一天的 stages[].wrong；
//   本函数读**另一营次的存档键**（第一期固定 eq_challenge_v2），与当前营次进度互不干扰。
// 口径：
//   · 汇总第一期存档里每一天每个阶段的 stages[].wrong（qid 去重）
//   · 按当前部门题库过滤（换部门后旧错题不再复现，与 v89 一致）
//   · 用 Store.getQuestion 取回题干，选项重洗（答案位置不固定）
//   · 旧存档无 wrong 字段 / 未参加过第一期 / 存档缺失 → 返回 []（第二期照常可考，只是无专属错题）
function chPrevRoundWrongQuestions() {
  const out = []
  try {
    let raw = null
    try { raw = JSON.parse(localStorage.getItem(CHALLENGE_KEY) || 'null') } catch (e) { raw = null }
    if (!raw || typeof raw !== 'object' || !raw.days) return out
    const bankIds = chBankIdSet()
    const seen = new Set()
    Object.keys(raw.days).forEach(dayK => {
      const d = raw.days[dayK]
      if (!d || !d.stages) return
      Object.keys(d.stages).forEach(siK => {
        const r = d.stages[siK]
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
    })
  } catch (e) { return [] }
  return out
}
// v111：第二期考试题源 = 本人第一期错题 + 分层随机补齐，凑满一场考试的题量。
// 目标：让每个人第二期的考试**一定包含自己第一期的错题**（用户口径：「每个人要有自己第一期的错题在里面」）。
//   · 错题全部前置（学员一进考场就遇到自己的薄弱题）
//   · 不足 total 题时用当前营次分层随机题补齐（题源 = 本人已刷题前缀，同 v80 口径）
//   · 错题数已 ≥ total 时只取前 total 道（避免考试无限长）；错题为空 → 退化为纯分层随机
//   · qid 去重（错题与补齐题可能撞题）
function challengeTestWithWrongQuestions(source, total) {
  const wrong = chPrevRoundWrongQuestions()
  const out = []
  const seen = new Set()
  const push = q => {
    const k = String(q && q.id)
    if (!k || k === 'undefined' || seen.has(k)) return
    seen.add(k)
    out.push(q)
  }
  wrong.forEach(push)
  if (out.length < total) {
    challengeStratifiedDraw(source || chRoundBankQuestions(), total).forEach(push)
  }
  return out.slice(0, total)
}
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

// ====== v107：七天挑战的适用部门（白名单）======
// 业务口径：七天挑战只对饮食部下的四个二级部门开放 —— 标帜餐厅 / 艳中餐厅 / 酒吧团队 / 客房送餐。
//   饮食部是一级部门，这四个是二级；三级（WOOBAR / WETBAR / LIQUID）只是「酒吧团队」的别名，
//   经 deptSubAlias 归一到 'dining/bar'，不单独成队、也不单独开营。
//   房务部（rooms）与其他部门（other）不参与七天挑战。
const CH_DEPT_SLUGS = ['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird']
// 当前视角是否具备参加七天挑战的部门资格。
//   管理员返回 true（管理员可在题库管理里给任一部门上传/查看，且要能在练习页切片预览各队挑战）。
//   学员：本人所属分部门 slug 命中白名单才可进；其他部门（房务部/其他部门/未设部门）不可进。
function chDeptAllowed() {
  try {
    if (typeof Store !== 'undefined' && Store.isAdmin && Store.isAdmin()) return true
    const k = chDeptKey()
    if (!k) return false
    if (k === 'all') return false
    return CH_DEPT_SLUGS.indexOf(k) >= 0
  } catch (e) { return false }
}
// 不可进入时的原因文案键（i18n）：房务部/其他部门 → 提示仅饮食部四个分队；未设部门 → 提示先选部门
function chDeptBlockReason() {
  const k = chDeptKey()
  if (!k || k === 'all') return 'chDeptNeedSet'
  return 'chDeptNotEligible'
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
// v110：判定改用「视角营次列表」—— 大部门视角（饮食部）其下分部门有营次即算有营次
//   （v109 及以前用 chRoundRecForDept()，大部门视角恒为 null → 饮食部被误判「暂无挑战」，正是用户报的问题）
function chNoRoundForDept() {
  try {
    if (typeof CloudSync === 'undefined') return false
    if (typeof roundDeptMatch === 'function' && Array.isArray(CloudSync._chRounds) && CloudSync._chRounds.length) {
      const k = chDeptKey()
      if (k) return (typeof chRoundListForView === 'function' ? chRoundListForView() : []).length === 0
      return false      // 全库视角（管理员「全部部门」/无部门）指针必命中，不存在「无营次」
    }
    return CloudSync._chNoRound === true
  } catch (e) { return false }
}
// 当前营次名称（横幅显示，如「第一期」）；优先按视角部门实时解析，云端未拉取时兜底「第一期」
// v110：大部门视角（饮食部）无单一主营次 → 回落到视角营次列表里最新一期（代表名），并从本期起展示子部门营次列表
function chRoundName() {
  try {
    // v110：与 chCurrentRound 同口径 —— 函数不存在则跳过该级回落，不要被外层 catch 吞掉整函数
    if (typeof chRoundRecForDept === 'function') {
      const rec = chRoundRecForDept()
      if (rec && rec.name) return String(rec.name)
    }
    if (typeof chRoundListForView === 'function') {
      const list = chRoundListForView()
      for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].name) return String(list[i].name)
    }
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
  // v149：抽不到题时给出明确提示，不再静默 return（旧行为 = 学员点「开始」毫无反应，无从判断）
  if (!qs.length) {
    alert(t('chEmptyAlert'))
    return
  }
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
  // v165：与 chBack 同款 —— 从结果页（✕）退出同样要能重播一次等级动画，否则升级提示会被吞掉
  if (typeof _chLvAnimAt !== 'undefined') _chLvAnimAt = 0
  renderChallenge()
}
// v165：回到挑战页时**允许重播一次等级变化动画** —— 学员做完当天练习、看完结果页再返回，
//   才第一次看到「L1 → L2 ⬆️」。不做这一步的话，动画只在 chRecordStage 那一刻被标记为已播，
//   而那一刻页面还停在结果页（等级卡根本没渲染），回来时静默无提示。
//   ★ 只重置 `_chLvAnimAt`，不动 lvChg 记录本身（它还要供等级卡的常驻文案使用）。
function chBack() {
  AntiCheat.stop(); chs = null
  if (typeof _chLvAnimAt !== 'undefined') _chLvAnimAt = 0
  renderChallenge()
}

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
// 重练不刷分），积分 = Σ(答对×100×环节权重) × 首答准确率 − Σ用时秒；v78：第七天期末考试 3 倍权重，管理员不参加排名。
// v160：乘以首答准确率（= 首次作答答对数 ÷ 首次作答题数）—— 与答对同源；绝不能用含重做的「正确率」，
//   否则把环节重做几遍就能把准确率刷到接近 100%，等于开了刷分后门（积分里的答对数按 v73 去重防的就是这个）。
// v84：被管理员重置成绩的测试记录（cleared 存根）不计分——重考后的新记录才计入。
// v88：只看当前营次的记录（rd 缺省 = 第一期/单期制旧数据）；round 省略时用当前营次。
// v110：round 省略且视角下有多个营次（大部门视角）→ 汇总这些营次的全部记录（与「饮食部能看到下属部门挑战」一致）；
//   显式传入 round（如看板指定期）或视角只有单个营次时，行为与 v88 完全一致。
function chLbAggregate(rows, round) {
  let wantList = null
  if (round == null) {
    try {
      const list = (typeof chRoundListForView === 'function') ? chRoundListForView() : []
      if (list.length > 1) wantList = list.map(r => chRoundSlug(String(r.id || '')))
    } catch (e) { wantList = null }
  }
  const want = String(round == null ? chCurrentRound() : round)
  const wantSlug = chRoundSlug(want)
  const matchRound = x => {
    const s = chRoundSlug(String((x && x.rd) || ''))
    return wantList ? wantList.indexOf(s) >= 0 : s === wantSlug
  }
  // v161：与看板 app.js 同口径的**计分用时**（两处独立实现，必须同步改，否则学员端与看板不一致）：
  //   每阶段先按 total × 30 秒封顶再累加 —— 削掉「页面挂着自己跑」的超长计时（实测有学员单个
  //   30 题阶段耗 3675 秒 = 122.5 秒/题，而全体 P90 仅约 25 秒/题）。total 缺失时不封顶。
  //   ★ 定义在函数内部、刻意不抽到模块级（与看板同理由：各套件按源码切片注入，抽出去会集体报错）。
  const chLbDeductSec = x => {
    const sec = Math.max(0, Number(x && x.usedSec) || 0)
    const total = Number(x && x.total) || 0
    if (total <= 0) return sec
    return Math.min(sec, total * 30)
  }
  // v78：管理员账号不参加排名（学员端前三同样剔除）
  const list = (rows || []).filter(r => r && r.role !== 'admin' && r.chy && r.chy.length).map(r => {
    const first = {}
    ;(r.chy || []).forEach(x => {
      if (x && x.cleared) return   // v84：成绩已重置的考试记录不计分
      if (!matchRound(x)) return   // v88：别的营次的记录不计入本期
      const k = x.day + '-' + x.si
      if (!first[k] || (x.at || 0) < (first[k].at || 0)) first[k] = x
    })
    let c = 0, tq = 0, tsec = 0, pts = 0
    Object.keys(first).forEach(k => {
      const x = first[k]
      c += x.correct || 0
      tq += x.total || 0
      tsec += chLbDeductSec(x)   // v161：计分用时（每阶段每题封顶 30 秒），与看板同口径
      pts += (x.correct || 0) * 100 * chLbStageWeight(x.day, x.kind)
    })
    // v160：与看板同口径 —— 积分 = 首答得分 × 首答准确率 − 用时秒。
    //   ★ 准确率必须与答对同源（去重后的首次完成记录），绝不能用含重做的「正确率」——那样重做就能刷分。
    const acc = tq > 0 ? Math.min(1, c / tq) : 1
    return { name: r.name || r.username || '', username: r.username, correct: c, q: tq, acc: acc, sec: tsec, score: Math.round(pts * acc) - tsec }
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
      <span style="color:#6b7280;font-size:12px;flex-shrink:0">${t('dashChThCorrect')} ${p.correct} · ${Math.round((p.acc == null ? 0 : p.acc) * 100)}%</span>
      <span style="font-weight:800;color:#b45309;flex-shrink:0">${p.score} ${t('scoreUnit')}</span>
    </div>`).join('')
}
let _chLbCache = { at: 0, top: null }
let _chGateRendered = null   // v76：挑战页渲染时的期末考试锁定态（拉取后变化则重渲染入口）
function chLbFill(top) {
  const el = document.getElementById('chLbBody')
  if (el) el.innerHTML = chLbRowsHtml(top)
}
// ====== v140：云端挑战进度 → 恢复到本地（换设备/浏览器不再从 Day1 重来） ======
// 由 v108 的 chAbsorbManualScores 泛化而来（用户拍板做「云端进度恢复」）：
// 挑战进度的权威是本机 localStorage，云端 chy 只做看板聚合 —— 学员换设备后挑战页会从 Day1
// 重新显示未完成（云端成绩仍在看板）。这里在积分榜拉取（挑战页周期执行）时，把**本人**
// 当前营次的全部未重置 chy 记录（练习 + 考试、补录或真实上报）合并进本地进度：
//   · 本地已有真实完成记录（done 且非 manual）→ 不覆盖（学员自己考出的成绩优先）
//   · 本地已吸收过（manual）→ 云端 manual 再覆盖（管理员 chyfix 改分同步；内容一致 = 幂等）
//   · 本地是重置存根（cleared）→ 被任何未 cleared 的云端记录覆盖恢复（重考成绩 / 补录）
//   · 已重置存根（cleared）的云端记录不恢复（重置语义优先）；'all' 重置的记录云端已删，天然不恢复
//   · 只吸收当前营次（rd 归一后比对）；恢复记录打 restored:true（补录仍打 manual:true）
//   · 错题明细（wrong[]）云端无按阶段存储 → 恢复记录为空数组（错题本不跨设备，已知限制）
function chAbsorbCloudProgress(rows) {
  const uid = challengeUid()
  let me = null
  ;(rows || []).forEach(r => { if (r && r.username === uid) me = r })
  // v180：顺手把「本人 chy 全量」缓存起来供定级使用（**跨营次、不筛 rd**）。
  //   ★ 放在 rd 过滤之前 —— 定级要的是「过往所有正确率」，跨营次的历史都要算。
  //   ★ 与下方进度恢复解耦：这里只读缓存，不改任何本地进度。
  try {
    _chCloudChy = (me && Array.isArray(me.chy)) ? me.chy.filter(x => x && !x.cleared) : []
  } catch (e) { _chCloudChy = [] }
  if (!me || !Array.isArray(me.chy) || !challengeState || !challengeState.days) return false
  let wantSlug = ''
  try { wantSlug = chRoundSlug(chCurrentRound()) } catch (e) { return false }
  let changed = false
  me.chy.forEach(x => {
    if (!x || x.cleared) return
    if (chRoundSlug(String((x && x.rd) || '')) !== wantSlug) return
    const day = Number(x.day) || 0, si = Number(x.si) || 0
    if (!day || si < 0) return
    if (!challengeState.days[day]) challengeState.days[day] = { stages: {} }
    const d = challengeState.days[day]
    if (!d.stages) d.stages = {}
    const rec = d.stages[si]
    if (rec && rec.done) {
      if (!rec.manual) return            // 学员真实成绩优先，永不覆盖
      if (!x.manual) return              // 本地补录 vs 云端真实上报：保守保留本地
      // 本地 manual + 云端 manual → 用云端覆盖（chyfix 改分后同步；内容一致 = 幂等）
    }
    // 本地无记录 / 半完成（进行中） / cleared 存根 → 写入恢复记录
    d.stages[si] = {
      done: true, at: Number(x.at) || Date.now(),
      correct: Number(x.correct) || 0, total: Number(x.total) || 0,
      wrong: [], ...(x.manual ? { manual: true } : { restored: true }),
    }
    changed = true
  })
  if (!changed) return false
  challengeSave()
  // 仅在非答题会话时重渲染（renderChallenge 对 quiz 会话另有保护，仍显式跳过更稳）
  try { if (!chs || chs.phase !== 'quiz') renderChallenge() } catch (e) { /* ignore */ }
  return true
}

// v166：从云端回放「能力等级」（base[u].chLevel）→ 本机存档 challengeState.chLevel（纯数字）。
//   为什么需要：等级本机是从「已完成的练习阶段」实时推导的（chLevelBench/chLevelAcc），
//   而练习阶段本身已经通过 chAbsorbCloudProgress 从云端恢复了 —— 但有两个真实的空窗：
//     ① 换设备第一天、本机 challengeState 全空 → chLevelBench=0 → 恒回 L1，
//        与看板显示的 L2/L3 不一致（学员会来问「为什么我的等级掉了」）；
//     ② 云端 chy 记录里 kind==='test' 的阶段不算等级依据（chLevelBench 只认 practice），
//        而 practice 阶段记录可能早被折叠/丢失 → 本机重算偏低。
//   本函数写的是「地板值」，由 chLevelOf() 在 **本机无任何依据时** 才使用（见 chLevelFloor）。
//   口径：
//     · **只升不降**：云端 lv 高于本机已知值才写。理由：本机值可能刚被本机练习推上去，
//       云端是历史快照；若本机刚升 L3、chlevel 事件还在推送队列里，采纳云端会让学员当场降级。
//     · u.chLevel 本身不带 rd（chlevel 事件的 rd 只用于排查），这里直接取云端最新等级 ——
//       与看板「等级」列完全同源，保证两处显示一致（这是本次需求的核心诉求）。
//   返回 true 表示本机地板值被云端抬高（渲染层据此刷新等级卡）。
function chAbsorbCloudLevel(rows) {
  try {
    if (typeof challengeState !== 'object' || !challengeState || !challengeState.days) return false
    const uid = challengeUid()
    let me = null
    ;(rows || []).forEach(r => { if (r && r.username === uid) me = r })
    if (!me) return false
    const cloudLv = Number(me.chLevel)
    if (!Number.isInteger(cloudLv) || cloudLv < 1 || cloudLv > 4) return false
    // v180：记下「云端当前等级」→ chLevelBackfill 的幂等短路依据（无论本机地板值是否需要抬高）
    _chCloudLevelKnown = cloudLv
    const known = Number(challengeState.chLevel) || 0
    if (cloudLv <= known) return false      // ★ 只升不降（同值也跳过，避免无意义落盘）
    challengeState.chLevel = cloudLv
    challengeSave()
    return true
  } catch (e) { return false }
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
      const rows = await CloudSync.getDashboardData()
      top = chLbAggregate(rows, chCurrentRound())
      // v108：手动补录的考试成绩同步进本地进度；v140：泛化为全部云端进度恢复（换设备不再从 Day1 重来）
      try { chAbsorbCloudProgress(rows) } catch (e) { /* 吸收失败不阻断积分榜 */ }
      // v166：云端等级回放（在进度恢复之后 —— 进度恢复会改变 chLevelBench，先恢复再比才有意义）。
      //   写的是 challengeState.lv，等级卡渲染走 chLevel() 实时推导，所以它**不改变**等级显示值，
      //   作用是留痕：让「本机曾从云端获知 Lx」这件事可被后续逻辑（如 chLevelApply 的 prev 起点）读到。
      try { chAbsorbCloudLevel(rows) } catch (e) { /* 同上，失败不影响主流程 */ }
      // v180：存量补评 —— 云端 chy 全量到手后，按「过往所有正确率」重算一次等级。
      //   为什么需要：v165 的定级只在「本机完成练习那一刻」触发（chRecordStage → chLevelApply），
      //   v165 上线**之前**练完的学员本机无等级依据、之后不再练 → 云端永远没等级。
      //   实测线上 49 人有练习记录、仅 5 人有等级 → 这里把漏掉的 44 人补上。
      //   ★ 必须放在 chAbsorbCloudProgress / chAbsorbCloudLevel 之后 —— 它俩决定了本次的
      //     准确率与基准（前者写 _chCloudChy，后者抬地板值），先喂数据再算才有意义。
      //   ★ 只在**有历史依据**时才上报（chLevelAcc 非 null）：绝不把「还没练过」的人写成 L1。
      try { chLevelBackfill() } catch (e) { /* 补评失败不影响积分榜 */ }
    }
  } catch (e) { /* 网络失败保留旧缓存或显示空态 */ }
  if (top) _chLbCache = { at: now, top }
  chLbFill(_chLbCache.top)
  // v76/v77：积分榜拉取顺带刷新了开关侧信道（_getDoc）→ 管理员刚开/关挑战或考试时重渲染入口；
  // v83：同一拉取也刷新了重置侧信道（_chResets）→ 刚被重置则清空本地进度并重渲染入口；
  // v88：营次切换（管理员新建/切换当前营次）也在此感知 → 换键重新装载本地进度；
  // 仅概览页响应（答题中 renderChallenge 会走会话分支，不打断作答）
  // ⚠️ v104：必须比对「本部门适用营次的身份」，不能只比对 open/exam 两个布尔量。
  //   事故：营次在学员页面已打开之后才创建（本部门原先无营次）时，open 前后都是 false
  //   → 值没变化 → 不重渲染、不重拉，学员永远停在「本部门无营次」的旧状态。
  //   表现极具迷惑性：挑战页打得开、进度与历史成绩照常显示（本地缓存渲染）、
  //   心跳照常上报，但每次开始都被总闸拦下 → 云端零上报。学员以为考完了，管理员查不到。
  try {
    if (typeof CloudSync !== 'undefined' && _chGateRendered !== null) {
      const cur = { open: chOpenLocked(), exam: chFinalExamLocked(), round: chCurrentRound(), dept: chDeptKey() }
      // 营次身份 = 本部门当前营次 id + 是否「本部门无营次」；任一变化都要重渲染
      const recNow = chRoundRecForDept()
      const idNow = recNow && recNow.id ? String(recNow.id) : ''
      const noRound = chNoRoundForDept()
      const shape = idNow + '|' + (noRound ? '1' : '0') + '|' + chRoundViewKey()
      if (cur.open !== _chGateRendered.open || cur.exam !== _chGateRendered.exam
        || cur.dept !== _chGateRendered.dept || shape !== _chGateRendered.shape) { renderChallenge(); return }
      if (cur.round !== _chGateRendered.round) { chEnsureRound(); renderChallenge(); return }
      if (chCheckRemoteReset()) renderChallenge()
    }
  } catch (e) { /* ignore */ }
}

// v114：学员侧「部门没同步过来」的自助修复。
//   事故现场：本机记录/会话里的部门丢了（早期版本残留、换设备、云端建号后本机只落了空值），
//   于是被判「不在七天挑战白名单」，页面只给一句「还未设置所属部门」，学员无从下手。
//   流程：云端重拉（含把云端部门回填本机账号记录）→ 按资料缓存回填会话 → 把 slug 推给 CloudSync → 重渲染。
//   修不好也没关系：仍是同一张说明页，只是顺带多了一次尝试。
async function chResyncDept() {
  try { if (typeof Store !== 'undefined' && Store.pullCloudChanges) await Store.pullCloudChanges() } catch (e) {}
  try { if (typeof Store !== 'undefined' && Store.repairSessionDept) Store.repairSessionDept() } catch (e) {}
  try { if (typeof Store !== 'undefined' && Store.syncDeptSlug) Store.syncDeptSlug() } catch (e) {}
  renderChallenge()
}

// v107：不具备参加资格的部门打开挑战页时的整页说明（入口卡的同口径展开版）
function chDeptBlockedPageHtml() {
  const reason = chDeptBlockReason()
  const names = CH_DEPT_SLUGS.map(s => (typeof deptSlugName === 'function' && deptSlugName(s)) || s)
  const list = names.map(n => `<span style="font-size:12px;background:#f3f4f6;color:#4b5563;border:1px solid #e5e7eb;border-radius:999px;padding:3px 12px">${escHtml(n)}</span>`).join('')
  const cta = reason === 'chDeptNeedSet'
    ? `<button class="btn btn-primary btn-sm" style="margin-top:14px" onclick="openProfileSetup()">${t('chDeptGoSet')}</button>`
    : ''
  // v114：把「本机记录 vs 资料缓存」的部门并排显示 —— 自助修复失败时，这张截图就能定位到底丢在哪一层
  let diag = ''
  try {
    const localDept = (typeof Store !== 'undefined' && Store.getSessionDept) ? (Store.getSessionDept() || '') : ''
    let profDept = ''
    try { profDept = ((typeof Store !== 'undefined' && Store.getUser && Store.getUser()) || {}).dept || '' } catch (e) {}
    const none = t('chDeptDiagNone')
    diag = `<p class="form-hint" style="margin:12px 0 0;font-size:11px;color:#9ca3af">${t('chDeptDiagLocal')}：${escHtml(localDept || none)} ｜ ${t('chDeptDiagProfile')}：${escHtml(profDept || none)}</p>`
  } catch (e) { diag = '' }
  return `
    <div class="card" style="max-width:520px;margin:24px auto;text-align:center">
      <div style="font-size:44px;opacity:.45">🏅</div>
      <h2 style="margin:8px 0 6px;color:#374151">${escHtml(t('chTitle'))}</h2>
      <p class="form-hint" style="margin:0;color:#9ca3af">🚫 ${t(reason)}</p>
      <p class="form-hint" style="margin:16px 0 8px;color:#6b7280">${t('chDeptEligibleList')}</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">${list}</div>
      ${cta}
      <div style="margin-top:10px">
        <button class="btn btn-ghost btn-sm" onclick="chResyncDept()">🔄 ${escHtml(t('chDeptResync'))}</button>
      </div>
      ${diag}
      <div style="margin-top:18px">
        <button class="btn btn-ghost btn-sm" onclick="navigate('practice')">${escHtml(t('backHome'))}</button>
      </div>
    </div>`
}

// v109：有资格但本部门暂无专属营次（如酒吧团队/客房送餐，目前只有标帜/艳中开营）时打开挑战页的整页说明。
// 与入口卡 challengeEntryNoRoundHtml 同口径：列出当前实际有营次的部门，不渲染别队营次的挑战内容。
function chDeptNoRoundPageHtml() {
  let names = []
  try {
    const rounds = (typeof CloudSync !== 'undefined' && Array.isArray(CloudSync._chRounds)) ? CloudSync._chRounds : []
    rounds.forEach(r => {
      ;(Array.isArray(r && r.depts) ? r.depts : []).forEach(d => {
        if (!d) return
        let n = d
        if (d.indexOf('/') >= 0) n = (typeof deptSlugName === 'function' && deptSlugName(d)) || d
        else try { n = (deptTree()[d] || {}).name || d } catch (e) {}
        if (names.indexOf(n) < 0) names.push(n)
      })
    })
  } catch (e) { names = [] }
  const list = names.map(n => `<span style="font-size:12px;background:#fef3c7;color:#b45309;border:1px solid #fde68a;border-radius:999px;padding:3px 12px">${escHtml(n)}</span>`).join('')
  return `
    <div class="card" style="max-width:520px;margin:24px auto;text-align:center">
      <div style="font-size:44px;opacity:.45">🏅</div>
      <h2 style="margin:8px 0 6px;color:#374151">${escHtml(t('chTitle'))}</h2>
      <p class="form-hint" style="margin:0;color:#9ca3af">🚫 ${t('chDeptNoRound')}</p>
      ${names.length ? `<p class="form-hint" style="margin:16px 0 8px;color:#6b7280">${t('chDeptNoRoundList')}</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">${list}</div>` : ''}
      <div style="margin-top:18px">
        <button class="btn btn-ghost btn-sm" onclick="navigate('practice')">${escHtml(t('backHome'))}</button>
      </div>
    </div>`
}

function renderChallenge() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  challengeLoad()
  // v107：部门白名单门禁 —— 必须放在最前，先于 quiz/review/result 阶段分支。
  // 入口卡（app.js challengeEntryHtml）已拦一道；这里防「手改 URL / 旧书签 / 部门被管理员改掉」
  // 后仍能继续作答：不适用部门一律直接给出说明页，不渲染任何挑战内容。
  if (typeof chDeptAllowed === 'function' && !chDeptAllowed()) {
    _chGateRendered = { open: chOpenLocked(), exam: chFinalExamLocked(), round: chCurrentRound(), dept: chDeptKey(), shape: 'blocked' }
    el.innerHTML = chDeptBlockedPageHtml()
    return
  }
  // v109：有资格但本部门暂无专属营次 → 说明页（否则会渲染「本部门标题 + 别队营次」的错位内容）
  if (typeof chNoRoundForDept === 'function' && chNoRoundForDept()) {
    _chGateRendered = { open: chOpenLocked(), exam: chFinalExamLocked(), round: chCurrentRound(), dept: chDeptKey(), shape: 'noround' }
    el.innerHTML = chDeptNoRoundPageHtml()
    return
  }
  if (chs && (chs.phase === 'quiz' || chs.phase === 'review' || chs.phase === 'result')) { renderChallengeQuiz(); return }
  // v77：记录本次渲染的门禁态（挑战开关 + 考试开关），拉取后变化则重渲染入口
  // v88：营次切换也会改变门禁与进度 → 一并纳入比较
  // v104：补 shape（本部门营次 id + 有无营次）与 dept —— 营次在页面打开之后才创建时，
  //   open/exam 前后都是同一布尔值，只比它们会漏掉「从无营次变成有营次」这一跃迁。
  _chGateRendered = {
    open: chOpenLocked(), exam: chFinalExamLocked(), round: chCurrentRound(),
    dept: chDeptKey(),
    // v110：shape 追加视角营次集合 —— 大部门视角下主营次可能不变而下属营次增减 → 也要重渲染
    shape: ((chRoundRecForDept() || {}).id || '') + '|' + (chNoRoundForDept() ? '1' : '0') + '|' + chRoundViewKey(),
  }
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
    ${chRoundListHtml()}
    ${chHardRoundHtml()}
    ${chLevelCardHtml()}
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
      ${chBankDiffGap() ? `<div class="feedback" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;margin-bottom:10px">⚠️ ${t('chBankDiffWarn', chBankDiffGap())}</div>` : ''}
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
    // v110：大部门视角无单一主营次 → 取视角营次列表最后一项（最新一期）的排期作代表
    let rec = (typeof chRoundRecForDept === 'function') ? chRoundRecForDept() : null
    if (!rec && typeof chRoundListForView === 'function') {
      const list = chRoundListForView()
      rec = list.length ? list[list.length - 1] : null
    }
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
// ====== v110：视角营次列表卡 → v153 收紧：只显示「单一部门」的历期 ======
// v110 原口径：「饮食部点开来应该能看到所有饮食部下属部门的挑战」（大部门/全库汇总所有下属营次）。
// v153 用户口径推翻总览：「本部门不是应该也只显示自己部门了么」—— 汇总视角下列别队的期反而误导
//   （标题写「本部门」、列的却是标帜/艳中的期）。取数改走 chRoundCardList()：
//   · 分部门视角 → 该分部门的历期；汇总视角（''/大部门/'all'）→ 登录账号自己部门的历期；
//     未设部门 / 不足 2 期 → 整卡不渲染（避免与上方营次标识条重复）。
// 说明：列表内营次仅供查看（当前存档/进度/上报仍按本视角主营次 chCurrentRound()）。
function chRoundListHtml() {
  try {
    const list = chRoundCardList()
    if (list.length < 2) return ''
    const rows = list.map(r => {
      const st = (typeof roundOpenState === 'function') ? roundOpenState(r, Date.now()) : { state: 'closed' }
      const depts = (Array.isArray(r && r.depts) ? r.depts : [])
        .map(d => (typeof deptSlugName === 'function' && deptSlugName(d)) || d)
        .filter(Boolean)
      const tags = depts.length
        ? depts.map(n => `<span style="font-size:11px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:999px;padding:1px 8px">🏷️ ${escHtml(n)}</span>`).join(' ')
        : `<span style="font-size:11px;background:#f3f4f6;color:#4b5563;border:1px solid #e5e7eb;border-radius:999px;padding:1px 8px">${t('chRoundAllDepts')}</span>`
      const stateTag = st.state === 'open'
        ? `<span style="font-size:11px;color:#059669;font-weight:700">● ${t('chRoundOpenTag')}</span>`
        : st.state === 'upcoming'
          ? `<span style="font-size:11px;color:#b45309;font-weight:700">⏳ ${t('chRoundUpcomingTag')}</span>`
          : st.state === 'ended'
            ? `<span style="font-size:11px;color:#6b7280;font-weight:700">🏁 ${t('chEnded')}</span>`
            : `<span style="font-size:11px;color:#9ca3af;font-weight:700">🔒 ${t('chNotOpen')}</span>`
      const s = Number(r.startAt) || 0, e = Number(r.endAt) || 0
      const f = ts => new Date(ts).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      const meta = (s && e) ? t('chRoundWindow', f(s), f(e)) : (s ? t('chRoundStartAt', f(s)) : (e ? t('chRoundEndAt', f(e)) : ''))
      return `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #f3f4f6">
          <span style="font-weight:700;font-size:13px">${escHtml(String(r.name || r.id || ''))}</span>
          ${stateTag}
          ${tags}
          ${meta ? `<span style="font-size:11px;color:#9ca3af">${meta}</span>` : ''}
        </div>`
    }).join('')
    return `
      <div class="card" style="margin-bottom:16px;border:2px solid #bfdbfe">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:4px">
          <h3 style="margin:0">📋 ${t('chRoundListTitle', list.length)}</h3>
        </div>
        <div>${rows}</div>
        <p class="form-hint" style="margin:6px 0 0">${t('chRoundListHint')}</p>
      </div>`
  } catch (e) { return '' }
}

// ====== v111：进阶期提示卡（第二期及以后）======
// 用户口径：「第二期难度比第一期略难 + 每个人要有自己第一期的错题在里面」。
// 学员需要**看见**这件事，否则会以为题目出错了。卡片说明：难度结构变化 + 已纳入的第一期错题数。
//   · 仅进阶期（chIsHardRound）渲染；第一期返回 ''（老学员界面零变化）
//   · 错题数实时从 localStorage 第一期存档统计（与 challengeTestWithWrongQuestions 同源）
//   · 未参加过第一期 / 无错题 → 仍显示「难度提升」说明，但隐藏错题条数
function chHardRoundHtml() {
  try {
    if (typeof chIsHardRound !== 'function' || !chIsHardRound()) return ''
    // 展示营次**名称**（'第二期'）而非 id（'r2'）：学员看得懂的是名称。
    // 优先取本部门当前营次记录的 name，取不到时回落 id，再回落空。
    let cur = ''
    try {
      const rec = (typeof chRoundRecForDept === 'function') ? chRoundRecForDept() : null
      if (rec && (rec.name || rec.id)) cur = String(rec.name || rec.id)
      if (!cur && typeof chRoundListForView === 'function') {
        const list = chRoundListForView()
        if (list.length) {
          const last = list[list.length - 1]
          cur = String((last && (last.name || last.id)) || '')
        }
      }
      if (!cur && typeof chCurrentRound === 'function') cur = String(chCurrentRound())
    } catch (e) { cur = '' }
    const n = (typeof chPrevRoundWrongQuestions === 'function') ? chPrevRoundWrongQuestions().length : 0
    const wrongLine = n > 0
      ? `<div style="font-size:12px;color:#b45309;font-weight:700;margin-top:4px">${t('chRound1WrongTitle', n)}</div>`
      : ''
    return `
      <div class="card" style="margin-bottom:16px;border:2px solid #fcd34d;background:#fffbeb">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <h3 style="margin:0">🔥 ${t('chHardRoundTitle')}</h3>
          ${cur ? `<span style="font-size:11px;background:#fef3c7;color:#b45309;border:1px solid #fde68a;border-radius:999px;padding:1px 8px">${escHtml(cur)}</span>` : ''}
        </div>
        <p class="form-hint" style="margin:6px 0 0">${t('chHardRoundHint')}</p>
        ${wrongLine}
      </div>`
  } catch (e) { return '' }
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
        ${!done && isTest && chIsHardRound() ? `<span style="font-size:12px;color:#b45309;margin-left:8px;font-weight:700">${t('chHardRoundTag', 20)}</span>` : ''}
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
    return vmOptionsHtml(q, ans, submitted ? 'review' : 'live', pickFn, 'renderChallengeQuiz')
  }
  if (qt === 'fill' || qt === 'translate') {
    const val = (ans === undefined || ans === null || ans === -1) ? '' : String(ans)
    return `<input type="text" class="input-answer" placeholder="${t('answerPlaceholder')}" value="${escAttr(val)}"
      oninput="chTextInput(this.value)" ${submitted ? 'disabled' : ''} />`
  }
  // v107：只渲染有效选项（同步删除尾部空槽），判分下标仍用原始 i
  return visibleOptionIndexes(q.options).map(i => {
    const opt = q.options[i]
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
  // v165：把「写入这一刻」的等级快照进 stage 记录 → 供下次差分取上一等级。
  //   ★ 必须在 chLevelApply 之前取（apply 会把 challengeState.lv 改成本次的新等级）。
  //   ★ typeof 守卫：切片沙箱只注入 chRecordStage 时盒外没有 chLevel（v161 同款教训）。
  if (typeof chLevel === 'function') { try { d.stages[chs.si].lv = chLevel() } catch (e) {} }
  challengeSave()
  Store.trackPractice(correct, total)
  // v165：每日练习完成 → 重新评定能力等级（升降级差分落盘，渲染层据 lvChg 播动画）。
  //   刻意放在 chRecordStage 内部、而不是各个调用点：练习/回顾轮/测试/防作弊强制交卷
  //   最终都汇集到这里，一处接线即可全覆盖，避免「某条路径忘了评定」。
  //   口径上「每天练习结束后评估」= 练习阶段每次完成都评一次（同日多阶段取最后一次为准）。
  if (chs.kind === 'practice' && typeof chLevelApply === 'function') {
    try { chLevelApply(chs.day) } catch (e) {}
  }
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
    <div data-sync-badge="1">${typeof syncBadgeHtml === 'function' ? syncBadgeHtml('syncBadgeCh') : ''}</div>
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
