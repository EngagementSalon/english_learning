// ====== CourseStore：线下课 / 班级 / 作业 / 成绩 云端存储 ======
// 独立 textdb 文档（与用户数据同步仓库分开，避免互相挤占 1MB 容量）
// 文档结构：{ v: 1, classes: [ { id, name, note, createdAt, createdBy, members:[username],
//   chInit(是否已做章节开关初始化，v134), chOpen:{ 章节名(空串=未分章): true|false }(v134),
//   assignments: [ { id, type:'homework'|'exam'|'video', title, desc, deadline, duration, passScore,
//     status:'draft'|(缺省=open，draft=草稿未发送，学员不可见), sentAt(发送时间),
//     createdAt, chapter(所属章节名，可空=未分章), questions:[{type,difficulty,question,options,answer,explanation}],
//     results: { username: { at, score, correct, total, usedSec, attempts } } } ] } ] }
// 写入采用「读-改-写 + 写后校验」，被并发覆盖自动重试

const COURSES_URL = 'https://textdb.dev/api/data/eq-quiz-classes-cf2a4fc1f2ab524c'
const COURSES_MAX_BYTES = 950000   // textdb 单文档上限 1MB，超过拒写
const COURSES_TIMEOUT = 8000       // fetch 超时（ms），避免永久挂起

// 带超时的 fetch：超时后 reject，不卡死
function _courseFetch(url, options, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms || COURSES_TIMEOUT)
  return fetch(url, Object.assign({ signal: ctrl.signal }, options))
    .finally(() => clearTimeout(timer))
}

