// ====== Local Storage Store ======
const STORAGE_KEYS = {
  QUESTIONS: 'eq_questions',
  UPLOADED: 'eq_uploaded',     // v52：管理员批量上传/手工新增的题目（独立存储，线下课题库重建不清除）
  CATEGORIES: 'eq_categories',
  PROGRESS: 'eq_progress',
  EXAMS: 'eq_exams',
  USER: 'eq_user',
  COUNTER: 'eq_counter',
  USERS: 'eq_users',
  SESSION: 'eq_session',
  TRAINING: 'eq_training_questions',
  BANK_VERSION: 'eq_bank_version',
  PLACEMENT: 'eq_placement_history',
  ACTIVITY: 'eq_activity',       // 每用户活动日志（登录时长/练习/考试/测评）
  ACTIVE_SESSION: 'eq_active_session', // 当前活跃会话（用于心跳累计时长）
  LOGO: 'eq_logo'                // 平台品牌 Logo（云端同步后的本地缓存 dataURL）
}

// 题库数据来自 bank-data.js（v4：500 题全部来自培训文档，11 分类）
const BANK_VERSION = (typeof BANK !== 'undefined' && BANK.version) ? BANK.version : 1

// ====== 等级体系（L1-L4）======
// 语法/商务/阅读类题目偏难（difficulty+1），词汇/口语/餐饮按 difficulty 原值
// difficulty 1-3 → level 1-4，管理员修改题目后等级自动重算
function levelOf(q) {
  const hardCat = [2, 3, 4].includes(Number(q.category_id))
  const d = Number(q.difficulty) || 1
  return Math.max(1, Math.min(4, hardCat ? d + 1 : d))
}

// v43：线下课题库 = 线下课班级已激活作业中的题目，由 rebuildBankFromCourse 动态派生到本地题库，
// 统一归入此单一分类；原 bank-data.js 的 11 大主题种子题库仅作为首次初始化占位，随后即被替换
const COURSE_BANK_CATEGORY = { id: 1, name: '线下课题库', description: '线下课班级已激活作业中的题目' }

// Initial data
const INITIAL_CATEGORIES = (typeof BANK !== 'undefined' && BANK.categories) ? BANK.categories : [
  { id: 1, name: '基础词汇', description: '日常英语基础词汇' },
  { id: 2, name: '语法结构', description: '英语语法与句型结构' },
  { id: 3, name: '商务英语', description: '职场与商务场景用语' },
  { id: 4, name: '阅读理解', description: '阅读理解与推理' },
  { id: 5, name: '听力口语', description: '听力与口语表达' }
]

const INITIAL_QUESTIONS = (typeof BANK !== 'undefined' && BANK.questions) ? BANK.questions : []


// ====== 密码哈希（SHA-256 + 随机盐）======
// 设计目标：云端/本地都不存明文密码，只存不可逆哈希，防止数据泄露后被撞库
// 旧账号（只有明文 password，无 ph/salt）仍兼容登录，并在登录/迁移时自动升级为哈希
// 安全提示：SHA-256 为通用哈希，非加盐慢哈希（如 bcrypt）；对刷题平台已足够，且无需额外依赖
const PW_MIGRATED_FLAG = 'eq_pw_migrated_v1'   // 明文→哈希 一次性迁移标记

// ====== 平台品牌 Logo（本地缓存）======
// 真实来源：云端文档顶层 logo 字段（管理员上传 → 全平台各终端 pull 时缓存到本地并渲染）
// getLocalLogo() 返回 dataURL 字符串；无 Logo 时返回 ''
function getLocalLogo() {
  try { return localStorage.getItem(STORAGE_KEYS.LOGO) || '' } catch (e) { return '' }
}
// 保存/清除本地 Logo 缓存；返回是否发生了变化（变化时调用方应触发界面重绘）
function setLocalLogo(url) {
  const next = String(url || '')
  const cur = getLocalLogo()
  if (next === cur) return false
  try {
    if (next) localStorage.setItem(STORAGE_KEYS.LOGO, next)
    else localStorage.removeItem(STORAGE_KEYS.LOGO)
  } catch (e) { /* 存储满等异常：忽略 */ }
  return true
}

// 生成随机盐（字符安全，不含 ':'，避免与分隔符冲突）
function genSalt() {
  const rnd = (typeof crypto !== 'undefined' && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(36).slice(2)
  return rnd + Date.now().toString(36)
}

// 计算密码哈希：sha256( salt + ':' + password )，输出 hex 小写
async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ':' + String(password || ''))
  if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
    const buf = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // 极老环境无 crypto.subtle 时退回同步简单散列（仅兜底，不用于正式部署）
  let h1 = 0x811c9dc5
  const bytes = new TextEncoder().encode(salt + ':' + String(password || ''))
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i]
    h1 = Math.imul(h1, 0x01000193) >>> 0
  }
  return 'fb_' + h1.toString(16)
}

// 校验密码：兼容「哈希」与「旧明文」两种存储格式
async function verifyPassword(u, password) {
  if (!u) return false
  const pw = String(password || '')
  if (u.ph && u.salt) return (await hashPassword(pw, u.salt)) === u.ph
  // 种子管理员在哈希异步补齐前：用默认密码兜底比对
  if (u.username === 'admin' && u.ph === '' && u.salt === '' && pw === 'admin123') return true
  // 旧账号：明文比对（大小写敏感，保持历史行为）
  return u.password === pw
}

// 判断账号是否已升级为哈希存储
function isHashed(u) {
  return !!(u && u.ph && u.salt)
}


