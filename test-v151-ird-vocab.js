// ====== 测试 v151：客房送餐部词汇题库（dining/ird，236 题）======
// 背景：dining/ird 此前在七天挑战抽题池（category_id=12）里是 **0 题** → 该部门挑战无法开跑。
//   本批从 Basic English words / Basic English words 2.0（59 个餐饮基础词）生成，
//   每词 4 题型（single 英→中 / listen 听音选义 / voicematch 看字选音 / judge 判断）= 236 题，
//   id 8700-8935（独立段，避开 v9 种子的 8001-8684），dept 恒为 'dining/ird'。
//
// ① 批次结构：236 题 / id 连续唯一 / category_id 全 12 / dept 全 dining/ird / 四型各 59 / BANK.version 仍为 9
// ② 每词四题齐全：id 每 4 题一组、题型序列固定、同词三型共用同一英文题干
// ③ 题型形态：single/listen 题干英文+4 中文选项+answer[0]；voicematch 题干英文+4 英文选项+options[0]=题干；
//             judge 题干中文陈述 + ['正确','错误'] + answer 0/1
// ④ 干扰项语义：中文干扰项取自其它词的真实释义、英文干扰项取自其它词的真实英文（不是随机字串）
// ⑤ 判断题「真/假」：30 真 / 29 假；真说法用本词英文，**假说法是「张冠李戴」**（用另一个词的真实英文）；
//             解析须给出「不是 X」的纠正
// ⑥ 难度分档：single=L1 / listen=L2 / judge 真=L1 假=L2 / voicematch 按「单词短词=2，长词与词组=3」
// ⑦ 挑战池（真跑 chBankQuestions）：ird 学员可见 236 题 ≥ CHALLENGE_MIN_BANK(190)；
//             **同大部门其它分队（sig/bar）看得到 0 道本批题**（不跨分队串题）；房务部 0 题
// ⑧ 端到端（真跑 challengePool）：ird 学员第一期练习序列**满 170 题、id 唯一、全部落在本部门池内**
//             （v149 的「桶枯竭 → 序列缩水 → 点开始没反应」在本部门不再发生）
// ⑨ 既有契约不受影响：BANK.version 仍为 9 / 种子题不进 localStorage / 管理端 _seed 只读
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
let passN = 0
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name); passN++ }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const DIR = __dirname
const BANK_SRC = fs.readFileSync(path.join(DIR, 'bank-data.js'), 'utf-8')
const STORE_SRC = fs.readFileSync(path.join(DIR, 'store.js'), 'utf-8')
const CH_SRC = fs.readFileSync(path.join(DIR, 'challenge.js'), 'utf-8')
const APP_SRC = fs.readFileSync(path.join(DIR, 'app.js'), 'utf-8')

// v89：DEPT_SUB_SLUGS 定义在 app.js，store.getQuestionsByDept 的大部门前缀分支依赖它（缺则四分队题全丢）
const DEPT_SUB_SLUGS_SRC = `const DEPT_SUB_SLUGS = {
  dining: { '标帜餐厅': 'sig', '艳中餐厅': 'yan', '酒吧团队': 'bar', '客房送餐': 'ird' },
  rooms: { '迎宾前台': 'fo', '礼宾部': 'concierge', '随时随需': 'ww', '客房造型': 'styling', '健身及水疗中心': 'spa' },
}`

