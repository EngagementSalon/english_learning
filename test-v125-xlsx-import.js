// test-v125-xlsx-import.js — v125 线下课测评 / 题库支持 .xlsx 上传题目
// ① 源码级：qgen.js 提供 xlsxToRows；importReadFile 有 .xlsx 分支；两处 accept 含 .xlsx
// ② 行为（沙箱真跑，数据在沙箱内部构造，避免跨 realm 的 .map() 失灵）：
//    - 平台自产 xlsx（inlineStr 风格）→ xlsxToRows → courseRowsToCsv → impParseText
//    - ★ Excel 另存风格（共享串表 t="s" + 跳过空单元格 + r="I3" 类引用）→ 同样正确对齐
//    - 非 zip 字节 → 抛错（qgenBadXlsx）
//    - 上传入口：.xlsx 走 arrayBuffer 解包分支（不落到 FileReader 文本读取）
// ③ i18n：qgenBadXlsx zh/en 成对
// ④ 版本弹性：唯一 ?v=N ×12 且 ≥125

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const DIR = __dirname
const APP = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8')
const CA = fs.readFileSync(path.join(DIR, 'course-app.js'), 'utf8')
const QG = fs.readFileSync(path.join(DIR, 'qgen.js'), 'utf8')
const I18N = fs.readFileSync(path.join(DIR, 'i18n.js'), 'utf8')
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')