const Store = {
  // Initialize
  init() {
    // v33：清理本地题库（localStorage.QUESTIONS）中的劣质翻译多选题，一次性执行
    // 劣质形状：题干 = 「X」对应的英文/中文/最佳中文翻译（X 为单词或短语，正确项=词义或整句原文句首，
    //   干扰项来自章节标题/无关短句，一眼蒙对）＋ 连线题/词库连线类。
    // v32 仅清理了 bank-data.js 种子文件；管理员之前通过 AI 出题保存进本地的同类题仍存在，需按文本模式过滤。
    // 注意「中文意思是」必须限定「」内为短词（旧 QGen en2zh 模板形状），
    //   避免误删合法句译题（如 "May I know…" 的中文意思是？选项为真实译文，id 17/176）。
    // 用一次性 flag 避免重复执行；题目增删不入云队列，故无需广播到云端
    if (!localStorage.getItem('eq_silly_cleaned_v33')) {
      const isSilly = q =>
        (q.type === 'single' || q.type === 'multiple') &&
        Array.isArray(q.options) && q.options.length >= 2 &&
        /对应的英文|对应的中文|最佳中文翻译|「[^」]{1,30}」的中文意思是|连线题中|词库连线|连线：|连线:/.test(q.question || '')
      try {
        const qs = JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTIONS) || '[]')
        const kept = qs.filter(q => !isSilly(q))
        if (kept.length !== qs.length) {
          localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify(kept))
          console.log('[v33] 已清理本地题库中的劣质翻译多选题:', qs.length - kept.length, '条')
        }
      } catch (e) { /* ignore */ }
      localStorage.setItem('eq_silly_cleaned_v33', '1')
    }

    // v38：看字选音发音修复后的分数修正，一次性执行
    // 背景：v36 上线（2026-09-03 15:00 GMT+8 前）至 v38 修复期间，安卓设备本地 TTS 静音导致
    // 看字选音题无法发音、学员只能盲猜，此期间的错答视为无效题（不计分）：
    //   1) eq_progress 剔除该期间的 voicematch 错答记录（个人正确率统计不再计入）
    //   2) 云端 perqfix 事件：每题正确率统计的分母同步剔除（全设备生效）
    //   3) eq_exams 考试卷按 ±10s 时间窗匹配错答重算 score/correct/passed，并上 examfix 事件修正看板聚合
    //   4) eq_activity 的 exam 活动记录同步重算（本设备统计一致）
    // 注：线下课测评成绩（云端 results）无逐题明细无法自动重算；作业可重做保最高分，重做即恢复。
    if (!localStorage.getItem('eq_vmfix_v38')) {
      localStorage.setItem('eq_vmfix_v38', '1')
      try { this._fixVoicematchScores(Date.parse('2026-09-03T15:00:00+08:00')) } catch (e) { /* ignore */ }
    }

    // v42：水平测试改从线下课题库（11 大主题分类）出题；一次性清理非课库题目
    // 背景：管理员此前通过 AI 出题/导入产生的「其他题库」题目（自建分类或未分类）不再使用，
    //   全部删除；线下课题库 = bank-data.js 的 11 个分类（id 1-11），落在这些分类下的题目保留。
    // 题目增删不入云队列，各设备升级后各自执行一次本地清理（与 v33 同机制）。
    if (!localStorage.getItem('eq_course_only_v42')) {
      const bankCats = (typeof BANK !== 'undefined' && BANK.categories) ? BANK.categories : null
      // 防御：BANK 未加载（异常环境）时分类集为空 → 跳过清理且不置 flag，避免误删整个题库
      if (bankCats && bankCats.length) {
        localStorage.setItem('eq_course_only_v42', '1')
        try {
          const catIds = new Set(bankCats.map(c => Number(c.id)))
          const qs = JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTIONS) || '[]')
          const kept = qs.filter(q => q.category_id != null && catIds.has(Number(q.category_id)))
          if (kept.length !== qs.length) {
            localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify(kept))
            console.log('[v42] 已清理非线下课题库题目:', qs.length - kept.length, '条，保留', kept.length, '条')
          }
          // 还原分类表为 11 大主题（移除管理员自建的其他题库分类）
          localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(INITIAL_CATEGORIES))
        } catch (e) { /* ignore */ }
      }
    }

    // 活动日志初始化
    if (!localStorage.getItem(STORAGE_KEYS.ACTIVITY)) {
      localStorage.setItem(STORAGE_KEYS.ACTIVITY, JSON.stringify([]))
    }
    // 题库版本升级：老浏览器自动更新到最新内置题库
    // 注意：v6 之前会重建题库（覆盖本地未同步的题目改动）；v6 及之后保留本地题库，仅做增量迁移
    const storedVer = JSON.parse(localStorage.getItem(STORAGE_KEYS.BANK_VERSION) || '0')
    if (storedVer < BANK_VERSION) {
      let mergedQuestions
      if (storedVer < 6) {
        // v6：合并培训题库到统一题库 + 题目加 dept 字段
        mergedQuestions = [...INITIAL_QUESTIONS]
        if (typeof QUESTIONS !== 'undefined' && QUESTIONS) {
          // 将培训题库的理解题和发音题转换为统一格式并合并（v7 起培训题并入饮食部）
          const TRAINING_DEPT = 'dining'  // 培训题并入饮食部题库
          let nextTrId = 9001
          ;(QUESTIONS.comprehension || []).forEach(q => {
            mergedQuestions.push({
              id: nextTrId++, dept: TRAINING_DEPT, category_id: 11,
              type: q.type === 'single' ? 'single' : 'judge',
              difficulty: 1, question: q.question, options: q.options,
              answer: Array.isArray(q.answer) ? q.answer : [q.answer],
              explanation: q.explanation || '', scene: q.scene || ''
            })
          })
          ;(QUESTIONS.pronunciation || []).forEach(q => {
            mergedQuestions.push({
              id: nextTrId++, dept: TRAINING_DEPT, category_id: 11,
              type: 'pronounce', difficulty: 1,
              question: q.question || q.word || '',
              options: q.options || [], answer: Array.isArray(q.answer) ? q.answer : [q.answer],
              explanation: q.explanation || ''
            })
          })
        }
      } else {
        // v6 及之后：保留本地题库（含管理员新增/修改的题目），仅做增量迁移
        mergedQuestions = JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTIONS) || '[]')
      }
      if (storedVer < 7) {
        // v7：培训合并题（id 9001+）并入饮食部题库
        mergedQuestions = mergedQuestions.map(q => (q.id >= 9001 && q.dept === 'all') ? Object.assign({}, q, { dept: 'dining' }) : q)
      }
      if (storedVer < 8) {
        // v8：追加内置题库新增种子题（voicematch 看字选音，id 525+）——只补缺失 id，
        // 不覆盖本地已存在（含管理员改过）的同 id 题；题目增删不入云队列，各设备升级版本后自行补齐
        const haveIds = new Set(mergedQuestions.map(q => q.id))
        const bankQs = (typeof BANK !== 'undefined' && BANK.questions) ? BANK.questions : []
        const missing = bankQs.filter(bq => !haveIds.has(bq.id))
        if (missing.length) mergedQuestions = mergedQuestions.concat(missing)
      }
      localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify(mergedQuestions))
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(INITIAL_CATEGORIES))
      localStorage.setItem(STORAGE_KEYS.BANK_VERSION, JSON.stringify(BANK_VERSION))
    }
    if (!localStorage.getItem(STORAGE_KEYS.QUESTIONS)) {
      localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify(INITIAL_QUESTIONS))
    }
    if (!localStorage.getItem(STORAGE_KEYS.CATEGORIES)) {
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(INITIAL_CATEGORIES))
    }
    // v43：题库改为「线下课班级已激活作业」动态派生（rebuildBankFromCourse）——
    // 一次性清空旧内置题库（11 大主题种子题），待线下课云端文档加载后重建派生题库
    // （app.js ensureCourseBankSynced 在应用初始化/水平测试/进入线下课页时触发）
    if (!localStorage.getItem('eq_course_only_v43')) {
      localStorage.setItem('eq_course_only_v43', '1')
      localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify([]))
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify([]))
      console.log('[v43] 已清空旧题库，等待线下课题库派生重建')
    }
    if (!localStorage.getItem(STORAGE_KEYS.PROGRESS)) {
      localStorage.setItem(STORAGE_KEYS.PROGRESS, JSON.stringify([]))
    }
    if (!localStorage.getItem(STORAGE_KEYS.EXAMS)) {
      localStorage.setItem(STORAGE_KEYS.EXAMS, JSON.stringify([]))
    }
    if (!localStorage.getItem(STORAGE_KEYS.COUNTER)) {
      localStorage.setItem(STORAGE_KEYS.COUNTER, JSON.stringify(100))
    }
    // 用户表：首次使用种子一个默认管理员
    if (!localStorage.getItem(STORAGE_KEYS.USERS)) {
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify([
        { id: 1, username: 'admin', ph: '', salt: '', name: '管理员', dept: '', role: 'admin', createdAt: Date.now() }
      ]))
      // 种子管理员密码哈希（admin123）异步补齐；在此之前用旧明文兜底登录
      this._seedAdminAsync()
    }
    // 培训题库：首次使用从 training-questions.js 的种子数据导入
    if (!localStorage.getItem(STORAGE_KEYS.TRAINING)) {
      const seed = (typeof QUESTIONS !== 'undefined' && QUESTIONS)
        ? { comprehension: QUESTIONS.comprehension || [], pronunciation: QUESTIONS.pronunciation || [] }
        : { comprehension: [], pronunciation: [] }
      localStorage.setItem(STORAGE_KEYS.TRAINING, JSON.stringify(seed))
    }
    // 启动云端用户资料/权限同步：拉一次 + 后续定时拉（保证多设备近实时一致）
    if (typeof setTimeout === 'function') {
      this._schedulePullCloud(500)             // 启动后立即拉一次
      this._pullCloudTimer = setInterval(() => { this.pullCloudChanges().catch(() => null) }, 30000) // 每 30 秒
    }
    // 明文密码 → 哈希 一次性迁移（启动兜底；登录时也会各自升级）
    this.migratePlainPasswords().catch(() => null)
  },

  // 跨设备用户/权限云同步：拉云端 events 应用到本地 users 表
  // 处理：register / role / rename / delete / dept + 平台 Logo
  // 返回 { ok, applied: { roleChanged, renamed, deleted, added, deptChanged, sessionRoleSync, sessionDeptSync, logoUpdated }, ts }
  async pullCloudChanges() {
    if (typeof CloudSync === 'undefined' || !CloudSync.fetchSyncSummary) return { ok: false, reason: 'no-cloudsync' }
    let summary
    try { summary = await CloudSync.fetchSyncSummary() }
    catch (e) { return { ok: false, reason: 'fetch-error' } }
    if (!summary || !summary.ok) return { ok: false, reason: (summary && summary.reason) || 'unreachable' }

    // —— 平台品牌 Logo：云端有变化则更新本地缓存并通知界面重绘（上传后所有终端自动显示）——
    if (summary.doc && typeof summary.doc.logo === 'string' && setLocalLogo(summary.doc.logo)) {
      try {
        if (typeof window !== 'undefined' && window.dispatchEvent && typeof Event === 'function') {
          window.dispatchEvent(new Event('eq-logo-updated'))
        }
      } catch (e) { /* ignore */ }
    }

    const events = ((summary.doc && summary.doc.events) || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const lastTsKey = 'eq_cloud_pull_ts'
    const lastTs = JSON.parse(localStorage.getItem(lastTsKey) || '0')
    const applied = { roleChanged: [], renamed: [], deleted: [], added: [], deptChanged: [], sessionRoleSync: false, sessionDeptSync: false }
    let users = this.getUsers()
    let dirty = false
    let maxTs = lastTs
    const cloudMap = summary.map || {}

    // 1) 按时间顺序处理事件
    events.forEach(ev => {
      if (!ev || !ev.u || !ev.ty) return
      if ((ev.ts || 0) <= lastTs) return
      if (ev.ty === 'delete') {
        const before = users.length
        users = users.filter(u => u.username !== ev.u)
        if (users.length !== before) { applied.deleted.push(ev.u); dirty = true }
      } else if (ev.ty === 'rename') {
        const nu = ev.d && ev.d.nu
        if (!nu || nu === ev.u) { if (ev.ts > maxTs) maxTs = ev.ts; return }
        const idx = users.findIndex(u => u.username === ev.u)
        if (idx >= 0 && !users.some(u => u.username === nu)) {
          users[idx] = Object.assign({}, users[idx], { username: nu })
          applied.renamed.push({ from: ev.u, to: nu }); dirty = true
        }
      } else if (ev.ty === 'role') {
        const newRole = ev.d && ev.d.role
        if (!newRole) { if (ev.ts > maxTs) maxTs = ev.ts; return }
        const idx = users.findIndex(u => u.username === ev.u)
        if (idx >= 0 && users[idx].role !== newRole) {
          users[idx] = Object.assign({}, users[idx], { role: newRole })
          applied.roleChanged.push({ username: ev.u, role: newRole }); dirty = true
        }
      } else if (ev.ty === 'dept') {
        // 管理员调整学员部门：同步到本地账号表（空串 = 清除部门）
        const nd = (ev.d && ev.d.dept !== undefined) ? String(ev.d.dept || '') : null
        if (nd === null) { if (ev.ts > maxTs) maxTs = ev.ts; return }
        const idx = users.findIndex(u => u.username === ev.u)
        if (idx >= 0 && (users[idx].dept || '') !== nd) {
          users[idx] = Object.assign({}, users[idx], { dept: nd })
          applied.deptChanged.push(ev.u); dirty = true
        }
      }
      if (ev.ts > maxTs) maxTs = ev.ts
    })

    // 2) 云端有但本地没有 → 建"影子账户"（密码空，不能跨设备登录，但能同步权限）
    users = users.filter(u => u && u.username)
    Object.keys(cloudMap).forEach(username => {
      if (!cloudMap[username]) return
      if (users.some(u => u.username === username)) return
      const cu = cloudMap[username]
      const cntr = parseInt(localStorage.getItem(STORAGE_KEYS.COUNTER) || '100', 10)
      const newId = cntr + 1
      users.push({
        id: newId, username, password: '',
        name: cu.name || username, dept: cu.dept || '',
        role: cu.role || 'student',
        ph: cu.ph || '', salt: cu.salt || '',
        createdAt: cu.createdAt || Date.now(),
        cloudOnly: true
      })
      localStorage.setItem(STORAGE_KEYS.COUNTER, JSON.stringify(newId))
      applied.added.push(username); dirty = true
    })

    // 3) 当前 session：以云端 map 的最终态为准（角色 + 部门）
    const s = this.getSession()
    if (s && s.username) {
      const sessionUser = users.find(u => u.username === s.username)
      if (!sessionUser && cloudMap[s.username]) {
        // session 用户没了（被删除），强制登出
        this.logout()
      } else if (sessionUser) {
        // 角色/部门被其他设备（管理员）修改 → 同步会话，使本机立即生效
        const patch = {}
        if (sessionUser.role !== s.role) {
          patch.role = sessionUser.role
          applied.sessionRoleSync = true
        }
        if ((sessionUser.dept || '') !== (s.dept || '')) {
          patch.dept = sessionUser.dept || ''
          applied.sessionDeptSync = true
        }
        if (Object.keys(patch).length) {
          localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ ...s, ...patch }))
          // eq_user（个人资料缓存）同步部门，保证资料弹窗/显示一致
          if (patch.dept !== undefined) this.setUser({ name: sessionUser.name, dept: sessionUser.dept || '' })
        }
      }
    }

    if (dirty) this.saveUsers(users)
    if (maxTs > lastTs) localStorage.setItem(lastTsKey, JSON.stringify(maxTs))
    return { ok: true, applied, ts: maxTs }
  },
  _schedulePullCloud(ms) {
    if (typeof setTimeout !== 'function') return
    if (this._pullTimer) clearTimeout(this._pullTimer)
    this._pullTimer = setTimeout(() => {
      this._pullTimer = null
      this.pullCloudChanges().catch(() => null)
    }, ms)
  },

  // ==================== 账号认证 ====================
  getUsers() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.USERS) || '[]')
  },
  saveUsers(users) {
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users))
  },
  // 平台 Logo 本地缓存（页面渲染用；云端更新见 pullCloudChanges）
  getLogo() { return getLocalLogo() },
  setLogo(url) { return setLocalLogo(url) },
  async login(username, password) {
    const users = this.getUsers()
    const u = users.find(u => u.username === username)
    if (!u) return null
    if (!(await verifyPassword(u, password))) return null
    // 旧明文账号 → 登录成功即升级为哈希存储（并同步到云端 ph/salt）
    if (!isHashed(u)) {
      u.salt = genSalt()
      u.ph = await hashPassword(password, u.salt)
      delete u.password
      this.saveUsers(users)
      if (typeof CloudSync !== 'undefined') {
        CloudSync.enqueue({ u: u.username, n: u.name, ty: 'register', ts: Date.now(), d: { name: u.name, dept: u.dept, role: u.role, ph: u.ph, salt: u.salt } })
        CloudSync.pushPending().catch(() => null)
      }
    }
    return this._doLogin(u)
  },
  // 跨设备登录：本地密码校验失败时，尝试用云端哈希校验
  // 云端存的是不可逆 ph/salt，本地可离线校验后登录，同时把账号落到本机
  async loginAllowCloud(username, password) {
    // 1) 先按本地账号校验（哈希或旧明文，均可）
    const localUsers = this.getUsers()
    const local = localUsers.find(u => u.username === username)
    if (local && await verifyPassword(local, password)) {
      if (!isHashed(local)) {
        local.salt = genSalt()
        local.ph = await hashPassword(password, local.salt)
        delete local.password
        this.saveUsers(localUsers)
      }
      return this._doLogin(local)
    }
    // 2) 本地没匹配到：拉一次云端，用云端 ph/salt 校验密码
    let cloudInfo = null
    if (typeof CloudSync !== 'undefined') {
      try {
        const summary = await CloudSync.fetchSyncSummary()
        if (summary && summary.ok && summary.map && summary.map[username]) cloudInfo = summary.map[username]
      } catch (e) { /* ignore，离线则走本地判定 */ }
    }
    if (!cloudInfo || !cloudInfo.ph || !cloudInfo.salt) return null
    if ((await hashPassword(password, cloudInfo.salt)) !== cloudInfo.ph) return null
    // 3) 云端校验通过 → 在本机创建账号记录（用云端姓名/部门/角色 + 哈希凭据）并登录
    let users = this.getUsers()
    let u = users.find(x => x.username === username)
    if (!u) {
      const cntr = parseInt(localStorage.getItem(STORAGE_KEYS.COUNTER) || '100', 10)
      u = { id: cntr + 1, username, ph: cloudInfo.ph, salt: cloudInfo.salt, name: cloudInfo.name || username, dept: cloudInfo.dept || '', role: cloudInfo.role || 'student', createdAt: cloudInfo.createdAt || Date.now() }
      users.push(u)
      localStorage.setItem(STORAGE_KEYS.COUNTER, JSON.stringify(u.id))
      this.saveUsers(users)
    } else {
      // 已有记录但密码不符：用云端哈希凭据替换并补全云端信息（姓名/部门/角色）
      u.ph = cloudInfo.ph
      u.salt = cloudInfo.salt
      delete u.password
      if (cloudInfo.name) u.name = cloudInfo.name
      if (cloudInfo.dept !== undefined) u.dept = cloudInfo.dept
      if (cloudInfo.role) u.role = cloudInfo.role
      this.saveUsers(users)
    }
    return this._doLogin(u)
  },
  // 首次创建用户表后，把种子管理员的密码哈希（admin123）异步补齐
  _seedAdminAsync() {
    if (typeof setTimeout !== 'function') return
    setTimeout(() => {
      const users = this.getUsers()
      const a = users.find(u => u.username === 'admin')
      if (!a || a.ph) return
      const salt = genSalt()
      hashPassword('admin123', salt).then(ph => {
        const u2 = this.getUsers()
        const a2 = u2.find(x => x.username === 'admin')
        if (!a2 || a2.ph) return
        a2.ph = ph
        a2.salt = salt
        this.saveUsers(u2)
      }).catch(() => null)
    }, 100)
  },

  // 一次性迁移：把旧明文密码账号升级为哈希存储（登录时也会各自升级，这里是启动兜底）
  async migratePlainPasswords() {
    if (localStorage.getItem(PW_MIGRATED_FLAG)) return { done: true, upgraded: 0, skipped: 0 }
    const users = this.getUsers()
    let upgraded = 0
    let skipped = 0
    for (const u of users) {
      if (!u || !u.username) { skipped++; continue }
      if (isHashed(u)) continue
      if (u.password) {
        u.salt = genSalt()
        u.ph = await hashPassword(u.password, u.salt)
        delete u.password
        upgraded++
        // 同步升级云端凭据哈希（仅不可逆）
        if (typeof CloudSync !== 'undefined') {
          CloudSync.enqueue({ u: u.username, n: u.name, ty: 'register', ts: Date.now(), d: { name: u.name, dept: u.dept, role: u.role, ph: u.ph, salt: u.salt } })
        }
      }
    }
    if (upgraded > 0) this.saveUsers(users)
    localStorage.setItem(PW_MIGRATED_FLAG, '1')
    if (typeof CloudSync !== 'undefined' && upgraded > 0) CloudSync.pushPending().catch(() => null)
    return { done: true, upgraded, skipped }
  },

  // 登录公共核心：建立会话、同步信息、登记活动
  _doLogin(u) {
    const session = { id: u.id, username: u.username, name: u.name, dept: u.dept, role: u.role, level: u.level || 0 }
    localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session))
    // 同步个人信息（进度显示用）
    this.setUser({ name: u.name, dept: u.dept })
    // —— 记录会话开始（用于登录时长统计）——
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify({ userId: u.id, username: u.username, name: u.name, loginAt: Date.now() }))
    // —— 云端同步：登记当前用户（登录时长归属）——
    if (typeof CloudSync !== 'undefined') CloudSync.setUser(u.username, u.name)
    this._appendActivity(u.id, 'login', {})
    // 登录后立即拉一次云端，避免角色/用户名被其他设备改了但本机仍是旧值
    this._schedulePullCloud(0)
    return session
  },
  async register({ username, password, name, dept }) {
    const users = this.getUsers()
    if (users.some(u => u.username === username)) {
      return { ok: false, msg: '用户名已存在' }
    }
    const salt = genSalt()
    const ph = await hashPassword(password, salt)
    const user = { id: this.nextId(), username, ph, salt, name: name || username, dept: dept || '', role: 'student', createdAt: Date.now() }
    users.push(user)
    this.saveUsers(users)
    // —— 注册信息上报云端（所有终端可见；只带不可逆哈希，不带明文）——
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: user.username, n: user.name, ty: 'register', ts: user.createdAt, d: { name: user.name, dept: user.dept, role: user.role, ph: user.ph, salt: user.salt } })
    }
    return { ok: true, user }
  },
  async addUser({ username, password, name, dept, role }) {
    const users = this.getUsers()
    if (users.some(u => u.username === username)) {
      return { ok: false, msg: '用户名已存在' }
    }
    const salt = genSalt()
    const ph = await hashPassword(password, salt)
    const user = { id: this.nextId(), username, ph, salt, name: name || username, dept: dept || '', role: role || 'student', createdAt: Date.now() }
    users.push(user)
    this.saveUsers(users)
    // —— 注册信息上报云端（所有终端可见；只带不可逆哈希，不带明文）——
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: user.username, n: user.name, ty: 'register', ts: user.createdAt, d: { name: user.name, dept: user.dept, role: user.role, ph: user.ph, salt: user.salt } })
    }
    return { ok: true, user }
  },
  deleteUser(id) {
    const users = this.getUsers()
    const victim = users.find(u => u.id === Number(id))
    const rest = users.filter(u => u.id !== Number(id))
    this.saveUsers(rest)
    // —— 云端同步：移除该用户的聚合数据 ——
    if (typeof CloudSync !== 'undefined' && victim) {
      CloudSync.enqueue({ u: victim.username, ty: 'delete', d: {} })
    }
    return true
  },
  // 修改登录用户名（管理员改学员 / 学员改自己共用）
  // 联动：本地账号表 + 会话 + 活跃会话 + 活动日志 + 定级历史 + 云端 rename 事件
  renameUser(id, newUsername) {
    const users = this.getUsers()
    const u = users.find(u => u.id === Number(id))
    if (!u) return { ok: false, msg: '账号不存在' }
    const nu = String(newUsername || '').trim()
    if (!nu) return { ok: false, msg: '用户名不能为空' }
    if (/\s/.test(nu)) return { ok: false, msg: '用户名不能包含空格' }
    if (nu.length < 2 || nu.length > 30) return { ok: false, msg: '用户名长度需 2-30 个字符' }
    if (nu === u.username) return { ok: false, msg: '与当前用户名相同' }
    if (users.some(x => x.username === nu && x.id !== Number(id))) return { ok: false, msg: '用户名已存在' }
    const old = u.username
    u.username = nu
    this.saveUsers(users)
    // 当前会话（若是改自己）
    const s = this.getSession()
    if (s && s.id === Number(id)) {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ ...s, username: nu }))
    }
    // 活跃会话（登录时长归属）
    try {
      const as = JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION) || 'null')
      if (as && as.userId === Number(id)) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify({ ...as, username: nu }))
      }
    } catch (e) { /* ignore */ }
    // 活动日志中的用户名（保证后续时长/事件上报归属新用户名）
    try {
      const acts = this.getActivity()
      let dirty = false
      acts.forEach(a => { if (a.username === old) { a.username = nu; dirty = true } })
      if (dirty) localStorage.setItem(STORAGE_KEYS.ACTIVITY, JSON.stringify(acts))
    } catch (e) { /* ignore */ }
    // 定级历史
    try {
      const ph = this.getPlacementHistory()
      let phDirty = false
      ph.forEach(h => { if (h.username === old) { h.username = nu; phDirty = true } })
      if (phDirty) localStorage.setItem(STORAGE_KEYS.PLACEMENT, JSON.stringify(ph))
    } catch (e) { /* ignore */ }
    // 云端 rename 事件（所有终端的看板自动迁移聚合记录）
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: old, n: u.name, ty: 'rename', d: { nu } })
      CloudSync.pushPending()
      if (s && s.id === Number(id)) CloudSync.setUser(nu, u.name)
    }
    return { ok: true, old, nu }
  },
  async resetPassword(id, newPassword) {
    const users = this.getUsers()
    const u = users.find(u => u.id === Number(id))
    if (!u) return false
    u.salt = genSalt()
    u.ph = await hashPassword(newPassword, u.salt)
    delete u.password
    this.saveUsers(users)
    // —— 云端同步：更新该用户的凭据哈希（仅不可逆 ph/salt），保证其他设备可用新密码登录 ——
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: u.username, n: u.name, ty: 'register', ts: Date.now(), d: { name: u.name, dept: u.dept, role: u.role, ph: u.ph, salt: u.salt } })
      CloudSync.pushPending().catch(() => null)
    }
    return true
  },
  // 设置/取消管理员（管理员操作学员）
  // 联动：本地账号表 + 当前会话 + 云端 role 事件（保证其他终端 30s 内拉到新权限）
  async setUserRole(id, role) {
    const users = this.getUsers()
    const u = users.find(u => u.id === Number(id))
    if (!u) return { ok: false, msg: '账号不存在' }
    if (u.role === role) return { ok: false, msg: '权限未变化' }
    const s = this.getSession()
    if (role !== 'admin' && s && s.id === Number(id)) {
      return { ok: false, msg: '不能取消自己的管理员权限' }
    }
    const oldRole = u.role
    u.role = role
    this.saveUsers(users)
    // 若改的是当前登录用户，同步会话角色
    if (s && s.id === Number(id)) {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ ...s, role }))
    }
    // 云端 role 事件（所有终端看板同步角色），并等待推送完成
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: u.username, n: u.name, ty: 'role', d: { role } })
      try { await CloudSync.pushPending() } catch (e) { /* 失败也能入队，下次定时推送 */ }
    }
    return { ok: true, old: oldRole, role }
  },
  // 给「云端存在但本机无记录」的账户设置权限（非本地账户）
  // 本地没有该用户时自动创建影子账户（密码空、cloudOnly），权限经云端 role 事件同步到所有终端
  async setUserRoleByUsername(username, role) {
    if (!username) return { ok: false, msg: '账号不存在' }
    let users = this.getUsers()
    let u = users.find(u => u.username === username)
    if (!u) {
      const cntr = parseInt(localStorage.getItem(STORAGE_KEYS.COUNTER) || '100', 10)
      u = { id: cntr + 1, username, password: '', name: username, dept: '', role: 'student', createdAt: Date.now(), cloudOnly: true }
      users.push(u)
      localStorage.setItem(STORAGE_KEYS.COUNTER, JSON.stringify(u.id))
      this.saveUsers(users)
    }
    if (u.role === role) return { ok: false, msg: '权限未变化' }
    const s = this.getSession()
    if (role !== 'admin' && s && s.username === username) {
      return { ok: false, msg: '不能取消自己的管理员权限' }
    }
    const oldRole = u.role
    u.role = role
    this.saveUsers(users)
    // 若改的是当前登录用户，同步会话角色
    if (s && s.username === username) {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ ...s, role }))
    }
    // 云端 role 事件（所有终端看板同步角色），并等待推送完成
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: u.username, n: u.name, ty: 'role', d: { role } })
      try { await CloudSync.pushPending() } catch (e) { /* 失败也能入队，下次定时推送 */ }
    }
    return { ok: true, old: oldRole, role }
  },
  // 管理员修改学员所属部门（本地有账号记录）
  // 联动：本地账号表 + 当前会话 + 个人资料缓存 + 云端 dept 事件（学员设备 30s 内自动生效）
  async setUserDept(id, dept) {
    const users = this.getUsers()
    const u = users.find(u => u.id === Number(id))
    if (!u) return { ok: false, msg: '账号不存在' }
    return this._applyDeptChange(u, dept, users)
  },
  // 给「云端存在但本机无记录」的账号调整部门（自动创建影子账户并同步云端）
  async setUserDeptByUsername(username, dept) {
    if (!username) return { ok: false, msg: '账号不存在' }
    let users = this.getUsers()
    let u = users.find(u => u.username === username)
    if (!u) {
      const cntr = parseInt(localStorage.getItem(STORAGE_KEYS.COUNTER) || '100', 10)
      // 影子账户先不设部门，交由 _applyDeptChange 统一写入（避免误判"部门未变化"）
      u = { id: cntr + 1, username, password: '', name: username, dept: '', role: 'student', createdAt: Date.now(), cloudOnly: true }
      users.push(u)
      localStorage.setItem(STORAGE_KEYS.COUNTER, JSON.stringify(u.id))
      this.saveUsers(users)
    }
    return this._applyDeptChange(u, dept, users)
  },
  // 部门变更公共逻辑：写入账号表 → 同步会话/资料 → 推送云端 dept 事件
  async _applyDeptChange(u, dept, users) {
    const nd = String(dept || '').trim()
    const old = u.dept || ''
    if (nd === old) return { ok: false, msg: '部门未变化' }
    u.dept = nd
    this.saveUsers(users)
    const s = this.getSession()
    if (s && s.id === Number(u.id)) {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ ...s, dept: nd }))
      this.setUser({ name: u.name, dept: nd })
    }
    // 云端 dept 事件（所有终端看板/学员账号同步部门）
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: u.username, n: u.name, ty: 'dept', d: { dept: nd } })
      try { await CloudSync.pushPending() } catch (e) { /* 失败也能入队，下次定时推送 */ }
    }
    return { ok: true, old, dept: nd }
  },
  getSession() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION) || 'null')
  },
  logout() {
    // —— 退出前累计本次会话时长 ——
    this._flushActiveSession()
    // —— 云端同步：把不足 5 分钟的剩余时长也上报（≥30 秒）——
    if (typeof CloudSync !== 'undefined') {
      CloudSync.flushDuration(30000)
      CloudSync.pushPending()
    }
    localStorage.removeItem(STORAGE_KEYS.SESSION)
  },
  isLoggedIn() {
    return !!this.getSession()
  },
  isAdmin() {
    const s = this.getSession()
    return !!s && s.role === 'admin'
  },

  // ==================== 学习数据追踪 ====================
  // 活动日志结构：{ userId, username, type, timestamp, data }
  // type: 'login' | 'logout' | 'practice' | 'exam' | 'placement' | 'heartbeat'
  _appendActivity(userId, type, data) {
    const s = this.getSession()
    const all = this.getActivity()
    all.unshift({
      id: this.nextId(),
      userId,
      username: s ? s.username : '',
      name: s ? s.name : '',
      type,
      timestamp: Date.now(),
      data: data || {}
    })
    if (all.length > 2000) all.length = 2000
    localStorage.setItem(STORAGE_KEYS.ACTIVITY, JSON.stringify(all))
    // —— 云端同步：登录/练习/考试/测评事件上报（heartbeat 走分块时长，见 _flushActiveSession）——
    if (typeof CloudSync !== 'undefined' && s && s.username) {
      const tyMap = { login: 'login', practice: 'practice', exam: 'exam', placement: 'placement' }
      if (tyMap[type]) {
        CloudSync.enqueue({ u: s.username, n: s.name, ty: tyMap[type], d: data || {} })
      }
    }
  },
  getActivity() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVITY) || '[]')
  },
  // 心跳：每隔一段时间调用，把当前活跃会话的累计时长刷新到日志
  _flushActiveSession() {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION)
    if (!raw) return
    const as = JSON.parse(raw)
    const dur = Date.now() - as.loginAt
    if (dur < 5000) return // 不到 5 秒不计
    this._appendActivity(as.userId, 'heartbeat', { duration: dur })
    // —— 云端同步：登录时长分块累计（每满 5 分钟上报一次）——
    if (typeof CloudSync !== 'undefined') {
      CloudSync.addDuration(dur, as.username || '', as.name || '')
    }
    // 重置起点，继续累计
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify({ userId: as.userId, username: as.username, name: as.name, loginAt: Date.now() }))
  },
  // 练习完成追踪
  trackPractice(correct, total) {
    const s = this.getSession()
    if (!s) return
    this._appendActivity(s.id, 'practice', { correct, total, accuracy: total > 0 ? Math.round(correct / total * 100) : 0 })
  },
  // 考试完成追踪
  trackExam(score, total, correct, passed) {
    const s = this.getSession()
    if (!s) return
    this._appendActivity(s.id, 'exam', { score, total, correct, passed })
  },
  // 测评/定级追踪（perLevel 传入云端以便管理员跨设备重算）
  trackPlacement(level, score, total, perLevel) {
    const s = this.getSession()
    if (!s) return
    this._appendActivity(s.id, 'placement', { level, score, total, perLevel: perLevel || null })
  },
  // 获取某用户聚合统计
  getUserStats(userId) {
    const acts = this.getActivity().filter(a => a.userId === userId)
    // 登录时长（秒）：累加 heartbeat + (当前活跃会话未刷新的部分)
    let loginSec = 0
    acts.filter(a => a.type === 'heartbeat').forEach(a => { loginSec += Math.round((a.data.duration || 0) / 1000) })
    const as = JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION) || 'null')
    if (as && as.userId === userId) loginSec += Math.round((Date.now() - as.loginAt) / 1000)
    const loginCount = acts.filter(a => a.type === 'login').length
    const practices = acts.filter(a => a.type === 'practice')
    const exams = acts.filter(a => a.type === 'exam')
    const placements = acts.filter(a => a.type === 'placement')
    const practiceCount = practices.length
    const practiceCorrect = practices.reduce((s, a) => s + (a.data.correct || 0), 0)
    const practiceTotal = practices.reduce((s, a) => s + (a.data.total || 0), 0)
    const examCount = exams.length
    const examAvg = examCount > 0 ? Math.round(exams.reduce((s, a) => s + (a.data.score || 0), 0) / examCount) : 0
    const examBest = examCount > 0 ? Math.max(...exams.map(a => a.data.score || 0)) : 0
    const examPassRate = examCount > 0 ? Math.round(exams.filter(a => a.data.passed).length / examCount * 100) : 0
    const lastPlacement = placements.length > 0 ? placements[0].data : null
    return {
      loginSec, loginCount, loginDuration: this._fmtDuration(loginSec),
      practiceCount, practiceAccuracy: practiceTotal > 0 ? Math.round(practiceCorrect / practiceTotal * 100) : 0,
      examCount, examAvg, examBest, examPassRate,
      placementLevel: lastPlacement ? lastPlacement.level : null,
      lastActive: acts.length > 0 ? acts[0].timestamp : null
    }
  },
  // 获取所有用户聚合统计（管理员看板用）
  getAllUserStats() {
    return this.getUsers().map(u => {
      const stats = this.getUserStats(u.id)
      return { ...u, ...stats }
    })
  },
  _fmtDuration(sec) {
    if (sec < 60) return sec + '秒'
    if (sec < 3600) return Math.floor(sec / 60) + '分钟'
    return (sec / 3600).toFixed(1) + '小时'
  },

  // ==================== 等级与水平测试 ====================
  // 更新用户表中的字段（如 level）
  updateUser(id, patch) {
    const users = this.getUsers()
    const u = users.find(u => u.id === Number(id))
    if (!u) return null
    Object.assign(u, patch)
    this.saveUsers(users)
    // 同步 session
    const s = this.getSession()
    if (s && s.id === Number(id)) {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ ...s, ...patch }))
    }
    return u
  },
  // 当前登录用户的等级（0 = 未定级）
  getUserLevel() {
    const s = this.getSession()
    if (!s) return 0
    const u = this.getUsers().find(u => u.id === s.id)
    return (u && u.level) || 0
  },
  saveUserLevel(level, detail) {
    const s = this.getSession()
    if (!s) return
    this.updateUser(s.id, { level, placedAt: Date.now() })
    // 记录定级历史
    const history = this.getPlacementHistory()
    history.unshift({
      id: this.nextId(),
      userId: s.id,
      username: s.username,
      name: s.name,
      level,
      score: detail ? detail.score : null,
      total: detail ? detail.total : null,
      perLevel: detail ? detail.perLevel : null,
      timestamp: Date.now()
    })
    if (history.length > 200) history.length = 200
    localStorage.setItem(STORAGE_KEYS.PLACEMENT, JSON.stringify(history))
    // —— 同步写入活动日志（管理员看板可见）——
    this.trackPlacement(level, detail ? detail.score : null, detail ? detail.total : null, detail ? detail.perLevel : null)
  },
  getPlacementHistory() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.PLACEMENT) || '[]')
  },
  // 一次性迁移：用新逻辑（逐级递进 + 60% 阈值）重算所有已有定级记录
  recalcPlacementLevels() {
    const FLAG = 'eq_placement_recalc_v2'
    if (localStorage.getItem(FLAG)) return  // 已执行过
    const THRESHOLD = 0.6
    const history = this.getPlacementHistory()
    if (!history.length) { localStorage.setItem(FLAG, '1'); return }
    let changed = 0
    history.forEach(h => {
      if (!h.perLevel) return
      let newLevel = 1
      for (let l = 1; l <= 4; l++) {
        const s = h.perLevel[l]
        const acc = s && s.total > 0 ? s.correct / s.total : 0
        if (acc >= THRESHOLD) { newLevel = l } else { break }
      }
      if (newLevel !== h.level) {
        h.level = newLevel
        changed++
        // 同步更新用户表里的等级
        const users = this.getUsers()
        const u = users.find(u => u.id === h.userId)
        if (u && u.level !== newLevel) {
          this.updateUser(u.id, { level: newLevel })
        }
      }
    })
    if (changed > 0) {
      localStorage.setItem(STORAGE_KEYS.PLACEMENT, JSON.stringify(history))
      // 如果当前登录用户的等级变了，上报新等级到云端
      const s = this.getSession()
      if (s) {
        const u = this.getUsers().find(u => u.id === s.id)
        if (u && u.level) {
          this.trackPlacement(u.level, null, null)
          if (typeof CloudSync !== 'undefined') CloudSync.flush && CloudSync.flush()
        }
      }
    }
    localStorage.setItem(FLAG, '1')
  },
  // 清空所有用户的定级记录（本机）
  clearAllPlacements() {
    // 1. 清空定级历史
    localStorage.setItem(STORAGE_KEYS.PLACEMENT, JSON.stringify([]))
    // 2. 所有用户 level 重置为 0，移除 placedAt
    const users = this.getUsers()
    users.forEach(u => {
      if (u.role === 'admin') return
      u.level = 0
      delete u.placedAt
    })
    this.saveUsers(users)
    // 3. 清除活动日志中的 placement 记录
    const acts = this.getActivity()
    const filtered = acts.filter(a => a.type !== 'placement')
    localStorage.setItem(STORAGE_KEYS.ACTIVITY, JSON.stringify(filtered))
    // 4. 重置 recalc flag，以便后续重新定级时可正常重算
    localStorage.removeItem('eq_placement_recalc_v2')
    // 5. 同步当前 session
    const s = this.getSession()
    if (s && s.role !== 'admin') {
      localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify({ ...s, level: 0 }))
    }
  },
  // 带等级信息的题目列表（可按部门筛选）
  getQuestionsWithLevel(deptKey) {
    const qs = deptKey ? this.getQuestionsByDept(deptKey) : this.getQuestions()
    return qs.map(q => ({ ...q, level: levelOf(q) }))
  },

  // ==================== v43：线下课题库派生 ====================
  // 从线下课班级文档提取「已激活作业」（非草稿 homework/exam）中的全部题目，
  // 去重后整体替换本地题库（原题库中其他来源的题目随之删除）。
  // - 题目 id 稳定：按 题型|题干 建立映射（localStorage eq_course_qmap），重复派生 id 不变，刷题记录不失效
  // - dept 统一 'all'（各部门学员均可见），category 固定 COURSE_BANK_CATEGORY
  // - 指纹比对：作业题目无变化时跳过写库，可高频安全调用
  // 返回：写入的题目数；题目无变化返回 -1
  rebuildBankFromCourse(classes) {
    const qmapKey = 'eq_course_qmap'
    let qmap = {}
    try { qmap = JSON.parse(localStorage.getItem(qmapKey) || '{}') } catch (e) { qmap = {} }
    let maxId = 0
    Object.keys(qmap).forEach(k => { maxId = Math.max(maxId, Number(qmap[k]) || 0) })
    const seen = new Set()
    const items = []
    const fps = []
    ;(classes || []).forEach(c => (c.assignments || []).forEach(a => {
      if (a.status === 'draft') return
      // 旧版作业无 type 字段（按 homework 语义作答），同样纳入；只排除视频/线下课
      if (a.type === 'video' || a.type === 'offline') return
      ;(a.questions || []).forEach(q => {
        const text = String(q.question || '').trim()
        if (!text) return
        const key = (q.type || 'single') + '|' + text
        if (seen.has(key)) return
        seen.add(key)
        if (!qmap[key]) qmap[key] = ++maxId
        const opts = Array.isArray(q.options) ? q.options : []
        const ans = Array.isArray(q.answer) ? q.answer : []
        items.push({
          id: qmap[key],
          dept: 'all',
          category_id: COURSE_BANK_CATEGORY.id,
          type: q.type || 'single',
          difficulty: Math.min(3, Math.max(1, Number(q.difficulty) || 1)),
          question: text,
          options: opts,
          answer: ans,
          explanation: String(q.explanation || '')
        })
        fps.push(key + '#' + (Number(q.difficulty) || 1) + '#' + JSON.stringify(opts) + '#' + JSON.stringify(ans))
      })
    }))
    const fp = fps.sort().join('\u0001')
    if (fp === this._courseBankFp) return -1
    this._courseBankFp = fp
    localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify(items))
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify([COURSE_BANK_CATEGORY]))
    localStorage.setItem(qmapKey, JSON.stringify(qmap))
    return items.length
  },

  // ==================== 培训题库（理解/发音） ====================
  getTrainingQuestions() {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEYS.TRAINING) || '{"comprehension":[],"pronunciation":[]}')
    return d
  },
  saveTrainingQuestions(data) {
    localStorage.setItem(STORAGE_KEYS.TRAINING, JSON.stringify(data))
  },
  addTrainingQuestion(kind, data) {
    // kind: comprehension | pronunciation
    const d = this.getTrainingQuestions()
    const newQ = { ...data, id: 't' + this.nextId() }
    d[kind].push(newQ)
    this.saveTrainingQuestions(d)
    return newQ
  },
  updateTrainingQuestion(kind, id, data) {
    const d = this.getTrainingQuestions()
    const idx = d[kind].findIndex(q => q.id === id)
    if (idx < 0) return null
    d[kind][idx] = { ...d[kind][idx], ...data, id }
    this.saveTrainingQuestions(d)
    return d[kind][idx]
  },
  deleteTrainingQuestion(kind, id) {
    const d = this.getTrainingQuestions()
    d[kind] = d[kind].filter(q => q.id !== id)
    this.saveTrainingQuestions(d)
    return true
  },
  resetTrainingQuestions() {
    localStorage.removeItem(STORAGE_KEYS.TRAINING)
    this.init()
  },

  // Counter
  nextId() {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEYS.COUNTER) || '100')
    const next = c + 1
    localStorage.setItem(STORAGE_KEYS.COUNTER, JSON.stringify(next))
    return next
  },

  // User
  getUser() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.USER) || 'null')
  },
  setUser(user) {
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user))
  },

  // Categories
  getCategories() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.CATEGORIES) || '[]')
  },
  getCategoryName(id) {
    const cats = this.getCategories()
    const c = cats.find(c => c.id === Number(id))
    return c ? c.name : '未分类'
  },
  addCategory(name, description) {
    const cats = this.getCategories()
    const newCat = { id: this.nextId(), name, description: description || '' }
    cats.push(newCat)
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(cats))
    return newCat
  },
  deleteCategory(id) {
    const questions = this.getQuestions()
    const used = questions.some(q => q.category_id === Number(id))
    if (used) return { ok: false, msg: '该分类下还有题目，无法删除' }
    const cats = this.getCategories().filter(c => c.id !== Number(id))
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(cats))
    return { ok: true }
  },

  // Questions
  // v52：题库 = 派生库（线下课作业重建生成，eq_questions）+ 上传库（管理员新增/批量导入，eq_uploaded）。
  // 上传库独立存储：rebuildBankFromCourse 整体替换 eq_questions 时不清除，实现「管理员题目永久保留」。
  _getUploaded() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.UPLOADED) || '[]') } catch (e) { return [] }
  },
  _setUploaded(list) {
    localStorage.setItem(STORAGE_KEYS.UPLOADED, JSON.stringify(list))
  },
  getQuestions() {
    const derived = JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTIONS) || '[]')
    const uploaded = this._getUploaded()
    return uploaded.length ? derived.concat(uploaded) : derived
  },
  // 按部门筛选题目：dining 看 dining+all，rooms 看 rooms+all，其他/空 看 all（含全部）
  // 实际调用方传 deptKey（'dining'|'rooms'|'other'|''|undefined）
  getQuestionsByDept(deptKey) {
    const qs = this.getQuestions()
    if (!deptKey || deptKey === 'other') return qs  // 其他部门/管理员看全部
    return qs.filter(q => !q.dept || q.dept === 'all' || q.dept === deptKey)
  },
  // 从 session 获取当前用户的大部门 key
  getSessionDeptKey() {
    const s = this.getSession()
    if (!s || !s.dept) return 'other'
    // dept 格式：'饮食部·标帜餐厅' → 取大部门名
    const idx = s.dept.indexOf('·')
    const majorName = idx >= 0 ? s.dept.slice(0, idx) : s.dept
    const tree = (typeof t === 'function') ? t('deptTree') : null
    if (!tree) {
      // fallback：直接匹配中文名
      if (majorName === '饮食部') return 'dining'
      if (majorName === '房务部') return 'rooms'
      return 'other'
    }
    for (const k of ['dining', 'rooms', 'other']) {
      if (tree[k] && tree[k].name === majorName) return k
    }
    return 'other'
  },
  getQuestion(id) {
    const sid = String(id)
    return this.getQuestions().find(q => String(q.id) === sid)
  },
  // dept：学员语义（dining 看到 dining+all）；deptExact：精确匹配题目 dept（题库管理用）
  queryQuestions({ category_id, difficulty, keyword, dept, deptExact, page, pageSize } = {}) {
    let qs = dept ? this.getQuestionsByDept(dept) : this.getQuestions()
    if (deptExact) qs = qs.filter(q => q.dept === deptExact)
    if (category_id) qs = qs.filter(q => q.category_id === Number(category_id))
    if (difficulty) qs = qs.filter(q => q.difficulty === Number(difficulty))
    if (keyword) {
      const kw = keyword.toLowerCase()
      qs = qs.filter(q => q.question.toLowerCase().includes(kw))
    }
    const total = qs.length
    if (page && pageSize) {
      const start = (page - 1) * pageSize
      qs = qs.slice(start, start + pageSize)
    }
    return { list: qs, total }
  },
  // v52：新增题目一律入上传库（eq_uploaded，id 前缀 'u'）——不受线下课题库重建清理影响，永久保留
  addQuestion(data) {
    const list = this._getUploaded()
    const newQ = { ...data, id: 'u' + this.nextId() }
    list.push(newQ)
    this._setUploaded(list)
    return newQ
  },
  updateQuestion(id, data) {
    const sid = String(id)
    // 优先在上传库中定位（id 带 'u' 前缀或命中上传题）
    let list = this._getUploaded()
    const ui = list.findIndex(q => String(q.id) === sid)
    if (ui >= 0) {
      list[ui] = { ...list[ui], ...data, id: list[ui].id }
      this._setUploaded(list)
      return list[ui]
    }
    // 派生库
    const qs = JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTIONS) || '[]')
    const di = qs.findIndex(q => String(q.id) === sid)
    if (di < 0) return null
    qs[di] = { ...qs[di], ...data, id: qs[di].id }
    localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify(qs))
    return qs[di]
  },
  deleteQuestion(id) {
    const sid = String(id)
    let list = this._getUploaded()
    if (list.some(q => String(q.id) === sid)) {
      this._setUploaded(list.filter(q => String(q.id) !== sid))
      return true
    }
    const qs = JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTIONS) || '[]')
    const kept = qs.filter(q => String(q.id) !== sid)
    if (kept.length !== qs.length) {
      localStorage.setItem(STORAGE_KEYS.QUESTIONS, JSON.stringify(kept))
      return true
    }
    return false
  },
  // 批量导入：逐条走 addQuestion 写入上传库（永久保留）；返回 { success, skipped }
  // 同 (type|题干) 已在库中 → 跳过（成功数不计入 success）
  batchImport(items) {
    let success = 0, skipped = 0
    const existing = new Set(this.getQuestions().map(q => (q.type || 'single') + '|' + String(q.question || '').trim().toLowerCase()))
    items.forEach(item => {
      const q = {
        category_id: Number(item.category_id) || 1,
        dept: item.dept || 'all',
        type: item.type || 'single',
        difficulty: Math.min(4, Math.max(1, Number(item.difficulty) || 1)),   // v52：支持 L4（difficulty 4）
        question: String(item.question || '').trim(),
        options: Array.isArray(item.options) ? item.options : [],
        answer: Array.isArray(item.answer) ? item.answer : [],
        explanation: String(item.explanation || '')
      }
      if (!q.question) return
      const key = q.type + '|' + q.question.toLowerCase()
      if (existing.has(key)) { skipped++; return }
      existing.add(key)
      this.addQuestion(q)
      success++
    })
    return { success, skipped }
  },

  // Progress (practice history)
  getProgress() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.PROGRESS) || '[]')
  },
  addProgress(record) {
    const list = this.getProgress()
    list.unshift({ ...record, id: this.nextId(), timestamp: Date.now() })
    // keep max 500
    if (list.length > 500) list.length = 500
    localStorage.setItem(STORAGE_KEYS.PROGRESS, JSON.stringify(list))
    // —— 每道题答题明细上报云端（管理员看板跨设备聚合每题正确率）——
    // 练习/在线考试都会走 addProgress，这里统一上报，无需逐个调用点改
    if (record && record.question_id != null && typeof CloudSync !== 'undefined') {
      this.reportPerQuestion(record.question_id, !!record.correct)
    }
  },
  // 上报单题答题对错到云端（perq 事件）
  // 云端聚合结构：聚合记录的 perQ[qid] = { correct, total }
  reportPerQuestion(qid, correct) {
    const s = this.getSession()
    if (!s || !s.username) return
    if (typeof CloudSync === 'undefined' || !CloudSync.enqueue) return
    CloudSync.enqueue({ u: s.username, n: s.name || '', ty: 'perq', d: { qid: Number(qid), correct: correct ? 1 : 0 } })
  },

  // v38：看字选音发音修复的分数修正（一次性迁移，由 init 调用，见 init 内说明）
  // fixTs = 修复基准时间；此前提交的 voicematch 错答视为无效题（安卓本地 TTS 静音、无法听音作答）
  _fixVoicematchScores(fixTs) {
    // 1) 收集修复前的 voicematch 错答（练习/考试等全部模式）
    const prog = JSON.parse(localStorage.getItem(STORAGE_KEYS.PROGRESS) || '[]')
    const bad = prog.filter(p => p && p.type === 'voicematch' && !p.correct && (p.timestamp || 0) < fixTs)
    if (!bad.length) return
    // 2) 本地明细剔除（个人正确率统计不再计入无效错答）
    const badIds = new Set(bad.map(p => p.id))
    localStorage.setItem(STORAGE_KEYS.PROGRESS, JSON.stringify(prog.filter(p => !badIds.has(p.id))))
    // 3) 云端每题正确率：分母剔除（云端 events 按入队顺序应用，perqfix 必晚于对应 perq）
    const session = this.getSession()
    if (typeof CloudSync !== 'undefined' && CloudSync.enqueue) {
      bad.forEach(p => CloudSync.enqueue({
        u: session ? session.username : '',
        ty: 'perqfix',
        d: { qid: Number(p.question_id), wrongFix: 1 }
      }))
    }
    // 4) 本地考试卷重算：mode='exam' 的无效错答按提交时间（±10s）匹配回对应考试卷
    const examBad = bad.filter(p => p.mode === 'exam')
    if (examBad.length) {
      const exams = JSON.parse(localStorage.getItem(STORAGE_KEYS.EXAMS) || '[]')
      let examsChanged = false
      examBad.forEach(p => {
        let best = null, bestDiff = Infinity
        exams.forEach(e => {
          const diff = Math.abs((e.timestamp || 0) - (p.timestamp || 0))
          if (diff <= 10000 && diff < bestDiff) { bestDiff = diff; best = e }
        })
        if (best) { best._vmFixN = (best._vmFixN || 0) + 1; examsChanged = true }
      })
      exams.forEach(e => {
        const n = e._vmFixN || 0
        if (!n) return
        delete e._vmFixN
        const scoreOld = e.score || 0
        const correctNew = (e.correct || 0) + n
        const scoreNew = Math.round(correctNew / Math.max(1, e.total || 1) * 100)
        const passedOld = !!e.passed
        const passedNew = scoreNew >= 60
        e.correct = correctNew
        e.score = scoreNew
        e.passed = passedNew
        e.vmFixed = (e.vmFixed || 0) + n   // 修正痕迹：无效题补回数
        if (typeof CloudSync !== 'undefined' && CloudSync.enqueue) {
          CloudSync.enqueue({ ty: 'examfix', d: { scoreOld, scoreNew, passedOld, passedNew } })
        }
      })
      if (examsChanged) localStorage.setItem(STORAGE_KEYS.EXAMS, JSON.stringify(exams))
      // 5) 活动日志的 exam 记录同步重算（本设备统计一致）
      try {
        const acts = JSON.parse(localStorage.getItem(STORAGE_KEYS.ACTIVITY) || '[]')
        let actChanged = false
        examBad.forEach(p => {
          let best = null, bestDiff = Infinity
          acts.forEach(a => {
            if (a.type !== 'exam') return
            const diff = Math.abs((a.timestamp || 0) - (p.timestamp || 0))
            if (diff <= 10000 && diff < bestDiff) { bestDiff = diff; best = a }
          })
          if (best) {
            best.data = best.data || {}
            best.data.correct = (best.data.correct || 0) + 1
            best.data.score = Math.round(best.data.correct / Math.max(1, best.data.total || 1) * 100)
            best.data.passed = best.data.score >= 60
            actChanged = true
          }
        })
        if (actChanged) localStorage.setItem(STORAGE_KEYS.ACTIVITY, JSON.stringify(acts))
      } catch (e) { /* ignore */ }
    }
  },

  // Exams
  getExams() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.EXAMS) || '[]')
  },
  addExam(record) {
    const list = this.getExams()
    list.unshift({ ...record, id: this.nextId(), timestamp: Date.now() })
    if (list.length > 200) list.length = 200
    localStorage.setItem(STORAGE_KEYS.EXAMS, JSON.stringify(list))
  },

  // Stats
  // deptKey：学员端传入本部门 key（dining/rooms），分类进度分母按本部门题库计算；管理员/其他部门不传或传 'other' 看全库
  getStats(deptKey) {
    const scoped = deptKey && deptKey !== 'other'
    const questions = scoped ? this.getQuestionsByDept(deptKey) : this.getQuestions()
    const categories = this.getCategories()
    const progress = this.getProgress()
    const exams = this.getExams()

    const totalAnswered = progress.length
    const correctCount = progress.filter(p => p.correct).length
    const accuracy = totalAnswered > 0 ? Math.round(correctCount / totalAnswered * 100) : 0

    const examCount = exams.length
    const examAvgScore = examCount > 0
      ? Math.round(exams.reduce((s, e) => s + e.score, 0) / examCount)
      : 0

    // Category coverage
    const categoryStats = categories.map(cat => {
      const catQuestions = questions.filter(q => q.category_id === cat.id)
      const catProgress = progress.filter(p => p.category_id === cat.id)
      const catCorrect = catProgress.filter(p => p.correct).length
      return {
        ...cat,
        totalQuestions: catQuestions.length,
        answered: catProgress.length,
        correct: catCorrect,
        accuracy: catProgress.length > 0 ? Math.round(catCorrect / catProgress.length * 100) : 0
      }
    })

    return {
      totalQuestions: questions.length,
      totalCategories: categories.length,
      totalAnswered,
      correctCount,
      accuracy,
      examCount,
      examAvgScore,
      categoryStats,
      recentProgress: progress.slice(0, 20),
      recentExams: exams.slice(0, 10)
    }
  }
}

Store.init()
