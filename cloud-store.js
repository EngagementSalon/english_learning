// ====== Cloud Sync（跨终端数据收集）======
// 使用 textdb.dev 免费云存储：所有终端共享同一份数据文档
// 文档结构：{ v: 1, base: { <username>: 聚合统计 }, events: [最近事件] }
// 事件格式（紧凑键名）：{ id, u:用户名, n:姓名, ty:类型, ts:时间戳, d:数据 }
// 事件类型：register / login / duration / practice / exam / placement / delete / rename / role / dept
// 平台级配置（如品牌 Logo）存于文档顶层字段 logo / logoAt，不随事件折叠
// 说明：密码不进入云端，仍保存在各终端本地（账号只能在注册它的设备上登录）

const CLOUD_SYNC_URL = 'https://textdb.dev/api/data/eq-quiz-sync-8bbbde30cfb569c6'
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
        // 单题答题对错上报：普通作答聚合到 r.perQ[qid]；七天挑战错答（d.ch）聚合到 r.chQ[qid]（total=错次）
        if (d.qid != null) {
          const tgt = d.ch ? (r.chQ = r.chQ || {}) : (r.perQ = r.perQ || {})
          const qid = String(d.qid)
          const rec = tgt[qid] || (tgt[qid] = { correct: 0, total: 0 })
          rec.total += 1
          if (d.correct) rec.correct += 1
        }
        break
      case 'chy':
        // v71 七天挑战阶段完成上报：保留每次完成记录（练习重练多条；水平测试仅一条）
        r.chy = r.chy || []
        r.chy.push({
          day: Number(d.day) || 0, si: Number(d.si) || 0, kind: String(d.kind || 'practice'),
          correct: Number(d.correct) || 0, total: Number(d.total) || 0, at: ev.ts,
        })
        break
      case 'perqfix':
        // v38 看字选音发音修复：无效错答从每题统计的分母中剔除（correct 不变——错答本就未计入）
        if (d.qid != null) {
          r.perQ = r.perQ || {}
          const qidF = String(d.qid)
          const recF = r.perQ[qidF]
          if (recF) recF.total = Math.max(recF.correct || 0, recF.total - (d.wrongFix || 1))
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
    Object.keys(doc.base || {}).forEach(u => { map[u] = Object.assign({}, doc.base[u], { username: u }) })
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
    Object.keys(doc.base || {}).forEach(u => { map[u] = Object.assign({}, doc.base[u], { username: u }) })
    const events = (doc.events || []).concat(this._queue())
    events.forEach(ev => this._apply(map, ev))
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
