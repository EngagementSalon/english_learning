// test-v182-level-report-target.js —— 「重算历史等级」必须把等级写到**学员**名下（v182）
//
// 事故（v181 上线后用户实测）：「点了 🔁 重算历史等级，账号管理里全员仍显示未评定」。
//   真因不是算错，而是**算对了但签错了名**：
//     Store.reportChallengeLevel(lv, round) 的 `u` 恒取 getSession()，第二参是**营次**；
//     dashRebuildLevels 旧调用写成 reportChallengeLevel(lv, r.username)
//       → 用户名被塞进 d.rd，99 名学员的等级事件全部挂到 admin 名下，学员 chLevel 从未写入。
//   且旧代码无条件 done++ → 提示「成功 N 人」是假数。
//
// 本套件锁三件事：
//   ① reportChallengeLevelFor(username, lv) 把 u 写成**目标学员**，不是当前会话；
//   ② 守卫：目标不存在 / 目标是 admin / lv 非法 → 一律不写（返回 false，不造幽灵账号）；
//   ③ app.js 的 dashRebuildLevels ①调新方法 ②按返回值计数 ③源码里不再出现旧错调用。
const fs = require('fs')
const path = require('path')

let pass = 0, fail = 0
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + detail : '')) }
}
const STORE = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')

// 用括号配对抽方法体（对象方法简写，extractFn 抽不到 —— v181 记录过的坑）
function extractMethod(src, name) {
  const re = new RegExp('\\n\\s*' + name + '\\s*\\(([^)]*)\\)\\s*\\{')
  const m = re.exec(src)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let d = 0, i = start
  for (; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') { d--; if (d === 0) break }
  }
  return src.slice(start, i + 1)
}
function grabFn(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) return null
  let d = 0, i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') { d--; if (d === 0) break }
  }
  return src.slice(start, i + 1)
}

// ---------- [1] 新方法存在 + 签名 ----------
console.log('\n[1] Store.reportChallengeLevelFor 存在且签名为 (username, lv)')
{
  const body = extractMethod(STORE, 'reportChallengeLevelFor')
  assert('方法存在', !!body)
  assert('签名首参是 username（不是 round）', /reportChallengeLevelFor\s*\(\s*username\s*,\s*lv\s*\)/.test(STORE),
    (STORE.match(/reportChallengeLevelFor\s*\([^)]*\)/) || [])[0])
  assert('★ 入队事件的 u 来自入参 username，不是 getSession()',
    /u:\s*uname\b/.test(body) && !/u:\s*s\.username/.test(body), body && body.slice(0, 200))
  assert('★ 源码里不再有「u: s.username」出现在新方法体内', !/getSession\(\)/.test(body))
  // 旧方法必须保持原样（学员自评路径不能动）
  const old = extractMethod(STORE, 'reportChallengeLevel')
  assert('旧方法 reportChallengeLevel 仍以会话为归属（学员自评路径不变）',
    /u:\s*s\.username/.test(old))
}

// ---------- [2] 运行期行为：沙箱真跑 ----------
console.log('\n[2] 运行期：上报归属 / 三重守卫（沙箱真跑，不靠 grep）')
{
  const vm = require('vm')
  function run(methodBody, opts) {
    const o = opts || {}
    const sb = { console, JSON, Array, Object, String, Number, Math, localStorage: null, __q: [] }
    vm.createContext(sb)
    vm.runInContext('var localStorage = { getItem: function (k) { return __LS.hasOwnProperty(k) ? __LS[k] : null } }', sb)
    sb.__LS = { eq_users: JSON.stringify(o.users || []) }
    sb.CloudSync = { enqueue: (ev) => { sb.__q.push(ev) } }
    // ★ 抽到的是「方法体」（以 { 开头），必须包成具名参数列表才能当函数求值
    const fn = vm.runInContext('(function (username, lv) ' + methodBody + ')', sb)
    const ret = fn.call({}, o.username, o.lv)
    return { ret: ret, q: JSON.parse(JSON.stringify(sb.__q)) }
  }
  const BODY = extractMethod(STORE, 'reportChallengeLevelFor')
  const users = [
    { username: 'admin', name: '管理员', role: 'admin' },
    { username: 'Avalon', name: '阎智捷', role: 'student' },
    { username: 'TKTGfour', name: '全佳衡', role: 'student' },
  ]
  const r1 = run(BODY, { users, username: 'Avalon', lv: 3 })
  assert('★ 目标学员 Avalon 上报 → u 是 Avalon（不是 admin）',
    r1.q.length === 1 && r1.q[0].u === 'Avalon', JSON.stringify(r1.q))
  assert('★ 事件带 lv=3 且 ty=chlevel', r1.q[0].ty === 'chlevel' && r1.q[0].d.lv === 3, JSON.stringify(r1.q[0]))
  assert('返回 true 表示真的写进去了', r1.ret === true)

  const r2 = run(BODY, { users, username: 'nobody', lv: 3 })
  assert('目标用户不存在 → 不写（不造幽灵账号）且返 false', r2.ret === false && r2.q.length === 0, JSON.stringify(r2))
  const r3 = run(BODY, { users, username: 'admin', lv: 3 })
  assert('目标是管理员 → 不写（admin 不参与定级）', r3.ret === false && r3.q.length === 0, JSON.stringify(r3))
  const r4 = run(BODY, { users, username: 'Avalon', lv: 1.5 })
  assert('lv 非整数 → 不写', r4.ret === false && r4.q.length === 0, JSON.stringify(r4))
  const r5 = run(BODY, { users, username: 'Avalon', lv: 5 })
  assert('lv 越界 → 不写', r5.ret === false && r5.q.length === 0, JSON.stringify(r5))
  const r6 = run(BODY, { users, username: '', lv: 2 })
  assert('username 为空 → 不写', r6.ret === false && r6.q.length === 0, JSON.stringify(r6))
  // ★ 反证：旧调用形态会「成功但归属错」—— 演示真因，防回归写成老样子
  const r7 = run(BODY, { users, username: 'TKTGfour', lv: 2 })
  assert('★ 反证：另一位学员 TKTGfour → u 是 TKTGfour（每次都是目标本人，不是会话）',
    r7.q.length === 1 && r7.q[0].u === 'TKTGfour', JSON.stringify(r7.q))
}