const CourseStore = {
  status: 'offline',   // 'offline' | 'online'
  _cache: null,

  _readCache() {
    try { return JSON.parse(localStorage.getItem('eq_course_cache') || 'null') } catch (e) { return null }
  },
  _saveCache(doc) {
    try { localStorage.setItem('eq_course_cache', JSON.stringify(doc)) } catch (e) { /* ignore */ }
  },

  async _fetchDoc() {
    const r = await _courseFetch(COURSES_URL, { cache: 'no-store' })
    if (!r.ok) throw new Error('courses GET ' + r.status)
    const doc = JSON.parse(await r.text())
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.classes)) throw new Error('bad courses doc')
    // v134：存量班级的章节开关回填（幂等，内存内完成，不做额外网络往返）。
    //   ★ 必须放在这里而不是「某个管理员点开页面时」—— 学员端 getDoc 也走这条路，
    //     若只在管理端回填，学员先打开就会被「无记录 = 关闭」误锁。
    //   ★ 这里只改内存副本，落盘由下一次 mutate 顺手完成（避免读路径产生写放大）。
    this._migrateChOpenDoc(doc)
    return doc
  },
  async _put(body) {
    const r = await _courseFetch(COURSES_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
    if (!r.ok) throw new Error('courses PUT ' + r.status)
  },

  // 读取（云端失败/超时时回退本地缓存，供展示）
  async getDoc() {
    try {
      const doc = await this._fetchDoc()
      this._cache = doc
      this._saveCache(doc)
      this.status = 'online'
      this._clearRetry()
      this._schedulePendingFlush(2000)   // v40：云端恢复可达 → 补传本地暂存的成绩
      return doc
    } catch (e) {
      // 无缓存时返回空文档而非抛错，让 UI 能正常渲染空状态
      this.status = 'offline'
      const c = this._cache || this._readCache()
      if (!c || !Array.isArray(c.classes)) {
        const empty = { v: 1, classes: [] }
        this._cache = empty
      }
      this._scheduleRetry()   // 云端暂不可达 → 后台静默重试，恢复后通知 UI 隐藏警告
      return c || this._cache
    }
  },

  // ---- 后台静默重试 ----
  // getDoc 失败后，30s 后再悄悄拉一次；成功就切回 online + dispatch 事件，UI 自动隐藏警告
  _retryTimer: null,
  _retryDelay: 30000,
  _clearRetry() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
  },
  _scheduleRetry() {
    if (this._retryTimer) return     // 已有定时器在排，不要重复排
    const tryOnce = async () => {
      this._retryTimer = null
      if (this.status === 'online') return
      try {
        const doc = await this._fetchDoc()
        this._cache = doc
        this._saveCache(doc)
        this.status = 'online'
        this._schedulePendingFlush(2000)   // v40：重试成功 → 补传本地暂存的成绩
        // 通知 UI 重新渲染（隐藏缓存警告）
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('course-store-online'))
        }
      } catch (e) {
        // 仍不通：继续等下次（指数退避，封顶 5 分钟）
        this._retryDelay = Math.min(this._retryDelay * 2, 300000)
        this._retryTimer = setTimeout(tryOnce, this._retryDelay)
      }
    }
    this._retryTimer = setTimeout(tryOnce, this._retryDelay)
  },

  // 读-改-写：fn(doc) 就地修改并返回 false 表示放弃；成功返回 true，离线抛错
  async mutate(fn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await this._fetchDoc()
      const ret = fn(doc)
      if (ret === false) return null
      const body = JSON.stringify(doc)
      if (body.length > COURSES_MAX_BYTES) throw new Error('over-limit')
      await this._put(body)
      // 写后校验：内容不一致说明被并发覆盖，取最新文档重试
      const verify = await this._fetchDoc()
      if (JSON.stringify(verify) === body) {
        this._cache = doc
        this._saveCache(doc)
        this.status = 'online'
        return true
      }
    }
    return false   // 重试用尽（持续被覆盖）
  },

  // ================================================================
  // v40 本地待补传队列：学员端成绩/观看记录云端写入失败时，先落本机
  // （localStorage eq_course_pending），网络恢复后自动重放合并上传。
  // op 格式：{ id, ts, atype:'homework'|'exam'|'video'|'videoquiz'|'review', cid, aid, u, entry }
  // 重放合并规则（幂等，可安全重复执行）：
  //   - 班级/任务已被删除 → 丢弃
  //   - 云端已有更新记录（prev.at >= entry.at）→ 丢弃
  //   - video：已有 ≥ 本次完成度 → 丢弃（自愈升级语义：只接受更高值）
  //   - homework：云端已有更高分 → 合并保留高分（与在线提交同规则）
  //   - review：v53 错题回顾轮次状态，只更新条目里的 review 字段（不动成绩）
  // ================================================================
  _pendingQueue() {
    try {
      const q = JSON.parse(localStorage.getItem('eq_course_pending') || '[]')
      return Array.isArray(q) ? q : []
    } catch (e) { return [] }
  },
  _savePending(q) {
    try { localStorage.setItem('eq_course_pending', JSON.stringify(q)) } catch (e) { /* ignore */ }
  },
  pendingCount() { return this._pendingQueue().length },

  enqueuePending(op) {
    if (!op || !op.cid || !op.aid || !op.u || !op.entry) return false
    if (!op.id) op.id = 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    if (!op.ts) op.ts = Date.now()
    const q = this._pendingQueue()
    q.push(op)
    if (q.length > 100) q.splice(0, q.length - 100)
    this._savePending(q)
    this._schedulePendingFlush(3000)
    return true
  },

  _flushTimer: null,
  _schedulePendingFlush(delay) {
    if (this._flushTimer) clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this.flushPending() }, delay || 3000)
  },

  // 把一条待补传 op 应用到文档（就地修改）；返回 'applied' | 'drop'
  _applyResultOp(doc, op) {
    const c = this.findClass(doc, op.cid)
    const a = this.findAssign(c, op.aid)
    if (!a) return 'drop'                       // 班级/任务已被管理员删除
    a.results = a.results || {}
    const prev = a.results[op.u]
    const entry = op.entry || {}
    if (prev && Number(prev.at) >= Number(entry.at)) return 'drop'   // 云端已有更新记录
    // v56 历次成绩合并（作业/测评补传重放）—— 必须先于下方 homework 高分合并执行：
    // 高分合并会把 entry.score 回写为云端最高分，history 必须记录本轮原始成绩（含低分轮）。
    // 老记录（无 history）自动补为首条。video/videoquiz/review 不适用（a.type 已排除）。
    if ((op.atype === 'homework' || op.atype === 'exam') && (a.type === 'homework' || a.type === 'exam')) {
      const recScore = Number(entry.score) || 0
      let h = []
      if (prev) {
        if (Array.isArray(prev.history)) h = prev.history.slice()
        else if (prev.score != null || prev.at) h = [{ at: Number(prev.at) || 0, score: Number(prev.score) || 0,
          correct: Number(prev.correct) || 0, total: Number(prev.total) || 0, usedSec: Number(prev.usedSec) || 0 }]
      }
      h.push({ at: Number(entry.at) || Date.now(), score: recScore, correct: Number(entry.correct) || 0,
        total: Number(entry.total) || 0, usedSec: Number(entry.usedSec) || 0 })
      if (h.length > 20) h = h.slice(h.length - 20)   // 防 1MB 容量膨胀，只留最近 20 次
      entry.history = h
    }
    if (op.atype === 'video') {
      const prevPct = prev && prev.watchedPct != null ? Number(prev.watchedPct) : 100
      if (Number(entry.watchedPct) <= prevPct) return 'drop'         // 只接受更高完成度
    } else if (op.atype === 'videoquiz') {
      // v44 视频课后小测：合并观看记录 + 测验成绩；云端已答过同一时间或更新的测验 → 丢弃
      if (prev && prev.quizTotal != null && Number(prev.quizAt || prev.at) >= Number(entry.quizAt || entry.at)) return 'drop'
      if (prev) {
        entry.watchedPct = prev.watchedPct != null ? Number(prev.watchedPct) : (entry.watchedPct != null ? entry.watchedPct : 100)
        entry.watchedSec = Math.max(Number(prev.watchedSec) || 0, Number(entry.watchedSec) || 0)
        entry.duration = Number(prev.duration) || Number(entry.duration) || 0
        entry.difficulty = prev.difficulty || entry.difficulty || 0
        entry.attempts = Math.max(Number(prev.attempts) || 1, Number(entry.attempts) || 1)
      }
    } else if (op.atype === 'review') {
      // v53 错题回顾轮次：只更新 review 状态（错题集/轮次），成绩字段不动。
      // 无基础成绩记录 / 云端有更新的作答或更新一轮回顾 → 丢弃
      const rv = (entry && entry.review) || {}
      if (!prev) return 'drop'
      if (Number(prev.at) >= Number(entry.at)) return 'drop'
      if (prev.review && Number(prev.review.at) >= Number(rv.at)) return 'drop'
      prev.review = rv
      return 'applied'          // prev 已在 doc 内，就地改完即返回，避免下方整体覆盖丢成绩
    } else if (op.atype === 'homework' && prev && (Number(prev.score) || 0) > (Number(entry.score) || 0)) {
      entry.score = prev.score; entry.correct = prev.correct; entry.total = prev.total
      // v51：逐题明细跟随保留的那次作答（prev 无明细 → 本次低分明细一并丢弃）
      if (Array.isArray(prev.wq) && prev.qn) { entry.wq = prev.wq; entry.qn = prev.qn } else { delete entry.wq; delete entry.qn }
      if (!prev.overdue) delete entry.overdue                        // 作业保留历史最高分
    }
    a.results[op.u] = entry
    return 'applied'
  },

  // 网络恢复后重放待补传队列：读-合并-写-校验，成功清空、失败保留下次再试
  _flushing: false,
  async flushPending() {
    if (this._flushing || this.status !== 'online') return
    const q0 = this._pendingQueue()
    if (!q0.length) return
    this._flushing = true
    try {
      let remaining = q0.slice()
      for (let attempt = 0; attempt < 3 && remaining.length; attempt++) {
        const doc = await this._fetchDoc()
        const dropped = new Set()
        remaining.forEach(op => { if (this._applyResultOp(doc, op) === 'drop') dropped.add(op.id) })
        const kept = remaining.filter(op => !dropped.has(op.id))
        if (kept.length) {
          const body = JSON.stringify(doc)
          if (body.length > COURSES_MAX_BYTES) throw new Error('over-limit')
          await this._put(body)
          // 写后校验：被并发覆盖则重试（重放幂等，可安全再来）
          const verify = await this._fetchDoc()
          if (JSON.stringify(verify) !== body) continue
        }
        remaining = []   // 本轮全部完成：drop 的已丢弃，kept 的已成功写入云端
        break
      }
      this._savePending(remaining)
    } catch (e) { /* 网络仍不可用：保留队列，等待下次触发 */ }
    finally { this._flushing = false }
  },

  // ---- 查找辅助 ----
  findClass(doc, cid) { return (doc.classes || []).find(c => c.id === cid) },
  findAssign(cls, aid) { return cls && (cls.assignments || []).find(a => a.id === aid) },
  newId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7) },

  // ================================================================
  // v134 章节开放开关（按「班级 + 章节」）—— 学员必须等管理员逐章开放才能做题
  //
  // ★★★ 语义口径（本功能最容易错的地方，改前先读完）：
  //   用户的原始需求是「默认所有内容都是关闭状态」，但线上已有一批学员正在用的班级。
  //   若把「无记录」直接当成「关闭」，上线瞬间所有存量班级会被全部锁死 —— 这是事故，不是需求。
  //   因此把「默认关闭」实现为**迁移事实**而不是**运行时判据**：
  //     · 新建建时由 courseCreateClass 写入 chInit:true，并把当时已有的章节
  //       （含未分章保留键）**逐章显式记录为已开放** → 以后新增的章节不在记录里 → 关闭；
  //     · 存量班级（无 chInit）在首次被读取/操作时由 _migrateChOpen 就地补齐并打 chInit，
  //       此刻存在的章节同样被显式记为已开放 → 老学员体验零变化；
  //     · 运行时判据恒为「chOpen[键] === true 才算开放」，双空/缺字段一律视为关闭。
  //   ★ 切换语义：管理员在管理端关闭某章 → 写 false（而不是删键）—— 删键会让该章在
  //    下次 _migrateChOpen 回填时被当作「存量章节」重新开放（关了又自己开）。
  //   ★ 新加章节（写作业时首次出现）不在 map 里 → 判据 false → 默认关闭，符合需求。
  //
  // 保留键：'' （空串）= 「未分章」组，同样受控、同样可开关。
  //   ★ 用空串而不是 '__none__' 这类哨兵值，是为了让键与章节名同源 ——
  //     章节名允许任意用户输入，哨兵值一旦撞名就会串味。
  // ================================================================
  chKey(chName) { return String(chName == null ? '' : chName).trim() },

  // 该章是否已开放（口径唯一收口；缺 map / 缺键 / 值非 true 一律 false）
  chOpen(cls, chName) {
    if (!cls || !cls.chOpen || typeof cls.chOpen !== 'object') return false
    return cls.chOpen[this.chKey(chName)] === true
  },

  // 该班级出现过的全部章节键（按 assignments 顺序去重，含 '' 未分章组）
  chNames(cls) {
    const seen = Object.create(null), out = []
    ;((cls && cls.assignments) || []).forEach(a => {
      const k = this.chKey(a.chapter)
      if (seen[k]) return
      seen[k] = 1
      out.push(k)
    })
    return out
  },

  // 存量迁移：把「此刻已存在的章节」显式记为已开放，并打 chInit 一次性标记。
  // 返回 true = 本次真的写入过 map（需要调用方落盘）。幂等：已迁移的班级直接返回 false。
  // ★ 刻意不改动已经是 false 的键 —— 管理员关过的章不能被迁移重新打开。
  _migrateChOpen(cls) {
    if (!cls || cls.chInit) return false
    cls.chInit = true
    cls.chOpen = cls.chOpen || {}
    let touched = false
    this.chNames(cls).forEach(k => {
      if (cls.chOpen[k] === undefined) { cls.chOpen[k] = true; touched = true }
    })
    return touched
  },

  // 文档级迁移：对每个班级做一次存量回填，返回是否有班级被改动过
  _migrateChOpenDoc(doc) {
    let touched = false
    ;((doc && doc.classes) || []).forEach(c => { if (this._migrateChOpen(c)) touched = true })
    return touched
  },

  // 建班时初始化：先打 chInit（阻断迁移路径），再把现有章节全开放
  initChOpenForNewClass(cls) {
    if (!cls) return
    cls.chInit = true
    cls.chOpen = cls.chOpen || {}
    this.chNames(cls).forEach(k => { cls.chOpen[k] = true })
  },

  // ---- 用户改名：迁移班级成员 / 创建者 / 成绩记录键 ----
  // 返回 true=已写入；null=云端没有该用户名的任何痕迹（无需写）；false=重试用尽
  async renameUser(oldU, newU) {
    return this.mutate(doc => {
      let touched = false
      ;(doc.classes || []).forEach(c => {
        if (Array.isArray(c.members) && c.members.includes(oldU)) {
          c.members = c.members.map(m => m === oldU ? newU : m)
          touched = true
        }
        if (c.createdBy === oldU) { c.createdBy = newU; touched = true }
        ;(c.assignments || []).forEach(a => {
          if (a.createdBy === oldU) { a.createdBy = newU; touched = true }
          if (a.results && a.results[oldU]) {
            if (a.results[newU]) {
              // 新旧用户名都有成绩：保留较新的一次，尝试次数累加
              const nr = a.results[newU], or = a.results[oldU]
              const merged = nr.at >= or.at ? nr : or
              merged.attempts = (nr.attempts || 1) + (or.attempts || 1)
              // v56：历次成绩合并（两账号 history 按时间升序合并，最多保留最近 20 条）
              const hl = []
              ;[or, nr].forEach(src => {
                if (Array.isArray(src.history)) hl.push(...src.history)
                else if (src.score != null || src.at) hl.push({ at: Number(src.at) || 0, score: Number(src.score) || 0,
                  correct: Number(src.correct) || 0, total: Number(src.total) || 0, usedSec: Number(src.usedSec) || 0 })
              })
              hl.sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0))
              if (hl.length) merged.history = hl.length > 20 ? hl.slice(hl.length - 20) : hl
              a.results[newU] = merged
            } else {
              a.results[newU] = a.results[oldU]
            }
            delete a.results[oldU]
            touched = true
          }
        })
      })
      if (!touched) return false   // 云端无该用户的班级数据，无需写入
    })
  }
}

// Node 测试环境导出（浏览器中忽略）
if (typeof module !== 'undefined' && module.exports) module.exports = CourseStore

// 浏览器：系统网络恢复事件 → 尽快补传本地暂存的成绩（Node 测试环境跳过）
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('online', () => CourseStore._schedulePendingFlush(2000))
}