// 依赖注入：手工按名补（禁止批量注入器 —— 见技能 §十八）
function extractFn(src, name) {
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
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
function extractScalar(src, name) {
  const m = new RegExp('const ' + name + ' = ([0-9]+)').exec(src)
  if (!m) throw new Error('const not found: ' + name)
  return m[1]
}
// 抠嵌套数组常量必须按括号配平（技能 §四·补十八：非贪婪正则会在第一个 ] 处截断）
function extractArr(src, name) {
  const key = 'const ' + name + ' = '
  const i = src.indexOf(key)
  if (i < 0) throw new Error('const not found: ' + name)
  const from = i + key.length
  if (src[from] !== '[') throw new Error(name + ' 右侧非数组')
  let d = 0
  for (let k = from; k < src.length; k++) {
    if (src[k] === '[') d++
    else if (src[k] === ']') { d--; if (!d) return src.slice(from, k + 1) }
  }
  throw new Error(name + ' 括号未闭合')
}

const MIN_BANK = Number(extractScalar(CH_SRC, 'CHALLENGE_MIN_BANK'))
const CH_SEED = extractScalar(CH_SRC, 'CHALLENGE_SEED')
const CH_DIFF_PLAN_SRC = extractArr(CH_SRC, 'CHALLENGE_DIFF_PLAN')

// 挑战相关函数（真实现，注入沙箱）
const CH_FNS_FOR_POOL = [
  'chDeptKey', 'chBankQuestions', 'chBankMaxDiff', 'chDiffBucketOf',
  'chBankDiffStats', 'chBankDiffGap',
  // v154：challengePool / chBankDiffStats / chBankCount 改走营次口径 → 注入新依赖
  //   （本沙箱无 CloudSync 营次数据 → chRoundBankQuestions 回落视角口径，题源不变）
  'chRoundRecForCurrent', 'chRoundBankQuestions',
  'challengeRng', 'chUserSeed', 'chPlanAllocate', 'chDrawWithBackfill', 'challengePool',
]

function mkChSandbox(dept, opts) {
  const o = opts || {}
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console, window: {}, document: { addEventListener() {} },
    // 学员身份侧信道：chDeptKey 的第一分支（管理员切片）因 Store.isAdmin() 为 false 而跳过
    sessionDeptSlug: () => dept,
  }
  vm.createContext(sb)
  vm.runInContext(BANK_SRC, sb)
  vm.runInContext(DEPT_SUB_SLUGS_SRC, sb)
  vm.runInContext(STORE_SRC, sb)
  // 常量：从源码取真值（不另抄一份快照 —— 技能 §四·补二十三）
  vm.runInContext('const CHALLENGE_SEED = ' + CH_SEED + ';', sb)
  vm.runInContext('const CHALLENGE_DIFF_PLAN = ' + CH_DIFF_PLAN_SRC + ';', sb)
  CH_FNS_FOR_POOL.forEach(n => vm.runInContext(extractFn(CH_SRC, n), sb))
  if (o.withPool) {
    // 只影响「洗牌种子」的三个依赖：本套件断言的是「序列长度/唯一性/归属」，
    // 与具体抽到哪几题无关 → 隔离 stub 即可，不必拉入整条 uid/营次链。
    vm.runInContext('function challengeUid() { return "ird-v151-test-user" }', sb)
    vm.runInContext('function chCurrentRound() { return "第一期" }', sb)
    vm.runInContext('function chRoundSlug() { return "第一期" }', sb)
  }
  return sb
}

