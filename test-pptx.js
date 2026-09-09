// 测试 PPTX 文本提取（用 Node.js 构造最小 ZIP + slide XML）
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---- 构造一个最小 ZIP（stored，无压缩）包含 ppt/slides/slide1.xml 和 slide2.xml ----
function makeStoredZip(entries) {
  // entries: [{ name: string, data: Buffer }]
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const data = e.data
    const crc = crc32(data)

    // Local file header (30 bytes + name)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)  // signature
    lfh.writeUInt16LE(20, 4)          // version needed
    lfh.writeUInt16LE(0, 6)           // flags
    lfh.writeUInt16LE(0, 8)           // method = stored (0)
    lfh.writeUInt16LE(0, 10)          // mod time
    lfh.writeUInt16LE(0, 12)          // mod date
    lfh.writeUInt32LE(crc, 14)        // crc32
    lfh.writeUInt32LE(data.length, 18) // compressed size
    lfh.writeUInt32LE(data.length, 22) // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26) // name len
    lfh.writeUInt16LE(0, 28)          // extra len

    const localHeader = Buffer.concat([lfh, nameBuf])
    localParts.push(Buffer.concat([localHeader, data]))

    // Central directory header (46 bytes + name)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)  // signature
    cdh.writeUInt16LE(20, 4)          // version made by
    cdh.writeUInt16LE(20, 6)          // version needed
    cdh.writeUInt16LE(0, 8)           // flags
    cdh.writeUInt16LE(0, 10)          // method = stored
    cdh.writeUInt16LE(0, 12)          // mod time
    cdh.writeUInt16LE(0, 14)          // mod date
    cdh.writeUInt32LE(crc, 16)        // crc32
    cdh.writeUInt32LE(data.length, 20) // compressed size
    cdh.writeUInt32LE(data.length, 24) // uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28) // name len
    cdh.writeUInt16LE(0, 30)          // extra len
    cdh.writeUInt16LE(0, 32)          // comment len
    cdh.writeUInt16LE(0, 34)          // disk number
    cdh.writeUInt16LE(0, 36)          // internal attrs
    cdh.writeUInt32LE(0, 38)          // external attrs
    cdh.writeUInt32LE(offset, 42)     // local header offset
    centralParts.push(Buffer.concat([cdh, nameBuf]))

    offset += localHeader.length + data.length
  }

  const localData = Buffer.concat(localParts)
  const centralData = Buffer.concat(centralParts)
  const cdOffset = localData.length
  const cdSize = centralData.length

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)   // signature
  eocd.writeUInt16LE(0, 4)            // disk number
  eocd.writeUInt16LE(0, 6)            // disk with CD
  eocd.writeUInt16LE(entries.length, 8)  // entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(cdSize, 12)      // CD size
  eocd.writeUInt32LE(cdOffset, 16)    // CD offset
  eocd.writeUInt16LE(0, 20)           // comment len

  return Buffer.concat([localData, centralData, eocd])
}

// CRC32 实现
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      }
      table[i] = c
    }
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ---- 构造测试 PPTX ----
const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>Reservation (预订)</a:t></a:r></a:p>
      <a:p><a:r><a:t>Check-in (入住登记)</a:t></a:r></a:p>
      <a:p><a:r><a:t>The guest arrived at the hotel</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`

const slide2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>Room Service (客房送餐)</a:t></a:r></a:p>
      <a:p><a:r><a:t>Breakfast (早餐)</a:t></a:r></a:p>
      <a:p><a:r><a:t>Concierge (礼宾部)</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`

const zipBuf = makeStoredZip([
  { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide1Xml, 'utf-8') },
  { name: 'ppt/slides/slide2.xml', data: Buffer.from(slide2Xml, 'utf-8') },
  { name: '[Content_Types].xml', data: Buffer.from('<types/>', 'utf-8') },
])

// ---- 加载 qgen.js 并测试 ----
// qgen.js 末尾有 module.exports = QGen，直接 require 即可
const QGen = require('./qgen.js')

async function run() {
  let pass = 0, fail = 0
  const assert = (cond, msg) => {
    if (cond) { pass++; console.log('  ✓ ' + msg) }
    else { fail++; console.log('  ✗ ' + msg) }
  }

  console.log('\n=== PPTX 文本提取测试 ===')

  // 测试 1: pptxToText 提取文本
  const text = await QGen.pptxToText(zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength))
  assert(text.includes('Reservation'), '提取 slide1 文本：Reservation')
  assert(text.includes('预订'), '提取 slide1 中文注解：预订')
  assert(text.includes('Check-in'), '提取 slide1 文本：Check-in')
  assert(text.includes('入住登记'), '提取 slide1 中文注解：入住登记')
  assert(text.includes('Room Service'), '提取 slide2 文本：Room Service')
  assert(text.includes('客房送餐'), '提取 slide2 中文注解：客房送餐')
  assert(text.includes('Concierge'), '提取 slide2 文本：Concierge')
  assert(text.includes('礼宾部'), '提取 slide2 中文注解：礼宾部')
  assert(text.includes('The guest arrived'), '提取 slide1 英文句子')

  // 测试 2: generate 能从 PPTX 文本生成题目
  const result = QGen.generate(text, { max: 60 })
  assert(result.questions.length > 0, '从 PPTX 文本生成题目：' + result.questions.length + ' 题')
  assert(result.info.pairs >= 3, '提取词对数 ≥ 3：' + result.info.pairs)

  // 检查是否生成了听音题
  const listenQs = result.questions.filter(q => q.type === 'listen')
  assert(listenQs.length > 0, '生成听音题 ≥ 1：' + listenQs.length)

  // 翻译多选题已停用（v32）：池里混杂章节标题时干扰项语义无关
  const transQs = result.questions.filter(q => q.type === 'single' && (q.rule === 'en2zh' || q.rule === 'zh2en' || q.rule === 'sent_zh2en' || q.rule === 'sent_en2zh'))
  assert(transQs.length === 0, '翻译多选题模板已停用：' + transQs.length)

  // 测试 3: 错误处理 - 无效文件
  try {
    await QGen.pptxToText(new ArrayBuffer(100))
    assert(false, '无效文件应抛出错误')
  } catch (e) {
    assert(true, '无效文件正确抛出错误')
  }

  // 测试 4: readText 路由 - .pptx 后缀
  const fakeFile = { name: 'test.pptx', arrayBuffer: () => Promise.resolve(zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength)) }
  const text2 = await QGen.readText(fakeFile)
  assert(text2.includes('Reservation'), 'readText(.pptx) 正确路由到 pptxToText')

  console.log(`\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
