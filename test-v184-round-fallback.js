// ====== 测试 v184：看板成绩/打卡的「营次回落」 ======
// 现场（2026-10-19）：学员考完 Day1/Day7 水平测试，看板「前测/后测」仍是 —，打卡全是 —。
//
// 真因：同一部门建了两期营次（r2 第一期 / r6 第二期），而学员挑战进度权威在本机 localStorage，
//       云端 chy 只聚合不回放 → 没换设备的人第二期交卷时沿用第一期存档键，
//       记录全挂在 r2 名下，r6 一条都没有（云端实测：r6 参与 0 人）。
//
// 本套件锁死三件事：
// ① 本营次有记录 → 用它（绝不因为别处有新记录就换源）
// ② 本营次没记录 → 回落到同部门「最近有记录」的营次（成绩与打卡都回落到同一份数据）
// ③ 绝不跨部门借成绩（艳中餐厅的视图取不到标帜餐厅学员的记录）
const fs = require('fs')
const vm = require('vm')
const APP = fs.readFileSync(__dirname + '/app.js', 'utf8')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}

// 抽 dashRoundSlug（营次归一，v88 既有函数）
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
function extractBlock(src, fromMark, toMark) {
  const i = src.indexOf(fromMark)
  if (i < 0) throw new Error('block start not found: ' + fromMark)
  const j = src.indexOf(toMark, i)
  if (j < 0) throw new Error('block end not found: ' + toMark)
  return src.slice(i, j)
}

const dashRoundSlug = new Function('return (' + extractFn(APP, 'dashRoundSlug') + ')')()
const V184 = extractBlock(APP, 'const chyOfSlug =', '// v89 部门筛选')

// 营次表（与线上同形）
const ROUNDS = [
  { id: 'r1', depts: ['dining/sig'] }, { id: 'r2', depts: ['dining/yan'] },
  { id: 'r3', depts: ['dining/sig'] }, { id: 'r4', depts: ['dining/ird'] },
  { id: 'r5', depts: ['dining/bar'] }, { id: 'r6', depts: ['dining/yan'] },
  { id: 'r7', depts: ['dining/ird'] },
]
// 学员部门 → { key: 分部门 slug, majorKey: 大部门 }
const DEPT2SLUG = {
  '饮食部·艳中餐厅': 'dining/yan', '饮食部·标帜餐厅': 'dining/sig',
  '饮食部·客房送餐部': 'dining/ird', '饮食部·酒吧团队': 'dining/bar',
}
const normDept = v => {
  const k = DEPT2SLUG[String(v || '').trim()]
  return k ? { key: k, majorKey: k.split('/')[0] } : null
}

// 在沙箱里跑 v184 代码块，返回 { chyOf, chyAnyOf }
function buildView(want) {
  const box = {
    want,
    dashRoundSlug,
    dashRoundList: () => ROUNDS,
    dashRoundListSafe: () => ROUNDS,
    normDept,
    rdList: ROUNDS,
    Array, Number, String, Object,
  }
  const fn = vm.runInNewContext(
    `(function(){
      const wantSlug = dashRoundSlug(want)
      const recSlug = x => dashRoundSlug((x && x.rd) || '')
      ${V184}
      return { chyOf, chyAnyOf }
    })()`,
    box
  )
  return fn
}
const score = x => (x && x.total ? Math.round(x.correct / x.total * 100) : null)
const t1of = chy => chy.find(x => x.kind === 'test' && x.day === 1 && !x.cleared)
const t7of = chy => chy.find(x => x.kind === 'test' && x.day === 7 && !x.cleared)

console.log('[1] 营次回落：本营次为空 → 取同部门最近营次的记录')
{
  // yang：记录全在 r2（第一期），r6（第二期）一条没有 —— 现场原样
  const yang = {
    dept: '饮食部·艳中餐厅',
    chy: [
      { at: 100, day: 1, si: 0, kind: 'test', correct: 9, total: 10, rd: 'r2' },
      { at: 200, day: 7, si: 1, kind: 'test', correct: 20, total: 20, rd: 'r2' },
      { at: 150, day: 2, si: 0, kind: 'practice', correct: 30, total: 32, rd: 'r2' },
    ],
  }
  const v6 = buildView('r6')
  assert('修复前形态：r6 视图下 chyOf 为空', v6.chyOf(yang).length === 0)
  const got = v6.chyAnyOf(yang)
  assert('修复后：r6 视图回落拿到 r2 的 3 条记录', got.length === 3, String(got.length))
  assert('回落后的前测 = 90', score(t1of(got)) === 90, String(score(t1of(got))))
  assert('回落后的后测 = 100', score(t7of(got)) === 100, String(score(t7of(got))))

  const v2 = buildView('r2')
  assert('r2 视图本身仍只取 r2（不因回落逻辑改动）', v2.chyAnyOf(yang).length === 3)
}