;(async () => {
  console.log('\n🧪 v151 客房送餐部词汇题库（dining/ird，236 题）测试')

  // ---------- 共用数据（空库沙箱，避免受本地库影响）----------
  const base = mkChSandbox('')
  const BANK = vm.runInContext('BANK', base)
  const q12 = BANK.questions.filter(q => Number(q.category_id) === 12)
  const IRD_LO = 8700, IRD_HI = 8935, WORD_N = 59
  const IRD = BANK.questions.filter(q => q.id >= IRD_LO && q.id <= IRD_HI)
  const S = IRD.filter(q => q.type === 'single')
  const L = IRD.filter(q => q.type === 'listen')
  const V = IRD.filter(q => q.type === 'voicematch')
  const J = IRD.filter(q => q.type === 'judge')
  const EN_WORDS = S.map(q => q.question)                       // 59 个英文词（按 id 升序）
  const CN_SET = new Set(S.map(q => q.options[0]))               // 59 个中文释义
  const EN_SET = new Set(EN_WORDS)
  const grp = q => Math.floor((q.id - IRD_LO) / 4)               // 词序号

  // ---------- ① 批次结构 ----------
  console.log('\n[1] 批次结构')
  {
    assert('客房送餐批次共 236 题', IRD.length === 236, `got ${IRD.length}`)
    const ids = IRD.map(q => q.id).sort((a, b) => a - b)
    assert('id 区间 8700-8935 且连续（无空洞）',
      ids[0] === IRD_LO && ids[ids.length - 1] === IRD_HI && ids.every((v, i) => i === 0 || v === ids[i - 1] + 1),
      `${ids[0]}..${ids[ids.length - 1]} len=${ids.length}`)
    assert('id 唯一', new Set(ids).size === 236)
    assert('category_id 全为 12（七天挑战抽题池）', IRD.every(q => Number(q.category_id) === 12),
      JSON.stringify([...new Set(IRD.map(q => q.category_id))]))
    assert('dept 全为 dining/ird', IRD.every(q => q.dept === 'dining/ird'),
      JSON.stringify([...new Set(IRD.map(q => q.dept))]))
    assert('题型四型各 59',
      ['single', 'listen', 'voicematch', 'judge'].every(t => IRD.filter(q => q.type === t).length === 59),
      JSON.stringify(['single', 'listen', 'voicematch', 'judge'].map(t => t + ':' + IRD.filter(q => q.type === t).length)))
    assert('题型全部属于挑战池合法集（single/listen/voicematch/judge）',
      IRD.every(q => ['single', 'listen', 'voicematch', 'judge'].indexOf(q.type) >= 0))
    assert('★ BANK.version 仍为 9（不得 bump —— cat>=12 走运行时拼接，bump 会触发全设备迁移）',
      BANK.version === 9, `got ${BANK.version}`)
    assert('id 段与 v9 种子段（8001-8684）无交集',
      !BANK.questions.some(q => Number(q.category_id) === 12 && q.id >= 8001 && q.id <= 8684 && q.id >= IRD_LO && q.id <= IRD_HI))
    assert('cat12 总量 = 920（v9 块 684 + 本批 236）', q12.length === 920, `got ${q12.length}`)
    assert('本批之外的 cat12 题（684）都不属于 dining/ird',
      q12.filter(q => !(q.id >= IRD_LO && q.id <= IRD_HI)).every(q => q.dept !== 'dining/ird'))
  }

  // ---------- ② 每词四题齐全 ----------
  console.log('\n[2] 每词四题齐全（59 词 × 4 型）')
  {
    assert('英文词 59 个且唯一', EN_WORDS.length === WORD_N && EN_SET.size === WORD_N,
      `got ${EN_WORDS.length}/${EN_SET.size}`)
    const seqBad = [], stemBad = []
    for (let i = 0; i < WORD_N; i++) {
      const lo = IRD_LO + i * 4
      const g = IRD.filter(q => q.id >= lo && q.id <= lo + 3).sort((a, b) => a.id - b.id)
      if (g.length !== 4 || g.map(q => q.type).join(',') !== 'single,listen,voicematch,judge') { seqBad.push(lo); continue }
      const en = g[0].question, cn = g[0].options[0]
      if (g[1].question !== en || g[2].question !== en) stemBad.push('三型题干不一致@' + lo)
      if (!g[3].question.startsWith('「' + cn + '」的英文是 ')) stemBad.push('判断题干未含同词中文释义@' + lo)
    }
    assert('每词恰好 4 题、id 连续、题型序列 single→listen→voicematch→judge',
      seqBad.length === 0, JSON.stringify(seqBad))
    assert('同词三型共用同一英文题干，判断题干含该词的中文释义',
      stemBad.length === 0, JSON.stringify(stemBad))
    assert('★ 59 个中文释义互不相同（每词一词一义）', CN_SET.size === WORD_N, `got ${CN_SET.size}`)
  }

  // ---------- ③ 题型形态 ----------
  console.log('\n[3] 题型形态')
  {
    const isEn = s => !/[\u4e00-\u9fff]/.test(s)
    const hasCn = s => /[\u4e00-\u9fff]/.test(s)
    assert('single：题干纯英文 / 4 个中文选项 / answer [0] / 选项无重复',
      S.every(q => isEn(q.question) && q.options.length === 4 && q.options.every(hasCn) &&
        JSON.stringify(q.answer) === '[0]' && new Set(q.options).size === 4),
      JSON.stringify(S.find(q => !(q.options.length === 4)) || ''))
    assert('listen：同 single 形态（题干纯英文 / 4 中文选项 / answer [0]）',
      L.every(q => isEn(q.question) && q.options.length === 4 && q.options.every(hasCn) &&
        JSON.stringify(q.answer) === '[0]' && new Set(q.options).size === 4))
    assert('★ voicematch：题干纯英文 / 4 个英文选项 / options[0] === 题干 / answer [0] / 选项无重复',
      V.every(q => isEn(q.question) && q.options.length === 4 && q.options.every(isEn) &&
        q.options[0] === q.question && JSON.stringify(q.answer) === '[0]' && new Set(q.options).size === 4),
      JSON.stringify(V.find(q => q.options[0] !== q.question) || ''))
    assert('★ judge：options 恒为 [正确,错误] / answer 为 0 或 1',
      J.every(q => JSON.stringify(q.options) === '["正确","错误"]' &&
        q.answer.length === 1 && (q.answer[0] === 0 || q.answer[0] === 1)))
    assert('judge 题干为中文陈述句（「X」的英文是 Y。）',
      J.every(q => /^「[^」]+」的英文是 [^。]+。$/.test(q.question)),
      JSON.stringify(J.find(q => !/^「[^」]+」的英文是 [^。]+。$/.test(q.question)) || ''))
    assert('全部题目都有 explanation', IRD.every(q => typeof q.explanation === 'string' && q.explanation.length > 0))
  }

  // ---------- ④ 干扰项语义 ----------
  console.log('\n[4] 干扰项语义（不是随机字串，取自同批其它词的真实释义/拼写）')
  {
    assert('★ single/listen 的中文干扰项全部来自本批其它词的真实释义',
      S.every(q => q.options.slice(1).every(o => CN_SET.has(o))) &&
      L.every(q => q.options.slice(1).every(o => CN_SET.has(o))))
    assert('★ voicematch 的英文干扰项全部来自本批其它词的真实拼写',
      V.every(q => q.options.slice(1).every(o => EN_SET.has(o))))
    // 干扰项优先级（enDistractors）：① 同首字母（形近音近）→ ② 同形态（词/词组）→ ③ 兜底任意。
    //   注意：**同一首字母的邻居不存在时**（Napkin/Halal/Ketchup/Utensils/7 up/Earl Grey Tea 各只有一个），
    //   ① 无货可借 → 必须验证它正确回落到 ②（同形态），而不是把优先级断言写死成「每题都有同首字母项」。
    const hasPeer = en => EN_WORDS.some(w => w !== en && w[0].toLowerCase() === en[0].toLowerCase())
    const noPeer = V.filter(q => !hasPeer(q.question))
    assert('★ voicematch 干扰项优先「同首字母」（形近音近，干扰有效）',
      V.filter(q => hasPeer(q.question)).every(q => { const f = q.question[0].toLowerCase(); return q.options.slice(1).some(o => o[0].toLowerCase() === f) }),
      JSON.stringify(V.filter(q => hasPeer(q.question) && !q.options.slice(1).some(o => o[0].toLowerCase() === q.question[0].toLowerCase())).map(q => q.question)))
    assert('★ 无同首字母邻居的词（实测 6 个）回落到「同形态」干扰项（词配词 / 词组配词组）',
      noPeer.length === 6 && noPeer.every(q => {
        const isPhrase = q.question.indexOf(' ') >= 0
        return q.options.slice(1).every(o => (o.indexOf(' ') >= 0) === isPhrase)
      }),
      JSON.stringify(noPeer.map(q => q.question + '→' + JSON.stringify(q.options.slice(1)))))
    assert('没有选项等于正确释义以外的重复项（全批）',
      IRD.every(q => new Set(q.options).size === q.options.length))
    assert('single/listen 的解析统一为「X = Y。」格式',
      S.every(q => q.explanation === q.question + ' = ' + q.options[0] + '。') &&
      L.every(q => q.explanation === q.question + ' = ' + q.options[0] + '。'))
  }

  // ---------- ⑤ 判断题真/假 ----------
  console.log('\n[5] 判断题「真/假」与张冠李戴的正确性')
  {
    const TRUE_J = J.filter(q => q.answer[0] === 0)
    const FALSE_J = J.filter(q => q.answer[0] === 1)
    assert('真 30 题 / 假 29 题（比例接近 1:1，防止「全选正确」蒙对）',
      TRUE_J.length === 30 && FALSE_J.length === 29, `真 ${TRUE_J.length} / 假 ${FALSE_J.length}`)

    const bad = []
    J.forEach(q => {
      const m = /^「(.+)」的英文是 (.+)。$/.exec(q.question)
      if (!m) { bad.push(q.id + ' 题干格式'); return }
      const cn = m[1], en = m[2]
      const s = S.find(x => grp(x) === grp(q))
      if (!s) { bad.push(q.id + ' 找不到同词 single'); return }
      if (cn !== s.options[0]) { bad.push(q.id + ' 中文释义与同词 single 不一致'); return }
      const realEn = s.question
      if (q.answer[0] === 0) {
        if (en !== realEn) bad.push(q.id + ' 真说法却用错英文')
        if (q.explanation.indexOf('说法正确') < 0) bad.push(q.id + ' 真说法解析缺「说法正确」')
      } else {
        if (en === realEn) bad.push(q.id + ' 假说法却用了本词正确英文')
        if (!EN_SET.has(en)) bad.push(q.id + ' 假说法的英文不是本批任何词的拼写')
        if (q.explanation.indexOf('不是 ' + en + '。') < 0) bad.push(q.id + ' 假说法解析未纠正「不是 X」')
      }
    })
    assert('★ 真说法用本词正确英文 / 假说法用「另一个词的真实英文」（张冠李戴，不是乱写）',
      bad.length === 0, JSON.stringify(bad.slice(0, 6)))
    assert('★ 假说法的解析必须给出正确拼写纠正（「…，不是 X。」）',
      FALSE_J.every(q => /^「.+」的英文是 .+，不是 .+。$/.test(q.explanation)),
      JSON.stringify(FALSE_J.find(q => !/^「.+」的英文是 .+，不是 .+。$/.test(q.explanation)) || ''))
    // 抽样固定几条，把「张冠李戴」形态钉成契约
    const j8711 = IRD.find(q => q.id === 8711)   // Napkin / 口布
    const j8723 = IRD.find(q => q.id === 8723)   // Ice cube / 冰块
    assert('抽样 8711：「口布」的英文是 Onion（假）',
      j8711 && j8711.question === '「口布」的英文是 Onion。' && j8711.answer[0] === 1, j8711 && j8711.question)
    assert('抽样 8723：「冰块」的英文是 Ice bucket（假，易混词）',
      j8723 && j8723.question === '「冰块」的英文是 Ice bucket。' && j8723.answer[0] === 1, j8723 && j8723.question)
    assert('抽样 8703：「筷子」的英文是 Chopsticks（真）',
      (function () { const q = IRD.find(x => x.id === 8703); return q && q.question === '「筷子」的英文是 Chopsticks。' && q.answer[0] === 0 })())
  }

  // ---------- ⑥ 难度分档 ----------
  console.log('\n[6] 难度分档')
  {
    assert('single 全 L1（英→中，最易）', S.every(q => q.difficulty === 1),
      JSON.stringify([...new Set(S.map(q => q.difficulty))]))
    assert('listen 全 L2（听音辨义，比看字难）', L.every(q => q.difficulty === 2),
      JSON.stringify([...new Set(L.map(q => q.difficulty))]))
    assert('judge：真说法 L1 / 假说法 L2（需发现错配）',
      J.every(q => q.difficulty === (q.answer[0] === 0 ? 1 : 2)),
      JSON.stringify(J.filter(q => q.difficulty !== (q.answer[0] === 0 ? 1 : 2)).map(q => q.id)))
    assert('voicematch 难度与「单词短词=2 / 长词与词组=3」规则一致',
      V.every(q => { const pure = q.question.replace(/[^A-Za-z]/g, ''); const want = (q.question.indexOf(' ') < 0 && pure.length <= 8) ? 2 : 3; return q.difficulty === want }),
      JSON.stringify(V.filter(q => { const pure = q.question.replace(/[^A-Za-z]/g, ''); const want = (q.question.indexOf(' ') < 0 && pure.length <= 8) ? 2 : 3; return q.difficulty !== want }).map(q => q.question)))
    assert('难度取值全在 1..3（不出现 L4 —— 否则会触发 v149 的归桶缩放）',
      IRD.every(q => [1, 2, 3].indexOf(q.difficulty) >= 0),
      JSON.stringify([...new Set(IRD.map(q => q.difficulty))]))
    const dist = IRD.reduce((a, q) => (a[q.difficulty] = (a[q.difficulty] || 0) + 1, a), {})
    assert('难度分布 = {1:89, 2:118, 3:29}（L1=59 single+30 真判断 / L3=29 长词与词组）',
      dist['1'] === 89 && dist['2'] === 118 && dist['3'] === 29, JSON.stringify(dist))
  }

  // ---------- ⑦ 挑战池（真跑 chBankQuestions）----------
  console.log('\n[7] 七天挑战抽题池（真跑 chBankQuestions）')
  {
    const irdSb = mkChSandbox('dining/ird')
    const poolIds = vm.runInContext('chBankQuestions().map(q => String(q.id))', irdSb)
    const poolSet = new Set(poolIds)
    assert('★ 客房送餐部挑战池题库量 ≥ CHALLENGE_MIN_BANK（190）',
      poolIds.length >= MIN_BANK, `池 ${poolIds.length} / MIN ${MIN_BANK}`)
    assert('★ 本批 236 题全部进入本部门挑战池',
      IRD.every(q => poolSet.has(String(q.id))),
      JSON.stringify(IRD.filter(q => !poolSet.has(String(q.id))).map(q => q.id).slice(0, 10)))
    assert('客房送餐部挑战池恰好 = 本批 236 题（该部门此前在该栏目 0 题）',
      poolIds.length === 236, `got ${poolIds.length}`)
    assert('池内题 id 唯一（challengePool 去重前无重复源）', poolSet.size === poolIds.length)

    // 结构缺口（v149 定式）：总量够但某难度档过少 → 序列缩水 → 点开始没反应
    assert('★ chBankDiffGap 对本部门报告「无结构性缺口」',
      vm.runInContext('chBankDiffGap()', irdSb) === '',
      JSON.stringify(vm.runInContext('chBankDiffStats()', irdSb)))
    const st = vm.runInContext('chBankDiffStats()', irdSb)
    assert('本部门分桶 {1:89, 2:118, 3:29}，三档均非空（桶2 不再恒空）',
      st[1] === 89 && st[2] === 118 && st[3] === 29, JSON.stringify(st))
    assert('题库最大难度 = 3（无 L4，归桶为恒等映射）', st.max === 3, `got ${st.max}`)

    // 跨分队隔离：同大部门其它分队不得看到本批题
    ;['dining/sig', 'dining/bar', 'rooms/fo', ''].forEach(k => {
      const sb2 = mkChSandbox(k)
      const ids2 = new Set(vm.runInContext('chBankQuestions().map(q => String(q.id))', sb2))
      const leak = IRD.filter(q => ids2.has(String(q.id))).length
      assert(`★ ${k || '(无部门/全库)'} 视角可见本批 ird 题 = ${k === '' ? 236 : 0}（不跨分队串题）`,
        leak === (k === '' ? 236 : 0), `leak=${leak}`)
    })

    // 部门切片查询（练习页口径）
    const Store = vm.runInContext('Store', irdSb)
    const q = Store.queryQuestions({ category_id: 12, dept: 'dining/ird' })
    assert('Store.queryQuestions({category_id:12, dept:dining/ird}) = 236', q.total === 236, `got ${q.total}`)
    const major = Store.queryQuestions({ category_id: 12, dept: 'dining' })
    assert('大部门 dining 视角 = 920（含本批）', major.total === 920, `got ${major.total}`)
  }

  // ---------- ⑧ 端到端：练习序列不缩水 ----------
  console.log('\n[8] 端到端：客房送餐部第一期练习序列（真跑 challengePool）')
  {
    // 源码数组字面量带尾随逗号 → 不能用 JSON.parse，改用 Function 求值（也是「抠完立刻验证可解析」的定式）
    const plan = new Function('return ' + CH_DIFF_PLAN_SRC)()
    const planTotal = plan.reduce((a, d) => a + d.reduce((x, y) => x + y, 0), 0)
    assert('第一期配比合计 = 170 题（Day1 10 → Day7 10）', planTotal === 170, `got ${planTotal}`)

    const sb = mkChSandbox('dining/ird', { withPool: true })
    const pool = vm.runInContext('challengePool()', sb)
    assert('★★ 练习序列恒为 170 题（v149 的「桶枯竭 → 序列缩水 → 点开始没反应」不再复现）',
      pool.length === 170, `got ${pool.length}`)
    const pids = pool.map(q => String(q.id))
    assert('★ 序列内题 id 唯一（无重复取题 —— 游标挂在 buckets 上，第二次调用必须接着取）',
      new Set(pids).size === pids.length, `${pids.length}/${new Set(pids).size}`)
    const irdPool = new Set(vm.runInContext('chBankQuestions().map(q => String(q.id))', mkChSandbox('dining/ird')))
    assert('★ 序列全部取自本部门题库（不跨分队串题）', pids.every(id => irdPool.has(id)),
      JSON.stringify(pids.filter(id => !irdPool.has(id)).slice(0, 5)))
    assert('序列题目都带题型（渲染/判题依赖）',
      pool.every(q => ['single', 'listen', 'voicematch', 'judge'].indexOf(q.type) >= 0))

    // 每日题量按配比（上限），且逐日题量总和不越界（Day3+ 切片依赖此前提）
    const meta = plan.map(d => d.reduce((a, b) => a + b, 0))
    assert('各天题量 = 配比设定（10/30/30/30/30/30/10）',
      JSON.stringify(meta) === JSON.stringify([10, 30, 30, 30, 30, 30, 10]), JSON.stringify(meta))

    // 第二次调用（换一个新沙箱的同一学员）仍应满 170 —— 防「游标泄漏导致第二次缩水」
    const sb2 = mkChSandbox('dining/ird', { withPool: true })
    const pool2 = vm.runInContext('challengePool()', sb2)
    assert('重复调用 challengePool() 仍满 170 题（无跨调用游标污染）', pool2.length === 170, `got ${pool2.length}`)
  }

  // ---------- ⑨ 既有契约不受影响 ----------
  console.log('\n[9] 既有契约不受影响')
  {
    const Store = vm.runInContext('Store', base)
    Store.init()
    const all = Store.getQuestions()
    const seeds = all.filter(q => Number(q.category_id) === 12)
    assert('空库下 getQuestions 可见 920 道 cat12 种子题', seeds.length === 920, `got ${seeds.length}`)
    assert('种子题带 _seed 标记（管理端据此只读）', seeds.every(q => q._seed === true))
    assert('★ 种子题未被写入 localStorage（cat>=12 走运行时拼接）',
      (JSON.parse(base.localStorage.getItem('eq_questions')) || []).length === 0,
      `got ${(JSON.parse(base.localStorage.getItem('eq_questions')) || []).length}`)
    assert('分类下拉含 id=12', Store.getCategories().some(c => Number(c.id) === 12))
    assert('管理端 _seed 只读渲染仍在', APP_SRC.includes('_seed'))
    // 本批题目不得被管理端编辑（与 v9 种子同待遇：走 _seed 只读路径）
    const seedQ = IRD[0]
    assert('updateQuestion 对种子题返回 null（只读）', Store.updateQuestion(seedQ.id, { question: 'x' }) === null)
    assert('deleteQuestion 对种子题返回 false（只读）', Store.deleteQuestion(seedQ.id) === false)
  }

  console.log(`\n${testFailed ? '❌ 存在失败断言' : '✅ 全部通过'}（${passN} 条断言）`)
  process.exit(testFailed ? 1 : 0)
})().catch(e => {
  console.error('\nFATAL ' + (e && e.stack ? e.stack : e))
  process.exit(3)
})