// ---------- [3] app.js 调用点修正 ----------
console.log('\n[3] dashRebuildLevels 调用点')
{
  const fn = grabFn(APP, 'dashRebuildLevels')
  assert('函数存在', !!fn)
  assert('★ 改调 reportChallengeLevelFor(r.username, lv)',
    /Store\.reportChallengeLevelFor\(r\.username,\s*lv\)/.test(fn))
  // ★★ 反证必须看语境：v182 的修正注释会主动引用旧调用当「事故标记」→ 只判「字符串存在」是假红。
  //   正确判据 = 「旧调用是否还作为**执行代码**出现」= 找出所有出现处，逐行判它是不是注释行。
  {
    const lines = fn.split('\n')
    const hits = lines.filter(l => /reportChallengeLevel\(lv\s*,\s*r\.username\)/.test(l))
    const codeHits = hits.filter(l => {
      const tk = l.trim()
      return !(tk.startsWith('//') || tk.startsWith('*') || tk.startsWith('/*'))
    })
    assert('★★ 旧错调用 reportChallengeLevel(lv, r.username) 已无「执行代码」形态',
      codeHits.length === 0, codeHits.join(' | '))
    assert('★ 旧错调用仅作为「事故标记」出现在注释里（有语境、可追溯）',
      hits.length >= 1 && codeHits.length === 0, hits.length + ' 处（全在注释）')
  }
  assert('★ done 按返回值计数（不再无条件 done++）',
    /if\s*\(okWrite\)\s*\{\s*done\+\+\s*\}\s*else\s*\{\s*skipped\+\+\s*\}/.test(fn.replace(/\s+/g, ' ').replace(/\{ /g, '{').replace(/ \}/g, '}'))
    || /okWrite\)\s*done\+\+/.test(fn.replace(/\s+/g, ' ')),
    (fn.match(/okWrite[^\n]*/g) || []).join(' | '))
  assert('★ 仍保留「只升不降」守卫（cloudLv >= lv → 跳过）', /cloudLv\s*>=\s*lv/.test(fn))
  // 旧的无条件 done++ 必须消失：紧邻 report 调用后不得直接 done++
  assert('★ 旧形态（try{report}catch{} 后紧跟 done++）已消失',
    !/try\s*\{\s*Store\.reportChallengeLevel\([^}]*\}\s*catch[^}]*\}\s*\n\s*done\+\+/.test(fn))
}

// ---------- [4] 学员自评路径未被误改 ----------
console.log('\n[4] 学员自评路径（challenge.js）不受影响')
{
  const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
  const calls = CH.match(/reportChallengeLevel\([^)]*\)/g) || []
  assert('challenge.js 仍用单参/双参的会话式上报（不传 username）',
    calls.every(c => !/Avalon|username/.test(c)), calls.join(' | '))
  assert('reportChallengeLevelFor 未被学员端误用', CH.indexOf('reportChallengeLevelFor') < 0)
}

console.log('\n' + (fail === 0 ? '=== ✅ PASS ' : '=== ❌ FAIL ') + pass + ' 项通过 / ' + fail + ' 项失败 ===')
process.exit(fail === 0 ? 0 : 1)
