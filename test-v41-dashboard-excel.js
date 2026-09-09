// ====== 测试：v41 线下课成绩看板宽度固定 + 作业完成情况导出 Excel ======
// ① xlsxColRef 列号转换（0→A / 25→Z / 26→AA / 27→AB）
// ② xlsxXmlEscape：XML 特殊字符转义、控制字符剔除
// ③ xlsxBuildZip：zip 结构（本地头/中央目录/EOCD）可被 Node 端手工解析，
//    条目名、内容、stored 方法均正确
// ④ courseExportCell：与看板一致的完成语义（作业/测评分数、线下课、视频）
// ⑤ renderCourseDashboard：表格 width:auto;min-width:100%（列不被压缩）、
//    任务列 min-width:110px、有班级时出现导出按钮
// ⑥ courseExportExcel：端到端 —— 触发下载捕获 Blob，解包验证 sheet 数据
// ⑦ i18n courseExportExcel（zh/en）
// ⑧ 源码接线断言
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
}

function makeSandbox() {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = {}
  const sandbox = {
    console,
    localStorage: {
      store: lsStore,
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { const el = mkEl(); el.click = () => { sandbox._clicked = el }; return el },
      body: { appendChild() {} }, title: '',
      hidden: false,
      addEventListener() {}, removeEventListener() {},
      visibilityState: 'visible',
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    alert(m) { sandbox._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder, Uint8Array, DataView, Int32Array, Buffer,
    // Blob / URL mock：createObjectURL 原样返回 blob，便于测试捕获内容
    Blob: class { constructor(parts) { this.parts = parts } },
    URL: { createObjectURL: b => b, revokeObjectURL() {} },
    fetch: async () => { throw new Error('network down') },
    AbortController,
    CloudSync: { status: 'online', onStatus() {}, enqueue() {}, addDuration() {}, flushDuration() {}, pushPending: async () => {} },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('course-store.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)   // escHtml 等公共 helper
  return sandbox
}

// —— Node 端 zip 手工解析（stored 条目）——
function zipEntries(buf) {
  const out = {}
  let pos = 0
  while (pos + 4 <= buf.length) {
    const sig = buf.readUInt32LE(pos)
    if (sig === 0x06054b50 || sig === 0x02014b50) break   // EOCD / 中央目录
    if (sig !== 0x04034b50) throw new Error('bad local header at ' + pos)
    const method = buf.readUInt16LE(pos + 8)
    const csize = buf.readUInt32LE(pos + 18)
    const nameLen = buf.readUInt16LE(pos + 26)
    const extraLen = buf.readUInt16LE(pos + 28)
    const name = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf-8')
    const data = buf.slice(pos + 30 + nameLen + extraLen, pos + 30 + nameLen + extraLen + csize)
    if (method !== 0) throw new Error('unexpected compression method ' + method)
    out[name] = data
    pos += 30 + nameLen + extraLen + csize
  }
  return out
}

async function main() {
  // ---------- ① 列号转换 ----------
  console.log('\n[1] xlsxColRef 列号转换')
  {
    const sb = makeSandbox()
    const r = vm.runInContext('[xlsxColRef(0), xlsxColRef(25), xlsxColRef(26), xlsxColRef(27), xlsxColRef(700)]', sb)
    assert('0→A / 25→Z / 26→AA / 27→AB / 700→ZY',
      JSON.stringify(r) === JSON.stringify(['A', 'Z', 'AA', 'AB', 'ZY']), JSON.stringify(r))
  }

  // ---------- ② XML 转义 ----------
  console.log('\n[2] xlsxXmlEscape')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`xlsxXmlEscape('<a b="1">&炎') + '|' + xlsxXmlEscape('x\\u0007y')`, sb)
    assert('特殊字符转义', r === '&lt;a b=&quot;1&quot;&gt;&amp;炎|xy', r)
  }

  // ---------- ③ zip 结构 ----------
  console.log('\n[3] xlsxBuildZip 结构')
  {
    const sb = makeSandbox()
    const buf = vm.runInContext(`
      (() => {
        const u = xlsxBuildZip([
          { name: 'a.txt', data: 'hello 炎' },
          { name: 'b/c.xml', data: '<x/>' }
        ])
        return Buffer.from(u)
      })()
    `, sb)
    assert('PK 头 + EOCD 尾', buf.readUInt32LE(0) === 0x04034b50 && buf.readUInt32LE(buf.length - 22) === 0x06054b50)
    const entries = zipEntries(buf)
    assert('两个条目名正确', Object.keys(entries).length === 2 && entries['a.txt'] && entries['b/c.xml'], Object.keys(entries).join(','))
    assert('条目内容一致（UTF-8）', entries['a.txt'].toString('utf-8') === 'hello 炎' && entries['b/c.xml'].toString() === '<x/>')
    // CRC 校验：用 vm 内同一 crc 函数对照
    const crcA = vm.runInContext(`xlsxCrc32(new TextEncoder().encode('hello 炎'))`, sb)
    const crcB = vm.runInContext(`xlsxCrc32(new TextEncoder().encode('<x/>'))`, sb)
    assert('中央目录 CRC 与内容一致', buf.readUInt32LE(14) === crcA, 'file A crc')
    // 中央目录：从 EOCD 字段精确定位后逐条遍历，校验每条 CRC
    const eocdPos = buf.length - 22
    const cdCount = buf.readUInt16LE(eocdPos + 10)
    const cdOffset = buf.readUInt32LE(eocdPos + 16)
    const crcMap = { 'a.txt': crcA, 'b/c.xml': crcB }
    let p = cdOffset, seen = 0
    while (p < eocdPos && buf.readUInt32LE(p) === 0x02014b50 && seen < cdCount) {
      const nameLen = buf.readUInt16LE(p + 28)
      const nm = buf.slice(p + 46, p + 46 + nameLen).toString('utf-8')
      assert(`中央目录 ${nm} CRC 一致`, buf.readUInt32LE(p + 16) === crcMap[nm], 'crc mismatch')
      p += 46 + nameLen; seen++
    }
    assert('中央目录条目数正确', seen === 2, 'seen=' + seen)
  }

  // ---------- ④ 导出单元格语义 ----------
  console.log('\n[4] courseExportCell 完成语义')
  {
    const sb = makeSandbox()
    const r = vm.runInContext(`
      (() => {
        const notDone = t('courseDashNotDone'), done = t('courseDoneTag')
        return {
          miss: courseExportCell({ type: 'homework' }, null),
          hw: courseExportCell({ type: 'homework' }, { score: 85 }),
          exam: courseExportCell({ type: 'exam' }, { score: 60 }),
          offDone: courseExportCell({ type: 'offline' }, { done: true }),
          offNot: courseExportCell({ type: 'offline' }, { done: false }),
          vid: courseExportCell({ type: 'video' }, { watchedPct: 95.6 }),
          vidNo: courseExportCell({ type: 'video' }, {}),
        }
      })()
    `, sb)
    const zhNot = '未完成', zhDone = '已完成'
    assert('无记录 → 未完成', r.miss === zhNot, r.miss)
    assert('作业/测评 → 分数', r.hw === 85 && r.exam === 60, JSON.stringify(r))
    assert('线下课 done → 已完成 / 否则未完成', r.offDone === zhDone && r.offNot === zhNot)
    assert('视频 → 百分比字符串（四舍五入）', r.vid === '96%', r.vid)
    assert('视频无 pct（历史记录）→ 已完成', r.vidNo === zhDone, r.vidNo)
  }

  // ---------- ⑤ 看板渲染：宽度固定 + 导出按钮 ----------
  console.log('\n[5] renderCourseDashboard 宽度固定 + 导出按钮')
  {
    const sb = makeSandbox()
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: 'A 班', members: ['stu', 'zhang'], assignments: [
        { id: 'hw1', type: 'homework', title: '单元一作业', results: { stu: { score: 90, attempts: 1 } } },
        { id: 'vd1', type: 'video', title: '礼貌用语视频', results: { zhang: { watchedPct: 100 } } },
        { id: 'of1', type: 'offline', title: '线下第一课', date: '2026-09-01', results: {} }
      ] } ] }
    `, sb)
    await vm.runInContext('renderCourseDashboard()', sb)
    const html = sb.document.getElementById('page-course').innerHTML
    assert('表格 width:auto;min-width:100%（列不被压缩）', html.includes('width:auto;min-width:100%'))
    assert('任务列 min-width:110px', html.includes('min-width:110px'))
    assert('学生列 min-width:130px', html.includes('min-width:130px'))
    assert('出现「下载 Excel」导出按钮', html.includes('courseExportExcel()'))
    assert('按钮文案为 t(courseExportExcel)', html.includes('下载 Excel'))

    // 无班级 → 不出按钮
    const sb2 = makeSandbox()
    vm.runInContext(`courseState.doc = { v: 1, classes: [] }`, sb2)
    await vm.runInContext('renderCourseDashboard()', sb2)
    const html2 = sb2.document.getElementById('page-course').innerHTML
    assert('无班级 → 无导出按钮、显示空数据提示', !html2.includes('courseExportExcel()') && html2.includes('courseDashNoData') === false && html2.includes('暂无班级或作业数据'))
  }

  // ---------- ⑥ 端到端导出 ----------
  console.log('\n[6] courseExportExcel 端到端')
  {
    const sb = makeSandbox()
    const Store = vm.runInContext('Store', sb)
    Store.getUsers = () => [
      { username: 'stu', name: '张三', dept: '饮食部' },
      { username: 'zhang', name: '', dept: '' },
    ]
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: '前台班', members: ['stu', 'zhang'], assignments: [
        { id: 'hw1', type: 'homework', title: '单元一 <作业>', results: { stu: { score: 85 } } },
        { id: 'vd1', type: 'video', title: '视频课', results: { zhang: { watchedPct: 100 } } }
      ] } ] }
    `, sb)
    await vm.runInContext('courseExportExcel()', sb)
    assert('触发下载', !!sb._clicked)
    const fname = sb._clicked.download || ''
    assert('文件名为 成绩看板_日期.xlsx', /^成绩看板_\d{4}-\d{2}-\d{2}\.xlsx$/.test(fname), fname)
    const blob = sb._clicked.href
    assert('Blob 内容存在', blob && blob.parts && blob.parts.length === 1 && blob.parts[0].length > 0)
    const buf = Buffer.from(blob.parts[0])
    const entries = zipEntries(buf)
    const need = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']
    assert('xlsx 包含全部 5 个必需条目', need.every(n => entries[n]), Object.keys(entries).join(','))
    const wb = entries['xl/workbook.xml'].toString('utf-8')
    assert('workbook 含 sheet 名「前台班」', wb.includes('name="前台班"'), wb)
    const sh = entries['xl/worksheets/sheet1.xml'].toString('utf-8')
    assert('sheet 含学员名「张三」', sh.includes('张三'))
    assert('sheet 含转义后的任务名', sh.includes('单元一 &lt;作业&gt;'))
    assert('sheet 含作业分数 85（数字单元格）', sh.includes('<c r="B2"><v>85</v></c>'), sh.slice(0, 400))
    assert('sheet 含视频 100%', sh.includes('100%'))
    assert('sheet 含表头「学员」', sh.includes('学员'))
    // XML 基础合法性：标签配平抽查
    assert('sheet XML 标签配平（row/c/is）',
      (sh.match(/<row /g) || []).length === (sh.match(/<\/row>/g) || []).length &&
      (sh.match(/<is>/g) || []).length === (sh.match(/<\/is>/g) || []).length)
  }

  // ---------- ⑦ i18n ----------
  console.log('\n[7] i18n 词条')
  {
    const sb = makeSandbox()
    const I18N = vm.runInContext('I18N', sb)
    assert('zh.courseExportExcel 存在', !!(I18N.zh && I18N.zh.courseExportExcel))
    assert('en.courseExportExcel 存在', !!(I18N.en && I18N.en.courseExportExcel))
  }

  // ---------- ⑧ 源码接线 ----------
  console.log('\n[8] 源码接线断言')
  {
    const app = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    assert('courseExportExcel 函数已定义', app.includes('function courseExportExcel()'))
    assert('xlsx 生成器已内置', app.includes('function xlsxBuildZip(') && app.includes('function xlsxSheetXml('))
    assert('看板表格宽度固定', app.includes('width:auto;min-width:100%'))
    assert('任务列固定 min-width:110px', app.includes('min-width:110px'))
    assert('看板头部含导出按钮', app.includes('courseExportExcel()'))
    assert('草稿任务不导出', app.includes("filter(a => a.status !== 'draft')"))
  }

  console.log(failed ? '\n存在失败用例 ✗' : '\n全部通过 ✓')
  process.exit(failed ? 1 : 0)   // 必须显式退出：沙箱内定时器句柄会阻止进程自然退出
}

main().catch(e => { console.error('测试执行异常：', e); process.exit(1) })