console.log('\n[2] 本营次有记录 → 优先本营次，绝不换源')
{
  const u = {
    dept: '饮食部·艳中餐厅',
    chy: [
      { at: 100, day: 1, si: 0, kind: 'test', correct: 5, total: 10, rd: 'r2' },  // 旧期
      { at: 900, day: 1, si: 0, kind: 'test', correct: 10, total: 10, rd: 'r6' }, // 新期（更晚）
    ],
  }
  const v6 = buildView('r6')
  const got = v6.chyAnyOf(u)
  assert('r6 有自己的记录时只用 r6', got.length === 1 && got[0].rd === 'r6')
  assert('前测取新期的 100（不是旧期的 50）', score(t1of(got)) === 100)

  const v2 = buildView('r2')
  assert('切到 r2 仍能取到 r2 自己的那条', v2.chyAnyOf(u).length === 1)
}

console.log('\n[3] 绝不跨部门借成绩')
{
  // 标帜餐厅学员的记录，在「艳中餐厅 r6」视图下必须取不到
  const sig = {
    dept: '饮食部·标帜餐厅',
    chy: [{ at: 100, day: 1, si: 0, kind: 'test', correct: 8, total: 10, rd: 'r3' }],
  }
  const v6 = buildView('r6')
  assert('艳中视图取不到标帜学员的记录', v6.chyAnyOf(sig).length === 0, String(v6.chyAnyOf(sig).length))

  // 反过来：艳中学员在标帜视图下也取不到
  const yan = {
    dept: '饮食部·艳中餐厅',
    chy: [{ at: 100, day: 1, si: 0, kind: 'test', correct: 9, total: 10, rd: 'r2' }],
  }
  const v3 = buildView('r3')
  assert('标帜视图取不到艳中学员的记录', v3.chyAnyOf(yan).length === 0)
}

console.log('\n[4] 多期按「最近时间」回落，不是按 id 大小')
{
  const u = {
    dept: '饮食部·艳中餐厅',
    chy: [
      { at: 100, day: 1, si: 0, kind: 'test', correct: 6, total: 10, rd: 'r2' },  // 早
      { at: 500, day: 1, si: 0, kind: 'test', correct: 9, total: 10, rd: 'rX' }, // 晚（假设第三期）
    ],
  }
  // 把 rX 加入营次表，确认回落取 at 更大的那条
  ROUNDS.push({ id: 'rX', depts: ['dining/yan'] })
  const v92 = buildView('r92')  // 一个谁都没记录的新营次
  const got = v92.chyAnyOf(u)
  assert('回落到时间更晚的 rX（前测 90，不是 r2 的 60）', score(t1of(got)) === 90, JSON.stringify(t1of(got)))
  ROUNDS.pop()
}

console.log('\n[5] 源码契约：参与名单与成绩取数同源')
{
  assert('parts 过滤用 chyAnyOf（否则缺席行会整行消失）',
    /const parts = \(rows \|\| \[\]\)\.filter\(r => r && chyAnyOf\(r\)\.length/.test(APP))
  assert('成绩取数用 chyAnyOf',
    /const chy = chyAnyOf\(r\)/.test(APP))
  assert('回落仅在本营次为空时触发（own.length 早退）',
    /const own = chyOf\(r\)[\s\S]{0,80}if \(own\.length\) return own/.test(APP))
  assert('回落候选必须过同部门校验',
    /_roundInSameDept\(r, slug\)/.test(APP))
  assert('营次 depts 为空时视为全部门适用（不误锁）',
    /if \(!wantDepts\.length\) return true/.test(APP))
}

if (testFailed) {
  console.log('\n❌ v184 营次回落测试有断言失败')
  process.exit(1)
}
console.log('\n✅ v184 营次回落（成绩/打卡同源）测试全部通过')
