// ====== 题库数据 ======
// comprehension: 理解类（基于 L1-L3 培训对话）
// pronunciation: 发音类（Web Speech API 真实发音）

const QUESTIONS = {

  // ==================== 理解类 ====================
  comprehension: [
    {
      id: 'c1', scene: 'L1 客人抵达', type: 'single',
      question: '客人有预订时，Host 会用什么方式核对预订信息？',
      options: [
        '询问客人的全名和身份证号',
        '询问客人手机号码的后四位',
        '查看客人的会员卡',
        '询问客人的房间号'
      ],
      answer: 1,
      explanation: '原对话："May I have the last four digits of your telephone number, please?" Host 通过手机号后四位核对预订。'
    },
    {
      id: 'c2', scene: 'L1 客人抵达', type: 'single',
      question: 'Host 向客人提供哪几种水？',
      options: [
        'Only still water（只有静水）',
        'Tap water and bottled water（自来水和瓶装水）',
        'Still water, sparkling water and complimentary lemon water',
        'Hot water and cold water（热水和冷水）'
      ],
      answer: 2,
      explanation: '原对话："We have still water, sparkling water and complimentary lemon water." 共三种：静水、气泡水、免费柠檬水。'
    },
    {
      id: 'c3', scene: 'L1 客人抵达', type: 'single',
      question: 'The Kitchen Table 是什么风格的餐厅？',
      options: [
        'A New York City style bistro（纽约风格小餐馆）',
        'A French fine dining restaurant（法式高端餐厅）',
        'A traditional Chinese restaurant（传统中餐厅）',
        'An Italian trattoria（意式餐厅）'
      ],
      answer: 0,
      explanation: '原对话："The Kitchen Table is a New York City style bistro with celebrated views of the Pudong skyline."'
    },
    {
      id: 'c4', scene: 'L1 客人抵达', type: 'single',
      question: 'The Kitchen Table 擅长什么菜品？',
      options: [
        'Modern Chinese cuisine（现代中餐）',
        'Charcoal grilled meats and seafood（炭烧肉类和海鲜）',
        'Desserts and cocktails（甜点和鸡尾酒）',
        'Vegetarian dishes（素食）'
      ],
      answer: 1,
      explanation: '原对话："We specialize in charcoal grilled meats and seafood." specialize in = 擅长/专攻。'
    },
    {
      id: 'c5', scene: 'L1 客人抵达', type: 'single',
      question: '关于 Yen 餐厅的描述，以下哪项正确？',
      options: [
        'It is the hotel\'s outdoor bar（酒店户外酒吧）',
        'It serves Italian cuisine（供应意大利菜）',
        'It is the hotel\'s Chinese restaurant serving modern Chinese cuisine',
        'It only serves desserts（只供应甜点）'
      ],
      answer: 2,
      explanation: '原对话："Yen is the hotel\'s Chinese restaurant. We serve modern Chinese cuisine with a focus on contemporary Jiangnan and Cantonese cuisines." Yen 是酒店中餐厅，主打当代江南菜和粤菜。'
    },
    {
      id: 'c6', scene: 'L1 客人抵达', type: 'single',
      question: '客人没有预订时，Host 应该先问什么？',
      options: [
        '"How may I address you?"（我怎么称呼您？）',
        '"Please leave."（请离开。）',
        '"What\'s your ID number?"（身份证号多少？）',
        '"Do you have cash?"（您有现金吗？）'
      ],
      answer: 0,
      explanation: '原对话：客人说没有预订后，Host 问 "How may I address you?"，先确认称呼，再问是否住店、检查空位。'
    },
    {
      id: 'c7', scene: 'L2 点餐', type: 'single',
      question: '服务员递上菜单后会问客人什么健康相关问题？',
      options: [
        '"Do you like the food here?"',
        '"Do you have any allergies or other dietary restrictions?"',
        '"Are you feeling well today?"',
        '"Have you eaten here before?"'
      ],
      answer: 1,
      explanation: '原对话："Do you have any allergies（过敏）or other dietary（饮食的）restrictions（限制）?" 这是点餐前的标准健康询问。'
    },
    {
      id: 'c8', scene: 'L2 点餐', type: 'single',
      question: '客人想表达"我对坚果过敏"，正确的说法是？',
      options: [
        '"I don\'t like nuts."',
        '"I am allergic to nuts."',
        '"Nuts are not good."',
        '"I never eat nuts."'
      ],
      answer: 1,
      explanation: '原对话句式："I am allergic to ___." / "I have a/an ___ allergy."（我对……过敏。）'
    },
    {
      id: 'c9', scene: 'L2 点餐', type: 'multiple',
      question: '以下哪些说法可以用来表达饮食限制？',
      options: [
        '"I am vegetarian."（我是素食者）',
        '"I have celiac."（我有乳糜泻）',
        '"I am diabetic."（我是糖尿病患者）',
        '"I like this restaurant."（我喜欢这家餐厅）'
      ],
      answer: [0, 1, 2],
      explanation: '培训材料中的饮食限制表达包括：MEDICAL CONDITION（celiac/diabetes）、LIFESTYLE（vegetarian/vegan）、ALLERGY、INTOLERANCE、RELIGION。"I like this restaurant" 只是普通表达。'
    },
    {
      id: 'c10', scene: 'L2 点餐', type: 'single',
      question: '当客人告知过敏信息后，服务员应该说什么？',
      options: [
        '"No problem."',
        '"I have made a note of that."',
        '"You should not eat here."',
        '"The chef will call you."'
      ],
      answer: 1,
      explanation: '原对话："I have made a note（笔记）of that, Mr. and Mrs. Smith." 表示"我已经记下来了"，随后再问 "Are you ready to order?"'
    },
    {
      id: 'c11', scene: 'L2 点餐', type: 'single',
      question: '服务员复述订单确认时，用什么句式开头？',
      options: [
        '"Let me repeat your order."',
        '"Please allow me to confirm your order."',
        '"Listen carefully."',
        '"I will read your order now."'
      ],
      answer: 1,
      explanation: '原对话："Please allow（允许）me to confirm（确认）your order." 之后逐项复述客人点的酒水和菜品，最后问 "Is that correct?"'
    },
    {
      id: 'c12', scene: 'L2 点餐', type: 'single',
      question: '确认订单后，服务员如何告知上菜时间？',
      options: [
        '"Your food is coming."',
        '"Your drinks will arrive within 5 minutes and your first dish will arrive within 15 minutes."',
        '"Please wait 20 minutes."',
        '"The kitchen is very busy."'
      ],
      answer: 1,
      explanation: '原对话："Your drinks will arrive（到达）within（在……之内）5 minutes and your first dish will arrive within 15 minutes." 酒水 5 分钟内、第一道菜 15 分钟内。'
    },
    {
      id: 'c13', scene: 'L3 结账', type: 'single',
      question: '客人要结账时，最常用的表达是？',
      options: [
        '"I want to pay now."',
        '"Bill / Check, please."',
        '"Give me the bill."',
        '"How much is it?"'
      ],
      answer: 1,
      explanation: '原对话客人开头第一句就是 "Bill / Check, please."（请结账。）Bill 是英式用法，Check 是美式用法。'
    },
    {
      id: 'c14', scene: 'L3 结账', type: 'single',
      question: '文中提到的会员体系是什么？',
      options: [
        'Hilton Honors（希尔顿荣誉客会）',
        'IHG Rewards（洲际优悦会）',
        'Marriott Bonvoy（万豪旅享家）',
        'Starwood Preferred Guest（喜达屋优先顾客）'
      ],
      answer: 2,
      explanation: '原对话："Are you a Marriott Bonvoy member?" 万豪旅享家（Marriott Bonvoy）是万豪旗下的会员计划。'
    },
    {
      id: 'c15', scene: 'L3 结账', type: 'single',
      question: 'Silver 会员（银卡会员）享受什么折扣？',
      options: [
        '5% 折扣',
        '10% 折扣',
        '15% 折扣',
        '20% 折扣'
      ],
      answer: 1,
      explanation: '原对话："As a silver member you will receive a 10% discount." 银卡会员享受 10% 折扣。'
    },
    {
      id: 'c16', scene: 'L3 结账', type: 'multiple',
      question: '根据培训材料，客人可以使用哪些付款方式？',
      options: [
        'Membership points（会员积分）',
        'Charge to room（挂房账）',
        'WeChat Pay / Alipay（微信支付/支付宝）',
        'Credit card / Cash（信用卡/现金）'
      ],
      answer: [0, 1, 2, 3],
      explanation: 'L3 对话涵盖全部四种：会员积分支付、挂房账、微信/支付宝扫码、信用卡（输密码+签名）以及现金（找零）。'
    },
    {
      id: 'c17', scene: 'L3 结账', type: 'single',
      question: '用信用卡付款时，服务员会请客人做什么？',
      options: [
        'Show the QR code（出示二维码）',
        'Enter PIN and sign here（输入密码并签名）',
        'Write the room number（写房间号）',
        'Show membership card（出示会员卡）'
      ],
      answer: 1,
      explanation: '原对话："Please enter（输入）your PIN（密码）. Please sign here." 出示二维码是微信/支付宝支付；写房间号是挂房账。'
    },
    {
      id: 'c18', scene: 'L3 结账', type: 'single',
      question: '餐厅服务员送客时的标准告别语是？',
      options: [
        '"Bye bye!"',
        '"Thank you for dining at The Kitchen Table / Yen."',
        '"See you next time!"',
        '"Have a good one!"'
      ],
      answer: 1,
      explanation: '原对话 RESTAURANT 部分："Thank you for dining（用餐）at The Kitchen Table / Yen, Mr. and Mrs. Smith." 酒吧则是 "Thank you for choosing Woo Bar / Wet Bar / Liquid."'
    },
    {
      id: 'c19', scene: 'L3 结账', type: 'single',
      question: '客人说 "Charge it to my room, please" 是想用什么方式付款？',
      options: [
        '现金',
        '挂房账（记到住宿账单）',
        '信用卡',
        '会员积分'
      ],
      answer: 1,
      explanation: '"Charge it to my room" = 挂房账，费用计入房间账单，退房时统一结算。此时服务员会请客人提供房号和姓名。'
    },
    {
      id: 'c20', scene: 'L3 结账', type: 'single',
      question: '"itemized bill" 与普通 bill 的区别是：',
      options: [
        '价格更低',
        '逐项列出每笔消费明细',
        '可以用于报销',
        '包含小费'
      ],
      answer: 1,
      explanation: 'itemized = 逐项列出的。itemized bill 把每道菜、每杯饮品单独列明，方便客人核对。invoice（发票）才是报销凭证。'
    },
    {
      id: 'c21', scene: 'L3 结账', type: 'single',
      question: '客人索要 invoice（发票）时，通常是因为：',
      options: [
        '需要用于公司报销',
        '觉得账单太贵',
        '想退菜',
        '想开发票给朋友'
      ],
      answer: 0,
      explanation: '原对话："Would you like an invoice?"（需要发票吗？）客人索要发票通常是公司报销需要。'
    },
    {
      id: 'c22', scene: 'L2 点餐', type: 'single',
      question: '服务员问 "How would you like your steak?" 是在询问：',
      options: [
        '牛排的熟度',
        '牛排的重量',
        '牛排的价格',
        '是否打包带走'
      ],
      answer: 0,
      explanation: '这是询问牛排熟度的标准句式：rare / medium rare / medium / medium well / well done。'
    },
    {
      id: 'c23', scene: 'L2 点餐', type: 'multiple',
      question: '关于确认订单（confirming the order），服务员正确的做法包括：',
      options: [
        '重复客人所点的全部菜品',
        '询问特殊要求（如过敏、熟度）',
        '告知大致上菜时间',
        '直接把订单送厨房不用复述'
      ],
      answer: [0, 1, 2],
      explanation: '标准点餐流程：复述订单确认无误 → 确认饮食限制/熟度 → 告知上菜时间（如 15-20 分钟）。不复述直接下单容易出错。'
    },
    {
      id: 'c24', scene: 'L1 客人抵达', type: 'single',
      question: '客人到店但表示没有预订时，Host 的正确做法是：',
      options: [
        '直接拒绝客人',
        '查看当前空位或告知等候时间',
        '让客人去其他餐厅',
        '要求客人先付押金'
      ],
      answer: 1,
      explanation: '面对 walk-in guest（未预订客人），应查看座位情况：有位直接安排，满座则告知大约等候时间。'
    },
    {
      id: 'c25', scene: 'L2 点餐', type: 'single',
      question: '客人表示对某食物过敏时，服务员应该：',
      options: [
        '照常上菜',
        '记录并立即告知厨房，确认菜品安全',
        '让客人自己负责',
        '建议客人换一家餐厅'
      ],
      answer: 1,
      explanation: '过敏是重大食品安全问题：必须记录、告知厨房并逐一确认食材，必要时推荐安全的替代菜品。'
    },
    {
      id: 'c26', scene: 'L2 点餐', type: 'single',
      question: '"May I take your order?" 的意思是：',
      options: [
        '可以为您点单了吗',
        '可以为您结账了吗',
        '可以为您上菜了吗',
        '可以为您引路了吗'
      ],
      answer: 0,
      explanation: 'take one\'s order = 为某人点单。结账是 "Would you like the bill?"，引路是 "Let me show you to your table."'
    },
    {
      id: 'c27', scene: 'L1 客人抵达', type: 'single',
      question: 'Host 引座时说 "Please allow me to escort you to a table"，其中 escort 的意思是：',
      options: [
        '护送、陪同',
        '催促',
        '询问',
        '收费'
      ],
      answer: 0,
      explanation: 'escort /ɪˈskɔːt/ v. 护送、陪同。这句是引座时的礼貌用语："请让我带您到座位。"'
    },
    {
      id: 'c28', scene: 'L3 结账', type: 'single',
      question: '客人用现金支付且金额大于账单时，服务员应：',
      options: [
        '把差额当小费',
        '当面点清并找回零钱（change）',
        '请客人扫码',
        '请客人下次再来取'
      ],
      answer: 1,
      explanation: '原对话现金场景：服务员当面核对纸币并找零："Here is your change."（这是您的找零。）差额是否作为小费由客人自己决定。'
    }
  ],

  // ==================== 发音类 ====================
  // 每题带 audio 字段 = Web Speech API 播放的真实发音
  pronunciation: [
    {
      id: 'p1', scene: 'L1 客人抵达', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'reservation',
      options: ['预订', '账单', '菜单', '收据'],
      answer: 0,
      explanation: 'reservation /ˌrezərˈveɪʃn/ n. 预订。对话："May I know if you have a reservation?"'
    },
    {
      id: 'p2', scene: 'L1 客人抵达', type: 'listen_identify',
      question: '听发音，选择你听到的单词',
      audio: 'sparkling',
      options: ['sparkling', 'sprinkling', 'sparklingly', 'spracking'],
      answer: 0,
      explanation: 'sparkling /ˈspɑːklɪŋ/ adj. 起泡的。"sparkling water" = 气泡水。注意 -ar- 发 /ɑː/ 音。'
    },
    {
      id: 'p3', scene: 'L1 客人抵达', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'complimentary',
      options: ['免费的', '赞美的', '补充的', '复杂的'],
      answer: 0,
      explanation: 'complimentary /ˌkɒmplɪˈmentri/ adj. 免费赠送的。"complimentary lemon water" = 免费柠檬水。注意与 complement（补充）区分。'
    },
    {
      id: 'p4', scene: 'L1 客人抵达', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'escort',
      options: ['护送', '逃离', '预订', '结账'],
      answer: 0,
      explanation: 'escort /ɪˈskɔːt/ v. 护送。对话："Please allow me to escort you to a table." 重音在第二音节。'
    },
    {
      id: 'p5', scene: 'L2 点餐', type: 'listen_identify',
      question: '听发音，选择你听到的单词',
      audio: 'allergy',
      options: ['allergy', 'energy', 'agency', 'algebra'],
      answer: 0,
      explanation: 'allergy /ˈælədʒi/ n. 过敏。对话："Do you have any allergies?" 注意与 energy /ˈenədʒi/ 的区别：开头是 /æl/ 还是 /en/。'
    },
    {
      id: 'p6', scene: 'L2 点餐', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'dietary restrictions',
      options: ['饮食限制', '预订确认', '账单明细', '会员积分'],
      answer: 0,
      explanation: 'dietary /ˈdaɪətəri/ adj. 饮食的；restriction /rɪˈstrɪkʃn/ n. 限制。"Do you have any allergies or other dietary restrictions?"'
    },
    {
      id: 'p7', scene: 'L2 点餐', type: 'listen_sentence',
      question: '听句子，选择你听到的内容',
      audio: 'I am allergic to nuts.',
      options: [
        'I am allergic to nuts.',
        'I am allergic to milk.',
        'I am a vegetarian.',
        'I am intolerant to lactose.'
      ],
      answer: 0,
      explanation: '对话句式："I am allergic to ___."（我对……过敏。）allergic /əˈlɜːdʒɪk/ 重音在第二音节。'
    },
    {
      id: 'p8', scene: 'L2 点餐', type: 'listen_sentence',
      question: '听句子，这句话属于哪个服务场景？',
      audio: 'Are you ready to order?',
      options: ['点餐', '结账', '客人抵达', '送客'],
      answer: 0,
      explanation: '"Are you ready to order?"（您准备好点餐了吗？）是 L2 点餐环节的标准用语。'
    },
    {
      id: 'p9', scene: 'L2 点餐', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'confirm',
      options: ['确认', '混淆', '缴费', '烹调'],
      answer: 0,
      explanation: 'confirm /kənˈfɜːm/ v. 确认。对话："Please allow me to confirm your order."'
    },
    {
      id: 'p10', scene: 'L3 结账', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'itemized bill',
      options: ['明细账单', '总账单', '发票', '小票'],
      answer: 0,
      explanation: 'itemized /ˈaɪtəmaɪzd/ adj. 逐项列明的。"Would you like an itemized bill?" = 您需要明细账单吗？'
    },
    {
      id: 'p11', scene: 'L3 结账', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'membership',
      options: ['会员资格', '友谊', '合伙', '资格赛'],
      answer: 0,
      explanation: 'membership /ˈmembəʃɪp/ n. 会员资格。对话："Are you a Marriott Bonvoy member?" "membership number" = 会员号。'
    },
    {
      id: 'p12', scene: 'L3 结账', type: 'listen_sentence',
      question: '听句子，选择你听到的付款方式',
      audio: 'Charge it to my room.',
      options: [
        'Charge it to my room.（挂房账）',
        'I will pay with cash.（付现金）',
        'I will use my points.（用积分）',
        'WeChat Pay, please.（微信支付）'
      ],
      answer: 0,
      explanation: '"Charge it to my room." = 挂到我的房账。之后服务员会说 "Please write your name and room number here."'
    },
    {
      id: 'p13', scene: 'L3 结账', type: 'listen_sentence',
      question: '听句子，这句话属于哪个服务场景？',
      audio: 'How would you like to pay?',
      options: ['结账付款', '点餐', '引座', '推荐菜品'],
      answer: 0,
      explanation: '"How would you like to pay?"（您想如何付款？）是 L3 结账环节的关键句。'
    },
    {
      id: 'p14', scene: 'L3 结账', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'invoice',
      options: ['发票', '信封', '收据', '折扣'],
      answer: 0,
      explanation: 'invoice /ˈɪnvɔɪs/ n. 发票。对话："Would you like an invoice?" 收据是 receipt，信封是 envelope。'
    },
    {
      id: 'p15', scene: '综合', type: 'listen_response',
      question: '听服务员的问题，选择正确的客人回应',
      audio: 'Do you have any allergies or other dietary restrictions?',
      options: [
        'No, we don\'t.（没有）',
        'Bill, please.（请结账）',
        'Still water.（静水）',
        'My membership number is 123456.'
      ],
      answer: 0,
      explanation: '服务员询问饮食限制，客人标准回应是 "No, we don\'t."（我们没有。）或说明具体过敏原。"Bill, please" 是结账用语。'
    },
    {
      id: 'p16', scene: 'L2 点餐', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'appetizer',
      options: ['开胃菜、前菜', '甜点', '主菜', '饮料'],
      answer: 0,
      explanation: 'appetizer /ˈæpɪtaɪzə/ n. 开胃菜。重音在第一音节 APP-e-ti-zer。'
    },
    {
      id: 'p17', scene: 'L3 结账', type: 'listen_identify',
      question: '听发音，选择你听到的单词',
      audio: 'receipt',
      options: ['receipt', 'recipe', 'respect', 'recent'],
      answer: 0,
      explanation: 'receipt /rɪˈsiːt/ n. 收据（注意 p 不发音）；recipe /ˈresəpi/ 是食谱。二者读音极易混淆。'
    },
    {
      id: 'p18', scene: 'L2 点餐', type: 'listen_meaning',
      question: '听发音，选择这个牛排熟度的中文说法',
      audio: 'medium rare',
      options: ['三分熟（偏生）', '五分熟', '七分熟', '全熟'],
      answer: 0,
      explanation: 'medium rare = 三分熟。牛排熟度由生到熟：rare → medium rare → medium → medium well → well done。'
    },
    {
      id: 'p19', scene: 'L3 结账', type: 'listen_scene',
      question: '听发音，这句话用于什么场景？',
      audio: 'Could I have the bill, please?',
      options: ['客人请求结账', '客人请求点菜', '客人请求加水', '客人请求订位'],
      answer: 0,
      explanation: '"Could I have the bill, please?" = 请给我账单，是客人结账的标准礼貌用语。'
    },
    {
      id: 'p20', scene: 'L2 点餐', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'vegetarian',
      options: ['素食者', '兽医', '蔬菜', '餐厅'],
      answer: 0,
      explanation: 'vegetarian /ˌvedʒəˈteəriən/ n. 素食者。重音在 -TE-。连蛋奶都不吃的是 vegan（纯素者）。'
    },
    {
      id: 'p21', scene: 'L1 客人抵达', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'no-show',
      options: ['预订后未到店的客人', '一场演出', '表现优异', '排队等候'],
      answer: 0,
      explanation: 'no-show n.（订位后）爽约的客人。餐饮行业常用术语。'
    },
    {
      id: 'p22', scene: 'L2 点餐', type: 'listen_meaning',
      question: '听发音，选择正确的中文意思',
      audio: 'house wine',
      options: ['本店招牌葡萄酒', '免费赠送的酒', '进口烈酒', '香槟'],
      answer: 0,
      explanation: 'house wine 指餐厅按杯供应的招牌酒，点单时说 "a glass of house red/white" 即可。'
    }
  ]
}

// 混合题单：交替排列
QUESTIONS.mixed = (function() {
  const comp = [...QUESTIONS.comprehension]
  const pron = [...QUESTIONS.pronunciation]
  const mixed = []
  const max = Math.max(comp.length, pron.length)
  for (let i = 0; i < max; i++) {
    if (i < comp.length) mixed.push(comp[i])
    if (i < pron.length) mixed.push(pron[i])
  }
  return mixed
})()
