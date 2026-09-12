// ====== 测试 v71：七天挑战看板统计（chy/chQ 聚合 + 挑战板块渲染） ======
// ① CloudSync._apply：chy 事件聚合 chy 数组；perq(ch=1) 聚合 chQ 错次；普通 perq 走 perQ；rename 合并
// ② renderDashChallengeBlock：参加名单/进度/正确率/Day1-Day7 测试分/错题排行；无数据显示提示
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

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

function makeSandbox() {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    window: {},
    document: { addEventListener() {}, getElementById() { return null } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm() { return true },
    addEventListener() {}, removeEventListener() {},
  }
  sb.window = sb
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
  // renderDashChallengeBlock 依赖：escHtml（提取真实实现）+ TYPE_LABELS 简版
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  vm.runInContext(extractFn(appSrc, 'escHtml'), sb)
  vm.runInContext(extractFn(appSrc, 'renderDashChallengeBlock'), sb)
  vm.runInContext('const TYPE_LABELS = new Proxy({}, { get: (_, k) => k })', sb)
  vm.runInContext('Store.init()', sb)
  return sb
}

;(async () => {
  console.log('\n🧪 v71 挑战看板统计测试')

  // ---------- ① _apply 聚合 ----------
  console.log('\n[1] CloudSync._apply：chy / chQ / perQ')
  let sb = makeSandbox()
  vm.runInContext(`
    const map = {}
    // 挑战阶段完成（练习重练 2 次 + 测试 1 次）
    CloudSync._apply(map, { u: 'bob', ty: 'chy', ts: 100, d: { day: 1, si: 0, kind: 'test', correct: 8, total: 20 } })
    CloudSync._apply(map, { u: 'bob', ty: 'chy', ts: 101, d: { day: 1, si: 1, kind: 'practice', correct: 25, total: 30 } })
    CloudSync._apply(map, { u: 'bob', ty: 'chy', ts: 102, d: { day: 1, si: 1, kind: 'practice', correct: 28, total: 30 } })
    // 挑战错题（ch 标记）与普通练习明细
    CloudSync._apply(map, { u: 'bob', ty: 'perq', ts: 103, d: { qid: 8003, correct: 0, ch: 1 } })
    CloudSync._apply(map, { u: 'bob', ty: 'perq', ts: 104, d: { qid: 8003, correct: 0, ch: 1 } })
    CloudSync._apply(map, { u: 'bob', ty: 'perq', ts: 105, d: { qid: 8006, correct: 0, ch: 1 } })
    CloudSync._apply(map, { u: 'bob', ty: 'perq', ts: 106, d: { qid: 8001, correct: 1 } })
    // 无用户事件忽略
    CloudSync._apply(map, { ty: 'chy', ts: 107, d: { day: 2, si: 0, kind: 'practice', correct: 1, total: 2 } })
    window.__map = map
  `, sb)
  assert('chy 数组保留全部 3 条完成记录', vm.runInContext('window.__map.bob.chy.length === 3', sb))
  assert('chy 记录字段完整（test 8/20）', (() => {
    const x = vm.runInContext('window.__map.bob.chy[0]', sb)
    return x.day === 1 && x.si === 0 && x.kind === 'test' && x.correct === 8 && x.total === 20 && x.at === 100
  })())
  assert('chQ[qid] 累计错次（8003×2）', vm.runInContext('window.__map.bob.chQ["8003"].total === 2 && window.__map.bob.chQ["8003"].correct === 0', sb))
  assert('普通 perq 不进 chQ（8001 走 perQ）', vm.runInContext('!window.__map.bob.chQ["8001"] && window.__map.bob.perQ["8001"].total === 1 && window.__map.bob.perQ["8001"].correct === 1', sb))
  assert('无用户事件被忽略', vm.runInContext('Object.keys(window.__map).length === 1', sb))
  {
    // rename 合并：bob → alice
    vm.runInContext(`
      CloudSync._apply(window.__map, { u: 'alice', ty: 'register', ts: 90, d: { name: 'Alice' } })
      CloudSync._apply(window.__map, { u: 'alice', ty: 'chy', ts: 95, d: { day: 2, si: 0, kind: 'practice', correct: 40, total: 50 } })
      CloudSync._apply(window.__map, { u: 'alice', ty: 'perq', ts: 96, d: { qid: 8009, correct: 0, ch: 1 } })
      CloudSync._apply(window.__map, { u: 'bob', ty: 'rename', ts: 110, n: 'Alice', d: { nu: 'alice' } })
    `, sb)
    assert('rename 后 bob 记录删除', vm.runInContext('!window.__map.bob', sb))
    assert('alice 合并 bob 的 chy（1+3=4 条）与 chQ（3 键）', (() => {
      const r = vm.runInContext('window.__map.alice', sb)
      return r.chy.length === 4 && Object.keys(r.chQ).length === 3
    })())
  }

  // ---------- ② 看板渲染 ----------
  console.log('\n[2] renderDashChallengeBlock')
  sb = makeSandbox()
  vm.runInContext('window.__els = {}', sb)
  vm.runInContext('document.getElementById = (id) => (window.__els[id] = window.__els[id] || { id, innerHTML: "" })', sb)
  {
    const rows = [
      {
        username: 'bob', name: '小王', dept: 'dining',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 16, total: 20, at: 100 },       // Day1 80 分
          { day: 1, si: 1, kind: 'practice', correct: 25, total: 30, at: 101 },
          { day: 2, si: 0, kind: 'practice', correct: 40, total: 50, at: 200 },
        ],
        chQ: { '8003': { correct: 0, total: 2 }, '8006': { correct: 0, total: 1 } },
      },
      {
        username: 'carol', name: '小李', dept: 'rooms',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 8, total: 20, at: 100 },        // Day1 40 分
          { day: 7, si: 0, kind: 'practice', correct: 30, total: 30, at: 500 },
          { day: 7, si: 1, kind: 'test', correct: 18, total: 20, at: 501 },       // Day7 90 分
        ],
        chQ: { '8003': { correct: 0, total: 1 } },
      },
    ]
    vm.runInContext(`window.__rows = ${JSON.stringify(rows)}`, sb)
    vm.runInContext('renderDashChallengeBlock(window.__rows)', sb)
    const html = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
    assert('参加人数 2', html.includes('>2<'), '')
    assert('总答题数 20+30+50+20+30+20=170', html.includes('170'))
    assert('学员 bob / carol 均在名单', html.includes('bob') && html.includes('carol'))
    assert('进度文案（chDashProgress）渲染', html.includes('/9'))
    assert('Day1 测试分 80 与 40 显示', html.includes('80') && html.includes('40'))
    assert('Day7 测试分 90 显示', html.includes('90'))
    assert('错题排行含题干 #8003（错 3 次排最前）', (() => {
      const i8003 = html.indexOf('#8003')
      const i8006 = html.indexOf('#8006')
      return i8003 >= 0 && i8006 >= 0 && i8003 < i8006
    })())
    assert('只统计挑战作答（普通 perQ 不进错题榜）', !html.includes('#8001'))
    assert('错题次数 3 显示', html.includes('>3<'))
  }
  {
    vm.runInContext('window.__els.dashChallengeBlock = { id: "dashChallengeBlock", innerHTML: "" }', sb)
    vm.runInContext('renderDashChallengeBlock([{ username: "dave", perQ: { "8001": { correct: 1, total: 1 } } }])', sb)
    const html = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
    assert('无挑战数据显示提示文案', html.includes('还没有学员参加七天挑战'))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
