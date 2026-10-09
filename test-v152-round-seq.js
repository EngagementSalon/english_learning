// ====== 测试 v152：营次「按部门独立编号」+ 「新建不切当前期」 ======
// 背景（用户 2026-10-09 指出）：v88~v151 的期号是**全局序号**——
//   _roundNextId 取全局最大 rN +1；_roundDefaultName 取「全数组长度 +1」。
//   两个函数都完全不看 depts，于是出现「标帜第一期(r1) / 艳中第一期(r2) / 标帜第二期(r3)」
//   这种跨部门交错、期号无意义的局面；某部门想拿「自己的第二期」得等全局排到很后面。
//   且 addChallengeRound 末尾硬写 doc.chRoundCur = newId → 「只想建期」也会把全平台当前期切走。
//
// v152 改动：
//   ① 新增 seq 字段（按**部门组**编号，显式落库）+ _roundDeptGroupKey / _roundNextSeq / _roundSeqOf
//   ② _roundDefaultName 改为按部门组编号，支持 labelOf 注入（slug → 中文）
//   ③ addChallengeRound 接受 makeCurrent（缺省 true，保持 v88 契约）；显式 false 则只建不切
//   ④ 后台新建表单新增「新建后立即设为当前营次」勾选项（id="dashRoundMakeCur"）
//
// 覆盖点：
//  [1] _roundDeptGroupKey：空 depts → '__all__'；多部门排序拼接（顺序无关）
//  [2] _roundNextSeq / _roundSeqOf：按组编号；存量无 seq 时按数组顺序现算兜底
//  [3] _roundDefaultName：部门组编号 + labelOf 中文前缀；全部部门组回落「第 N 期」
//  [4] _roundsNorm 放行 seq 字段（白名单不能吞掉它）
//  [5] addChallengeRound：seq 落库、按组连续、id 仍是全局唯一序号
//  [6] makeCurrent：false 不切 / true 切 / 缺省 true（v88 契约）
//  [7] UI 接线：勾选项存在、dashCreateRound 真的把 makeCurrent / labelOf 传下去
//  [8] i18n：dashRoundMakeCurLabel 在 zh / en 两个字典块各有一次
//  [9] 存量数据不受影响：老营次（无 seq）不被动过、期号现算正确
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}
const CLOUD = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

// ---------- 云端沙箱（与 test-v88 同构，整载 cloud-store.js） ----------
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

// 三个部门交错的存量营次（复现用户的真实困境：sig 有 1、3 两期，yan 是 2）
const LEGACY_ROUNDS = [
  { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: false, examOpen: true, startAt: 0, endAt: 0, at: 1 },
  { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: true, examOpen: false, startAt: 0, endAt: 0, at: 2 },
  { id: 'r3', name: '标帜餐厅七天挑战第二期', depts: ['dining/sig'], open: false, examOpen: false, startAt: 0, endAt: 0, at: 3 },
]
const LABELS = { 'dining/sig': '标帜餐厅', 'dining/yan': '艳中餐厅', 'dining/bar': '酒吧团队', 'dining/ird': '客房送餐部' }
const LABEL_FN = `(k) => (${JSON.stringify(LABELS)}[k] || k)`

