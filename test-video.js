// ====== 测试视频课任务：CourseStore 视频发布 + 完成确认 ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) console.log('  ✓', name)
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

// 加载 CourseStore（含 fetch mock）
function makeSandbox({ doc }) {
  const sb = {
    console,
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    setTimeout() { return 0 }, clearTimeout() {},
    AbortController,
    fetch() { return Promise.reject(new Error('no-fetch')) },  // 默认离线
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'course-store.js'), 'utf-8'), sb)
  return sb
}

// 用一个内存 doc + 可写 mock 的 fetch
function withDoc(initialDoc) {
  let doc = JSON.parse(JSON.stringify(initialDoc))
  const fetchMock = (url, opts) => {
    const method = (opts && opts.method) || 'GET'
    if (method === 'GET') {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(doc)), status: 200 })
    } else {
      doc = JSON.parse(opts.body)
      return Promise.resolve({ ok: true, text: () => Promise.resolve('ok'), status: 200 })
    }
  }
  return { getDoc: () => doc, fetchMock }
}

const baseDoc = { v: 1, classes: [ { id: 'c1', name: '房务一班', note: '', createdBy: 'admin', members: ['张三','李四'], assignments: [] } ] }

;(async () => {
  console.log('\n🧪 测试 1：视频作业发布（无题目，存 videoUrl）')
  {
    const { getDoc, fetchMock } = withDoc(baseDoc)
    const sb = makeSandbox({ doc: getDoc() })
    sb.fetch = fetchMock
    const CS = vm.runInContext('CourseStore', sb)
    // 模拟 coursePublishAssign 的视频分支
    const aid = CS.newId('a')
    const ok = await CS.mutate(doc => {
      const c = CS.findClass(doc, 'c1')
      c.assignments = c.assignments || []
      c.assignments.push({ id: aid, type: 'video', title: '消防演练视频', desc: '必看', deadline: 0, videoUrl: 'https://cdn.example.com/fire.mp4', createdAt: Date.now(), results: {} })
    })
    assert('mutate 成功', ok === true)
    const a = CS.findAssign(CS.findClass(getDoc(), 'c1'), aid)
    assert('type=video', a && a.type === 'video')
    assert('videoUrl 保存正确', a && a.videoUrl === 'https://cdn.example.com/fire.mp4')
    assert('无 questions 字段', a && !a.questions)
  }

  console.log('\n🧪 测试 2：视频完成确认写入 results')
  {
    const doc = JSON.parse(JSON.stringify(baseDoc))
    doc.classes[0].assignments = [ { id: 'a1', type: 'video', title: 'v', desc: '', deadline: 0, videoUrl: 'https://x.mp4', createdAt: Date.now(), results: {} } ]
    const { getDoc, fetchMock } = withDoc(doc)
    const sb = makeSandbox({ doc: getDoc() })
    sb.fetch = fetchMock
    const CS = vm.runInContext('CourseStore', sb)
    // 模拟 courseVideoConfirm 的 mutate
    const ok = await CS.mutate(d => {
      const c = CS.findClass(d, 'c1')
      const a = CS.findAssign(c, 'a1')
      a.results = a.results || {}
      a.results['张三'] = { at: Date.now(), watched: true, watchedPct: 100, watchedSec: 300, duration: 300, difficulty: 3, attempts: 1 }
    })
    assert('确认写入成功', ok === true)
    const r = CS.findAssign(CS.findClass(getDoc(), 'c1'), 'a1').results['张三']
    assert('watched=true', r && r.watched === true)
    assert('watchedPct=100', r && r.watchedPct === 100)
    assert('watchedSec=300', r && r.watchedSec === 300)
    assert('难度=3 已写入', r && r.difficulty === 3)
    assert('不写入看懂程度', r && !('comprehension' in r))
  }

  console.log('\n🧪 测试 2.1：难度汇总统计（1-5 分布 + 均分）')
  {
    const doc = JSON.parse(JSON.stringify(baseDoc))
    doc.classes[0].assignments = [ { id: 'a1', type: 'video', title: 'v', desc: '', deadline: 0, videoUrl: 'https://x.mp4', createdAt: Date.now(), results: {
      '张三': { at: 1, watched: true, difficulty: 3 },
      '李四': { at: 2, watched: true, difficulty: 2 },
      '王五': { at: 3, watched: true, difficulty: 4 },
    } } ]
    const { getDoc } = withDoc(doc)
    const sb = makeSandbox({ doc: getDoc() })
    const CS = vm.runInContext('CourseStore', sb)
    const a = CS.findAssign(CS.findClass(getDoc(), 'c1'), 'a1')
    // 汇总逻辑（与 course-app.js 一致）
    let diffSum = 0, diffCount = 0
    const diffDist = [0,0,0,0,0]
    Object.values(a.results).forEach(r => {
      if (r.difficulty) { diffSum += r.difficulty; diffCount++; diffDist[Math.min(4,Math.max(0,r.difficulty-1))]++ }
    })
    const diffAvg = Math.round(diffSum/diffCount*10)/10
    assert('难度均分=(3+2+4)/3=3', diffAvg === 3)
    assert('难度分布正确', JSON.stringify(diffDist) === JSON.stringify([0,1,1,1,0]))
  }

  console.log('\n🧪 测试 2.2：修改已发布视频作业的播放地址')
  {
    const doc = JSON.parse(JSON.stringify(baseDoc))
    doc.classes[0].assignments = [ { id: 'a1', type: 'video', title: 'v', desc: '', deadline: 0, videoUrl: 'https://old.mp4', createdAt: Date.now(), results: { '张三': { at: 111, watched: true, watchedPct: 100, watchedSec: 300, duration: 300, difficulty: 3, attempts: 1 } } } ]
    const { getDoc, fetchMock } = withDoc(doc)
    const sb = makeSandbox({ doc: getDoc() })
    sb.fetch = fetchMock
    const CS = vm.runInContext('CourseStore', sb)
    // 模拟 courseSaveVideoUrl 的 mutate（视频作业 → 更新 videoUrl）
    const ok = await CS.mutate(d => {
      const a = CS.findAssign(CS.findClass(d, 'c1'), 'a1')
      if (!a || a.type !== 'video') return false
      a.videoUrl = 'https://new.mp4'
    })
    assert('改地址 mutate 成功', ok === true)
    const a = CS.findAssign(CS.findClass(getDoc(), 'c1'), 'a1')
    assert('videoUrl 已更新为新地址', a && a.videoUrl === 'https://new.mp4')
    assert('学员已完成记录不受影响', a && a.results['张三'] && a.results['张三'].watched === true)
    // 非视频作业改地址应被拒绝（fn 返回 false → mutate 放弃）
    getDoc().classes[0].assignments[0].type = 'homework'
    let fnResult = true
    const ret2 = await CS.mutate(d => {
      const a = CS.findAssign(CS.findClass(d, 'c1'), 'a1')
      if (!a || a.type !== 'video') { fnResult = false; return false }
      a.videoUrl = 'https://hack.mp4'
    })
    assert('非视频作业改地址被拒绝', fnResult === false && ret2 === null)
    assert('homework 的 videoUrl 未被改动', CS.findAssign(CS.findClass(getDoc(), 'c1'), 'a1').videoUrl === 'https://new.mp4')
  }

  console.log('\n🧪 测试 2.3：逾期提交标记 overdue')
  {
    // 场景 A：截止时间前提交 → 不写 overdue
    const docA = JSON.parse(JSON.stringify(baseDoc))
    docA.classes[0].assignments = [ { id: 'a1', type: 'video', title: 'v', desc: '', deadline: Date.now() + 86400000, videoUrl: 'https://x.mp4', createdAt: Date.now(), results: {} } ]
    const { getDoc: getA, fetchMock: fa } = withDoc(docA)
    const sbA = makeSandbox({ doc: getA() })
    sbA.fetch = fa
    const CSA = vm.runInContext('CourseStore', sbA)
    await CSA.mutate(d => {
      const a = CSA.findAssign(CSA.findClass(d, 'c1'), 'a1')
      a.results = a.results || {}
      const entry = { at: Date.now(), watched: true, watchedPct: 100, watchedSec: 300, duration: 300, difficulty: 3, attempts: 1 }
      if (a.deadline && Date.now() > a.deadline) entry.overdue = true
      a.results['张三'] = entry
    })
    const rA = CSA.findAssign(CSA.findClass(getA(), 'c1'), 'a1').results['张三']
    assert('截止前提交无 overdue', rA && !rA.overdue)

    // 场景 B：截止时间后提交 → overdue: true
    const docB = JSON.parse(JSON.stringify(baseDoc))
    docB.classes[0].assignments = [ { id: 'a1', type: 'video', title: 'v', desc: '', deadline: Date.now() - 1000, videoUrl: 'https://x.mp4', createdAt: Date.now(), results: {} } ]
    const { getDoc: getB, fetchMock: fb } = withDoc(docB)
    const sbB = makeSandbox({ doc: getB() })
    sbB.fetch = fb
    const CSB = vm.runInContext('CourseStore', sbB)
    await CSB.mutate(d => {
      const a = CSB.findAssign(CSB.findClass(d, 'c1'), 'a1')
      a.results = a.results || {}
      const entry = { at: Date.now(), watched: true, watchedPct: 100, watchedSec: 300, duration: 300, difficulty: 3, attempts: 1 }
      if (a.deadline && Date.now() > a.deadline) entry.overdue = true
      a.results['张三'] = entry
    })
    const rB = CSB.findAssign(CSB.findClass(getB(), 'c1'), 'a1').results['张三']
    assert('截止后提交 overdue=true', rB && rB.overdue === true)
  }

  console.log('\n🧪 测试 3：视频确认幂等（重复确认不覆盖）')
  {
    const doc = JSON.parse(JSON.stringify(baseDoc))
    doc.classes[0].assignments = [ { id: 'a1', type: 'video', title: 'v', desc: '', deadline: 0, videoUrl: 'https://x.mp4', createdAt: Date.now(), results: { '张三': { at: 111, watched: true, watchedPct: 100, watchedSec: 300, duration: 300, attempts: 1 } } } ]
    const { getDoc, fetchMock } = withDoc(doc)
    const sb = makeSandbox({ doc: getDoc() })
    sb.fetch = fetchMock
    const CS = vm.runInContext('CourseStore', sb)
    // 重复确认 → mutate fn 返回 false（幂等跳过）
    let fnResult = true
    const ret = await CS.mutate(d => {
      const a = CS.findAssign(CS.findClass(d, 'c1'), 'a1')
      a.results = a.results || {}
      if (a.results['张三']) { fnResult = false; return false }
      a.results['张三'] = { at: 999, watched: true }
    })
    assert('幂等：fn 返回 false 被放弃', fnResult === false)
    assert('mutate 返回 null（放弃）', ret === null)
    const r = CS.findAssign(CS.findClass(getDoc(), 'c1'), 'a1').results['张三']
    assert('原记录未被覆盖（at=111）', r && r.at === 111)
  }

  console.log('\n✅ 视频课任务测试' + (failed ? ' 有失败' : ' 全部通过'))
  process.exit(failed ? 1 : 0)
})()