let failed = 0
function assert(name, cond, extra) {
  if (cond) { console.log('✓ ' + name) }
  else { failed++; console.log('✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}

function grabFn(src, name) {
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
function grabBlock(src, name) {
  // 取 QGen 内某方法体（源码级断言用）
  const re = new RegExp('(^|\\n)\\s*(async )?' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = re.exec(src)
  if (!m) return ''
  const start = m.index + m[0].length - 1
  let i = start, depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// ---------- ① 源码级 ----------
assert('qgen.js 定义 xlsxToRows', /(^|\n)\s*(async\s+)?xlsxToRows\s*\(/.test(QG))
assert('qgen.js 抽出共用 ZIP 目录遍历 _zipEntries/_entryData/_zipText',
  /_zipEntries\s*\(/.test(QG) && /_entryData\s*\(/.test(QG) && /_zipText\s*\(/.test(QG))
assert('qgen.js 提供列号换算 xlsxColIndex 与实体还原 xlsxUnesc',
  /function xlsxColIndex\s*\(/.test(QG) && /function xlsxUnesc\s*\(/.test(QG))
const xr = grabBlock(QG, 'xlsxToRows')
assert('xlsxToRows 读共享串表 xl/sharedStrings.xml', xr.includes('sharedStrings'))
assert('★ xlsxToRows 按 r= 引用补中间空列（Excel 会跳过空单元格）',
  xr.includes('while (cells.length < colIdx) cells.push')
  && /r="\(\[A-Z\]\+\)\\d\+"/.test(xr))
assert('xlsxToRows 支持 inlineStr / 共享串 s / 布尔 b 三种单元格',
  xr.includes("type === 'inlineStr'") && xr.includes("type === 's'") && xr.includes("type === 'b'"))

assert('course-app.js 定义 courseRowsToCsv（二维数组 → CSV）', /(^|\n)function courseRowsToCsv\s*\(/.test(CA))
const csvBody = grabFn(CA, 'courseRowsToCsv')
assert('★ courseRowsToCsv 按 IMPORT_COLS 列宽补齐', csvBody.includes('IMPORT_COLS.length'))
assert('★ courseRowsToCsv 复用 impCsvRow（引号/逗号/换行转义，与模板下载同口径）', csvBody.includes('impCsvRow(cells)'))

const appIRF = grabFn(APP, 'importReadFile')
assert('★ importReadFile 有 .xlsx 分支且走 arrayBuffer（不当文本读）',
  appIRF.includes('\\.xlsx') && appIRF.includes('arrayBuffer') && appIRF.includes('xlsxToRows'))
assert('importReadFile 的 xlsx 失败路径有提示（不静默出乱码）', appIRF.includes("t('qgenBadXlsx')"))
assert('★ 失败分支用 catch 兜住（解包异常不冒泡成白屏）', /\.catch\(\(\)\s*=>\s*alert\(t\('qgenBadXlsx'\)\)\)/.test(appIRF))
assert('importReadFile 保留原 CSV 文本路径（FileReader 仍在）', appIRF.includes('FileReader'))
assert('courseImportReadFile 收口到 importReadFile（不各自解包）',
  grabFn(CA, 'courseImportReadFile').includes('importReadFile(f)'))

assert('★ 线下课上传入口 accept 含 .xlsx', /id="caImportFile"[^>]*accept="[^"]*\.xlsx/.test(CA))
assert('★ 题库上传入口 accept 含 .xlsx', /id="importFile"[^>]*accept="[^"]*\.xlsx/.test(APP))
assert('★ 题库上传入口 accept 含 xlsx MIME', /id="importFile"[^>]*application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/.test(APP))
assert('★ accept 扩展名与 onchange 挂载配套（importFile → importFileChange 接线）',
  /id="importFile"[^>]*onchange="importFileChange\(this\)"/.test(APP) && /(^|\n)function importFileChange\s*\(/.test(APP))

// ---------- ② 行为（沙箱）----------
function mkSandbox() {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Promise, Date, RegExp,
    TextEncoder, TextDecoder, DataView, Uint8Array, ArrayBuffer, Int32Array,
    Blob, Response, DecompressionStream,
    t: k => 'T_' + k,
    IMPORT_COLS: ['题型', '题干', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '正确答案', '解析', '难度(L1-L4 选填)'],
  }
  vm.createContext(sb)
  // 写入器（平台自产 xlsx 用）
  ;['xlsxCrc32', 'xlsxXmlEscape', 'xlsxColRef', 'xlsxSheetXml', 'xlsxBuildZip'].forEach(f => {
    vm.runInContext(grabFn(CA, f), sb)
  })
  vm.runInContext(grabFn(APP, 'impCsvRow'), sb)
  vm.runInContext(grabFn(APP, 'impParseDelimited'), sb)
  vm.runInContext(grabFn(APP, 'impIsHeader'), sb)
  vm.runInContext(grabFn(APP, 'impNormType'), sb)
  vm.runInContext(grabFn(APP, 'impNormDiff'), sb)
  vm.runInContext(grabFn(APP, 'impEnglishWords'), sb)
  vm.runInContext(grabFn(APP, 'impEstimateLevel'), sb)
  vm.runInContext(grabFn(APP, 'impEntryFromCells'), sb)
  vm.runInContext(APP.match(/const IMP_LETTER_RE = .*/)[0], sb)
  vm.runInContext(grabFn(APP, 'impParseText'), sb)
  // ★ 数据在沙箱内部构造（宿主数组进沙箱会让 .map() 失灵）
  vm.runInContext(grabFn(CA, 'courseRowsToCsv'), sb)
  // qgen.js（去掉 CJS 导出尾巴）
  vm.runInContext(QG.replace(/if \(typeof module[\s\S]*$/, ''), sb)
  return sb
}

// 场景 A：平台自产 xlsx（inlineStr 风格）全链路
const rowsFromXlsx = (sb, varName) => {
  return vm.runInContext(`
    (function(){
      const bytes = ${varName}
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return QGen.xlsxToRows(ab)
    })()
  `, sb)
}

const sbA = mkSandbox()
vm.runInContext(grabFn(APP, 'impXlsxFromSheets'), sbA)
vm.runInContext(`
var SHEETS_A = [{ name: '题目模板', rows: [
  ['题型','题干','选项A','选项B','选项C','选项D','选项E','选项F','正确答案','解析','难度(L1-L4 选填)'],
  ['单选','What does "escort" mean?','引导、陪同','催促','打电话','预订','','','A','escort = 引导/护送。','L2'],
  ['判断','Room service is 24 hours.','','','','','','','对','','L1'],
  ['填空','The guest wants to ____ a taxi.','','','','','','','book','叫车。','L1']
] }];
globalThis.BYTES_A = impXlsxFromSheets(SHEETS_A);
globalThis.AB_A = BYTES_A.buffer.slice(BYTES_A.byteOffset, BYTES_A.byteOffset + BYTES_A.byteLength);
`, sbA)
const bytesA = vm.runInContext('BYTES_A', sbA)
assert('场景A：平台写入器产出 xlsx 字节', bytesA && bytesA.length > 500, bytesA && bytesA.length)

const pa = vm.runInContext('QGen.xlsxToRows(AB_A)', sbA)
  .then(rows => {
    assert('场景A：读回 4 行', rows.length === 4, rows.length)
    assert('场景A：表头 11 列', rows[0].length === 11 && rows[0][0] === '题型', JSON.stringify(rows[0]))
    assert('场景A：题干引号完整', rows[1][1] === 'What does "escort" mean?', rows[1][1])
    sbA.ROWS_A = rows
    const csv = vm.runInContext('courseRowsToCsv(ROWS_A)', sbA)
    assert('场景A：转 CSV 后行数 4', csv.split('\n').length === 4, csv.split('\n').length)
    assert('★ 场景A：CSV 里题干引号被转义（"" 包裹）', csv.includes('"What does ""escort"" mean?"'), csv.split('\n')[1])
    const parsed = vm.runInContext('impParseText(CSV_A)', Object.assign(sbA, { CSV_A: csv }))
    assert('★ 场景A：解析出 3 道题（表头被剔除）', parsed.length === 3, parsed.length)
    assert('场景A：第1题单选/答案A', parsed[0].ok && parsed[0].q.type === 'single' && JSON.stringify(parsed[0].q.answer) === '[0]', JSON.stringify(parsed[0]))
    assert('场景A：第2题判断/答案对(0)', parsed[1].ok && parsed[1].q.type === 'judge' && JSON.stringify(parsed[1].q.answer) === '[0]', JSON.stringify(parsed[1]))
    assert('场景A：第2题选项裁尾槽（判断只有 2 项）', parsed[1].q.options.length === 2, JSON.stringify(parsed[1].q.options))
    assert('场景A：第3题填空/答案 book', parsed[2].ok && parsed[2].q.type === 'fill' && parsed[2].q.options[0] === 'book', JSON.stringify(parsed[2]))
    assert('场景A：难度 L2/L1 被识别', parsed[0].q.difficulty === 2 && parsed[1].q.difficulty === 1,
      parsed[0].q.difficulty + '/' + parsed[1].q.difficulty)
  })

// 场景 B：★ Excel 另存风格（共享串表 + 跳过空单元格 + 完整 r="A1" 引用）
const sbB = mkSandbox()
vm.runInContext(`
var SST = [
  '题型','题干','选项A','选项B','选项C','选项D','选项E','选项F','正确答案','解析','难度(L1-L4 选填)',
  '单选','What does &quot;escort&quot; mean?','引导、陪同','催促','打电话','预订','A','escort = 引导/护送。','L2',
  '判断','Room service is 24 hours.','对','L1'
];
function si(l){ return l.map(s => '<si><t xml:space="preserve">' + s + '</t></si>').join('') }
function cs(col, row, idx){ return '<c r="' + col + row + '" t="s"><v>' + idx + '</v></c>' }
function rw(n, inner){ return '<row r="' + n + '">' + inner + '</row>' }
var COLS = ['A','B','C','D','E','F','G','H','I','J','K'];
var SHEET_B = '<worksheet><sheetData>'
  + rw(1, COLS.map(function(c,i){ return cs(c,1,i) }).join(''))
  + rw(2, COLS.map(function(c,i){ return cs(c,2,11+i) }).join(''))
  // 判断题只写 A/B/I/K 四格：C..H 缺失，必须靠 r= 引用补列
  + rw(3, [cs('A',3,20), cs('B',3,21), cs('I',3,22), cs('K',3,23)].join(''))
  + '</sheetData></worksheet>'
var SST_B = '<sst count="' + SST.length + '">' + si(SST) + '</sst>'
globalThis.BYTES_B = xlsxBuildZip([
  { name: 'xl/sharedStrings.xml', data: SST_B },
  { name: 'xl/worksheets/sheet1.xml', data: SHEET_B }
]);
globalThis.AB_B = BYTES_B.buffer.slice(BYTES_B.byteOffset, BYTES_B.byteOffset + BYTES_B.byteLength);
`, sbB)

const pb = vm.runInContext('QGen.xlsxToRows(AB_B)', sbB)
  .then(rows => {
    assert('场景B：读回 3 行', rows.length === 3, rows.length)
    assert('场景B：共享串表还原 + 实体反转', rows[1][1] === 'What does "escort" mean?', rows[1][1])
    assert('★ 场景B：跳空单元格补列（行3 也是 11 列）', rows[2].length === 11, rows[2].length)
    assert('★ 场景B：行3 答案对齐第 9 列（不是第 3 列）', rows[2][8] === '对', JSON.stringify(rows[2]))
    assert('★ 场景B：行3 难度对齐第 11 列', rows[2][10] === 'L1', JSON.stringify(rows[2]))
    assert('场景B：行3 C/D 为空串', rows[2][2] === '' && rows[2][3] === '', JSON.stringify(rows[2].slice(0, 5)))
    sbB.ROWS_B = rows
    const csv = vm.runInContext('courseRowsToCsv(ROWS_B)', sbB)
    const parsed = vm.runInContext('impParseText(CSV_B)', Object.assign(sbB, { CSV_B: csv }))
    assert('★ 场景B：端到端解析出 2 道题', parsed.length === 2, parsed.length)
    assert('★ 场景B：判断题答案正确落入 answer（补列没把「对」挤走）',
      parsed[1].ok && JSON.stringify(parsed[1].q.answer) === '[0]', JSON.stringify(parsed[1]))
  })

// 场景 C：非 zip 字节 → 抛 qgenBadXlsx
const sbC = mkSandbox()
const pc = vm.runInContext('QGen.xlsxToRows(new Uint8Array([1,2,3,4,5,6,7,8,9,10]).buffer)', sbC)
  .then(() => assert('场景C：非 zip 应报错', false, '未抛错'))
  .catch(err => assert('场景C：非 zip 抛 qgenBadXlsx', /T_qgenBadXlsx/.test(err.message), err.message))

// 场景 D：CSV 原路径未受影响（回归守卫）
const sbD = mkSandbox()
const pd = Promise.resolve().then(() => {
  // 用平台自己的 impCsvRow 拼一行合法 CSV（含逗号题干 + 引号转义），避免手写转义出错
  vm.runInContext(`
    var CSV_OLD = impCsvRow(['题型','题干','选项A','选项B','选项C','选项D','选项E','选项F','正确答案','解析','难度(L1-L4 选填)'])
      + '\\n' + impCsvRow(['单选','hi, "there"','alpha','beta','','','','','A','ex','L1']);
  `, sbD)
  const parsed = vm.runInContext('impParseText(CSV_OLD)', sbD)
  assert('场景D：纯 CSV 文本路径仍可解析（未被 xlsx 改造破坏）',
    parsed.length === 1 && parsed[0].ok, JSON.stringify(parsed))
  assert('场景D：逗号/引号题干原样还原', parsed[0].ok && parsed[0].q.question === 'hi, "there"',
    parsed[0].ok ? parsed[0].q.question : 'n/a')
})

// 场景 E：上传入口分支判据（模拟 .xlsx 文件名走解包、.csv 走文本）
const sbE = mkSandbox()
const pe = Promise.resolve().then(() => {
  const bodyIRF = grabFn(APP, 'importReadFile')
  assert('场景E：判据为 /\.xlsx$/i（大小写不敏感，.XLSX 也走解包）', bodyIRF.includes('/\\.xlsx$/i'))
  assert('场景E：xlsx 分支在 FileReader 之前 return（不会双路径并发）',
    bodyIRF.indexOf('arrayBuffer') < bodyIRF.indexOf('new FileReader')
    && /return\s*\n\s*\}\s*\n\s*const fr = new FileReader/.test(bodyIRF))
})

// ---------- ③ i18n ----------
const zhHit = I18N.match(/qgenBadXlsx: '([^']*)'/)
assert('i18n 有 qgenBadXlsx（中文）', !!zhHit && zhHit[1].indexOf('.xlsx') >= 0, zhHit && zhHit[1])
const enZone = I18N.slice(I18N.indexOf('qgenBadPptx: \'Not a valid'))
const enHit = enZone.match(/qgenBadXlsx: '([^']*)'/)
assert('i18n 有 qgenBadXlsx（英文）', !!enHit && /\.xlsx/.test(enHit[1]), enHit && enHit[1])
assert('qgenBadXlsx 与既有 qgenBadDocx/qgenBadPptx 同处一族（键位未错放）',
  /qgenBadDocx:[\s\S]{0,120}qgenBadPptx:[\s\S]{0,200}qgenBadXlsx:/.test(I18N))

// ---------- ④ 版本弹性 ----------
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('版本号 >= 125', uniq.length === 1 && uniq[0] >= 125, JSON.stringify(uniq))

Promise.all([pa, pb, pc, pd, pe]).then(() => {
  console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
  process.exit(failed ? 1 : 0)
}).catch(e => { console.error('FATAL', e && e.message); process.exit(1) })