;(async () => {
  console.log('\n🧪 v152 营次「按部门独立编号」测试')

  // ================= ① 部门组键 =================
  console.log('\n[1] _roundDeptGroupKey：分组口径')
  {
    const sb = makeCloudSandbox({ users: {}, events: [] })
    const k = (d) => call(sb, `_roundDeptGroupKey({ depts: ${JSON.stringify(d)} })`)
    assert('空 depts → "__all__"（全部部门自成一列）', k([]) === '__all__', k([]))
    assert('缺 depts 字段 → "__all__"', call(sb, '_roundDeptGroupKey({})') === '__all__', call(sb, '_roundDeptGroupKey({})'))
    assert('单部门 → slug 原文', k(['dining/ird']) === 'dining/ird', k(['dining/ird']))
    assert('★ 多部门排序拼接（与书写顺序无关）',
      k(['dining/ird', 'dining/bar']) === k(['dining/bar', 'dining/ird']) && k(['dining/bar', 'dining/ird']) === 'dining/bar+dining/ird',
      k(['dining/bar', 'dining/ird']))
    assert('过滤非字符串/空值', k(['dining/bar', '', null, 3]) === 'dining/bar', k(['dining/bar', '', null, 3]))
  }

  // ================= ② 期号计算 =================
  console.log('\n[2] _roundNextSeq / _roundSeqOf：按部门组编号')
  {
    const sb = makeCloudSandbox({ users: {}, events: [] })
    const R = JSON.stringify(LEGACY_ROUNDS)
    // 存量数据无 seq → 现算兜底
    assert('★ 存量无 seq：r3 在 sig 组内是第 2 期（不是全局第 3 期）',
      call(sb, `_roundSeqOf(${R}, 'r3')`) === 2, call(sb, `_roundSeqOf(${R}, 'r3')`))
    assert('存量无 seq：r1 在 sig 组内是第 1 期', call(sb, `_roundSeqOf(${R}, 'r1')`) === 1)
    assert('存量无 seq：r2 在 yan 组内是第 1 期', call(sb, `_roundSeqOf(${R}, 'r2')`) === 1)
    assert('未知 id → 0', call(sb, `_roundSeqOf(${R}, 'rX')`) === 0)
    // _roundNextSeq：sig 组已有 2 期 → 下一个是 3
    assert('★ _roundNextSeq(sig) = 3（组内已有 2 期）',
      call(sb, `_roundNextSeq(_roundsNorm({ chRounds: ${R} }), ['dining/sig'])`) === 3,
      call(sb, `_roundNextSeq(_roundsNorm({ chRounds: ${R} }), ['dining/sig'])`))
    assert('★ _roundNextSeq(ird) = 1（该组还没有任何期）',
      call(sb, `_roundNextSeq(_roundsNorm({ chRounds: ${R} }), ['dining/ird'])`) === 1,
      call(sb, `_roundNextSeq(_roundsNorm({ chRounds: ${R} }), ['dining/ird'])`))
    assert('_roundNextSeq(全部部门组) 独立计数',
      call(sb, `_roundNextSeq(_roundsNorm({ chRounds: ${R} }), [])`) === 1)
    // 显式 seq 优先于现算
    const withSeq = JSON.stringify([
      { id: 'r1', depts: ['dining/sig'], seq: 7 },
      { id: 'r2', depts: ['dining/sig'] },
    ])
    assert('★ 显式 seq 优先（=7，不因数组里有别的同组项而重算）',
      call(sb, `_roundSeqOf(${withSeq}, 'r1')`) === 7, call(sb, `_roundSeqOf(${withSeq}, 'r1')`))
    assert('同组无 seq 的项继续按顺序现算', call(sb, `_roundSeqOf(${withSeq}, 'r2')`) === 2)
  }

  // ================= ③ 默认名 =================
  console.log('\n[3] _roundDefaultName：按部门组编号 + 中文前缀')
  {
    const sb = makeCloudSandbox({ users: {}, events: [] })
    const R = JSON.stringify([
      { id: 'r1', depts: ['dining/sig'], seq: 1 },
      { id: 'r2', depts: ['dining/yan'], seq: 1 },
      { id: 'r3', depts: ['dining/sig'], seq: 2 },
    ])
    const nm = (d) => call(sb, `_roundDefaultName(${R}, ${JSON.stringify(d)}, ${LABEL_FN})`)
    assert('★ ird 第一期 →「客房送餐部七天挑战第1期」', nm(['dining/ird']) === '客房送餐部七天挑战第1期', nm(['dining/ird']))
    assert('★ sig 已有 2 期 → 新期是「标帜餐厅七天挑战第3期」', nm(['dining/sig']) === '标帜餐厅七天挑战第3期', nm(['dining/sig']))
    assert('yan 已有 1 期 → 新期是「艳中餐厅七天挑战第2期」', nm(['dining/yan']) === '艳中餐厅七天挑战第2期', nm(['dining/yan']))
    assert('多部门 → 中文名并列', nm(['dining/bar', 'dining/ird']) === '酒吧团队、客房送餐部七天挑战第1期', nm(['dining/bar', 'dining/ird']))
    assert('全部部门组 → 回落「第 N 期」', call(sb, `_roundDefaultName(${R}, [], ${LABEL_FN})`) === '第 1 期', call(sb, `_roundDefaultName(${R}, [], ${LABEL_FN})`))
    assert('labelOf 缺省时不报错（回落 slug 原文）',
      call(sb, `_roundDefaultName(${R}, ['dining/ird'])`) === 'dining/ird七天挑战第1期', call(sb, `_roundDefaultName(${R}, ['dining/ird'])`))
  }

  // ================= ④ seq 进 _roundsNorm 白名单 =================
  console.log('\n[4] _roundsNorm 放行 seq')
  {
    const sb = makeCloudSandbox({ users: {}, events: [] })
    const out = JSON.parse(call(sb, `JSON.stringify(_roundsNorm({ chRounds: [{ id: 'r9', depts: ['dining/ird'], seq: 5, name: 'x' }] }))`))
    assert('★ seq 未被白名单吞掉', out[0].seq === 5, JSON.stringify(out[0]))
    const out2 = JSON.parse(call(sb, `JSON.stringify(_roundsNorm({ chRounds: [{ id: 'r9', depts: ['dining/ird'], name: 'x' }] }))`))
    // v152：存量期（从未有 seq）**必须保持「无 seq 字段」**，不能补成 0 ——
    //   _roundSeqOf 正是靠「字段缺失」识别存量、改走同组数组顺序现算的。
    //   旧契约（归一为 seq:0）已作废：它会让所有存量期现算兜底失效、新期期号全塌成「第 1 期」。
    assert('★ 缺 seq 的存量期 → 保留无 seq 字段（不补 0）', !('seq' in out2[0]), JSON.stringify(out2[0]))
    assert('★ 且读 seq 时表现为 0（可选链 0 兜底可用）', !Number(out2[0].seq), JSON.stringify(out2[0].seq))
    const out3 = JSON.parse(call(sb, `JSON.stringify(_roundsNorm({ chRounds: [{ id: 'r9', seq: '3', name: 'x' }] }))`))
    assert('seq 字符串数字 → 归一为数值', out3[0].seq === 3, JSON.stringify(out3[0]))
  }

  // ================= ⑤ addChallengeRound：seq 落库 =================
  console.log('\n[5] addChallengeRound：seq 落库、按组连续、id 仍全局唯一')
  {
    const docRef = { users: {}, events: [], chOpen: false, chExamOpen: false, chRoundCur: 'r2', chRounds: JSON.parse(JSON.stringify(LEGACY_ROUNDS)) }
    const sb = makeCloudSandbox(docRef)

    const r4 = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.addChallengeRound({ name: '', depts: ['dining/ird'], open: true, makeCurrent: false, labelOf: ${LABEL_FN} })))()`))
    assert('★ id 仍走全局序号 = r4（id 是数据键，语义不变）', r4.ok === true && r4.id === 'r4', JSON.stringify(r4))
    const rec4 = docRef.chRounds.find(r => r.id === 'r4')
    assert('★ ird 第一期 seq = 1（不受全局序号 4 影响）', rec4 && rec4.seq === 1, JSON.stringify(rec4))
    assert('★ 默认名按部门组 =「客房送餐部七天挑战第1期」', rec4 && rec4.name === '客房送餐部七天挑战第1期', rec4 && rec4.name)
    assert('depts 正确写入', rec4 && JSON.stringify(rec4.depts) === JSON.stringify(['dining/ird']), JSON.stringify(rec4 && rec4.depts))

    // 同组第二期 → seq 连续
    const r5 = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.addChallengeRound({ name: '', depts: ['dining/ird'], makeCurrent: false, labelOf: ${LABEL_FN} })))()`))
    const rec5 = docRef.chRounds.find(r => r.id === r5.id)
    assert('★ ird 第二期 seq = 2（同组连续）', rec5 && rec5.seq === 2, JSON.stringify(rec5))
    assert('★ ird 第二期名 =「客房送餐部七天挑战第2期」', rec5 && rec5.name === '客房送餐部七天挑战第2期', rec5 && rec5.name)

    // sig 组（存量已有 2 期，且都没 seq）→ 第三期
    const r6 = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.addChallengeRound({ name: '', depts: ['dining/sig'], makeCurrent: false, labelOf: ${LABEL_FN} })))()`))
    const rec6 = docRef.chRounds.find(r => r.id === r6.id)
    assert('★ sig 新增期 seq = 3（存量 2 期按顺序现算 + 1）', rec6 && rec6.seq === 3, JSON.stringify(rec6))

    // 自定义名优先于默认名
    const r7 = JSON.parse(await call(sb, `(async () => JSON.stringify(await CloudSync.addChallengeRound({ name: '我自己起的名字', depts: ['dining/ird'], makeCurrent: false })))()`))
    const rec7 = docRef.chRounds.find(r => r.id === r7.id)
    assert('自定义名优先（不被默认名覆盖）', rec7 && rec7.name === '我自己起的名字', rec7 && rec7.name)
    assert('自定义名下 seq 仍照常编号 = 3', rec7 && rec7.seq === 3, JSON.stringify(rec7))
  }

  // ================= ⑥ makeCurrent =================
  console.log('\n[6] makeCurrent：新建是否顺手切当前期')
  {
    const mk = () => ({ users: {}, events: [], chOpen: false, chExamOpen: false, chRoundCur: 'r2', chRounds: JSON.parse(JSON.stringify(LEGACY_ROUNDS)) })

    const d1 = mk(); const sb1 = makeCloudSandbox(d1)
    await call(sb1, `(async () => { await CloudSync.addChallengeRound({ name: 'A', depts: ['dining/ird'], makeCurrent: false }) })()`)
    assert('★ makeCurrent:false → 当前营次保持 r2 不动', d1.chRoundCur === 'r2', d1.chRoundCur)

    const d2 = mk(); const sb2 = makeCloudSandbox(d2)
    await call(sb2, `(async () => { await CloudSync.addChallengeRound({ name: 'B', depts: ['dining/ird'], makeCurrent: true }) })()`)
    assert('makeCurrent:true → 当前营次切到新期 r4', d2.chRoundCur === 'r4', d2.chRoundCur)

    const d3 = mk(); const sb3 = makeCloudSandbox(d3)
    await call(sb3, `(async () => { await CloudSync.addChallengeRound({ name: 'C', depts: ['dining/ird'] }) })()`)
    assert('★ makeCurrent 缺省仍是 true（保持 v88 契约，老调用方零改动）', d3.chRoundCur === 'r4', d3.chRoundCur)
  }

  // ================= ⑦ 存量数据不被污染 =================
  console.log('\n[7] 存量营次不被动过')
  {
    const docRef = { users: {}, events: [], chOpen: false, chExamOpen: false, chRoundCur: 'r2', chRounds: JSON.parse(JSON.stringify(LEGACY_ROUNDS)) }
    const sb = makeCloudSandbox(docRef)
    await call(sb, `(async () => { await CloudSync.addChallengeRound({ name: '', depts: ['dining/ird'], makeCurrent: false }) })()`)
    const r1 = docRef.chRounds.find(r => r.id === 'r1')
    const r2 = docRef.chRounds.find(r => r.id === 'r2')
    const r3 = docRef.chRounds.find(r => r.id === 'r3')
    assert('★ 存量 r1 名称/部门/open 未被改写', r1.name === '标帜餐厅七天挑战第一期' && r1.depts[0] === 'dining/sig' && r1.open === false, JSON.stringify(r1))
    assert('★ 存量 r1/r2/r3 未被补写 seq（读取侧现算，不写回脏数据）', !('seq' in r1) && !('seq' in r2) && !('seq' in r3),
      JSON.stringify([r1.seq, r2.seq, r3.seq]))
    assert('存量期数不变（4 期：3 存量 + 1 新增）', docRef.chRounds.length === 4, docRef.chRounds.length)
  }

  // ================= ⑧ UI 接线 =================
  console.log('\n[8] 后台 UI 接线')
  {
    assert('★ 新建表单含「设为当前营次」勾选项', /id="dashRoundMakeCur"/.test(APP))
    assert('★ 勾选项默认 checked（保持原有「新建即切」的默认行为）', /id="dashRoundMakeCur"\s+checked/.test(APP))
    assert('★ dashCreateRound 读取勾选框状态', /getElementById\('dashRoundMakeCur'\)/.test(APP))
    assert('★ dashCreateRound 把 makeCurrent 传给云端', /makeCurrent[,:\s]/.test(APP) && /addChallengeRound\(\{[\s\S]{0,200}?makeCurrent[\s\S]{0,200}?\}\)/.test(APP))
    assert('★ dashCreateRound 把 labelOf 传给云端（默认名带中文部门名）', /labelOf:/.test(APP) && /addChallengeRound\(\{[\s\S]{0,260}?labelOf:/.test(APP))
    assert('labelOf 用的是全局 adminTabLabel（不是局部 deptLabelOf）', /labelOf:[\s\S]{0,80}adminTabLabel/.test(APP))
    assert('★ 成功提示的默认名兜底改为按部门组口径（dashRoundDefaultNameHint）', /function dashRoundDefaultNameHint/.test(APP))
    assert('旧的「按数组长度 +1」提示已移除', !/t\('dashRoundCreated', name \|\| \('第 ' \+ \(\(dashRoundList\(\)\.length\) \+ 1\) \+ ' 期'\)\)/.test(APP))
    // v152：期号徽章 —— 让「按部门独立编号」在后台真正可见
    assert('★ 营次表名称列渲染期号徽章', /dashRoundSeqTitle/.test(APP))
    assert('★ 徽章期号取自 CloudSync.roundSeqOf（与写入口径同源）', /CloudSync\.roundSeqOf\(r\.id\)/.test(APP))
    assert('★ 徽章只在期号 > 0 时渲染', /const seqTag = dseq > 0/.test(APP))
  }

  // ================= ⑨ i18n =================
  console.log('\n[9] i18n 双语文案成对')
  {
    const zhBlock = I18N.slice(0, I18N.indexOf('  en:', I18N.indexOf('I18N') >= 0 ? I18N.indexOf('I18N') : 0))
    const cnt = (s, re) => (s.match(re) || []).length
    assert('★ dashRoundMakeCurLabel 出现恰 2 次（zh + en 各一）', cnt(I18N, /dashRoundMakeCurLabel:/g) === 2, cnt(I18N, /dashRoundMakeCurLabel:/g))
    const zhPart = I18N.slice(0, I18N.indexOf('dashRoundMakeCurLabel'))
    const idx1 = I18N.indexOf('dashRoundMakeCurLabel')
    const idx2 = I18N.indexOf('dashRoundMakeCurLabel', idx1 + 1)
    // zh 块在前：先出现的应是中文文案
    assert('第一个（zh）是中文文案', /新建后立即设为当前营次/.test(I18N.slice(idx1, idx1 + 120)), I18N.slice(idx1, idx1 + 120))
    assert('第二个（en）是英文文案', /Make this the current round/.test(I18N.slice(idx2, idx2 + 160)), I18N.slice(idx2, idx2 + 160))
    // v152 新增：期号徽章 tooltip 也必须成对
    const s1 = I18N.indexOf('dashRoundSeqTitle')
    const s2 = I18N.indexOf('dashRoundSeqTitle', s1 + 1)
    assert('★ dashRoundSeqTitle 出现恰 2 次（zh + en 各一）', cnt(I18N, /dashRoundSeqTitle:/g) === 2, cnt(I18N, /dashRoundSeqTitle:/g))
    assert('dashRoundSeqTitle 第一条是中文', /各部门独立编号/.test(I18N.slice(s1, s1 + 160)), I18N.slice(s1, s1 + 160))
    assert('dashRoundSeqTitle 第二条是英文', /each department numbers independently/i.test(I18N.slice(s2, s2 + 200)), I18N.slice(s2, s2 + 200))
    void zhBlock; void zhPart
  }

  // ================= ⑩ CloudSync 公开期号接口（后台提示与写入口径必须同源） =================
  console.log('\n[10] CloudSync 公开期号接口 + 后台提示同源')
  {
    const sb = makeCloudSandbox({ users: {}, events: [] })
    // 造一份「存量期无 seq + 新期有 seq」的混合列表，验证公开接口能正确合并两种口径
    const MIX = `[{id:'r1',depts:['dining/sig'],name:'a'},{id:'r2',depts:['dining/yan'],name:'b'},{id:'r3',depts:['dining/sig'],name:'c'},{id:'r4',depts:['dining/sig'],seq:3,name:'d'}]`
    const seqSig = call(sb, `CloudSync.roundSeqOf('r3', ${MIX})`)
    assert('★ roundSeqOf 对存量期现算 = 2', seqSig === 2, seqSig)
    const seqNew = call(sb, `CloudSync.roundSeqOf('r4', ${MIX})`)
    assert('★ roundSeqOf 对新期用显式 seq = 3', seqNew === 3, seqNew)
    const nxtSig = call(sb, `CloudSync.roundNextSeq(['dining/sig'], ${MIX})`)
    assert('★ roundNextSeq 合并两种口径 → sig 下一期 = 4', nxtSig === 4, nxtSig)
    const nxtIrd = call(sb, `CloudSync.roundNextSeq(['dining/ird'], ${MIX})`)
    assert('★ roundNextSeq 跨组互不干扰 → ird 下一期 = 1', nxtIrd === 1, nxtIrd)
    const nm = call(sb, `CloudSync.roundDefaultName(['dining/ird'], () => '客房送餐部', ${MIX})`)
    assert('★ roundDefaultName 经公开接口得「客房送餐部七天挑战第1期」', nm === '客房送餐部七天挑战第1期', nm)
    // 后台提示必须直接复用云端函数（不能自己按 Number(r.seq)||0 累加，否则漏算存量期）
    assert('★ dashRoundDefaultNameHint 复用 CloudSync.roundDefaultName', /CloudSync\.roundDefaultName\(/.test(APP), '')
    assert('dashRoundDefaultNameHint 不再自行按 r.seq 取最大值（漏算存量期的老写法已移除）',
      !/same\.reduce\(\(m, r\) => Math\.max\(m, Number\(r\.seq\) \|\| 0\), 0\)/.test(APP), '')
    assert('提示回落时用 roundNextSeq（而非数组长度）', /CloudSync\.roundNextSeq\(depts\)/.test(APP), '')
  }

  console.log('\n' + (testFailed ? '❌ 有断言失败' : '✅ 全部通过（' + 'v152）'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.log('ERR', e.message, '\n', e.stack); process.exit(1) })
