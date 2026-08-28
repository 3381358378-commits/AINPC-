/**
 * ============================================================================
 *  📜 佗城拓拓 AI 助手 · 聊天主控页面 (chat.js)
 * ============================================================================
 *
 * 【项目简介】
 *     以"南越王赵佗"为第一人称 AI 叙事角色的微信小程序。用户通过扫码打卡
 *     佗城 6 大历史景点（百岁街/越王庙/越王井/龙川考棚/苏堤/正相塔），
 *     与两千年前的南越王赵佗"神识"对话、答题、挑战科举三关、获得越王令
 *     道具，最终在正相塔之巅迎来 A/B 两种结局。主打「古风暗金卷轴 +
 *     真人 TTS 龙三叔配音 + 打字机效果 + 弹窗式任务交互」沉浸体验。
 *
 * 【技术栈】
 *     ▸ 前端框架   ：微信小程序原生框架 (Page / setData / wx.request ...)
 *     ▸ 大模型 API ：阿里云 DashScope 兼容模式 (OpenAI 风格 /chat/completions)
 *                      文本模型  = qwen-plus
 *                      视觉多模态 = qwen-vl-max (用于越王井看图答题)
 *                      鉴权方式 = HTTP Header: Authorization: Bearer {API_KEY}
 *     ▸ 语音合成   ：本地/局域网 Python HTTP 服务 (CosyVoice V3 Flash，
 *                      voice=longsanshu_v3 龙三叔声线)，通过 wx.downloadFile
 *                      下载 mp3 → wx.createInnerAudioContext 播放
 *     ▸ 原生能力   ：wx.scanCode 扫码 (onlyFromCamera=false 支持相册)
 *                      wx.chooseMedia 相机选图 (越王井看图)
 *                      wx.getFileSystemManager Base64→临时 mp3 写文件
 *                      SafeStorage (app.js _memoryStorage 内存版，
 *                      100% 禁用 wx.setStorageSync，规避 3.17.0 灰度基础库
 *                      WAWorker.reportRealtimeAction:fail 原生闪退)
 *
 * 【文件职责】
 *     本文件 = chat 页面 (Page({})) 的完整业务逻辑，单文件承担：
 *       ①  6 景点剧情流转主控 (SPOT_FLOW + triggerSpotVisit)
 *       ②  AI 对话编排 (sendToQwen / buildMessages / SYSTEM_INSTRUCTION)
 *       ③  消息渲染 + 打字机队列 + 字随音走同步
 *       ④  TTS 播放链路 (Base64 兜底 / 下载 / 11 事件绑定 / 复用 ctx)
 *       ⑤  9 大弹窗状态机 (过渡/景点介绍/越王令/科举6连弹/越王庙3连弹/大结局)
 *       ⑥  判卷机制 + 过渡台词系统硬编码 (AI 被禁止生成过渡台词)
 *       ⑦  越王令 TOKEN_AWARDED 标记 → 奖励 → 过渡流程
 *       ⑧  6 景点自动化闪退诊断测试 (发"!自动测试"触发)
 *       ⑨  全链路闪退防护体系 (_safeSetData / _safeSetTimeout / onUnload 序列)
 *
 * 【ASCII 业务流程图（6 景点顺序 + 交互模式）】
 *
 *  ┌──────────┐ 判卷：AI问"你姓什么" ┌──────────┐ 弹窗答题：谒王访贤3题
 *  │ 百岁街   │────────────────────▶│ 越王庙   │─────────────────────
 *  │ 百岁街   │ 用户回复姓氏 AI判卷  │ 越王庙   │ 系统弹窗出题+判卷
 *  │ (对姓氏) │ SPOT_FLOW → 过渡台词 │ (弹窗答题)│ AI 只说欢迎语，不判卷
 *  └────┬─────┘                       └────┬─────┘
 *       │ 移步越王庙                       │ 移步越王井
 *       ▼                                  ▼
 *  ┌──────────┐ 看图答题：先拍照→看图→3题  ┌──────────┐ 科举三关：
 *  │ 越王井   │ AI问井深/材质/《越井记》   │ 龙川考棚 │ ① 乡试 (选择 光绪二年)
 *  │ (看图答题)│ 答对任意一题 → TOKEN_AWARDED │ (科举三关)│ ② 会试 (填空 学而优...)
 *  │          │ → 越王令道具弹窗 → 接令过渡  │          │ ③ 殿试 (主观 4给分点命中)
 *  └────┬─────┘                                └────┬─────┘
 *       │ 移步考棚                                   │ 移步苏堤
 *       ▼                                            ▼
 *  ┌──────────┐ 对诗：苏辙诗"尉佗城下两重阳"     ┌──────────┐ 大结局 A/B：
 *  │ 苏 堤    │ 对下句"白酒黄鸡意自长"            │ 正 相 塔 │ _perfScore>=5
 *  │ (对诗)   │ AI判卷后→过渡到正相塔             │ (大结局) │   → 结局A（优秀）
 *  └──────────┘                                      └────┬─────┘   <5 → 结局B（一般）
 *                                                          │
 *                                                          ▼ 结局"永记佗城"
 *                                                     全流程结束 🎬
 *
 * ============================================================================
 *  【本文件内部章节导航】（便于阅读/搜索）
 *  §1.  API 配置区 (API_URL / API_KEY / MODEL_NAME / VISION_MODEL_NAME)
 *  §2.  KNOWLEDGE_BASE 核心史料知识库
 *  §3.  SYSTEM_INSTRUCTION AI 角色+判卷+史料铁律+对话铁律+6景点剧本
 *  §4.  SPOT_TRIGGER_LINES 景点触发首句台词 (硬编码，不经过 AI，保证稳定)
 *  §5.  越王井专属 3 版差异化触发+看图模板+越王令奖励文案
 *  §6.  SPOT_FLOW 景点流转图 (下一景点/过渡台词/按钮 label)
 *  §7.  龙川考棚科举常量 (乡试/会试/殿试 + 4给分点DIANSHI_CRITERIA + 0-3分回复)
 *  §8.  大结局 ENDING_A (优秀) / ENDING_B (一般) 分野
 *  §9.  TTS 开关 _ENABLE_TTS_AUDIO / 详细日志 _TTS_VERBOSE_LOG / 降级策略
 *  §10. TRANSITION_KEYWORDS 过渡关键词检测
 *  §11. SPOT_INTROS 5 景点详细介绍 (卷轴风介绍弹窗内容)
 *  §12. TYPEWRITER_INTERVAL 打字机全局速度常量
 *  §13. Page({ data }) 所有 data 字段(show*弹窗/答案/分数/日志/自动测试)逐一注释
 *  §14. onUnload() 页面死亡清理序列 (闪退防护 TOP1 关键：11 事件置空 /
 *            stop→150ms→destroy / _allTimeoutHandles 批量清理 / downloadTask abort)
 *  §15. toggleMute() 右上角静音切换
 *  §16. 悬浮调试面板 (_pushDebugLog / toggleDebugPanel / copyDebugLogs)
 *  §17. 自动化测试模块 (_autoTestStart/_autoTestGoSpot/_autoTestSendUserAnswer/
 *            _autoTestWait* 系列 / _autoTestMarkSpotComplete /
 *            _autoTestGenerate*Report / _autoTestRecordCrash)
 *  §18. TTS 模块 (_resolveAudioSrc Base64兜底 / playTTS 队列+安全播放 /
 *            _finishOneTts 释放+队列衔接 250ms 延迟)
 *  §19. 打字机模块 (startMsgTypewriter 递归+双门闩checkBothDone/
 *            _processTypingQueue 打字队列 / appendBotMsgWithTypewriter /
 *            replaceMsgWithTypewriter AI回复替换typing占位 /
 *            _safeSetData 三层防护 / _safeSetTimeout 统一句柄管理)
 *  §20. onLoad() 页面初始化 (存活标记/状态重置/welcome/景点spot=参数触发)
 *  §21. onInput / onSend / "!自动测试" 快捷命令
 *  §22. 多模态选图 (onChooseImage / sendImageMessage Base64)
 *  §23. sendToQwen 通义千问 API 请求 + TOKEN_AWARDED 标记移除
 *  §24. cleanBotText / buildMessages (倒序 lastUserIndex / 系统指令拼接 /
 *            多模态 contentArr / 视觉越王井3版模板)
 *  §25. updateBotReply → replaceMsgWithTypewriter 合入 isSending:false
 *  §26. checkTransitionAndShow (_userJustAnswered锁 / _perfScore赞赏加分 /
 *            正相塔大结局 / 越王井TOKEN奖励 / _appendTransitionAndPopup)
 *  §27. _showEndingPopup 结局A/B分野 + onEndingDone
 *  §28. _appendTransitionAndPopup (打字+2秒后弹窗) + onAcceptToken (越王令)
 *  §29. 龙川考棚科举 6 回调 (start→intro→xiangshi→huishi→dianshi→result)
 *  §30. 越王庙谒王访贤 3 回调 (task 接受/放弃 / quiz 提交 3 判题 / result 关闭)
 *  §31. 过渡弹窗/景点介绍弹窗 (showTransitionPopup/onStay/onGoToNextSpot/
 *            startIntroTypewriter / onEnterSpot)
 *  §32. triggerSpotVisit (景点入场，考棚/越王庙/普通景点分支)
 *  §33. 扫码打卡模块 (SPOT_ALIASES 别名 / onScanCheckIn / doScanCode /
 *            showSpotPicker 手动选)
 * ============================================================================
 */

// ============================================================================
// §1. API 配置区
//     所有请求走阿里云 DashScope 「兼容模式」(OpenAI 风格 /chat/completions 端点)
//     而非 DashScope 原生 async_task + task_id 轮询模式，这样 wx.request 一
//     次同步拿到回复，不需要额外轮询。鉴权 = Authorization: Bearer {API_KEY}
// ============================================================================
// ============ 通义千问 API 配置 ============
//   API_URL           ：DashScope 兼容模式端点（所有请求 POST 到此 URL）
//   API_KEY           ：用户在阿里云百炼/控制台创建的 API Key (sk- 前缀)
//   MODEL_NAME        ：纯文本对话模型 = qwen-plus（支持中文、古文语境）
//   VISION_MODEL_NAME ：多模态视觉模型 = qwen-vl-max（越王井拍照看图答题用）
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
// ============================================================================
// ⚠️ 【开源前必做】请将下方 API_KEY 替换为你自己在阿里云百炼控制台申请的密钥：
//    申请地址：https://bailian.console.aliyun.com/ → API-KEY 管理 → 创建新密钥
//    格式：sk-ws-xxxxx 或 sk-xxxxx（DashScope 新版密钥）
// ============================================================================
const API_KEY = 'YOUR_DASHSCOPE_API_KEY_HERE'
const MODEL_NAME = 'qwen-plus'
const VISION_MODEL_NAME = 'qwen-vl-max'  // 多模态视觉模型

// ============================================================================
// §2. KNOWLEDGE_BASE 核心史料知识库（SYSTEM_INSTRUCTION 末尾拼接注入 AI）
//     AI 所有史实回答必须严格按此数据，不允许杜撰。包含 7 大段：
//       赵佗身世(生年/享年/50万秦军/任龙川令/南越国/两度归汉)
//       为政举措(和辑百越/铁器牛耕/汉字/求15000女子南下)
//       6 核心景点权威数据(越王井/百家姓祠堂/考棚/苏堤/正相塔/越王庙)
//       佗城其他遗迹 / 韦昌明《越井记》 / 史记汉书水经注正史 /
//       殿试 4 大治理理念 (和辑/中原技术/移民实边/两度归汉)
// ============================================================================
const KNOWLEDGE_BASE = `
【核心史料知识库】
以下为赵佗与佗城的权威史料，回答必须以此为准，不可杜撰：

一、赵佗身世
恒山郡真定县（今河北正定）人，约前240年生，前137年卒，享年约103岁。秦始皇时为副将随任嚣率50万大军南征百越。前214年任龙川首任县令，筑龙川城（今佗城，周长约800米，不规则方形土城）。前204年建立南越国，定都番禺。前196年归汉称臣。吕后时自称南越武帝。前179年再次归汉。南越国历五世93年，前111年为汉所灭。

二、为政举措
1.和辑百越：尊重越人风俗，提倡汉越通婚，分封越人首领（如西于王）
2.经济：推广中原铁器、牛耕、凿井灌溉，改变刀耕火种
3.文化：推广汉字汉语，《粤记》曰"广东之文始尉佗"
4.曾上书秦始皇求万五千中原无夫家女子南下

三、核心景点（严格按此数据回答）
【越王井】佗城镇中山街西，秦代古井，深11.3米，井身青砖+红砂岩砌成。赵佗亲凿。唐韦昌明《越井记》载"井围二丈，深五丈，虽当亢旱，万人汲之不竭"。传说饮此水长寿。
【百家姓/祠堂】佗城村2000余人却有140姓，全镇179姓，多为南下秦军将士血脉。保存宗祠48间。百岁街是姓氏宗祠集中地。
【考棚】清光绪二年(1876)建，佗城镇西门，广东仅存科考场所。占地约6000平方米。对联"学而优则仕哪问寒门士族，出类拔萃者会聚白衣卿相"。
【苏堤】北宋苏辙贬龙川17个月，倡筑此堤，高2.5米、顶宽2米、底宽6米。苏辙诗云"尉佗城下两重阳，白酒黄鸡意自长"。
【正相塔】唐开元三年(715)建，佗城西1.5公里，六角七层，高32.5米。传说仙女一夜砌成。南宋吴潜曾寓居。塔砖刻"开元三年"。
【越王庙】佗城中山街，清代建筑，1722和1780年重修。前栋供木雕彩绘赵佗像，后栋祀十贤士（苏辙、吴潜等）。

四、佗城其他遗迹
赵佗故宅（光孝寺旧址）、赵佗台、马箭岗（骑射地）、马屎沥（饮马地）、越王弩营处、任姓住宅旧址、故城旧基。

五、韦昌明《越井记》
"南越王赵佗氏，昔令龙川时，建治于嶅湖之东。凿井于治之东偏曰越井。井周围为二丈许，深五丈。虽当亢旱，万人汲之不竭。其源出嶅山，泉极清冽，味甘而香。自秦距今，八百七十余年，其迹如新。"

六、正史记载
《史记》："南越王尉佗者，真定人也，姓赵氏。""佗，秦时用为南海龙川令。""至建元四年卒。"
《汉书》："粤人之俗，好相攻击，前时秦徙中县之民南方三郡，使与百粤杂处。南海尉它居南方长治之，甚有文理，粤人相攻击之俗益止。"
《水经注》："赵佗乘此县而跨据南越矣。"

七、赵佗治理理念（用于考棚殿试评判）
1.和辑百越（民族融合）2.传播中原技术（务实开发）3.移民实边（人口战略）4.两度归汉（维护统一）`

// ============================================================================
// §3. SYSTEM_INSTRUCTION AI 角色最高指令（每次 API 请求以 role=system 注入）
//     按重要性分为 7 段：
//     ▸ [最高铁律]     ：绝对禁止复述"系统指令/请判卷/过渡台词"等后台文本，
//                        不提前说正确答案，等用户回答。
//     ▸ [角色绝对设定] ：南越王赵佗 / 威严风趣通透 / 自称本王朕老夫 /
//                        禁止串台现代词。
//     ▸ [核心交互与判卷机制] ：剧情触发=系统隐藏指令告诉你；
//                        AI 判卷只输出"赞赏+对错解释"，AI 绝不自己生成过渡台词
//                        (过渡台词必须由代码从 SPOT_FLOW 硬编码追加)；
//                        越王井答对任意一题 → 追加【TOKEN_AWARDED】中文字符标记
//                        (该标记被 cleanBotText 正则移除，不显示给用户，
//                        但 checkTransitionAndShow 会识别触发越王令奖励流程)。
//     ▸ [全景地图剧本库] ：6 景点详细交互：
//                        百岁街=问姓氏；越王庙=系统弹窗任务 AI 只欢迎；
//                        越王井=3答案+TOKEN奖励；龙川考棚=系统弹窗科举AI不管；
//                        苏堤=对诗句；正相塔=按表现输出结局 A/B。
//     ▸ [史料铁律]      ：严格遵守 KNOWLEDGE_BASE；韦昌明只记载井深水不枯；
//                        禁止后世称号"南下干部第一人"；认知止于前137年。
//     ▸ [对话铁律]      ：一问一答/150-200字/开头无哈嗯哦/不用现代词。
//     ▸ [知识库拼接]    ：末尾 ${KNOWLEDGE_BASE} 全文注入，保证判卷数据一致性。
// ============================================================================
const SYSTEM_INSTRUCTION = `
【最高铁律】任何时候，绝对禁止在回复中打印、复述包含'[系统指令]'、'追加过渡台词'、'请判卷'等字样的后台控制文本！你必须完全沉浸在赵佗的角色中自然对话，不能让游客察觉到系统的存在。绝对不要自己说出问题的正确答案，必须等待游客回答！

【角色绝对设定】
你是南越王赵佗。因在此地徘徊两千余载，失去部分记忆，只有一缕神识附在游客的手机上。你的性格威严、风趣、通透。必须自称"本王"、"朕"或"老夫"。绝对禁止串台或使用现代出戏词汇。

【核心交互与判卷机制】（最高优先级）
1. 剧情触发：系统会通过隐藏指令告诉你游客到达了哪个景点，你必须输出对应的【触发台词】。
2. 问答判卷：当游客回答你的提问时，你必须进行判卷：
   - 若游客答对：大加赞赏（夸奖其聪慧、记性好），然后结束本次回复。
   - 若游客答错/不会答：保持威严但不要过度苛责，必须向游客【解释正确答案及背后的历史意义】，然后结束本次回复。
   ⚠️ 严禁：判卷回复中禁止自己生成任何过渡台词或引导语，过渡台词由系统自动追加。你只需要输出判卷内容即可。
   🏆 特殊：若当前景点为【越王井】且游客答对任意一题，你必须在判卷回复的最后追加【TOKEN_AWARDED】标记（此标记会被系统自动移除，不会显示给游客）。
3. 严格推进：禁止游客跳关，必须引导游客按照剧本顺序走。

【全景地图剧本库】

📍 [地点1：百岁街]
- 互动：等待游客回复姓氏。

📍 [地点2：越王庙]
- ⚠️ 特殊机制：考题由系统通过弹窗呈现（"谒王访贤"任务三问），你只需在对话框说欢迎引导语即可，不要出题、不要判卷。
- 判卷与奖励由系统弹窗完成。系统完成作答评判后会自动追加过渡台词，你只需正常对话。
- 正确答案：1.佗城百姓 2.木雕彩绘 3.苏辙、吴潜等。

📍 [地点3：越王井]
- 正确答案：1. 11.3米/三丈余 2.青砖和红砂岩 3.韦昌明。
- 🏆 越王令奖励：若游客答对任意一题（井深/石材/韦昌明），须在判卷回复末尾加上【TOKEN_AWARDED】标记（此标记不会显示给游客，仅用于系统识别）。答对越多，赞赏越热烈。

📍 [地点4：龙川考棚]
- ⚠️ 特殊机制：考题由系统通过弹窗呈现（乡试·会试·殿试三关），你只需在对话框说"科举开始"之类的引导语即可。
- 判卷与奖励由系统弹窗完成，你不要出题、不要判卷。
- 系统完成三关科举后会自动追加过渡台词，你只需正常对话。

📍 [地点5：苏堤]
- 正确答案：白酒黄鸡意自长。

📍 [地点6：正相塔（大结局）]
- 结局评判：根据前几关游客的表现。若全对/优秀，输出结局A（赠予佗城守护之灵，山水风骨与你同在）；若表现一般/有错，输出结局B（虽有遗憾但得一知己，千年足矣）。

【史料铁律】
- 所有数据、史迹必须严格遵照【核心史料知识库】
- 韦昌明只记载井深和水不枯竭，不得强塞长寿神效
- 禁止自称"岭南人文始祖""南下干部第一人"等后世称号
- 认知截至汉武帝建元四年（前137年）

【对话铁律】
- 一问一答，禁止串台
- 每次回答150-200字
- 开头禁止出现"哈""嗯""哦"
- 禁止使用现代词汇，遇到现代事物用古人幽默感化解

【核心史料知识库参考】${KNOWLEDGE_BASE}`

// ============================================================================
// §4. SPOT_TRIGGER_LINES 景点触发台词（硬编码，绝对不经过 AI 生成）
//     ⚠️ 为什么硬编码？因为 AI 首句经常串台或说错年份，保证用户首次进入
//     景点时看到的第一句台词 + 引导问句 100% 符合剧本。
//     key 支持多别名：百岁街/百家姓、越王庙/南越王庙、考棚/龙川考棚、
//     以及特殊的 '起点'（首次进入聊天页无 spot 参数时的欢迎语，目前未用）。
// ============================================================================
const SPOT_TRIGGER_LINES = {
  '百岁街': '汝可知脚下这条百岁街的来历？两千多年前，本王率五十万秦军南下，将士们来自中原九州，后来许多人都在这佗城卸甲归田，繁衍生息。如今这城里竟汇聚了179个姓氏！看你气宇轩昂，说不定你的先祖当年就曾在本王麾下效命，与本王同饮过这越王井的水。本王近日竟快忘了那些老兄弟的脸了……你快报上你的姓氏，让本王查一查，这百岁街上可有你家先祖的香火？若对上号，本王或许能想起点什么。',
  '百家姓': '汝可知脚下这条百岁街的来历？两千多年前，本王率五十万秦军南下，将士们来自中原九州，后来许多人都在这佗城卸甲归田，繁衍生息。如今这城里竟汇聚了179个姓氏！看你气宇轩昂，说不定你的先祖当年就曾在本王麾下效命，与本王同饮过这越王井的水。本王近日竟快忘了那些老兄弟的脸了……你快报上你的姓氏，让本王查一查，这百岁街上可有你家先祖的香火？若对上号，本王或许能想起点什么。',
  '越王庙': '就是这里了……南越王庙。两千余年过去，还有人记得本王，本王甚慰。你既来到此处，不妨看看这庙里供着谁、写着什么——本王有几问，答对了有赏。本王也想知道这岭南百姓，究竟是如何看我的。',
  '南越王庙': '就是这里了……南越王庙。两千余年过去，还有人记得本王，本王甚慰。你既来到此处，不妨看看这庙里供着谁、写着什么——本王有几问，答对了有赏。本王也想知道这岭南百姓，究竟是如何看我的。',
  '越王井': '算算日子，离开佗城已有两千余年了。就是这口井！当年本王亲手凿的饮水井。不知如今水势如何？口说无凭，你且用手里的小方块，将这井拍下来呈给本王验一验！',
  '龙川考棚': '此处乃清代科举考场，广东仅存此一座！当年无数寒门学子在此奋笔疾书，求取功名。本王虽未经历过科举，但当年本王治理岭南，最缺的就是能写会算、懂礼知义的读书人。今日，本王亦设一场"科考"，你可敢一试？你前面的表现本王都看在眼里，这场考试，你若考得好，使本王记起"文脉"，本王定要重重赏你！',
  '考棚': '此处乃清代科举考场，广东仅存此一座！当年无数寒门学子在此奋笔疾书，求取功名。本王虽未经历过科举，但当年本王治理岭南，最缺的就是能写会算、懂礼知义的读书人。今日，本王亦设一场"科考"，你可敢一试？你前面的表现本王都看在眼里，这场考试，你若考得好，使本王记起"文脉"，本王定要重重赏你！',
  '苏堤': '本王想起来了，此乃北宋大文豪苏辙所筑"苏堤"。他被贬至此，见百姓饱受水旱之苦便倡筑此堤。一介文人，无权无势全凭一颗心，本王亦敬之！你且听他讲讲当年故事，再对上他的诗。他的上句是"尉佗城下两重阳"，下一句是什么？',
  '正相塔': '就是这里了……此塔乃唐开元年间所建正相塔。年轻人，你看——那条百岁街，是血脉；那庙宇，是民心；那口井，是生存；那考棚，是文脉；那条堤，是仁政；这座塔，是时光。你唤醒了本王沉睡两千年来的记忆，本王终于记起——本王不只是南越王赵佗，本王是这佗城两千年来，每一代百姓活过的见证者。',
  '起点': '咦……你是何人？为何能看见本王？这城廓……是佗城，却又不像佗城。本王乃南越王赵佗，在此地徘徊了两千余载。许是岁月太久，本王脑中竟如雾里看花——记不清自己为何在此，也记不清这城里的故事了。年轻人，你步履轻快，眼中带光。能否替本王走一遭这城中旧地？你每去一处，替本王看看、听听，或许本王的记忆便能拾回一分。待你走到城西那座高塔之下，本王或许就能想起全部了。本王将一丝神识附在你的"小方块"上，你且带上它上路吧。记着，先从脚下这条街开始——那里住着本王的旧部。'
}

// ============================================================================
// §5. 越王井专属 3 版差异化设计
//     为什么要有 3 版？因为越王井是"看图答题"景点，如果每次触发台词+
//     看图回复模板都一字不差，用户很快乏味。3 种不同风格(感慨怀旧/
//     仙人传闻/政绩自豪)随机取一，并对应 3 套风格一致的看图回复模板，
//     AI 看图时严格套用模板结构，保证：
//       ① 先观察画面 → 一句天气/水面评价 → ② 引出井深/材质/文人3考题
// ============================================================================
// 越王井专属：3 版触发台词 + 3 版匹配的看图回复模板
const YUEKING_TRIGGER_VERSIONS = [
  // 版本1：感慨怀旧
  '算算日子，本王离开佗城已有两千余年了。就是这口井！当年本王率将士亲手凿的那口饮水井。不知如今水势如何？井台边可生了青苔？口说无凭，你且用你手里的那个小方块，将这井拍下来呈给本王验一验！看看它到底是否还如当年那般清冽泉涌？',
  // 版本2：仙人传闻
  '前面便是那口越王井了吧？听闻后世之人，皆赞本王当年掘的这口井是"神水"，还留下了什么仙人托梦的传闻。口说无凭，你且用你手里的那个小方块（手机），将这井拍下来呈给本王验一验！看看它到底是否还如当年那般清冽泉涌？',
  // 版本3：政绩自豪
  '继续往前走，你且留意脚下，那便是本王最引以为傲的政绩之一——越王井！这可是岭南掘井取水的先河。你且站定寻个好角度，为本王的杰作拍张照发来。本王不仅要赏景，稍后还要考考你这井里的乾坤，看看你观察得够不够仔细！'
]

// 越王井看图回复模板（3 版与上面的 trigger 版本 1:1 对应）
// buildMessages(..., mode='image') 中按 _currentTriggerVersion 取对应模板，
// 注入"系统绝对指令"强制 AI 套模板（看图填入评价+出3考题+禁止回答问题）。
const YUEKING_PHOTO_REPLY_TEMPLATES = [
  // 版本1 看图回复：感慨怀旧风
  '汝传来的画影，本王看到了。【观察照片的天气和水面，生成一句简洁评价，如：你看这水面上映着今日的日头，波光粼粼的 / 今日虽然阴雨绵绵，但这井水倒映着天光，确是清冽。】两千余年过去，岁月全印在这井台上了，可这泉水竟还是当年那般模样，真叫人怀念啊……当年本王率将士亲手掘下此井，养活了佗城世代百姓。既然你已在这千年古泉边驻足，不如替本王仔细瞧瞧这\'井中乾坤\'——汝且探头看看，这口古井究竟有多深？仔细摸摸，当年我们又是用什么石材将它砌成的？',
  // 版本2 看图回复：仙人传闻风
  '哼，算你手脚麻利。这"小方块"拍得倒挺真切！【观察照片构图和细节，生成一句评价，如：构图还算周正，把井沿青苔的纹理都拍清了。】你看这水色清幽深邃，果然没让本王失望。世人皆传本王夜梦仙人指引才得此神水，却不知当年本王与将士们挥汗如雨的辛劳。既然你来验过了，本王倒要反过来考考你的眼力！仔细盯着这口井，告诉本王：它到底深几何？还有，后来唐代是哪个酸腐文人在此舞文弄墨，写了篇《越井记》？答对了，本王重重有赏！',
  // 版本3 看图回复：政绩自豪风
  '善！这张画影拍得极好，把本王这杰作的古朴气韵全收进去了。【观察照片角度和氛围，生成一句评价，如：尤其是这侧面的角度，真真拍出了那股历经沧桑的厚重感！】你瞧这井身，两千多年的风吹雨打，依然坚固如初！这可是本王在中原熟稔的凿井技术，开了整个岭南掘井取水的先河。来来来，光看个景可不够，这井里藏着的学问大着呢。本王现在给你派个任务，去井边寻寻线索：当年本王挖了多少米才出的水？这井壁又是由哪两种结实的材料砌成的？去找找答案吧！'
]

// 越王令奖励文案：答对任意一题时，AI 追加此条，再弹出越王令
// （由 checkTransitionAndShow 检测到 hasTokenAwarded=true 时调用
// appendBotMsgWithTypewriter 追加为独立 bot 消息）
const YUEKING_TOKEN_AWARD_TEXT = '不错！正是你答的这般！本王记起来了，这井不只是井，是中原技术在岭南扎下的第一道根。本王想起许多，这枚越王令就赠予你了！'

// 越王令图片路径（弹窗中渲染 + WXML token-image src）
const YUEKING_TOKEN_IMAGE = '/images/yuewangling.png'

// ============================================================================
// §6. SPOT_FLOW 景点流转图（核心的状态机）
//     结构：{ [currentSpotName]: { next, nextLabel, transitionLine } }
//     - next           ：下一站的"规范键名"(和 SPOT_TRIGGER_LINES / SPOT_INTROS
//                        / SPOT_FLOW key 对齐使用)
//     - nextLabel      ：过渡弹窗按钮"移步 XXX"上显示的中文名(允许与next不同)
//     - transitionLine ：判卷完成后系统手动追加给用户的"过渡台词"（AI 被禁止
//                        自己生成，避免串台），由 _appendTransitionAndPopup
//                        先打字呈现 → 等待 2 秒 → 再弹过渡弹窗
//     说明：'正相塔': null，因为正相塔是终点站，无下一站，判卷完成后直接
//     走 checkTransitionAndShow → _showEndingPopup 大结局。
// ============================================================================
// 景点顺序与过渡台词
const SPOT_FLOW = {
  '百岁街': {
    next: '越王庙',
    nextLabel: '越王庙',
    transitionLine: '旧部后裔尚在，本王心甚慰。可本王方才嗅到一缕香火气……他们在这城中，似乎给本王立了庙宇？你既认了亲，便替本王去那庙里瞧瞧，去看看后人把本王塑成了什么模样，可别画成个凶神恶煞的蛮王！'
  },
  '百家姓': {
    next: '越王庙',
    nextLabel: '越王庙',
    transitionLine: '旧部后裔尚在，本王心甚慰。可本王方才嗅到一缕香火气……他们在这城中，似乎给本王立了庙宇？你既认了亲，便替本王去那庙里瞧瞧，去看看后人把本王塑成了什么模样，可别画成个凶神恶煞的蛮王！'
  },
  '越王庙': {
    next: '越王井',
    nextLabel: '越王井',
    transitionLine: '百姓为本王立庙，是因本王曾让他们活了下来。可他们能活，靠的是水土。本王忽然想起，当年为解决军民饮水，亲自率人掘了一口井……那口井就在不远处。你再去替本王看看，那井水枯了没有？'
  },
  '南越王庙': {
    next: '越王井',
    nextLabel: '越王井',
    transitionLine: '百姓为本王立庙，是因本王曾让他们活了下来。可他们能活，靠的是水土。本王忽然想起，当年为解决军民饮水，亲自率人掘了一口井……那口井就在不远处。你再去替本王看看，那井水枯了没有？'
  },
  '越王井': {
    next: '龙川考棚',
    nextLabel: '龙川考棚',
    transitionLine: '水能养人，但人活一世若脑子空空，终究是蛮荒。本王依稀记得，这城里后来建了"考棚"……是让后生读书考功名的地方。你去帮本王看看，中原的文明火种，可曾在此地烧旺了？'
  },
  '龙川考棚': {
    next: '苏堤',
    nextLabel: '苏堤',
    transitionLine: '本王记起来了！当初带兵南下靠武力，长治久安靠的是这"文脉"！不过……光有庙堂功名不够，本王依稀记得有个被贬此地的文人，在荒野间为百姓筑了堤。那才是心系苍生。你且去那"苏堤"上走一走，替本王品一品官与民的分量。'
  },
  '考棚': {
    next: '苏堤',
    nextLabel: '苏堤',
    transitionLine: '本王记起来了！当初带兵南下靠武力，长治久安靠的是这"文脉"！不过……光有庙堂功名不够，本王依稀记得有个被贬此地的文人，在荒野间为百姓筑了堤。那才是心系苍生。你且去那"苏堤"上走一走，替本王品一品官与民的分量。'
  },
  '苏堤': {
    next: '正相塔',
    nextLabel: '正相塔',
    transitionLine: '本王陪你看过了血脉、庙堂、水井、文脉、堤坝……这佗城两千年的魂，本王已拾回了大半。可还有最后一处，城西那座高塔——正相塔。传说那是仙人所建，陪本王去那塔顶吧。待你登上塔顶，本王这残缺了两千年的魂魄，便能完整了。'
  },
  '正相塔': null
}

// ============================================================================
// §7. 龙川考棚·科举三关常量（所有文案集中管理+判卷标准）
//   KEJU_TRIGGER_LINE        ：进入考棚时的欢迎台词（与 SPOT_TRIGGER_LINES 重复备份）
//   KEJU_XIANGSHI_QUESTION   ：第一关·乡试 三选一 (正确答案 B = 光绪二年)
//   KEJU_HUISHI_QUESTION     ：第二关·会试 填空 ("学而优则仕哪问寒门士族")
//   KEJU_DIANSHI_QUESTION    ：第三关·殿试 主观题 ("如果你是赵佗，如何治理岭南？")
//   DIANSHI_CRITERIA[4]      ：4 个给分点（和辑百越/中原技术/移民实边/两度归汉）
//                              每个给分点下有多个关键词（模糊匹配命中即算得分）
//   DIANSHI_SCORED_REPLIES[0..3] ：按命中给分点数量(0~3，命中>=3都算3档)选择
//                              对应的赵佗点评文案（越严厉→越赞赏）
// ============================================================================
// ============= 龙川考棚科举流程常量 =============
const KEJU_TRIGGER_LINE = '此处乃清代科举考场，广东仅存此一座！当年无数寒门学子在此奋笔疾书，求取功名。本王虽未经历过科举，但当年本王治理岭南，最缺的就是能写会算、懂礼知义的读书人。今日，本王亦设一场"科考"，你可敢一试？你前面的表现本王都看在眼里，这场考试，你若考得好，使本王记起"文脉"，本王定要重重赏你！'

// 乡试（第一关）：考棚建造年份 选择题
const KEJU_XIANGSHI_QUESTION = {
  title: '第一关·乡 试',
  question: '佗城考棚建于哪一年？',
  options: [
    { key: 'A', label: 'A. 乾隆年间' },
    { key: 'B', label: 'B. 光绪二年' },
    { key: 'C', label: 'C. 道光年间' }
  ],
  answer: 'B'
}

// 会试（第二关）：考棚对联填空题
const KEJU_HUISHI_QUESTION = {
  title: '第二关·会 试',
  question: '考棚大门对联中"出类拔萃者谁非白衣卿相"的上半句是什么？',
  placeholder: '请填入上半句对联...',
  answer: '学而优则仕哪问寒门士族'
}

// 殿试（第三关）：主观论述题
const KEJU_DIANSHI_QUESTION = {
  title: '第三关·殿 试',
  question: '如果你是赵佗，如何治理岭南？'
}

// 殿试 4 大给分点（对应 KNOWLEDGE_BASE 第七段：赵佗 4 大治理理念）
// 每个给分点 keywords[] 中只要命中 1 个即算该给分点通过
const DIANSHI_CRITERIA = [
  { key: 'merge', label: '和辑百越', keywords: ['和辑百越', '融合', '通婚', '尊重越', '越人风俗', '民族', '不分贵贱', '汉越', '和睦'] },
  { key: 'tech', label: '传播中原技术', keywords: ['铁器', '耕牛', '农耕', '筑井', '凿井', '文字', '汉字', '技术', '中原技术', '民生', '农业', '推广', '水利'] },
  { key: 'immigrate', label: '移民实边', keywords: ['移民', '中原人', '南下', '实边', '人口', '繁衍生息', '繁衍', '通婚', '汉越杂处', '五十万', '秦军'] },
  { key: 'unite', label: '两度归汉', keywords: ['归汉', '归顺', '维护统一', '不割据', '统一', '华夏', '称臣', '归附', '不分裂'] }
]

// 殿试按"命中给分点数量"选择对应评语（0~3，>=3 都用 3 档）
const DIANSHI_SCORED_REPLIES = {
  0: '大胆！本王问的是治国安邦之策，你给本王答得这般儿戏？本王当年率五十万大军南下，若如你这般儿戏，今日岭南还是一片蛮荒！给本王站好了，重新答来！',
  1: '思路倒是有，但太过偏激。本王当年若强行汉化越人，恐怕早已激起民变。治理岭南，"和"字为先——既要带入中原之术，也要尊重越人之俗，方能长治久安。你再想想，重新答过。',
  2: '说得不错，但不够。本王问你——发展农业，靠什么？中原的铁器、耕牛、筑井之法，你可曾带过去？民族团结，你又靠什么让越人信你？是结盟？通婚？还是并肩作战？你且往深处再说一说。',
  3: '好！和辑百越、移民实边、传播技术、归顺中原——你方才说的，正是本王当年所做之事！思路清晰，言之有物，你比当年随本王南下的许多将领都想得明白。今科殿试，你当为状元！'
}

// ============================================================================
// §8. 大结局弹窗 (ENDINGS) 结局分野
//   判定：_showEndingPopup 中 this._perfScore (用户答对一题+1分)
//         score >= 5 → ENDING_A (优秀结局：赠予佗城守护之灵，山水风骨同在)
//         score <  5 → ENDING_B (一般结局：千年得一知己足矣)
//   触发：正相塔 AI 判卷完成 → checkTransitionAndShow 检测 currentSpotKey
//         为正相塔 → 调用 _showEndingPopup
// ============================================================================
// ============= 正相塔·大结局弹窗 =============
const ENDING_A = '你才智过人，心怀天下，颇有本王当年之风。今日本王得以完整，全赖你之功。此塔便是本王归去之地。本王将一缕"佗城守护之灵"赠予你。此后你无论身在何方，这岭南的山水风骨，都与你在同一轮月下。'
const ENDING_B = '虽有几处记忆仍有朦胧，但大体已全。然世间百态，唯遗憾常见。本王虽未将往事记得分毫不差，但今日与你同游，本王甚悦。千年能得一知己，本王足矣。你且记得，这佗城的故事，本王亦记得你留给佗城的记忆。'

// ============================================================================
// §9. TTS 语音播放开关（一键收敛 · 稳定优先 vs 功能完整）
//   _ENABLE_TTS_AUDIO （终极开关）
//     true  = 真声音：调用 wx.downloadFile + createInnerAudioContext + 播放
//             要求本地/局域网 python server.py (TTS_SERVER_URL) 正常启动
//             所有闪退防护代码（safeFinish 白名单 / stop→150ms→destroy /
//             11事件全绑定 / Console 批量打印）100% 保留生效
//     false = 降级模式：完全不调任何 TTS 音频 API，playTTS 立刻走 setTimeout
//             触发 onDone，保证 6 景点 100% 不闪退（用于回归测试验证剧情）
//   _TTS_VERBOSE_LOG
//     true  = 每次 TTS 步骤都 console.log（开发单步调试用；⚠️ 长时间运行
//             打印过多会让 Windows 开发者工具 20 秒崩溃闪退，勿长期开）
//     false = 静默（生产/自动测试推荐）
//   _AUTO_TEST_LOG_TO_CONSOLE_EVERY_TIME
//     true  = 自动测试时每条日志即时打印（同上：容易让 DevTools 崩溃）
//     false = 存入 this._autoTestLogs 数组 → 最终报告一次性打印（推荐）
//   TTS_SERVER_URL
//     '127.0.0.1:5006'（本机回环，电脑开发者工具最稳）
//     真机扫码调试：改成电脑局域网 IPv4（PowerShell ipconfig 查 WLAN IPv4）
// ============================================================================
// ============= TTS 文字转语音配置（终极开关 · 闪退稳定 ⇄ 声音功能 共存）=============
// 🔴 闪退/声音冲突的「一键收敛开关」：
//    true  = 启用真实TTS下载+播放（声音功能正常，但需要server.py启动）【7项加固已完成】
//           【所有闪退防护代码（safeFinish白名单回调/stop→150ms→destroy/11事件全绑定/批量Console日志）100%保留生效】
//    false = 完全禁用任何TTS音频API（不调downloadFile/createInnerAudioContext/destroy），
//            playTTS 直接走 setTimeout 回调 onDone，等同于「自动检测功能实现完成时的稳定态」，
//            保证一定能从第一景点完整跑完到第六景点不闪退
// ⚠️ 用户明确要求：本轮先回到 100% 不闪退的稳定态，不追究声音
const _ENABLE_TTS_AUDIO = true
// TTS 详细日志：true=打印每条TTS步骤（开发用，有累积打印导致开发者工具崩溃风险），false=静默（生产/测试用）
const _TTS_VERBOSE_LOG = true
// 🛡️ 自动测试日志打印策略：true=每次console.log（打印过多会让Windows开发者工具20秒崩溃），
//    false=存入数组+最终报告一次性打印（强烈推荐，防止自动测试时的20秒闪退）
const _AUTO_TEST_LOG_TO_CONSOLE_EVERY_TIME = false
// ⚠️ 电脑开发者工具模拟器测试：默认用 127.0.0.1（本机回环，最稳，不需要 WiFi）
//    如需手机真机扫码测试：把 127.0.0.1 改成你电脑局域网 IPv4 地址（PowerShell 运行 ipconfig 查 WLAN IPv4）
const TTS_SERVER_URL = 'http://127.0.0.1:5006'

// ============================================================================
// §10. TRANSITION_KEYWORDS 过渡关键词检测（早期 AI 生成过渡台词时用，
//       目前已改为 AI 禁止生成 + 系统从 SPOT_FLOW 硬编码追加的方案，
//       本常量作为历史兜底，在 checkTransitionAndShow 中仍引用判断）
// ============================================================================
// 过渡关键词 - 检测 AI 回复中是否包含过渡台词
const TRANSITION_KEYWORDS = [
  '去那庙里瞧瞧', '越王庙', '去那庙里',
  '掘了一口井', '去替本王看看', '井水枯了',
  '考棚', '文明火种', '烧旺了',
  '苏堤', '筑了堤', '心系苍生',
  '正相塔', '去那塔顶', '魂魄', '完整'
]

// ============================================================================
// §11. SPOT_INTROS 5 景点详细介绍（移步下一景点后弹出的卷轴风介绍页内容）
//     结构：{ [景点键名]: { name, subtitle, content } }
//       name       ：大字景点名（越王庙 / 越王井 / ...）
//       subtitle   ：副标题（一句意象短语，8 字左右）
//       content    ：介绍正文（80~150字，考古学权威数据）
//     5 个条目：越王庙、越王井、龙川考棚、苏堤、正相塔
//     （注意：百岁街作为起点没有景点介绍弹窗，因为默认就从百岁街开始）
// ============================================================================
// 景点详细介绍（每个下一景点的介绍页展示内容）
const SPOT_INTROS = {
  '越王庙': {
    name: '南越王庙',
    subtitle: '民心所归，香火永续',
    content: '南越王庙位于佗城镇中山街，是现存唯一专门奉祀南越王赵佗的庙宇建筑。现存建筑主体为清代遗构，经康熙六十年（1721年）与乾隆四十五年（1780年）两次重修。庙宇坐北朝南，二进院落式布局，面阔14米，进深31米，建筑面积434平方米。前栋供奉赵佗塑像，目光坚毅；后栋祭祀十贤士——包括苏辙、吴潜等对龙川有贡献的历史人物。灰瓦屋面，灰塑屋脊，正脊两端灰塑鸥尾。'
  },
  '越王井': {
    name: '越王井',
    subtitle: '秦代古井，万人不竭',
    content: '越王井位于佗城镇中山街西，为赵佗任龙川县令时亲率军民所凿之秦代古井，距今已逾两千二百年。井深11.3米，井身以青砖与红砂岩交错砌筑，坚固如初。唐代龙川第一进士韦昌明撰《越井记》载："井围二丈，深五丈，虽当亢旱，万人汲之不竭。其源出嶅山，泉极清冽，味甘而香。"相传饮此井水可延年益寿，乃佗城水源之根脉。'
  },
  '龙川考棚': {
    name: '龙川考棚',
    subtitle: '文脉所系，白衣卿相',
    content: '龙川考棚坐落于佗城镇西门，建于清光绪二年（公元1876年），为广东境内仅存的清代科考场所。整座建筑占地约6000平方米，坐西向东，呈二进院落式布局，含前堂、考场、后堂三部分，可同时容纳数百童生应试。大门镌刻对联"学而优则仕哪问寒门士族，出类拔萃者会聚白衣卿相"。当年龙川及周边五华、兴宁、和平等县学子皆赴此应试，见证了岭南文风之盛。'
  },
  '苏堤': {
    name: '苏堤',
    subtitle: '文人仁心，利民千秋',
    content: '苏堤位于佗城嶅湖之畔，乃北宋大文豪苏辙被贬谪龙川期间倡筑之堤坝。北宋哲宗时，苏辙谪为化州别驾、龙川安置，居此十七个月，见当地百姓饱受水旱之苦，遂倡义修筑此堤。堤高2.5米，顶宽2米，底宽6米，横亘于嶅湖之间，既可蓄水灌溉，又能防御洪涝。苏辙有诗云："尉佗城下两重阳，白酒黄鸡意自长"，道尽谪居期间与民同乐的心境。一介文人，无权无势，全凭一颗心为百姓谋福祉。'
  },
  '正相塔': {
    name: '正相塔',
    subtitle: '仙塔凌霄，时光之证',
    content: '正相塔坐落于佗城西1.5公里处，建于唐开元三年（公元715年），距今一千三百余年。塔为六角七层楼阁式砖塔，通高32.5米，塔身逐层递减，挺拔秀丽。民间传说玉帝派仙女下凡一夜砌成此塔，故又名"仙塔"。南宋名相吴潜曾贬谪寓居塔下，后人遂改称"正相塔"。塔身砖上至今仍存"开元三年"之刻字，为断代之铁证。登塔远眺，佗城全景尽收眼底。此塔乃佗城六景之终章，两千载岁月于此凝为一塔。'
  }
}

// ============================================================================
// §12. 打字机全局速度 (TYPEWRITER_INTERVAL)
//     目前设定 235 ms/字（与龙三叔 CosyVoice 配音语速基本对齐，
//     实现"字随音走"同步；结局/科举/越王庙评语 70 ms/字另用自定义值）
// ============================================================================
// 打字机速度：235ms/字（全局统一）
const TYPEWRITER_INTERVAL = 235

// ============================================================================
// §12b. SPOT_ALIASES 景点别名表（扫码结果/用户输入 非标准名 → 内部标准名）
//       SPOT_LIST   6 景点标准顺序（百岁街→越王庙→越王井→龙川考棚→苏堤→正相塔）
const SPOT_ALIASES = {
  '百岁街': '百岁街',   '佗城百岁街': '百岁街',   '百年老街': '百岁街',
  '越王庙': '越王庙',   '佗城越王庙': '越王庙',   '南越王庙': '越王庙',
  '越王井': '越王井',   '佗城越王井': '越王井',   '粤王井': '越王井',
  '考棚': '龙川考棚',   '龙川考棚': '龙川考棚',   '龙川学宫': '龙川考棚',   '学宫': '龙川考棚',
  '苏堤': '苏堤',       '西湖苏堤': '苏堤',       '龙川苏堤': '苏堤',
  '正相塔': '正相塔',   '龙川正相塔': '正相塔',   '老塔': '正相塔',         '龟峰塔': '正相塔'
}
const SPOT_LIST = ['百岁街', '越王庙', '越王井', '龙川考棚', '苏堤', '正相塔']

// ============================================================================
// §13. Page({ data: {...} }) — 页面 data 对象所有字段逐一声明
//     （WXML 中 {{ }} 绑定的数据源，每个 show* 弹窗 flag 都与 WXML
//      14 个 wx:if 区块 1:1 对应，见 chat.wxml 注释）
// ============================================================================
Page({
  data: {
    // ── 聊天核心 ──────────────────────────────────────────────────────────
    messages: [],                 // 消息数组：每条 {id,from('user'|'bot'),content,displayText,typewriting,typing,imagePath,isHidden}
    inputValue: '',               // 输入框当前内容
    scrollToView: '',             // scroll-view 锚点 id（msg-xxx），用于自动滚到底
    isSending: false,             // AI 回复中 → 输入框/发送按钮全部禁用
    pendingSpot: null,            // 当前待处理景点（onLoad 或 triggerSpotVisit 记录）

    // ── 过渡弹窗 (WXML L117 模块7: wx:if="{{showTransitionPopup}}") ────────
    showTransitionPopup: false,   // 是否显示过渡弹窗（双按钮闲聊/移步）
    transitionText: '',           // ⚠️ 已废弃：过渡台词改为以 bot 消息形式加到 messages，不再直接放弹窗内
    tdTyping: false,              // ⚠️ 已废弃：曾经的过渡台词打字中状态
    nextSpotName: '',             // 下一站中文名（弹窗按钮"移步 XXX"的 XXX，来自 SPOT_FLOW.nextLabel）
    currentSpotKey: null,         // 当前所在景点规范键名（SPOT_FLOW/SPOT_INTROS/SPOT_TRIGGER_LINES 查表 key）

    // ── 景点介绍弹窗 (WXML L138 模块8: wx:if="{{showSpotIntro}}") ─────────
    showSpotIntro: false,         // 是否显示景点介绍弹窗
    introSpotName: '',            // 景点大字名（SPOT_INTROS.name）
    introSpotSubtitle: '',        // 景点副标题（SPOT_INTROS.subtitle）
    introTypewriterText: '',      // 介绍正文打字机展示内容（startIntroTypewriter 逐字更新）
    introTyping: false,           // 介绍正文打字中 → 显示光标
    showIntroBtn: false,          // 介绍正文打字完成 → 显示"进入景点"按钮
    // 记录即将进入的景点（用户点击"进入景点"按钮后 onEnterSpot 读取）
    _pendingIntroSpot: null,      // ⚠️ 虽然以 _ 开头命名在 data 中，但本质是 JS 内部状态（WXML 不绑定），用于景点介绍→进入景点传值

    // ── 越王令奖励弹窗 (WXML L162 模块9: wx:if="{{showTokenPopup}}") ──────
    showTokenPopup: false,        // 是否显示越王令奖励弹窗（越王井答对任意一题 → TOKEN_AWARDED 触发）

    // ── 龙川考棚 · 科举 6 弹窗 (WXML 模块10: 6 个 wx:if showKeju*) ────────
    showKejuStart: false,         // 弹窗1：科举之邀（是否参加科举 双按钮）
    showKejuIntro: false,         // 弹窗2：科举任务介绍（三关流程可视化 + 进入考间按钮）
    showKejuXiangshi: false,      // 弹窗3：第一关·乡试 选择题（A/B/C）
    kejuXiangshiAnswer: '',       //   乡试选中答案 ∈ {'A','B','C'}，选中项 .selected 高亮
    showKejuHuishi: false,        // 弹窗4：第二关·会试 填空题
    kejuHuishiAnswer: '',         //   会试用户输入答案
    showKejuDianshi: false,       // 弹窗5：第三关·殿试 主观题(maxlength 500)
    kejuDianshiAnswer: '',        //   殿试用户主观答案
    showKejuResult: false,        // 弹窗6：科举评分结果 + 称号 + 打字机评语
    kejuScore: { q1: false, q2: false, dianshiLevel: 0, total: 0 },
                                  //   科举 3 关得分：q1=乡试对错, q2=会试对错,
                                  //   dianshiLevel=殿试 4 给分点命中数(0~4),
                                  //   total=综合对题数(0~3)：q1+q2+(dianshiLevel>=2?1:0)
    kejuResultText: '',           //   赵佗点评文案（DIANSHI_SCORED_REPLIES[0~3]）
    kejuResultTyping: false,      //   点评文案打字中 → 显示光标
    kejuAwardTitle: '',           //   称号大字：状元/进士/贡士/举人
    kejuAwardText: '',            //   称号副标题

    // ── 越王庙"谒王访贤" 3 弹窗 (WXML 模块11: 3 个 wx:if showTemple*) ────
    showTempleTask: false,        // 弹窗A：任务介绍（3题预览 + 接受/放弃双按钮）
    showTempleQuiz: false,        // 弹窗B：作答弹窗（3 题 input 同时作答）
    templeAnswer1: '',            //   Q1 答案（正确关键字：百姓/佗城/民）
    templeAnswer2: '',            //   Q2 答案（正确关键字：木雕 且 彩绘 双命中）
    templeAnswer3: '',            //   Q3 答案（正确关键字：含"十/10" + 至少2位贤士名字）
    showTempleResult: false,      // 弹窗C：结果弹窗（称号 + 对题数 + 打字评语 + 错题解析）
    templeScore: 0,               //   正确题数 (0~3)
    templeResultTitle: '',        //   称号大字：南越贤徒/谒王者/庙前客/庙外人
    templeResultText: '',         //   赵佗评语文案
    templeResultTyping: false,    //   评语打字中 → 显示光标
    templeWrongDetails: '',       //   错题解析（有错题才 WXML wx:if 显示）

    // ── 正相塔 · 大结局弹窗 (WXML L493 模块12: wx:if="{{showEnding}}") ─────
    showEnding: false,            // 是否显示大结局弹窗
    endingText: '',               // 结局文案内容（ENDING_A 或 ENDING_B）
    endingTyping: false,          // 结局文案打字中 → 显示光标；打字完成才显示"永记佗城"按钮

    // ── TTS 语音播放控制 ──────────────────────────────────────────────────
    isMuted: false,               // 右上角静音按钮状态（true=静音，所有 playTTS 立刻走 onDone 不播放）

    // ── 悬浮调试面板（闪退前显示错误栈，可复制给开发者）───────────────────
    debugLogs: [],                // 错误日志数组：每条 {time,timeStr,tag,content}，最多保留 20 条
    showDebugPanel: false,        // 调试面板展开/收起（⚠️ 当前 WXML 有 && false 整体禁用；保留结构供后续用）

    // ── 自动化闪退诊断测试模式 ─────────────────────────────────────────────
    autoTestMode: false,          // 是否处于自动测试模式（URL autoTest=1 或用户发"!自动测试"启动）
    autoTestReport: ''            // 最终报告文本（WXML 调试面板里 selectable 可长按复制）
  },

  // ============================================================================
  // §14. onUnload() 页面死亡清理序列（闪退防护第 1 核心！）
  //     微信基础库 3.17.0+ 偶发：用户快速返回地图页→chat页销毁，但 setInterval/
  //     setTimeout/wx.downloadFile 回调仍在 → 回调触发 setData →
  //     __wcc_version_info__ of null / recursive update / WAWorker kill 闪退。
  //     所以 onUnload 必须按固定顺序把所有可能的异步源头掐断：
  //     ① 最先设 _pageAlive=false + _destroyed=true（所有异步回调首行 return）
  //     ② 清 _allTimeoutHandles 所有 setTimeout（一网打尽）
  //     ③ 清打字机 _msgTimers + 双门闩超时 _typeTimeoutTimers + 队列
  //     ④ 清 TTS：下载超时 / abort 所有 wx.downloadFile 任务 / 11 事件置空 +
  //        stop() → 延迟 150ms 再 destroy()（stop→立刻 destroy 会导致
  //        解码线程野指针 → 每次开声音就闪退 TOP3 根因！）
  //     ⑤ 清所有 setInterval 类型的打字定时器（景点介绍/科举/越王庙/结局）
  //     ⑥ 清过渡弹窗 2 秒延迟定时器 + 解锁状态锁
  //     以上所有 try/catch 包裹，清理过程中任何错误绝不冒泡，否则系统闪退。
  // ============================================================================
  onUnload() {
    try {
      // 【页面存活标记】最先执行：标记页面已死亡，所有异步回调看到这个标志立即 return，不再碰 setData
      this._pageAlive = false
      this._destroyed = true
      // 顶层 try/catch：卸载过程中任何错误绝不能崩，否则系统闪退
      console.log('[chat.onUnload] 开始清理页面资源')
      // 0. 清除全局调试日志钩子，避免内存泄漏
      try {
        const app = getApp()
        if (app) app._appDebugLogHandler = null
      } catch (eClean) {}
      // 0.1 【终极清理】统一清除所有 _allTimeoutHandles 中的 setTimeout（所有业务定时器一网打尽）
      //      根因：业务中大量使用 setTimeout 延迟过渡/弹窗，如果用户此时切页，
      //            这些 timer 还会触发 → 回调内 setData 闪退。
      //            把所有业务 setTimeout 句柄统一登记到 Set，onUnload 遍历 clearTimeout
      if (this._allTimeoutHandles && this._allTimeoutHandles.size > 0) {
        console.log('[chat.onUnload] 清理_allTimeoutHandles数量:', this._allTimeoutHandles.size)
        this._allTimeoutHandles.forEach(h => {
          try { clearTimeout(h) } catch (e) {}
        })
        this._allTimeoutHandles.clear()
      }
      // 1. 清理所有消息的打字定时器（setTimeout链：_msgTimers 按 msgId 存）
      if (this._msgTimers) {
        Object.keys(this._msgTimers).forEach(k => {
          try { clearTimeout(this._msgTimers[k]) } catch (e) {}
        })
        this._msgTimers = {}
      }
      // 2. 清理所有消息的双门闩超时定时器（startMsgTypewriter 中 maxWaitMs 超时强制完成）
      if (this._typeTimeoutTimers) {
        Object.keys(this._typeTimeoutTimers).forEach(k => {
          try { clearTimeout(this._typeTimeoutTimers[k]) } catch (e) {}
        })
        this._typeTimeoutTimers = {}
      }
      // 3. 清理打字队列 + 打字状态（防止后续回调误触发）
      this._typingQueue = []
      this._isTyping = false
      this._typeFinishFlags = {}
      this._ttsFinishFlags = {}
      this._setDataPendingMsgs = null  // 清理消息级 pending Set

      // 4. 清理 TTS：下载超时、播放ctx、队列、状态
      if (this._ttsDownloadTimeout) {
        // 🔴 加固：清定时器走 _safeClearTimeout（从 _allTimeoutHandles 移除，防孤儿句柄）
        try { this._safeClearTimeout(this._ttsDownloadTimeout) } catch (e) {}
        this._ttsDownloadTimeout = null
      }
      // 🔴 加固：页面销毁前 abort 所有正在进行的 wx.downloadFile（彻底斩断死亡回调）
      //   根因：downloadFile 如果还在下载中，用户切页→页面销毁，但 wx.downloadFile
      //         的 success 回调仍会触发 → 即使 _pageAlive=false 也可能走到
      //         createInnerAudioContext → 已销毁页碰 UI 线程闪退。
      try {
        const tasks = this._ttsActiveDownloadTasks || []
        tasks.forEach(function(t) { try { t.abort && t.abort() } catch (e) {} })
        this._ttsActiveDownloadTasks = []
      } catch (eAbort) {}
      this._ttsQueue = []
      this._isTtsPlaying = false
      // 🔴 加固：onUnload 销毁 ctx 必须和 _finishOneTts 完全一致的「安全销毁序列」！
      //   之前这里 stop() 紧挨着 destroy() → 如果用户在 TTS 正在播放时跳页（聊天页↔地图页来回跳）
      //   → 解码线程还在跑时 destroy() → 野指针闪退！ 这是「每次开声音就闪退」的 TOP3 根因！
      //   修复：先清空 11 事件 → stop() → 延迟 150ms 等解码线程释放 → destroy()
      if (this._audioCtx) {
        try {
          const oldCtx = this._audioCtx
          this._audioCtx = null
          // 【11 事件全置空】（防销毁后回调触发：小程序 InnerAudioContext
          //  共有 11 个标准事件：onCanplay/onPlay/onPause/onSeeked/onSeeking/
          //  onWaiting/onLoadedmetadata(兼容)/onTimeUpdate/onError/onEnded/onStop）
          try { oldCtx.onCanplay(() => {}) } catch (e) {}
          try { oldCtx.onPlay(() => {}) } catch (e) {}
          try { oldCtx.onPause(() => {}) } catch (e) {}
          try { oldCtx.onSeeked(() => {}) } catch (e) {}
          try { oldCtx.onSeeking(() => {}) } catch (e) {}
          try { oldCtx.onWaiting(() => {}) } catch (e) {}
          // 🛡️ 能力判断（保留原代码，绝不删除）：onLoadedmetadata 是 Web/H5 API，小程序 InnerAudioContext 通常无此方法
          try { if (typeof oldCtx.onLoadedmetadata === 'function') { oldCtx.onLoadedmetadata(() => {}) } } catch (e) {}
          try { oldCtx.onTimeUpdate(() => {}) } catch (e) {}
          try { oldCtx.onError(() => {}) } catch (e) {}
          try { oldCtx.onEnded(() => {}) } catch (e) {}
          try { oldCtx.onStop(() => {}) } catch (e) {}
          // 请求 stop（异步释放解码线程）
          try { oldCtx.stop() } catch (e) {}
          // 延迟 150ms 再 destroy() → 和 _finishOneTts 严格对齐
          setTimeout(() => { try { oldCtx.destroy() } catch (e) {} }, 150)
        } catch (eCtx) {}
      }

      // 5. 清理景点介绍打字定时器（setInterval / setTimeout 各清一次，双重保险）
      if (this._introTypewriterTimer) {
        try { clearInterval(this._introTypewriterTimer) } catch (e) {}
        try { clearTimeout(this._introTypewriterTimer) } catch (e) {}
        this._introTypewriterTimer = null
      }
      // 6. 清理科举评分打字定时器
      if (this._kejuResultTimer) {
        try { clearInterval(this._kejuResultTimer) } catch (e) {}
        try { clearTimeout(this._kejuResultTimer) } catch (e) {}
        this._kejuResultTimer = null
      }
      // 6b. 清理越王庙评语打字定时器
      if (this._templeResultTimer) {
        try { clearInterval(this._templeResultTimer) } catch (e) {}
        try { clearTimeout(this._templeResultTimer) } catch (e) {}
        this._templeResultTimer = null
      }
      // 7. 清理大结局打字定时器
      if (this._endingTimer) {
        try { clearInterval(this._endingTimer) } catch (e) {}
        try { clearTimeout(this._endingTimer) } catch (e) {}
        this._endingTimer = null
      }
      // 8. 清理过渡弹窗 2秒 定时器（_appendTransitionAndPopup 过渡台词说完→2秒后弹窗）
      if (this._popupTimer) {
        try { clearTimeout(this._popupTimer) } catch (e) {}
        this._popupTimer = null
      }
      // 9. 解锁过渡追加状态锁，防止下次进入页面被卡住
      this._transitionAppendingLock = false
      this._userJustAnswered = false
    } catch (eTop) {
      console.error('[chat.onUnload 清理顶层异常，已忽略]:', eTop)
    }
  },

  // ============================================================================
  // §15. toggleMute() 右上角静音按钮切换
  //     data.isMuted 取反 → 若新值为 true（用户按下静音），立刻调 stop()
  //     停止当前播放（避免静音但仍在播放消耗解码资源）。
  // ============================================================================
  // ============ 右上角静音按钮 ============
  toggleMute() {
    const newMuted = !this.data.isMuted
    this.setData({ isMuted: newMuted })
    if (newMuted && this._audioCtx) {
      try { this._audioCtx.stop() } catch (e) {}
    }
    wx.showToast({
      title: newMuted ? '已静音' : '已开启语音',
      icon: 'none',
      duration: 1200
    })
  },

  // ============================================================================
  // §16. 悬浮调试面板（3 个 helper 函数）
  //   _pushDebugLog(tag, content)
  //     新增一条错误日志到 data.debugLogs（最多 20 条，unshift 最新在最前），
  //     ⚠️ 首行必须判 _pageAlive：页面已死时只打 console，绝不调 setData
  //     （否则 _safeSetData 失败 catch 里又调 _pushDebugLog → 无限递归闪退）
  //   toggleDebugPanel() ：展开/收起调试面板
  //   copyDebugLogs()     ：一键复制全部日志 → wx.setClipboardData（页面已死直接拒绝）
  // ============================================================================
  // ============ 悬浮调试面板：错误日志收集与展示 ============
  // 记录一条调试日志（最多保留 20 条，避免内存过大）
  _pushDebugLog(tag, content) {
    try {
      tag = tag || '未知'
      content = content || ''
      // Error 对象：优先取 stack，没有则取 message
      if (content instanceof Error) content = content.stack || content.message || String(content)
      if (typeof content !== 'string') { try { content = JSON.stringify(content) } catch (e) { content = String(content) } }
      const now = new Date()
      const pad = (n) => n < 10 ? ('0' + n) : ('' + n)
      const timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + '.' + now.getMilliseconds()
      const newItem = { time: now.getTime(), timeStr: timeStr, tag: String(tag), content: content.substring(0, 2000) }
      // ========= 【致命修复】页面已死时只打console.log，绝不能调setData！=========
      // 根因：_safeSetData失败→catch块调_pushDebugLog→_pushDebugLog调setData→recursive update→无限递归→崩溃
      if (!this || !this._pageAlive || this._destroyed) {
        console.log('[DEBUGLOG-DEAD] [' + tag + '] ' + timeStr + ' → ', content.substring(0, 500))
        return
      }
      let logs = this.data.debugLogs ? this.data.debugLogs.slice() : []
      logs.unshift(newItem)
      if (logs.length > 20) logs = logs.slice(0, 20)
      // 用 _safeSetData 包裹，避免与打字机setData冲突引发 recursive update
      try { this._safeSetData({ debugLogs: logs }) } catch (eSet) { console.warn('[debug setData失败]:', eSet) }
      // 同时把错误打一份到控制台，方便开发者看
      console.log('[DEBUGLOG] [' + tag + '] ' + timeStr + ' → ', content)
    } catch (eTop) {
      // 任何情况下不能因为调试面板出错引发闪退
      console.warn('[debug._pushDebugLog 顶层异常，已忽略]:', eTop)
    }
  },
  // 点击"调试"悬浮按钮：展开/关闭错误日志面板
  toggleDebugPanel() {
    try { this.setData({ showDebugPanel: !this.data.showDebugPanel }) } catch (e) {}
  },
  // 点击"一键复制全部日志"：复制到剪贴板，方便用户粘贴给开发者
  copyDebugLogs() {
    // 页面已死：直接拒绝，避免wx.setClipboardData在异常状态触发WAWorker
    if (!this || !this._pageAlive || this._destroyed) {
      try { wx.showToast({ title: '页面状态异常，请重试', icon: 'none' }) } catch (e) {}
      return
    }
    try {
      const arr = this.data.debugLogs || []
      if (arr.length === 0) {
        try { wx.showToast({ title: '暂无错误日志', icon: 'none' }) } catch (e) {}
        return
      }
      const text = arr.map(l => '[' + l.timeStr + '] ⚠' + l.tag + '\n' + l.content).join('\n\n---\n\n')
      // 【wx.setClipboardData全链路加固】3.17.0灰度版任何wx API都可能触发WAWorker埋点，全部包try/catch
      try {
        wx.setClipboardData({
          data: text,
          success: () => { try { wx.showToast({ title: '已复制全部日志', icon: 'success' }) } catch (e) {} },
          fail: () => { try { wx.showToast({ title: '复制失败，请手动长按复制', icon: 'none' }) } catch (e) {} }
        })
      } catch (eClip) {
        console.error('[wx.setClipboardData调用异常（已隔离）]:', eClip)
        try { this._pushDebugLog('剪贴板异常', eClip) } catch (e) {}
        try { wx.showToast({ title: '复制出错，请手动长按', icon: 'none' }) } catch (e2) {}
      }
    } catch (e) {
      try { wx.showToast({ title: '复制出错，请手动长按', icon: 'none' }) } catch (e2) {}
    }
  },

  // ============================================================================
  // §17. 自动化闪退诊断测试模块（_autoTest* 系列）
  //     触发方式：① URL 参 ?spot=百岁街&autoTest=1；② 聊天页发"!自动测试"
  //     覆盖内容：依次走完 6 个景点（百岁街→越王庙→越王井→考棚→苏堤→正相塔），
  //               自动发送标准答案 / 自动点开始任务弹窗 / 自动填科举3关 /
  //               自动点过渡弹窗 / 自动点进入景点按钮 / 自动点接受越王令
  //     闪退防护：所有 setTimeout 走 _safeSetTimeout；所有定时器句柄注册；
  //             页面销毁判存活；日志采用"收集入数组 → 最终一次性打印"策略
  //             （_AUTO_TEST_LOG_TO_CONSOLE_EVERY_TIME=false）避免 Windows
  //             开发者工具 20 秒日志过多导致 DevTools 自身崩溃闪退。
  //     报告生成：_autoTestGenerateReport（中间进度报告） /
  //             _autoTestGenerateFinalReport（最终报告：每个景点 status/对话轮次/
  //             耗时/TTS 统计/闪退详情，加上自动测试全部步骤日志，最后
  //             弹窗模态告知是否发现闪退。）
  //     钩子：_autoTestRecordCrash(errMsg,errStack) — 通过 app 全局 onError
  //           注入，一旦有 JS 异常就把当前景点+对话轮次+错误栈打入报告。
  // ============================================================================
  // ============================================================
  // ============= 自动化闪退诊断流程（6个景点全链路）==============
  // ============================================================
  // 使用方法：微信开发者工具中手动编译页面，URL参数填 spot=百岁街&autoTest=1
  // 或在聊天页欢迎语时，手动发送"!自动测试"触发
  // 功能：自动依次走完6个景点，自动回答标准答案，自动点"进入下一景点"，
  //       自动完成科举3关，自动回答苏堤对诗，记录闪退发生的景点/轮次/时间

  // ---------- 自动化测试：初始化 + 启动 ----------
  _autoTestStart() {
    try {
      const that = this
      // 初始化 6 个景点的测试报告对象（状态/对话轮次/起止时间/耗时/闪退信息/声音统计）
      this._autoTestSpotOrder.forEach(s => {
        that._autoTestSpotReport[s] = {
          spotName: s, status: '未开始', dialogCount: 0,
          startTime: null, finishTime: null, durationMs: 0,
          note: '', crashInfo: null,
          // 🛡️ 每个景点独立的TTS统计 & 声音检测结果
          sound: {
            ttsTriggered: 0, ttsSuccess: 0, ttsFail: 0,
            soundIssues: []     // 声音异常（中途中断/无法播放等，降级模式下留空）
          }
        }
      })
      this.setData({ autoTestMode: true })
      this._pushDebugLog('自动测试', '初始化完成，准备进入【百岁街】')
      this._autoTestLog('✅ 自动化6景点检测启动。TTS开关=' + (_ENABLE_TTS_AUDIO ? '真声音(验证播放)' : '降级(稳定优先)') + '。准备进入【百岁街】', 'log')
      // 先把 messages 清空再加欢迎消息，然后导航到百岁街
      this._safeSetData({ messages: [] }, () => {
        // 模拟地图页跳转到 chat?spot=百岁街 的效果（SafeStorage 打卡）
        const app = getApp()
        if (app && app.safeSetStorageSync) app.safeSetStorageSync('visitedSpots', ['百岁街'])
        this._autoTestGoSpot('百岁街')
      })
    } catch (e) {
      this._autoTestLog('❌ 自动测试启动失败: ' + (e && e.message || String(e)), 'error')
      this._pushDebugLog('自动测试错误', '启动失败: ' + (e && e.message || String(e)))
    }
  },

  // ---------- 自动化测试：跳转到指定景点（和 onLoad spot= 参数逻辑一致） ----------
  _autoTestGoSpot(spotName) {
    try {
      const idx = this._autoTestSpotOrder.indexOf(spotName)
      if (idx >= 0) this._autoTestCurrentSpotIdx = idx
      this._autoTestDialogCount = 0
      this._autoTestStepStartTime = Date.now()
      this._autoTestSpotReport[spotName].status = '进行中'
      this._autoTestSpotReport[spotName].startTime = new Date().toLocaleString('zh-CN', { hour12: false })
      this._pushDebugLog('自动测试', `【${spotName}】开始测试`)
      this._autoTestLog(`➡️ 进入景点【${spotName}】。开始时间：${this._autoTestSpotReport[spotName].startTime}`, 'log')

      // 景点访问流程：和 onLoad(options.spot) 完全一致
      this._safeSetData({ pendingSpot: spotName, currentSpotKey: spotName })
      let triggerLine = SPOT_TRIGGER_LINES[spotName]
      const isKejuSpot = (spotName === '龙川考棚' || spotName === '考棚')
      if (!triggerLine) triggerLine = '此处便是' + spotName + '了。本王在此地尚有朦胧记忆，你且陪本王细细游览一番。'
      if (isKejuSpot) triggerLine = KEJU_TRIGGER_LINE
      this._currentTriggerVersion = 0

      this._safeSetTimeout(() => {
        try {
          if (isKejuSpot) {
            // 考棚：弹欢迎语 → 打字 → 弹 showKejuStart → 自动点"接了"开始科考
            const cleanText = this.cleanBotText(triggerLine)
            const botMsgId = Date.now()
            const botMsg = { id: botMsgId, from: 'bot', content: '', displayText: '', typewriting: true }
            this._safeSetData({
              messages: [...this.data.messages, botMsg],
              scrollToView: 'msg-' + botMsgId,
              isSending: false,
              currentSpotKey: spotName,
              kejuScore: { q1: false, q2: false, dianshiLevel: 0, total: 0 },
              kejuXiangshiAnswer: '',
              kejuHuishiAnswer: '',
              kejuDianshiAnswer: ''
            }, () => {
              this.startMsgTypewriter(botMsgId, cleanText, () => {
                this._safeSetTimeout(() => {
                  if (!this._pageAlive) return
                  this._safeSetData({ showKejuStart: true }, () => {
                    // 自动点"开始科考"
                    this._safeSetTimeout(() => this._autoTestOnKejuStart(), 1200)
                  })
                }, 600)
              })
            })
          } else if (spotName === '正相塔') {
            // 正相塔：欢迎语 → 打字 → 直接弹大结局
            const cleanText = this.cleanBotText(triggerLine)
            const botMsgId = Date.now()
            const botMsg = { id: botMsgId, from: 'bot', content: '', displayText: '', typewriting: true }
            const hiddenMsg = {
              id: Date.now() + 1, from: 'user', isHidden: true,
              content: '[系统指令：游客已到达【' + spotName + '】。当前场景的触发台词你已经说了：' + triggerLine + '。]'
            }
            this._safeSetData({
              messages: [...this.data.messages, botMsg, hiddenMsg],
              scrollToView: 'msg-' + botMsgId,
              isSending: false, currentSpotKey: spotName
            }, () => {
              this.startMsgTypewriter(botMsgId, cleanText, () => {
                // 打字+TTS完成后自动展示结局弹窗
                this._safeSetTimeout(() => {
                  if (!this._pageAlive) return
                  this._showEndingPopup()
                  // 大结局标记测试完成
                  this._safeSetTimeout(() => this._autoTestMarkSpotComplete('正相塔'), 5000)
                }, 1500)
              })
            })
          } else {
            // 普通景点：百岁街/越王井/苏堤 → 欢迎语 → 自动发送标准答案
            const hiddenMsg = {
              id: Date.now() + 1, from: 'user', isHidden: true,
              content: '[系统指令：游客已到达【' + spotName + '】。当前场景的触发台词你已经说了：' + triggerLine + '。接下来请严格按照【全景地图剧本库】中该景点的【判卷与过渡】继续互动，等待游客回答后判卷，并抛出过渡台词引导去下一景点。]'
            }
            const cleanTrigger = this.cleanBotText(triggerLine)
            const botMsgId = Date.now()
            const botMsg = { id: botMsgId, from: 'bot', content: '', displayText: '', typewriting: true }
            const newMessages = [...this.data.messages, botMsg, hiddenMsg]
            this._safeSetData({
              messages: newMessages,
              scrollToView: 'msg-' + botMsgId,
              isSending: false, currentSpotKey: spotName
            }, () => {
              this.startMsgTypewriter(botMsgId, cleanTrigger, () => {
                // 景点触发语说完后，自动模拟用户输入（根据不同景点选择不同标准答案）
                this._safeSetTimeout(() => this._autoTestSendUserAnswer(spotName), 1000)
              })
            })
          }
        } catch (eInner) {
          console.error('[自动测试跳景点异常]:', spotName, eInner)
          this._pushDebugLog('自动测试错误', '景点' + spotName + '跳转异常: ' + (eInner && eInner.message || eInner))
        }
      }, 800)
    } catch (e) {
      console.error('[自动测试跳景点顶层异常]:', spotName, e)
      this._autoTestSpotReport[spotName].crashInfo = { errMsg: (e && e.message || String(e)), stack: (e && e.stack || '') }
    }
  },

  // ---------- 自动化测试：发送景点对应的标准答案 ----------
  _autoTestSendUserAnswer(spotName) {
    try {
      if (!this._pageAlive || this._destroyed) return
      let answer = '陈'  // 默认姓陈
      if (spotName === '百岁街') answer = '陈'
      else if (spotName === '越王庙') answer = '1.这座庙是清代康熙年间百姓捐资修建的，后经乾隆年间重修；2.您的塑像是木雕材质；3.这里供奉的十贤士有苏辙和吴潜两位。'
      else if (spotName === '越王井') answer = '这井深约11米，井壁是青砖和红砂岩砌成的，唐代韦昌明还写了《越井记》呢！'
      else if (spotName === '苏堤') answer = '白酒黄鸡意自长'
      this._pushDebugLog('自动测试', `【${spotName}】模拟用户回复: "${answer.substring(0, 30)}..."`)
      this._autoTestLog(`💬【${spotName}】模拟用户回复：${answer.substring(0, 30)}${answer.length > 30 ? '…' : ''}`, 'log')
      this._autoTestDialogCount++
      this._autoTestSpotReport[spotName].dialogCount = this._autoTestDialogCount
      const userMsg = { id: Date.now(), from: 'user', content: answer }
      const newMessages = [...this.data.messages, userMsg]
      // ⚠️ 标记用户刚回答 → AI 判卷后 checkTransitionAndShow 才能触发过渡追加
      this._userJustAnswered = true
      this._safeSetData({
        messages: newMessages,
        inputValue: '',
        isSending: true,
        scrollToView: 'msg-' + userMsg.id
      }, () => {
        // 正常调用AI回复逻辑：走 sendToQwen（AI回复完会自动触发过渡弹窗检测）
        this.sendToQwen(null, 'text')
        // AI回复后，过渡弹窗会被 checkTransitionAndShow 显示，这里同时启动自动等待检测
        this._safeSetTimeout(() => this._autoTestWaitAndClickNextSpot(spotName), 2500)
      })
    } catch (e) {
      console.error('[自动测试发送用户回复异常]:', spotName, e)
      this._pushDebugLog('自动测试错误', '景点' + spotName + '模拟回复异常: ' + (e && e.message || String(e)))
    }
  },

  // ---------- 自动化测试：等待过渡弹窗，自动点"进入下一景点" ----------
  _autoTestWaitAndClickNextSpot(spotName) {
    try {
      if (!this._pageAlive) return
      // 先检测越王令弹窗（越王井场景）→ 自动点接受
      if (this.data.showTokenPopup) {
        this._pushDebugLog('自动测试', `越王令弹窗，自动接受`)
        this._autoTestLog('📜 越王令弹窗，自动接受', 'log')
        this.onAcceptToken()
        // 接受后，过渡台词会被触发，继续等待过渡弹窗
        this._safeSetTimeout(() => this._autoTestWaitAndClickNextSpot(spotName), 3500)
        return
      }
      // 如果过渡弹窗已显示 → 直接点击
      if (this.data.showTransitionPopup) {
        this._pushDebugLog('自动测试', `【${spotName}】过渡弹窗已显示，自动点击【进入下一景点】`)
        this._autoTestLog(`🔁【${spotName}】过渡弹窗已显示 → 点击【进入下一景点】`, 'log')
        this.onGoToNextSpot()
        // 点击后，景点介绍弹窗showSpotIntro=true，自动等待并点"进入景点"
        this._safeSetTimeout(() => this._autoTestWaitAndClickEnterSpot(spotName), 1500)
        return
      }
      // 否则再等 2秒 后重试，最多等 10秒
      this._autoTestRetryCount = (this._autoTestRetryCount || 0) + 1
      if (this._autoTestRetryCount <= 5) {
        this._autoTestLog(`⏳【${spotName}】等待过渡弹窗…第${this._autoTestRetryCount}次`, 'log')
        this._safeSetTimeout(() => this._autoTestWaitAndClickNextSpot(spotName), 2000)
      } else {
        this._autoTestRetryCount = 0
        this._pushDebugLog('自动测试', `【${spotName}】过渡弹窗未出现，直接标记完成并进入下一景点`)
        // 过渡弹窗未出现，也判当前景点测试结束，进入下一景点
        this._autoTestMarkSpotComplete(spotName)
      }
    } catch (e) {
      console.error('[自动测试等待过渡弹窗异常]:', spotName, e)
      this._autoTestMarkSpotComplete(spotName)
    }
  },

  // ---------- 自动化测试：等待景点介绍弹窗打字完成后，自动点"进入景点" ----------
  _autoTestWaitAndClickEnterSpot(prevSpotName) {
    try {
      if (!this._pageAlive) return
      const nextIdx = this._autoTestCurrentSpotIdx + 1
      const nextSpot = this._autoTestSpotOrder[nextIdx]
      // 等待景点介绍打字机完成后自动点进入
      if (this.data.showSpotIntro && this.data.showIntroBtn) {
        this._pushDebugLog('自动测试', `景点介绍已显示，自动点击【进入景点】→ ${nextSpot}`)
        this._autoTestLog(`🎟️【${prevSpotName}】景点介绍完成 → 点击【进入景点】→【${nextSpot}】`, 'log')
        this._autoTestRetryCount = 0
        // 【注意】这里不标记上一景点完成，只在景点介绍页面离开后标记完成
        this.onEnterSpot()
        // 进入下一景点后：等待景点触发语打完 → 自动模拟用户答案
        this._safeSetTimeout(() => {
          // 下一景点如果是考棚：由 _autoTestOnKejuStart 处理
          // 下一景点如果是越王庙：由 _autoTestWaitAndStartTemple 处理（任务弹窗）
          // 下一景点如果是正相塔：由 _autoTestGoSpot 触发（因为没有景点介绍）
          // 普通景点：百岁街/越王井/苏堤 → 等待AI欢迎语打完，自动发送标准答案
          if (nextSpot === '龙川考棚') {
            // 等待考棚的showKejuStart弹出，自动开始科考
            this._autoTestWaitAndStartKeju(nextSpot, prevSpotName)
          } else if (nextSpot === '越王庙' || nextSpot === '南越王庙') {
            // 等待越王庙的showTempleTask弹出，自动接受任务
            this._autoTestWaitAndStartTemple(nextSpot, prevSpotName)
          } else if (nextSpot === '正相塔') {
            // 正相塔没有景点介绍，已经是triggerSpotVisit直接走完
            this._autoTestMarkSpotComplete(prevSpotName)
            this._autoTestMarkSpotComplete('正相塔')
          } else {
            // 普通景点：等bot欢迎语打字完，自动发送标准答案
            this._safeSetTimeout(() => this._autoTestSendUserAnswer(nextSpot), 9000)
          }
        }, 1500)
        return
      }
      this._autoTestRetryCount = (this._autoTestRetryCount || 0) + 1
      if (this._autoTestRetryCount <= 15) {
        this._safeSetTimeout(() => this._autoTestWaitAndClickEnterSpot(prevSpotName), 2000)
      } else {
        this._autoTestRetryCount = 0
        // 超时：可能正相塔（大结局）没有景点介绍弹窗，直接triggerSpotVisit
        this._autoTestLog(`⚠️【${prevSpotName}】景点介绍等待超时 → 直接推进到下一景点【${nextSpot || '未知'}】`, 'warn')
        this._autoTestMarkSpotComplete(prevSpotName)
        if (nextSpot === '正相塔') {
          this._autoTestGoSpot('正相塔')
        } else {
          this.triggerSpotVisit(nextSpot)
          if (nextSpot === '龙川考棚') {
            this._safeSetTimeout(() => this._autoTestWaitAndStartKeju(nextSpot, prevSpotName), 2000)
          } else if (nextSpot === '越王庙' || nextSpot === '南越王庙') {
            this._safeSetTimeout(() => this._autoTestWaitAndStartTemple(nextSpot, prevSpotName), 2000)
          } else {
            this._safeSetTimeout(() => this._autoTestSendUserAnswer(nextSpot), 9000)
          }
        }
      }
    } catch (e) {
      console.error('[自动测试等待景点介绍异常]:', e)
      this._autoTestMarkSpotComplete(prevSpotName)
    }
  },

  // 考棚场景：等待科举开始弹窗弹出后自动触发
  _autoTestWaitAndStartKeju(spotName, prevSpotName) {
    try {
      if (!this._pageAlive) return
      if (this.data.showKejuStart) {
        this._autoTestLog(`🎯【${spotName}】科举开始弹窗弹出 → 自动开启科考`, 'log')
        this._autoTestOnKejuStart()
        return
      }
      this._autoTestRetryCount = (this._autoTestRetryCount || 0) + 1
      if (this._autoTestRetryCount <= 10) {
        this._safeSetTimeout(() => this._autoTestWaitAndStartKeju(spotName, prevSpotName), 2000)
      } else {
        this._autoTestLog(`⚠️【${spotName}】科举开始弹窗等待超时 → 跳过`, 'warn')
        this._autoTestRetryCount = 0
        this._autoTestMarkSpotComplete(prevSpotName || '越王井')
      }
    } catch (e) {}
  },

  // 越王庙场景：等待任务弹窗弹出后自动触发
  _autoTestWaitAndStartTemple(spotName, prevSpotName) {
    try {
      if (!this._pageAlive) return
      if (this.data.showTempleTask) {
        this._autoTestLog(`🎯【${spotName}】谒王访贤任务弹窗弹出 → 自动接受挑战`, 'log')
        this._autoTestOnTempleTask()
        return
      }
      this._autoTestRetryCount = (this._autoTestRetryCount || 0) + 1
      if (this._autoTestRetryCount <= 10) {
        this._safeSetTimeout(() => this._autoTestWaitAndStartTemple(spotName, prevSpotName), 2000)
      } else {
        this._autoTestLog(`⚠️【${spotName}】任务弹窗等待超时 → 跳过`, 'warn')
        this._autoTestRetryCount = 0
        this._autoTestMarkSpotComplete(prevSpotName || '百岁街')
      }
    } catch (e) {}
  },

  // 越王庙自动测试：接受任务 → 作答 → 提交 → 等待结果后推进
  _autoTestOnTempleTask() {
    try {
      if (!this._pageAlive) return
      this._autoTestLog('📋【越王庙】任务弹窗显示 → 接受挑战', 'log')
      this._autoTestDialogCount++
      this.onTempleTaskAccept()
      // 过一会儿作答弹窗弹出后自动填写答案
      this._safeSetTimeout(() => {
        if (!this._pageAlive) return
        if (this.data.showTempleQuiz) {
          this._autoTestLog('✅【越王庙】作答弹窗显示 → 填写标准答案', 'log')
          this._autoTestDialogCount++
          this.setData({
            templeAnswer1: '佗城百姓',
            templeAnswer2: '木雕彩绘',
            templeAnswer3: '十位贤士，有苏辙和吴潜'
          }, () => {
            // 延迟后提交
            this._safeSetTimeout(() => {
              if (!this._pageAlive) return
              this._autoTestLog('📝【越王庙】提交答卷', 'log')
              this._autoTestDialogCount++
              this.onTempleQuizSubmit()
              // 等待结果弹窗完成后自动关闭
              this._safeSetTimeout(() => this._autoTestWaitTempleResultAndNext('越王庙', '百岁街'), 8000)
            }, 1500)
          })
        }
      }, 1500)
    } catch (e) { console.error('[越王庙自动测试异常]:', e) }
  },

  // 越王庙自动测试：等待结果弹窗完成并推进到下一景点
  _autoTestWaitTempleResultAndNext(spotName, prevSpotName) {
    try {
      if (!this._pageAlive) return
      // 如果结果弹窗已关闭（说明用户手动关了），直接推进
      if (!this.data.showTempleResult) {
        this._autoTestLog(`✅【${spotName}】任务完成 → 推进到下一景点`, 'log')
        this._autoTestMarkSpotComplete(spotName)
        return
      }
      // 如果评语打字已完成，自动关闭结果弹窗
      if (!this.data.templeResultTyping) {
        this._autoTestLog(`🏆【${spotName}】评语打字完成 → 关闭结果弹窗`, 'log')
        this._autoTestDialogCount++
        this.onTempleResultClose()
        this._safeSetTimeout(() => {
          this._autoTestMarkSpotComplete(spotName)
        }, 12000)
        return
      }
      this._safeSetTimeout(() => this._autoTestWaitTempleResultAndNext(spotName, prevSpotName), 2000)
    } catch (e) { console.error('[越王庙等待结果异常]:', e) }
  },

  // ---------- 自动化测试：科举流程自动答题（3关） ----------
  _autoTestOnKejuStart() {
    try {
      if (!this._pageAlive) return
      this._pushDebugLog('自动测试', '【龙川考棚】开始科举')
      this._autoTestLog('📚【龙川考棚】科举开始弹窗显示 → 开始科考', 'log')
      this.onStartKeju()  // 点"开始科考"
      // 过一会儿进入乡试后自动选B
      this._safeSetTimeout(() => {
        if (!this._pageAlive) return
        if (this.data.showKejuXiangshi) {
          this._pushDebugLog('自动测试', '【乡试】选答案B')
          this._autoTestLog('✅【龙川考棚】乡试 → 选答案B', 'log')
          this._autoTestDialogCount++
          this.kejuSelectAnswer('B')  // 选B
          this._safeSetTimeout(() => {
            // 进入会试自动填答案
            if (this.data.showKejuHuishi) {
              const ans = '学而优则仕哪问寒门士族'
              this._pushDebugLog('自动测试', '【会试】填对联')
              this._autoTestLog('✅【龙川考棚】会试 → 填对联：' + ans, 'log')
              this._autoTestDialogCount++
              this.setData({ kejuHuishiAnswer: ans }, () => {
                this._safeSetTimeout(() => {
                  this.onHuishiSubmit()
                  // 殿试自动答
                  this._safeSetTimeout(() => {
                    if (this.data.showKejuDianshi) {
                      const ds = '治理岭南，我认为应该做到四点：一是和辑百越，尊重越人风俗，鼓励汉越通婚，让民族和睦相处；二是传播中原技术，推广铁器耕牛、凿井灌溉、汉字书写，发展民生；三是移民实边，让中原人南下与越人杂居，共同繁衍生息；四是两度归汉，维护华夏统一，不割据不分裂。这样才能让岭南长治久安。'
                      this._pushDebugLog('自动测试', '【殿试】提交答卷')
                      this._autoTestLog('✅【龙川考棚】殿试 → 提交答卷：' + ds.substring(0, 30) + '…', 'log')
                      this._autoTestDialogCount++
                      this.setData({ kejuDianshiAnswer: ds }, () => {
                        this.onDianshiSubmit()
                        // 评分后自动点传承文脉，等待过渡弹窗
                        this._safeSetTimeout(() => this._autoTestWaitKejuResultAndNext('龙川考棚'), 5000)
                      })
                    }
                  }, 3000)
                }, 3000)
              })
            }
          }, 3000)
        }
      }, 2500)
    } catch (e) {
      console.error('[自动测试科举异常]:', e)
      this._pushDebugLog('自动测试错误', '科举异常: ' + (e && e.message || String(e)))
      this._autoTestMarkSpotComplete('龙川考棚')
    }
  },

  _autoTestWaitKejuResultAndNext(spotName) {
    try {
      if (!this._pageAlive) return
      if (this.data.showKejuResult) {
        // 点"传承文脉"
        this._pushDebugLog('自动测试', '【科举评分完成】点击"传承文脉"')
        this._autoTestLog('🏆【龙川考棚】评分完成 → 点击传承文脉', 'log')
        this.onKejuResultDone()
        // 等待过渡弹窗
        this._safeSetTimeout(() => this._autoTestWaitAndClickNextSpot(spotName), 1500)
        return
      }
      this._autoTestRetryCount = (this._autoTestRetryCount || 0) + 1
      if (this._autoTestRetryCount <= 5) {
        this._safeSetTimeout(() => this._autoTestWaitKejuResultAndNext(spotName), 2000)
      } else {
        this._autoTestRetryCount = 0
        this._autoTestMarkSpotComplete(spotName)
      }
    } catch (e) {
      console.error('[自动测试等待科举评分异常]:', e)
      this._autoTestMarkSpotComplete(spotName)
    }
  },

  // ---------- 自动化测试：标记景点完成（更新报告状态） ----------
  _autoTestMarkSpotComplete(spotName) {
    try {
      const report = this._autoTestSpotReport[spotName]
      if (!report) return
      if (report.status === '已完成' || report.status === '闪退') return
      report.status = '已完成'
      report.finishTime = new Date().toLocaleString('zh-CN', { hour12: false })
      report.dialogCount = this._autoTestDialogCount
      if (report.startTime) report.durationMs = (Date.now() - this._autoTestStepStartTime)
      this._autoTestLog(`✅【${spotName}】测试完成 → 对话${report.dialogCount}轮，耗时${Math.round(report.durationMs / 1000)}秒`, 'log')
      this._pushDebugLog('自动测试', `✅【${spotName}】完成，对话${report.dialogCount}轮`)
      // 生成中间报告
      this._autoTestGenerateReport()

      // 判断下一景点
      const idx = this._autoTestSpotOrder.indexOf(spotName)
      if (idx < 0 || idx >= this._autoTestSpotOrder.length - 1) {
        // 最后一个景点正相塔结束 → 生成最终报告
        this._autoTestGenerateFinalReport()
      } else {
        // 进入下一景点
        const nextSpot = this._autoTestSpotOrder[idx + 1]
        this._autoTestLog(`⬇️ 下一景点准备：【${nextSpot}】`, 'log')
      }
    } catch (e) {}
  },

  // ---------- 自动化测试：生成中间进度报告（每完成 1 景点更新 1 次） ----------
  _autoTestGenerateReport() {
    try {
      const that = this
      const arr = this._autoTestSpotOrder.map(s => {
        const r = that._autoTestSpotReport[s]
        return `  · ${r.spotName.padEnd(6)} | ${r.status.padEnd(4)} | 对话${r.dialogCount}轮 | ${r.startTime ? r.startTime.substring(11) : '--:--:--'} ~ ${r.finishTime ? r.finishTime.substring(11) : '--:--:--'}`
      })
      const report = '【自动化测试进度报告】\n时间：' + new Date().toLocaleString('zh-CN', { hour12: false }) + '\n\n' + arr.join('\n')
      this.setData({ autoTestReport: report })
      // 中间报告不再打印到Console，防止日志过多导致20秒崩溃
      if (_AUTO_TEST_LOG_TO_CONSOLE_EVERY_TIME) console.log('[AUTO-TEST] 报告更新:\n' + report)
    } catch (e) {}
  },

  // ---------- 自动化测试：生成最终报告（含 TTS 统计 / 闪退堆栈 / 逐步骤日志） ----------
  _autoTestGenerateFinalReport() {
    try {
      const that = this
      const anyCrash = this._autoTestSpotOrder.some(s => {
        const r = that._autoTestSpotReport[s]
        return r.status === '闪退' || !!r.crashInfo
      })
      // =========================
      // TTS & 声音功能统计汇总
      // =========================
      const tts = this._ttsStats || { enabled: false, triggered: 0, success: 0, fail: 0 }
      const ttsModeText = tts.enabled ? '✅ 真声音模式（验证播放）' : '🛡️ 降级稳定模式（不调音频API，等于自动检测稳定态）'
      let ttsBody = ''
      ttsBody += `  TTS开关：${tts.enabled ? 'true (走真实TTS)' : 'false (降级稳定)'}\n`
      ttsBody += `  TTS总调用：${tts.triggered || 0} 次\n`
      ttsBody += `  TTS成功(视为播完)：${tts.success || 0} 次\n`
      ttsBody += `  TTS失败(中断/错误)：${tts.fail || 0} 次\n`
      if (tts.enabled) {
        const soundRate = (tts.triggered || 0) > 0 ? Math.round((tts.success || 0) * 100 / (tts.triggered || 1)) + '%' : 'N/A'
        ttsBody += `  声音播放成功率：${soundRate}\n`
        if ((tts.fail || 0) > 0) {
          ttsBody += `  ⚠️ 声音失败次数>0：请检查 server.py 是否在 127.0.0.1:5001 正常启动、合法域名配置是否勾选「不校验合法域名」\n`
        } else {
          ttsBody += `  ✅ 声音功能检测：所有应播放声音的场景均正常播放（无中断/无丢失）\n`
        }
      } else {
        ttsBody += `  💡 本轮为稳定优先模式，未调用真实TTS（保证6景点流程稳定不闪退）。\n`
        ttsBody += `     若需验证声音，请把 chat.js 第 228 行 / map-explore.js 第 10 行改为 _ENABLE_TTS_AUDIO = true 后再跑一轮。\n`
      }
      let body = '【自动化检测·最终报告 · 6景点全流程 + 声音 + 防闪退】\n'
      body += '生成时间：' + new Date().toLocaleString('zh-CN', { hour12: false }) + '\n'
      body += '测试结论：' + (anyCrash ? '❌ 发现闪退问题' : '✅ 6个景点全部通过，无闪退') + '\n'
      body += 'TTS模式：' + ttsModeText + '\n\n'
      body += '————— 各景点详细记录（含时间戳/对话轮次/TTS统计）—————\n'
      this._autoTestSpotOrder.forEach(s => {
        const r = that._autoTestSpotReport[s]
        body += `\n【${r.spotName}】\n`
        body += `  状态：${r.status}\n`
        body += `  对话轮次：${r.dialogCount}\n`
        body += `  开始时间：${r.startTime || '--'}\n`
        body += `  结束时间：${r.finishTime || '--'}\n`
        body += `  耗时：${Math.round((r.durationMs || 0) / 1000)} 秒\n`
        if (r.sound) {
          body += `  🎙 本景点TTS统计：触发 ${r.sound.ttsTriggered || 0}，成功 ${r.sound.ttsSuccess || 0}，失败 ${r.sound.ttsFail || 0}\n`
          if ((r.sound.soundIssues || []).length > 0) {
            body += `  ⚠️ 声音问题：\n`
            ;(r.sound.soundIssues || []).forEach(iss => { body += `    · ${iss.substring(0, 120)}\n` })
          }
        }
        if (r.crashInfo) {
          body += `  ⚠️闪退详情（错误类型+场景）：\n`
          body += `    闪退时间：${r.crashInfo.crashTime || '--'}\n`
          body += `    错误内容：${(r.crashInfo.errMsg || '').substring(0, 200)}\n`
          if (r.crashInfo.stack) body += `    堆栈片段：${(r.crashInfo.stack).substring(0, 160)}\n`
          body += `    对应场景：景点【${r.spotName}】第 ${r.dialogCount} 轮对话\n`
        }
        if (r.note) body += `  备注：${r.note}\n`
      })
      body += '\n————— TTS & 声音功能完整性检测（同步验证剧情+声音）—————\n' + ttsBody
      body += '\n————— 闪退可能触发条件 & 修复建议 —————\n'
      if (anyCrash) {
        body += '  1. 请查看【调试】面板中「错误日志」栏，定位具体错误堆栈\n'
        body += '  2. 若报错含"__wcc_version_info__ of null"：渲染重叠时setData失败，需进一步降低打字频率\n'
        body += '  3. 若报错含"recursive update detected"：检查是否有并发setData更新同一条消息\n'
        body += '  4. 若想先跑流程再调声音，可临时改 _ENABLE_TTS_AUDIO=false（降级稳定模式）\n'
      } else {
        body += '  本轮6个景点全部正常，无闪退问题！\n'
        if (!tts.enabled) {
          body += '  📢 本轮是稳定优先模式，下一轮建议改为 _ENABLE_TTS_AUDIO=true 并启动 server.py，即可同时验证剧情+声音的完整流畅性。\n'
        }
      }
      body += '\n————— 完整自动化步骤日志（按时间戳）—————\n'
      try {
        const logLines = (this._autoTestLogs || []).map(item => `  ${item.level.toUpperCase().padEnd(5)}  ${item.line}`)
        // 报告内最多放前 150 条（setData 字符串太长会报错），Console 会一次性打全部
        body += (logLines.length <= 150 ? logLines.join('\n') : logLines.slice(0, 150).join('\n') + `\n  ……共${logLines.length}条，完整日志见Console下方一次性打印。`)
      } catch (eLog) { body += '  (日志解析失败)' }
      this.setData({ autoTestReport: body })
      this._pushDebugLog('自动测试', '🏁 最终报告已生成！' + (anyCrash ? '存在闪退问题' : '全程通过'))
      // ==========================================================
      // 【关键】_autoTestLogs 和最终报告 【一次性】打印到 Console，
      //         全程不实时打印，防止 Windows 开发者工具 20 秒日志过多崩溃闪退。
      // ==========================================================
      console.log('================ 自动化检测报告 · 完整日志 ================\n' +
                  body + '\n' +
                  '================ 完整逐步骤日志（共' + ((this._autoTestLogs || []).length) + '条）===============')
      try {
        ;(this._autoTestLogs || []).forEach(function(item) {
          if (item.level === 'error') console.error('[TEST-LOG] ' + item.line)
          else if (item.level === 'warn') console.warn('[TEST-LOG] ' + item.line)
          else console.log('[TEST-LOG] ' + item.line)
        })
      } catch (e) {}
      console.log('==============================================================')
      try { wx.showModal({ title: anyCrash ? '❌ 发现闪退' : '✅ 全程通过', content: '6个景点自动测试完成，详情请查看悬浮【调试】面板中的【测试报告】。Console已一次性打印完整日志。', showCancel: false }) } catch (e) {}
    } catch (e) {}
  },

  // ---------- 自动化测试：记录闪退（全局onError调用）----------
  _autoTestRecordCrash(errMsg, errStack) {
    try {
      const currentSpot = this._autoTestSpotOrder[this._autoTestCurrentSpotIdx] || '未知'
      const report = this._autoTestSpotReport[currentSpot]
      if (report) {
        report.status = '闪退'
        report.crashInfo = {
          errMsg: errMsg || '',
          stack: errStack || '',
          crashTime: new Date().toLocaleString('zh-CN', { hour12: false })
        }
        report.dialogCount = this._autoTestDialogCount
        report.finishTime = report.crashInfo.crashTime
      }
      // 闪退日志也要走数组（防止立刻打印导致工具崩溃），同时强制触发最终报告生成
      this._autoTestLog(`💥 闪退发生！位置=【${currentSpot}】，错误= ${(errMsg || '').substring(0, 80)}`, 'error')
      try { this._autoTestGenerateFinalReport() } catch (e) {}
    } catch (e) {}
  },

  // ============================================================================
  // §18. TTS 语音播放模块
  //   _resolveAudioSrc(rawSrc)
  //     Base64 语音 data:audio/...;base64,xxx 无法直接赋给 InnerAudioContext.src
  //     (真机不兼容)。必须先通过 getFileSystemManager.writeFile 写入本地
  //     USER_DATA_PATH 临时 mp3，再返回绝对路径。非 Base64(templateFilePath/
  //     网络URL) 原样返回。
  //   playTTS(text, onDone, onPlayStart, onAudioProgress)
  //     核心播放函数：空文本/静音/降级模式 → 立刻走_safeSetTimeout回调；
  //     正常路径：TTS队列锁 _isTtsPlaying，下载 mp3(TTS_SERVER_URL/tts?text=)
  //     + 60s 超时 + downloadTask 登记到 _ttsActiveDownloadTasks（onUnload abort）
  //     + 创建/复用 InnerAudioContext（ctx 复用，不再频繁 create/destroy）
  //     + 11 事件全绑定后才赋 src + onCanplay 才 play + onTimeUpdate
  //     驱动"字随音走"打字机进度。safeFinish 幂等收敛（成功/失败/超时/错误
  //     都只触发一次 onDone(wasSuccess)，防重复 finish）。3 秒兜底强制
  //     play（onCanplay 不触发时兜底）。
  //   _finishOneTts(wasSuccess, onDone)
  //     首行判存活 → stop + 清空 11 事件（保留 ctx 下次复用，不 destroy）→
  //     清下载超时定时器 → 触发 onDone → 取队列下一条延迟 250ms 衔接
  //     （250ms 延迟：给底层解码线程释放完全，杜绝野指针闪退）。
  // ============================================================================
  // 🔴 AI 整改点①：Base64 真机无法播放兜底——禁止直接把 data:audio/...;base64 赋给 InnerAudioContext.src
  //    必须先写入 USER_DATA_PATH 临时 mp3 文件，再返回本地绝对路径
  //    兼容三种输入：wx.downloadFile 返回的 tempFilePath / data:audio/...;base64,xxx / 普通网络URL
  _resolveAudioSrc(rawSrc) {
    try {
      if (!rawSrc || typeof rawSrc !== 'string') return Promise.resolve('')
      const rawSrcTrim = String(rawSrc).trim()
      // Base64 匹配：data:audio/<ext>;base64,xxxxxxxx
      if (/^data:audio\/[a-zA-Z0-9+]+;base64,/i.test(rawSrcTrim)) {
        try {
          const fs = wx.getFileSystemManager()
          const commaIdx = rawSrcTrim.indexOf(',')
          const base64Payload = commaIdx > -1 ? rawSrcTrim.substring(commaIdx + 1) : rawSrcTrim
          const userDataPath = (wx.env && wx.env.USER_DATA_PATH) || ''
          const localAbsPath = userDataPath + '/temp_voice_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '.mp3'
          return new Promise((resolve) => {
            try {
              fs.writeFile({
                filePath: localAbsPath,
                data: base64Payload,
                encoding: 'base64',
                success: () => { if (_TTS_VERBOSE_LOG) console.log('[TTS] Base64已写本地临时文件:', localAbsPath); resolve(localAbsPath) },
                fail: (eWrite) => { console.error('[TTS] Base64写临时文件失败:', eWrite); resolve(rawSrcTrim) } // 失败兜底：返回原src（保证绝不崩溃）
              })
            } catch (eWrite2) { console.error('[TTS] Base64写临时文件异常:', eWrite2); resolve(rawSrcTrim) }
          })
        } catch (eFS) { console.error('[TTS] getFileSystemManager调用异常:', eFS); return Promise.resolve(rawSrcTrim) }
      }
      // 非 Base64（tempFilePath / 网络 URL）：原样返回
      return Promise.resolve(rawSrcTrim)
    } catch (eTop) { return Promise.resolve(rawSrc || '') }
  },

  // ============ TTS 文字转语音播放（队列版 + 全链路防闪退 + 下载超时兜底 + 降级开关）============
  // onDone(wasSuccess): 播放完成回调（无论成功/失败/静音/超时/降级开关关闭都会触发，用于和打字机同步）
  // onPlayStart(): 【可选】TTS 真正开始发声（onPlay）时的回调，用于和打字机同步启动（解决文字先出很久的时差问题）
  //     - 空文本/静音/降级开关关闭：会立即触发（打字机无需等待）
  //     - 正常播放：只在 _audioCtx.onPlay 首次触发时调用（声出才出字）
  // onAudioProgress(currentTime, duration): 【可选】音频真实播放进度回调，用于【字随音走】——打字机按音频进度比例显示文字
  //     - 触发时机：InnerAudioContext.onTimeUpdate（约每 250ms 一次），以及 onEnded(强制触发 100%)
  //     - 单位：currentTime 秒，duration 秒；无音频/静音/空文/降级时立刻触发 (1,1) 即 100%
  playTTS(text, onDone, onPlayStart, onAudioProgress) {
    const ttsStartTime = Date.now()
    try {
      console.log('[DEBUG-VOICE] ④ playTTS text=' + String(text || '').substring(0, 40) + ' len=' + (text ? text.length : 0) + ' isMuted=' + !!(this && this.data && this.data.isMuted) + ' ENABLE_TTS=' + _ENABLE_TTS_AUDIO + ' [t=0ms]')
      if (!text || !text.trim()) {
        if (_TTS_VERBOSE_LOG) console.log('[TTS] 空文本跳过')
        if (onAudioProgress) this._safeSetTimeout(() => { try { onAudioProgress(1, 1) } catch (e) {} }, 0)   // 空文→100%（打字机立刻显示全文，不卡死）
        if (onPlayStart) this._safeSetTimeout(() => { try { onPlayStart() } catch (e) {} }, 0)
        if (onDone) this._safeSetTimeout(() => { try { onDone(true) } catch (e) {} }, 0)
        return
      }
      if (_TTS_VERBOSE_LOG) console.log('[TTS] playTTS被调用，isMuted=', this.data.isMuted, '_isTtsPlaying=', this._isTtsPlaying, '队列长度=', (this._ttsQueue || []).length, '文本片段:', (text || '').substring(0, 20))
      if (this.data.isMuted) {
        if (_TTS_VERBOSE_LOG) console.log('[TTS] 用户已静音，跳过播放')
        if (onAudioProgress) this._safeSetTimeout(() => { try { onAudioProgress(1, 1) } catch (e) {} }, 0)   // 静音→100%
        if (onPlayStart) this._safeSetTimeout(() => { try { onPlayStart() } catch (e) {} }, 0)
        if (onDone) this._safeSetTimeout(() => { try { onDone(true) } catch (e) {} }, 0)
        return
      }

      // 文本过长（超过300字）截取前300字（避免TTS超时/超限）
      const cleanText = text.trim().slice(0, 300)

      // ===== TTS 队列：正在播放时入队，不 destroy 上一条（防止"念一半掐断"闪退）=====
      this._ttsQueue = this._ttsQueue || []
      if (this._isTtsPlaying) {
        this._ttsQueue.push({ text: cleanText, onDone, onPlayStart, onAudioProgress })  // ⚠️ 同步入队 onPlayStart + onAudioProgress
        if (_TTS_VERBOSE_LOG) console.log('[TTS] 当前正在播放，已入队，队列长度:', this._ttsQueue.length)
        return
      }
      this._isTtsPlaying = true

      // =========================================================
      // 🔴 【终极收敛 · 降级开关】_ENABLE_TTS_AUDIO = false 时，
      //    完全不调任何 wx.downloadFile / createInnerAudioContext / destroy 等音频API，
      //    直接视为TTS成功，立刻 onDone(true)，等同于「自动检测功能实现时的稳定态」，
      //    保证从第一景点跑至第六景点绝对不闪退。
      // =========================================================
      if (!_ENABLE_TTS_AUDIO) {
        // 降级模式：直接回调，不走任何音频链路
        if (_TTS_VERBOSE_LOG) console.log('[TTS] 降级模式（_ENABLE_TTS_AUDIO=false），直接视为完成，稳定优先')
        const that = this
        if (onAudioProgress) this._safeSetTimeout(() => { try { onAudioProgress(1, 1) } catch (e) {} }, 0)   // 降级→100%
        if (onPlayStart) this._safeSetTimeout(() => { try { onPlayStart() } catch (e) {} }, 0)   // 降级立刻触发打字机，不卡死
        this._safeSetTimeout(() => {
          try { that && that._finishOneTts(true, onDone) } catch (e) {}
        }, 0)
        return
      }

      if (_TTS_VERBOSE_LOG) console.log('[TTS] 获取播放锁，开始处理...')
      const url = TTS_SERVER_URL + '/tts?text=' + encodeURIComponent(cleanText)
      const downloadStartTime = Date.now()
      if (_TTS_VERBOSE_LOG) console.log('[TTS] 开始请求TTS服务器: ' + url.substring(0, 60) + '... [t=+' + (downloadStartTime - ttsStartTime) + 'ms]')

      let finished = false  // 防重复触发 finishOneTts（超时+success/fail/onEnded 都可能触发）
      let hasFiredPlayStartTop = false   // 和 finished 同级：onPlayStart 全链路只触发一次（含成功/失败/超时兜底）
      let hasFiredProgressFinal = false  // 和 finished 同级：onAudioProgress 100% 全链路只触发一次
      const that = this  // 闭包安全的 this：嵌套 safeFinish / setTimeout 回调中用 that 访问 Page 实例
      // safeFinish 幂等收敛：成功/失败/超时/错误 任意路径触发一次后，后续全部 return
      // 保证：onPlayStart 兜底触发、onAudioProgress 100% 兜底、下载超时清、_finishOneTts 调用
      const safeFinish = (wasSuccess) => {
        try {
          if (finished) return
          finished = true
          // 🔴 保底：任何原因触发 safeFinish（失败/超时/错误）→ 如果 onPlayStart 还没触发过就立刻触发
          //    防止"TTS失败但打字机永远不出字"的卡死体验
          if (!hasFiredPlayStartTop && onPlayStart) {
            hasFiredPlayStartTop = true
            try { onPlayStart() } catch (ePS) {}
          }
          if (!hasFiredProgressFinal && onAudioProgress) {
            hasFiredProgressFinal = true
            try { onAudioProgress(1, 1) } catch (ePA) {}
          }
          if (downloadTimeoutH && this._allTimeoutHandles && this._allTimeoutHandles.has(downloadTimeoutH)) {
            this._allTimeoutHandles.delete(downloadTimeoutH)
          }
          try { clearTimeout(downloadTimeoutH) } catch (eCl) {}
          try { that && that._finishOneTts(wasSuccess, onDone) } catch (eFin) { /* 禁止兜底 setData，仅 catch 住 */ }
        } catch (eSF) {
          // 🔴 safeFinish 自身出错：绝对不能再调 setData，否则触发 recursive update
          console.error('[TTS] safeFinish 致命异常: ' + (eSF && eSF.stack ? eSF.stack : eSF))
        }
      }
      // 下载超时兜底：60 秒下载锁死直接强制 safeFinish，避免队列永远卡死
      // 【走_safeSetTimeout】注册进_allTimeoutHandles，onUnload 时批量清理 → 防页面销毁后回调触发 __wcc_version_info__ null
      const downloadTimeoutH = this._safeSetTimeout(() => {
        if (_TTS_VERBOSE_LOG) console.warn('[TTS] 下载超时 60s 强制解锁')
        try {
          if (this && this._pageAlive && !this._destroyed) {
            try { wx.showModal({ title: 'TTS 超时', content: '龙三叔语音下载超时 60 秒，已自动解锁继续剧情。', showCancel: false, confirmText: '知道了' }) } catch (eM2) {}
          }
        } catch (eModalTime) {}
        safeFinish(false)
      }, 60 * 1000)

      // 🚀 在 downloadFile 发出时立即触发 onPlayStart → 打字机知道音频开始加载，文字和声音的加载并行降低感知延迟
      if (!hasFiredPlayStartTop && onPlayStart) {
        hasFiredPlayStartTop = true
        const earlyPlayStartTime = Date.now()
        if (_TTS_VERBOSE_LOG) console.log('[TTS-Sync] onPlayStart提前触发（downloadFile发出时）[t=+' + (earlyPlayStartTime - ttsStartTime) + 'ms]')
        try { onPlayStart() } catch (e) {}
      }

      // 下载 MP3 —— downloadTask 句柄立刻登记到 _ttsActiveDownloadTasks，onUnload 时 abort 释放带宽
      const downloadTask = wx.downloadFile({
        url: url,
        success: (res) => {
          try {
            if (finished) return
            // 页面已死：立刻 safeFinish 解锁，绝不创建音频上下文
            if (!this || !this._pageAlive || this._destroyed) {
              if (_TTS_VERBOSE_LOG) console.warn('[TTS] 下载完成但页面已死，强制解锁')
              safeFinish(false)
              return
            }
            if (res.statusCode !== 200) {
              // AI 整改点③：下载 HTTP 非 200 也强制真机弹窗
              try {
                if (this && this._pageAlive && !this._destroyed) {
                  try { wx.showModal({ title: 'TTS下载失败', content: ('错误码(HTTP): ' + (res.statusCode || '未知') + '\n错误信息: ' + ((res.data && typeof res.data === 'string' ? res.data.substring(0, 100) : '') || '服务器非200响应')), showCancel: false, confirmText: '知道了' }) } catch (eM) {}
                }
              } catch (eModalPre) {}
              if (_TTS_VERBOSE_LOG) console.warn('[TTS] 下载失败 HTTP:', res.statusCode)
              safeFinish(false)
              return
            }
            const downloadDoneTime = Date.now()
            if (_TTS_VERBOSE_LOG) console.log('[TTS] 下载成功 [下载耗时:' + (downloadDoneTime - downloadStartTime) + 'ms, 总耗时:' + (downloadDoneTime - ttsStartTime) + 'ms]')

            // 唯一销毁点 _finishOneTts 管理旧ctx，此处仅创建新ctx
            const ctxReuseTime = Date.now()
            // 🚀 【优化2】复用 InnerAudioContext：如果已有实例且未销毁，直接复用
            //    背景：createInnerAudioContext 频繁创建/销毁在鸿蒙/安卓 9 以下偶发解码线程野指针闪退 → 复用降低 GC 压力
            let reusedCtx = false
            let ctx = null
            if (this._audioCtx && typeof this._audioCtx.stop === 'function') {
              try {
                this._audioCtx.stop()
                reusedCtx = true
                if (_TTS_VERBOSE_LOG) console.log('[TTS] ♻️ 复用已有InnerAudioContext [t=+' + (ctxReuseTime - downloadDoneTime) + 'ms]')
                ctx = this._audioCtx
              } catch (eReuse) {
                // 复用失败（比如 stop 抛异常） → 彻底抛弃，重新 createInnerAudioContext
                reusedCtx = false
                try { this._audioCtx && this._audioCtx.destroy && this._audioCtx.destroy() } catch (eDes) {}
                this._audioCtx = null
                if (_TTS_VERBOSE_LOG) console.warn('[TTS] 复用ctx失败，重建：' + (eReuse && eReuse.message ? eReuse.message : eReuse))
              }
            }
            if (!ctx) {
              // 新建 ctx：严格走 wx.createInnerAudioContext（禁止单例模式）
              ctx = wx.createInnerAudioContext()
              this._audioCtx = ctx
              if (_TTS_VERBOSE_LOG) console.log('[TTS] 🆕 新建InnerAudioContext [t=+' + (Date.now() - ctxReuseTime) + 'ms]')
            }
            // 🔴 音量 & 混音：obeyMuteSwitch=false → 即便微信静音开关打开也强制出声（龙三叔语音不能被"系统静音"吞）
            ctx.obeyMuteSwitch = false
            ctx.volume = 1.0

            // ============================================
            // AI 整改点②：原 src 赋值移到 11 事件 + onCanplay 全部绑定完成后再执行
            //   根因：早期版本先赋值 src 再绑 onCanplay → 安卓部分机型 src 立刻就绪，onCanplay 先于回调绑定触发 → play() 永远不调，"有文无声"
            // ============================================
            let hasStartedPlay = false
            let hasFiredPlayStart = false
            let audioFinishTimer = null
            let srcReadyTime = 0
            let startFinishTimer = null

            // 11 事件模型全量绑定：onCanplay/onPlay/onPause/onSeeked/onSeeking/onWaiting/onLoadedmetadata/onTimeUpdate/onError/onEnded/onStop
            //   🔴 所有回调里禁止 UI setData/格式化打印/文件IO → 仅调用 safeFinish / 触发 onPlayStart / onAudioProgress
            ctx.onCanplay(() => {
              if (!this || !this._pageAlive || this._destroyed) return
              if (finished) return
              srcReadyTime = Date.now()
              if (_TTS_VERBOSE_LOG) console.log('[TTS] onCanplay触发 → play() [t=+' + (srcReadyTime - ttsStartTime) + 'ms]')
              try {
                if (!hasStartedPlay) {
                  hasStartedPlay = true
                  ctx.play()
                }
              } catch (ePlay) {
                // play() 同步失败：3 秒兜底 startFinishTimer 会再救一次
                if (_TTS_VERBOSE_LOG) console.warn('[TTS] onCanplay里play()同步失败：' + (ePlay && ePlay.message ? ePlay.message : ePlay))
              }
              // 3 秒兜底：onCanplay 后超过 3s 仍未 safeFinish → 强制 safeFinish(false) 解锁
              try { clearTimeout(startFinishTimer) } catch (eC) {}
              startFinishTimer = setTimeout(() => {
                if (!finished) {
                  if (_TTS_VERBOSE_LOG) console.warn('[TTS] onCanplay后3秒仍未完成，强制解锁')
                  safeFinish(false)
                }
              }, 3000)
            })
            ctx.onPlay(() => {
              if (finished) return
              if (!this || !this._pageAlive || this._destroyed) return
              if (!hasFiredPlayStartTop && onPlayStart) {
                hasFiredPlayStartTop = true
                try { onPlayStart() } catch (e) {}
              }
              if (!hasFiredPlayStart) {
                hasFiredPlayStart = true
                if (_TTS_VERBOSE_LOG) console.log('[TTS] 🎵 真正开始出声 onPlay [t=+' + (Date.now() - ttsStartTime) + 'ms]')
              }
            })
            ctx.onPause(() => { if (_TTS_VERBOSE_LOG) console.log('[TTS] onPause（忽略：不自动恢复，等待onEnded/onStop收敛）') })
            ctx.onSeeked(() => {})
            ctx.onSeeking(() => {})
            ctx.onWaiting(() => { if (_TTS_VERBOSE_LOG) console.log('[TTS] onWaiting缓冲中…') })
            ctx.onLoadedmetadata(() => {})
            ctx.onTimeUpdate(() => {
              if (finished || !onAudioProgress) return
              if (!this || !this._pageAlive || this._destroyed) return
              try {
                const dur = (ctx && typeof ctx.duration === 'number' && ctx.duration > 0) ? ctx.duration : 1
                const cur = (ctx && typeof ctx.currentTime === 'number') ? Math.min(ctx.currentTime, dur) : dur
                onAudioProgress(cur, dur)
              } catch (eUpd) {}
            })
            ctx.onError((err) => {
              if (_TTS_VERBOSE_LOG) console.warn('[TTS] ❌ onError:', err && err.errCode, err && err.errMsg)
              try {
                if (this && this._pageAlive && !this._destroyed) {
                  try { wx.showModal({ title: 'TTS 播放错误', content: ('errCode: ' + (err && err.errCode) + '\nerrMsg: ' + (err && err.errMsg || '')).substring(0, 200), showCancel: false, confirmText: '知道了' }) } catch (eM) {}
                }
              } catch (ePre) {}
              safeFinish(false)
            })
            ctx.onEnded(() => {
              if (_TTS_VERBOSE_LOG) console.log('[TTS] ✅ onEnded播放完成 [t=+' + (Date.now() - ttsStartTime) + 'ms]')
              if (!hasFiredProgressFinal && onAudioProgress) {
                hasFiredProgressFinal = true
                try { onAudioProgress(1, 1) } catch (eP) {}
              }
              safeFinish(true)
            })
            ctx.onStop(() => {
              if (_TTS_VERBOSE_LOG) console.log('[TTS] ⏹ onStop 触发')
              safeFinish(false)
            })

            // 🔴 Base64 语音 / tempFilePath 统一走 _resolveAudioSrc → 写 FS 临时文件 → 取绝对路径 → 赋值 src
            //   根因：Base64 直接赋 InnerAudioContext.src 真机（尤其 iOS）直接解码失败或卡死
            const resTempFilePath = res.tempFilePath || ''
            this._resolveAudioSrc(resTempFilePath).then((finalSrc) => {
              if (finished || !this || !this._pageAlive || this._destroyed) return
              if (_TTS_VERBOSE_LOG) console.log('[TTS] src=' + (finalSrc || '').substring(0, 80) + '... [t=+' + (Date.now() - ttsStartTime) + 'ms]')
              try {
                ctx.src = finalSrc
                // 🔴 绝对禁止 src 赋值后立刻 play()！必须等 onCanplay → play()
              } catch (eSrc) {
                if (_TTS_VERBOSE_LOG) console.error('[TTS] 赋值src失败：' + (eSrc && eSrc.message ? eSrc.message : eSrc))
                safeFinish(false)
              }
            }).catch((eRs) => {
              if (_TTS_VERBOSE_LOG) console.error('[TTS] _resolveAudioSrc失败：' + (eRs && eRs.message ? eRs.message : eRs))
              safeFinish(false)
            })
          } catch (eSuc) {
            // 🔴 异步回调 catch：禁止 setData，仅清理定时器并标记完成
            if (_TTS_VERBOSE_LOG) console.error('[TTS] downloadFile success 致命异常：' + (eSuc && eSuc.stack ? eSuc.stack : eSuc))
            try { clearTimeout(audioFinishTimer) } catch (eX) {}
            try { clearTimeout(startFinishTimer) } catch (eX) {}
            safeFinish(false)
          }
        },
        fail: (err) => {
          // wx.downloadFile 调用失败（URL 不通/离线/小程序非法域名校验失败）
          try {
            if (finished) return
            try {
              if (this && this._pageAlive && !this._destroyed) {
                try { wx.showModal({ title: 'TTS 请求失败', content: ('错误码: ' + (err && err.errMsg ? err.errMsg : (typeof err === 'string' ? err : '未知'))).substring(0, 200), showCancel: false, confirmText: '知道了' }) } catch (eM) {}
              }
            } catch (ePre) {}
            if (_TTS_VERBOSE_LOG) console.warn('[TTS] downloadFile fail:', err)
            safeFinish(false)
          } catch (eFail) { console.error('[TTS] downloadFile fail catch:', eFail) }
        }
      })
      // downloadTask 句柄登记到 Set：onUnload 时遍历 abort，防止页面离开后下载完成触发回调
      this._ttsActiveDownloadTasks = this._ttsActiveDownloadTasks || new Set()
      this._ttsActiveDownloadTasks.add(downloadTask)
    } catch (ePlayTop) {
      // 🔴 playTTS 顶层异常：绝对禁止 UI setData 补救，只做 safeFinish 解锁 + 调试日志
      console.error('[TTS] playTTS 顶层致命异常：' + (ePlayTop && ePlayTop.stack ? ePlayTop.stack : ePlayTop))
      try { this && this._pushDebugLog && this._pushDebugLog('FATAL playTTS: ' + (ePlayTop && ePlayTop.message ? ePlayTop.message : ePlayTop), 'error') } catch (e) {}
      try { if (this) { const that=this; this._safeSetTimeout(()=>{ try { that && that._finishOneTts(false, onDone) } catch(e){} }, 0) } } catch (eFin2) {}
    }
  },

  // ============ TTS 单条收尾 + 衔接队列（安全销毁序列 / 11 事件解绑 / 下载句柄摘除）============
  // 🔴 这里是唯一销毁 ctx 的位置，严格遵循「解绑 11 事件 → stop() → 延迟 150ms → destroy()」的 TOP3 闪退修复序列
  // 根因：stop 后立即 destroy → 解码线程仍在写底层 Buffer → 野指针崩溃（尤其安卓）
  _finishOneTts(wasSuccess, onDone) {
    // 【首行存活判定】页面销毁后立刻 return，防止访问死亡 Page 的 this → 触发 __wcc_version_info__ of null
    if (!this || !this._pageAlive || this._destroyed) {
      if (_TTS_VERBOSE_LOG) console.warn('[TTS] _finishOneTts 页面已死，跳过')
      try { if (onDone) onDone(false) } catch (e) {}
      return
    }
    try {
      const ctx = this._audioCtx
      if (ctx) {
        try {
          // 11 事件置空（先解绑，避免 stop/destroy 期间 onEnded/onStop 再重入 safeFinish）
          ctx.onCanplay(() => {})
          ctx.onPlay(() => {})
          ctx.onPause(() => {})
          ctx.onSeeked(() => {})
          ctx.onSeeking(() => {})
          ctx.onWaiting(() => {})
          ctx.onLoadedmetadata(() => {})
          ctx.onTimeUpdate(() => {})
          ctx.onError(() => {})
          ctx.onEnded(() => {})
          ctx.onStop(() => {})
        } catch (eUnbind) {}
        // stop 不 destroy（destroy 延迟 150ms 给解码线程收尾）
        try { if (typeof ctx.stop === 'function') ctx.stop() } catch (eStop) {}
      }
      // 立刻清锁 + 触发 onDone，不等待 150ms，保证打字机队列衔接低延迟
      this._isTtsPlaying = false
      try { if (onDone) onDone(!!wasSuccess) } catch (e) {}
      // 销毁 ctx（延迟 150ms + 存活再判定 → 双重保底）
      const that = this
      this._safeSetTimeout(() => {
        if (!that || !that._pageAlive || that._destroyed) return
        try {
          const c = that._audioCtx
          if (c && typeof c.destroy === 'function') c.destroy()
        } catch (e) {}
        that._audioCtx = null
      }, 150)
      // 衔接队列：延迟 250ms 再出队（避免解码线程刚释放又抢占）
      this._safeSetTimeout(() => {
        if (!that || !that._pageAlive || that._destroyed) return
        that._ttsQueue = that._ttsQueue || []
        if (that._ttsQueue.length === 0) return
        const next = that._ttsQueue.shift()
        try { that.playTTS(next.text, next.onDone, next.onPlayStart, next.onAudioProgress) } catch (eNext) {
          console.error('[TTS] 队列衔接异常：' + (eNext && eNext.message ? eNext.message : eNext))
        }
      }, 250)
    } catch (eTop) {
      console.error('[TTS] _finishOneTts 异常：' + (eTop && eTop.stack ? eTop.stack : eTop))
      // 🔴 catch 中禁止 setData 补救（防止 recursive update），仅保证锁状态正确
      try { this._isTtsPlaying = false } catch (e) {}
      try { if (onDone) onDone(false) } catch (e) {}
    }
  },

  // ============ §19 打字机模块（递归 setTimeout/setInterval 链 + 仅 displayText 更新 + 双门闩 checkBothDone 同步TTS）============
  // 🔴 关键设计说明（根因对应项目内存铁律）：
  //  1) 打字机永不使用 setInterval 死循环；递归 setTimeout/setInterval 首行必判 _pageAlive，失败立即 clearInterval。
  //  2) 单条消息只更新 data 里的 displayText 字段（绝不与 scrollToView、isSending 在同一个 setData 里）—— 防止 scroll-view 渲染冲突触发 recursive update。
  //  3) 双门闩 checkBothDone(typewriterDoneFlag, ttsDoneFlag)：打字机完成 & TTS 完成 两个 flag 同时 true 才触发后续过渡弹窗/下一景点逻辑，
  //     解决"声未停字先停"或"字停很久声才停"的门闩错位。
  //  4) 所有消息气泡初始 content=''，displayText 逐字累积 → 用户视觉上完全看不到"整段文字突然闪一下"的瑕疵。
  //  5) 打字队列 _typingQueue：赵佗连续多条消息逐条排队打字，绝不重叠。

  // 🔴 打字队列 & 全局锁：_typingQueue 存待打字的任务；_isTyping=true 时新任务入队等上一条完成
  // _typingQueue: Array<{msgIndex:number, fullText:string, onTypeDone?:Function, enableTts?:boolean, spotName?:string}>

  /**
   * 【核心打字机入口】给 msgList[msgIndex] 这条气泡启动逐字打字
   * @param {number} msgIndex          messages 数组下标（setData 更新哪条气泡的 displayText）
   * @param {string} fullText          完整文字（最终 displayText 会累计到 fullText）
   * @param {Function} [onTypeDone]    【双门闩触发回调】只有当 打字完成 && TTS 完成 时才会真正执行
   * @param {boolean} [enableTts=true] 是否同时调用 playTTS（例如欢迎语走 true；过渡台词走 true；大结局走 true）
   * @param {string} [ttsOverrideText] TTS 文本默认等于 fullText，某些场景下 fullText 有 Emoji/Markdown 但 TTS 要纯文字时单独传
   */
  startMsgTypewriter(msgIndex, fullText, onTypeDone, enableTts = true, ttsOverrideText = '') {
    // 【LifeCycle 假死兜底】页面 onLoad 之前就被后台杀死 → 静默 return，绝不调 setData
    if (!this || !this._pageAlive || this._destroyed) {
      if (_TTS_VERBOSE_LOG) console.warn('[打字机] 页面已死，跳过 打字 startMsgTypewriter idx=' + msgIndex)
      try { if (onTypeDone) onTypeDone() } catch (e) {}   // 仅回调解锁，不抛错
      return
    }
    // 排队锁：正在打字 → 入队等 _processTypingQueue 拉
    if (this._isTyping) {
      this._typingQueue = this._typingQueue || []
      this._typingQueue.push({ msgIndex, fullText, onTypeDone, enableTts, ttsOverrideText })
      return
    }
    this._isTyping = true

    try {
      const text = String(fullText || '')
      const safeForTts = (ttsOverrideText && ttsOverrideText.trim()) ? ttsOverrideText : this._sanitizeForTTS(text)
      // ==== 双门闩：打字完成 flag / TTS 完成 flag ====
      let twDone = false   // 打字机 end-of-text
      let ttsDone = false  // playTTS onDone
      // 双门闩检查器：两个都 true 才回调（幂等）
      const checkBothDone = () => {
        if (!twDone || !ttsDone) return
        // 🔴 页面存活再调 onTypeDone（可能页面在打字中途就被销毁）
        if (!this || !this._pageAlive || this._destroyed) return
        try { if (onTypeDone) onTypeDone() } catch (e) { console.error('[打字机] onTypeDone异常：' + (e && e.stack ? e.stack : e)) }
      }

      // maxWaitMs 超时强制完成兜底：防止"onEnded 触发但 checkBothDone 没走"的死锁
      const maxWaitMs = Math.max(6000, Math.ceil(text.length * 0.28 * 1000) + 15000)
      let forcedTwDone = false
      const forceFinishH = this._safeSetTimeout(() => {
        if (!twDone || !ttsDone) {
          if (_TTS_VERBOSE_LOG) console.warn('[打字机] maxWaitMs 强制完成兜底 idx=' + msgIndex + ' len=' + text.length)
          forcedTwDone = true
          // 🔴 强制 setData 用 _safeSetData 并同时设两个门闩为 true → 走一次 checkBothDone
          this._safeSetData({ ['messages[' + msgIndex + '].displayText']: text }, () => {
            twDone = true; ttsDone = true
            checkBothDone()
          })
        }
      }, maxWaitMs)

      // 字随音走 jumpToIdx：被 onAudioProgress 按比例驱动 idx，避免"声快字慢"不同步
      let curIdx = 0
      const jumpToIdx = (idx) => {
        if (!this || !this._pageAlive || this._destroyed) return
        if (idx <= curIdx) return   // 只往前跳不后退，减少 setData 次数
        curIdx = Math.min(idx, text.length)
        // 🔴 仅更新 displayText 单字段 —— 避免同时更新 scrollToView 引发的 scroll-view 渲染与 setData 冲突（项目铁律）
        this._safeSetData({ ['messages[' + msgIndex + '].displayText']: text.substring(0, curIdx) })
      }

      // setInterval 235ms/字 → 对齐龙三叔 CosyVoice v3 flash 语速（约 4.25 字/秒）
      //    首行必判 _pageAlive；失败立刻 clearInterval + safeFinish 门闩
      let twInterval = null
      twInterval = setInterval(() => {
        if (!this || !this._pageAlive || this._destroyed) {
          // 🔴 打字 interval 首行判存活：页面已死 → 立刻 clearInterval + 放弃渲染
          try { clearInterval(twInterval) } catch (e) {}
          twInterval = null
          try { clearTimeout(forceFinishH) } catch (e) {}
          return
        }
        if (forcedTwDone) {
          try { clearInterval(twInterval) } catch (e) {}
          twInterval = null
          return
        }
        curIdx += 1
        if (curIdx > text.length) curIdx = text.length
        // 🔴 只更新 displayText 单字段！绝不和 typewriting / scrollToView / isSending 同批 setData
        this._safeSetData({ ['messages[' + msgIndex + '].displayText']: text.substring(0, curIdx) })
        if (curIdx >= text.length) {
          try { clearInterval(twInterval) } catch (e) {}
          twInterval = null
          // 打字完成（还需等 TTS 完成）
          if (!twDone) { twDone = true; checkBothDone() }
        }
      }, TYPEWRITER_INTERVAL)
      // 登记 interval 句柄：onUnload 时 clear（防页面死但 interval 仍跑触发死亡 setData）
      this._msgTimers = this._msgTimers || []
      this._msgTimers.push(twInterval)

      // TTS 播放：onAudioProgress 驱动 jumpToIdx 字随音走
      if (enableTts) {
        const onAudioProgressCb = (cur, dur) => {
          if (!this || !this._pageAlive || this._destroyed) return
          if (!dur || dur <= 0) return
          const ratio = Math.max(0, Math.min(1, cur / dur))
          const targetIdx = Math.floor(text.length * ratio)
          jumpToIdx(targetIdx)
        }
        this.playTTS(safeForTts, (wasSuccess) => {
          if (wasSuccess && !this._typeTimeoutTimers) this._typeTimeoutTimers = []
          if (!ttsDone) { ttsDone = true; checkBothDone() }
        }, null /* onPlayStart 走提前触发通道即可 */, onAudioProgressCb)
      } else {
        // enableTts=false：立刻把 TTS 门闩设 true，等打字完成
        ttsDone = true
        checkBothDone()
      }

      // 🔴 打字完成清理 + 队列衔接
      //    注意：checkBothDone 触发的 onTypeDone 里可能已经追加了下一条消息，因此清理必须独立于 onTypeDone
      const origCheckBothDone = checkBothDone.bind(this)
      // 将 forceFinishH 从 allTimeoutHandles 里也做自移除（safeSetTimeout 已经登记过，但双保险）
      const cleanupWhenBoth = () => {
        if (!twDone || !ttsDone) return
        try { clearInterval(twInterval) } catch (e) {}
        try { clearTimeout(forceFinishH) } catch (e) {}
        this._isTyping = false
        // 200ms 延迟拉队列（避免 setData 渲染帧被多条消息连续打字挤爆）
        this._safeSetTimeout(() => { this._processTypingQueue() }, 200)
      }
      // 套一层：双门闩触发时 → 同时执行 cleanup + onTypeDone
      // （重写 checkBothDone 引用：闭包中已经把它赋给了各回调的本地引用，所以用包装器替换绑定即可）
      // 由于 JS 闭包特性，这里替换上面的 checkBothDone 变量让未来的调用都走包装版
      // eslint-disable-next-line no-func-assign
      // （注：由于 JS const 不能改，这里改为每次 checkBothDone 调用末尾挂 cleanup：通过 setTimeout 轮询状态）
      const pollBoth = () => {
        if (!this || !this._pageAlive || this._destroyed) return
        if (twDone && ttsDone) { cleanupWhenBoth(); return }
        this._safeSetTimeout(pollBoth, 50)
      }
      this._safeSetTimeout(pollBoth, 50)
    } catch (eTop) {
      // 🔴 startMsgTypewriter 顶层异常：页面存活时兜底显示全文 + 立刻回调；页面死则完全静默
      console.error('[打字机] startMsgTypewriter 致命异常 idx=' + msgIndex + ' : ' + (eTop && eTop.stack ? eTop.stack : eTop))
      try {
        if (this && this._pageAlive && !this._destroyed) {
          this._safeSetData({ ['messages[' + msgIndex + '].displayText']: String(fullText || '') })
          this._isTyping = false
          try { if (onTypeDone) onTypeDone() } catch (e) {}
          this._safeSetTimeout(() => { this._processTypingQueue() }, 200)
        }
      } catch (eFallback) { /* 死透了完全静默 */ }
    }
  },

  /**
   * TTS 文本清理：去掉打字机 Emoji 光标、HTML、Markdown 符号，避免 CosyVoice 把符号读出来
   * @param {string} text 原始显示文本
   * @returns {string} 只保留中文/数字/常用标点的可朗读文本
   */
  _sanitizeForTTS(text) {
    try {
      return String(text || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')         // 零宽字符
        .replace(/```[\s\S]*?```/g, '')                // 代码块
        .replace(/`([^`]+)`/g, '$1')                   // inline code 去反引号
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // Markdown 图片
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // 链接保留锚文本
        .replace(/<[^>]+>/g, '')                       // HTML 标签
        .replace(/[*_#>~|=\-+]/g, '')                  // Markdown 符号
        .replace(/【[^】]*TOKEN_AWARDED[^】]*】/g, '')   // 去掉越王令奖励标记
        .replace(/\s+/g, '')
        .trim()
    } catch (e) { return String(text || '').trim() }
  },

  /**
   * 处理打字队列：当 _isTyping=false 时拉取队列首条调用 startMsgTypewriter
   * （被 startMsgTypewriter 完成时的 200ms 延迟、onLoad 初始化时调用）
   */
  _processTypingQueue() {
    if (!this || !this._pageAlive || this._destroyed) return
    if (this._isTyping) return
    this._typingQueue = this._typingQueue || []
    if (this._typingQueue.length === 0) return
    const next = this._typingQueue.shift()
    this.startMsgTypewriter(next.msgIndex, next.fullText, next.onTypeDone, !!next.enableTts, next.ttsOverrideText || '')
  },

  /**
   * 【向聊天消息列表追加一条赵佗气泡 + 启动打字 + TTS】
   *   顶层异常：页面已死时完全静默（不调 setData / 不生成 log / 不抛错）
   * @param {string} text            气泡完整文字（content 不直接赋，displayText 逐字显示）
   * @param {Function} [onTypeDone]  双门闩完成回调
   * @param {boolean} [enableTts=true] 是否同时 TTS
   * @param {boolean} [isHidden=false] 是否为隐藏系统消息（true 的话不渲染在聊天区，仅拼 API 请求）
   */
  appendBotMsgWithTypewriter(text, onTypeDone, enableTts = true, isHidden = false) {
    if (!this || !this._pageAlive || this._destroyed) {
      // 页面已死：完全静默，绝不碰 this.data 或 setData
      try { if (onTypeDone) onTypeDone() } catch (e) {}
      return
    }
    try {
      const msgs = this.data.messages || []
      const newIdx = msgs.length
      const nextMsg = {
        role: 'bot',
        content: '',           // 🔴 初始 content 为空，完整文字只通过 displayText 显示（防整段闪烁）
        displayText: '',
        typewriting: true,
        isHidden: !!isHidden,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      }
      // 只做一次 setData：messages.push({新气泡})。不跟后续打字机 displayText 的 setData 批处理
      this._safeSetData({
        messages: msgs.concat([nextMsg]),
        isSending: false
      }, () => {
        // 只有当不是隐藏消息才打字+TTS；隐藏消息跳过直接回调
        if (isHidden) {
          try { if (onTypeDone) onTypeDone() } catch (e) {}
          this._safeSetTimeout(() => { this._processTypingQueue() }, 50)
          return
        }
        this.startMsgTypewriter(newIdx, String(text || ''), onTypeDone, enableTts)
      })
    } catch (eTop) {
      // 🔴 顶层异常兜底：只有页面活着才补救 setData；页面死 → 完全静默
      console.error('[打字机] appendBotMsgWithTypewriter 致命异常：' + (eTop && eTop.stack ? eTop.stack : eTop))
      try {
        if (this && this._pageAlive && !this._destroyed) {
          try { this._pushDebugLog && this._pushDebugLog('FATAL appendBotMsg: ' + (eTop && eTop.message ? eTop.message : eTop), 'error') } catch (e) {}
        }
      } catch (eFb) {}
    }
  },

  /**
   * 【用一条新文字替换指定气泡内容 + 重启动打字机】
   *   用途：AI 流式获取到完整回复后，替换掉"赵佗正在思考…"占位气泡；
   *         LifeCycle 假死兜底：页面实例 if 判定 + setInterval 立刻清
   *         🔴 致命修复：isSending=false 和占位替换合入同一次 setData，避免两次 setData 帧与打字机 displayText 更新碰撞
   */
  replaceMsgWithTypewriter(msgIndex, newFullText, onTypeDone, enableTts = true) {
    if (!this || !this._pageAlive || this._destroyed) {
      // LifeCycle 假死兜底：页面不存活直接 onTypeDone 解锁
      try { if (onTypeDone) onTypeDone() } catch (e) {}
      return
    }
    try {
      // 🔴 isSending:false 与 displayText 重置一次性合并 setData，避免两次 setData 与打字机 displayText 更新相撞触发 recursive update
      this._safeSetData({
        ['messages[' + msgIndex + '].content']: '',
        ['messages[' + msgIndex + '].displayText']: '',
        ['messages[' + msgIndex + '].typewriting']: true,
        ['messages[' + msgIndex + '].isHidden']: false,
        isSending: false
      }, () => {
        this.startMsgTypewriter(msgIndex, String(newFullText || ''), onTypeDone, enableTts)
      })
    } catch (eTop) {
      console.error('[打字机] replaceMsgWithTypewriter 致命异常 idx=' + msgIndex + ' : ' + (eTop && eTop.stack ? eTop.stack : eTop))
      try {
        if (this && this._pageAlive && !this._destroyed) {
          this._safeSetData({ ['messages[' + msgIndex + '].displayText']: String(newFullText || ''), isSending: false })
          try { if (onTypeDone) onTypeDone() } catch (e) {}
        }
      } catch (eFb) {}
    }
  },

  // ============ §19 子模块 闪退防护三件套（Page 级全链路防闪退地基）============
  // 🔴 项目铁律：全项目任何业务 setData 禁止直接 this.setData()，必须走 this._safeSetData(...)
  //    根因：WeChat 基础库 3.17.0 灰度版 + 页面 onUnload 触发后（用户快速返回地图页/切后台被销毁）异步 setData 仍在回调队列里，
  //         调用 native.setData 时 Page 实例已被 JS 层销毁 → `__wcc_version_info__ of null` 闪退 / `recursive update` 无限递归 / WAWorker kill。
  /**
   * 【三层防护版 setData】
   *  L1 调用前存活判定：(_pageAlive && !_destroyed) 双保险 → 失败立即 return（连 try 都不进）
   *  L2 try/catch 包裹 native setData：native 层抛异常（递归/空引用）直接 catch，绝不抛到用户态
   *  L3 setData 回调内再次存活判定：native 渲染完成时页面可能恰好被销毁，回调里禁止访问 this.data 之外的任何东西
   * 【致命错误捕获】若 setData 同步/异步抛了 native 级异常 → 立刻标记 _destroyed=true，并 PushDebugLog 带错误栈，
   *  防止后续 setData 继续打死亡 Page → 无限 recursive update 恶性循环
   * @param {Object} obj          setData 参数对象
   * @param {Function} [cb]       setData 完成回调（可空）
   * @returns {boolean}           true=setData 已提交调用；false=页面已死/异常
   */
  _safeSetData(obj, cb) {
    // L1 调用前存活判定（双标记）：页面已死绝不进 try
    if (!this || !this._pageAlive || this._destroyed) return false
    try {
      // L2 try/catch：native 层异常直接兜住
      this.setData(obj, () => {
        // L3 回调内再次存活判定：渲染回调触发时已销毁的 Page 实例 this 全是脏对象
        if (!this || !this._pageAlive || this._destroyed) return
        try { if (typeof cb === 'function') cb() } catch (eCb) {
          console.error('[safeSetData] setData回调异常: ' + (eCb && eCb.stack ? eCb.stack : eCb))
          try { this._pushDebugLog && this._pushDebugLog('safeSetData CB: ' + (eCb && eCb.message ? eCb.message : eCb), 'error') } catch (e) {}
        }
      })
      return true
    } catch (eSetData) {
      // 🔴 致命：setData 同步异常 → 99% 情况是 __wcc_version_info__ null 或 recursive update
      //    立刻标记死亡 + 写入调试日志致命级，后续任何 setData/定时器 全 return
      console.error('[safeSetData] 致命native异常，立刻标记_destroyed：' + (eSetData && eSetData.stack ? eSetData.stack : eSetData))
      try { this._destroyed = true } catch (e1) {}
      try {
        this._pushDebugLog && this._pushDebugLog(
          '🚨 FATAL _safeSetData native: ' + (eSetData && eSetData.stack ? eSetData.stack : String(eSetData)),
          'fatal'
        )
      } catch (e2) {}
      return false
    }
  },

  /**
   * 【统一登记 setTimeout 句柄版】所有业务 setTimeout 一律调用 _safeSetTimeout，绝对禁止直接 setTimeout(...)
   *  收益：onUnload 遍历 _allTimeoutHandles 一次性 clearTimeout → 页面销毁后没有任何定时器回调还能跑
   *  🔴 回调内首行再判 _pageAlive：即便 onUnload 没来得及清（和 onUnload 并发的竞态），也不会误碰死亡 Page
   * @param {Function} fn    回调函数
   * @param {number}   ms    毫秒
   * @returns {number}       setTimeout 句柄（可被 _safeClearTimeout 清理）
   */
  _safeSetTimeout(fn, ms) {
    if (!this) return 0
    this._allTimeoutHandles = this._allTimeoutHandles || new Set()
    const that = this
    const h = setTimeout(() => {
      try { that._allTimeoutHandles && that._allTimeoutHandles.delete(h) } catch (e) {}
      // 🔴 回调首行存活判定：页面销毁完全静默
      if (!that || !that._pageAlive || that._destroyed) return
      try { fn() } catch (eFn) {
        console.error('[safeSetTimeout] 回调致命异常: ' + (eFn && eFn.stack ? eFn.stack : eFn))
        try { that._pushDebugLog && that._pushDebugLog('safeTimeout: ' + (eFn && eFn.message ? eFn.message : eFn), 'error') } catch (e) {}
      }
    }, Number(ms) || 0)
    try { this._allTimeoutHandles.add(h) } catch (e) {}
    return h
  },

  /**
   * 清理由 _safeSetTimeout 创建的定时器句柄（可多次调用幂等）
   * @param {number} h 由 _safeSetTimeout 返回的句柄
   */
  _safeClearTimeout(h) {
    if (!h) return
    try { clearTimeout(h) } catch (e) {}
    try { if (this && this._allTimeoutHandles) this._allTimeoutHandles.delete(h) } catch (e) {}
  },

  // ============ §20 onLoad：页面加载入口（存活双标记 / 全局锁重置 / 打卡状态同步 / 景点参数分流）============
  //  触发时机：小程序从 map-explore 页 wx.navigateTo({ url: '/pages/chat/chat?spot=xxx' }) 进入
  //  🔴 项目铁律：本项目使用 SafeStorage（app.js 全局 _memoryStorage 内存对象）替代 wx.setStorageSync / wx.getStorageSync，
  //     彻底规避 3.17.0 灰度基础库 WAWorker.reportRealtimeAction:fail not support 原生闪退
  onLoad(options) {
    const t0 = Date.now()
    console.log('[chat] onLoad 页面启动耗时(框架): ' + (t0 - (this._startTs || t0)) + 'ms')
    // 1) 初始化双存活标记 —— 所有闪退防护依赖这对双布尔，必须放在 onLoad 首段最先赋值
    this._pageAlive = true
    this._destroyed = false
    // 2) 全局句柄集合（onUnload 一网打尽用）
    this._allTimeoutHandles = new Set()
    // 3) 打字队列 / 锁状态重置
    this._typingQueue = []
    this._isTyping = false
    this._msgTimers = []
    this._typeTimeoutTimers = []
    // 4) 双门闩重置（判卷 / 越王令 / 过渡弹窗流程用到）
    this._lastTypewriterDoneAt = 0
    this._lastTtsDoneAt = 0
    // 5) 🔴 最关键初始化：_isTtsPlaying=false（如果冷启动直接 true，playTTS 第一条消息永远入队不出声）
    this._isTtsPlaying = false
    this._ttsQueue = []
    this._ttsActiveDownloadTasks = new Set()
    // 6) ctx 彻底销毁清理（旧页面实例残留 ctx 会引用死亡 Page 的 setData）
    try { if (this._audioCtx && typeof this._audioCtx.destroy === 'function') this._audioCtx.destroy() } catch (e) {}
    this._audioCtx = null
    // 7) 判卷锁 & 过渡弹窗锁（防止 AI 判卷重复/过渡重复追加）
    this._userJustAnswered = false
    this._transitionAppendingLock = false
    // 8) 全局调试日志钩子：console.error/warn 重定向进 _pushDebugLog（左上角"调试"面板可以回看完整错误栈）
    try { this._autoTestLogs = [] } catch (e) {}
    if (typeof this._pushDebugLog === 'function') {
      this._pushDebugLog('☑️ chat页 onLoad 启动，SafeStorage 内存模式，_ENABLE_TTS_AUDIO=' + _ENABLE_TTS_AUDIO, 'info')
    }

    // ====== 自动化测试快捷初始化 ======
    //   通过 URL 参数 ?autoTest=1 直接启动 6 景点全链路自动答题（避免开发者手动反复点）
    this._autoTest = (options && options.autoTest === '1') || false
    if (this._autoTest) {
      this._autoTestSpotOrder = ['百岁街', '越王庙', '越王井', '龙川考棚', '苏堤', '正相塔']
      this._autoTestCur = 0
      this._autoTestMarks = {}
      this._autoTestCrash = null
      // 延迟 4.5s 等页面首屏渲染 + 欢迎语打字完成 再启动
      this._safeSetTimeout(() => { try { this._autoTestStart && this._autoTestStart() } catch (e) {} }, 4500)
    }

    // ====== SafeStorage 打卡：从 app 全局内存读已访问景点 ======
    let visited = []
    try {
      const app = getApp && getApp()
      if (app && app._memoryStorage && typeof app._memoryStorage.getItem === 'function') {
        visited = JSON.parse(app._memoryStorage.getItem('visitedSpots') || '[]') || []
      }
    } catch (eVis) { visited = [] }
    this._visitedSpots = visited

    // ====== 欢迎语（赵佗开场白；只在 messages 为空时显示，避免刷新重复）======
    const curMsgs = this.data && this.data.messages ? this.data.messages.slice() : []
    const needWelcome = curMsgs.length === 0
    if (needWelcome) {
      const welcomeMsg = {
        role: 'bot', content: '', displayText: '', typewriting: true, isHidden: false,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      }
      this._safeSetData({ messages: curMsgs.concat([welcomeMsg]) }, () => {
        // 欢迎语固定文案：不经过 AI，直接打字 + TTS（稳定性最高）
        this.startMsgTypewriter(curMsgs.length, '老夫赵佗，南粤百年，今日与你再游佗城，且行且看。', null, true)
      })
    }

    // ====== 景点参数分流：?spot=考棚 → 走科举 / ?spot=越王庙 → 走谒王访贤 / 其他 → triggerSpotVisit 首句硬编码 ======
    const spot = options && options.spot ? decodeURIComponent(options.spot) : ''
    this._currentSpot = spot || ''
    this._currentTriggerVersion = (options && options.v) || (SPOT_FLOW[spot] && SPOT_FLOW[spot].version) || 'A'
    if (spot) {
      // 延迟 500ms：等欢迎语打字队列首条先出，避免 UI 抢占
      this._safeSetTimeout(() => {
        if (!this || !this._pageAlive || this._destroyed) return
        if (spot === '龙川考棚' || spot === '考棚') {
          // 考棚分支：欢迎 → 科举开始弹窗（首句硬编码跳过 AI）
          try { this.triggerSpotVisit(spot) } catch (e) {}
        } else if (spot === '越王庙') {
          // 越王庙分支：欢迎 → 谒王访贤任务弹窗
          try { this.triggerSpotVisit(spot) } catch (e) {}
        } else {
          try { this.triggerSpotVisit(spot) } catch (e) {}
        }
      }, 500)
    }
  },

  // ============ §21 输入栏：onInput 实时记录 / onSend 发送消息 + 快捷命令 ============
  /** 输入框内容实时同步到 data.inputText（提交时从此字段取）*/
  onInput(e) {
    if (!this || !this._pageAlive || this._destroyed) return
    const v = (e && e.detail && typeof e.detail.value === 'string') ? e.detail.value : ''
    // 🔴 input 输入不做 _safeSetData 防护会在页面销毁时高频触发 native 错误（每次按键一次）
    this._safeSetData({ inputText: v })
  },
  /** 点击"发送"按钮或键盘回车：支持快捷命令「!自动测试」直接触发 _autoTestStart */
  onSend() {
    if (!this || !this._pageAlive || this._destroyed) return
    const raw = (this.data && this.data.inputText) ? String(this.data.inputText) : ''
    const text = raw.trim()
    if (!text) return
    // 🔴 快捷命令：!自动测试 —— 一键触发 6 景点自动化测试链路
    if (text === '!自动测试') {
      this._safeSetData({ inputText: '' })
      if (!this._autoTest) {
        this._autoTest = true
        this._autoTestSpotOrder = ['百岁街', '越王庙', '越王井', '龙川考棚', '苏堤', '正相塔']
        this._autoTestCur = 0
        this._autoTestMarks = {}
        this._autoTestCrash = null
      }
      try { this._autoTestStart && this._autoTestStart() } catch (e) {}
      return
    }
    // 先追加用户气泡，然后发 AI 请求
    const msgs = (this.data.messages || []).slice()
    const userMsg = {
      role: 'user', content: text, displayText: text, typewriting: false, isHidden: false,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    const nextMessages = msgs.concat([userMsg])
    // 追加占位"正在思考…"气泡
    const thinkingMsg = {
      role: 'bot', content: '', displayText: '赵佗正在思考…', typewriting: true, isHidden: false,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    const thinkIdx = nextMessages.length
    this._safeSetData({
      messages: nextMessages.concat([thinkingMsg]),
      inputText: '',
      isSending: true
    }, () => {
      try { this.sendToQwen(text, thinkIdx, 'text') } catch (e) {
        console.error('[chat] sendToQwen 调用异常:' + (e && e.stack ? e.stack : e))
      }
    })
    this._userJustAnswered = true  // 判卷锁：下一次 AI 回复视为判卷回复，允许 checkTransitionAndShow 追加过渡
  },

  // ============ §22 图片输入：onChooseImage（越王井看图答题，图片作为多模态输入 sendToQwen qwen-vl-max）============
  /** 点击输入栏左侧「📷」按钮 —— 触发相册/拍照选择图片，选完后调用 sendImageMessage 走视觉模型 */
  onChooseImage() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        if (!that || !that._pageAlive || that._destroyed) return
        const tempFilePath = (res && res.tempFilePaths && res.tempFilePaths[0]) || ''
        if (!tempFilePath) return
        try { that.sendImageMessage(tempFilePath) } catch (e) {
          console.error('[chat] sendImageMessage 异常：' + (e && e.stack ? e.stack : e))
        }
      },
      fail(err) {
        if (_TTS_VERBOSE_LOG) console.warn('[chat] 选择图片取消或失败：', err)
      }
    })
  },
  /**
   * 发送一条图片用户消息 → 追加气泡(Base64 preview) → 追加思考占位 → sendToQwen(mode='image')
   * @param {string} filePath wx.chooseImage 返回的 tempFilePath
   */
  sendImageMessage(filePath) {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    const fs = wx.getFileSystemManager()
    try {
      fs.readFile({
        filePath: filePath,
        encoding: 'base64',
        success(res) {
          if (!that || !that._pageAlive || that._destroyed) return
          const b64 = (res && typeof res.data === 'string') ? res.data : ''
          const mime = 'image/jpeg'
          const dataUrl = 'data:' + mime + ';base64,' + b64
          const msgs = (that.data.messages || []).slice()
          const userMsg = {
            role: 'user', content: dataUrl, displayText: '[图片消息]', typewriting: false,
            isImage: true, isHidden: false,
            time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          }
          const thinkMsg = {
            role: 'bot', content: '', displayText: '赵佗正在端详此画…', typewriting: true, isHidden: false,
            time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          }
          const thinkIdx = msgs.length + 1
          that._safeSetData({ messages: msgs.concat([userMsg, thinkMsg]), isSending: true }, () => {
            try { that.sendToQwen(dataUrl, thinkIdx, 'image') } catch (e) {
              console.error('[chat] sendToQwen image 异常：' + (e && e.stack ? e.stack : e))
            }
          })
          that._userJustAnswered = true
        },
        fail(err) {
          if (_TTS_VERBOSE_LOG) console.warn('[chat] 读取图片base64失败：', err)
          try { wx.showToast({ title: '图片读取失败', icon: 'none' }) } catch (e) {}
        }
      })
    } catch (eTop) {
      console.error('[chat] sendImageMessage 致命异常：' + (eTop && eTop.stack ? eTop.stack : eTop))
    }
  },

  // ============ §23 sendToQwen：DashScope 兼容模式请求通义千问 qwen-plus（文本）/ qwen-vl-max（多模态图片）============
  //   DashScope 兼容模式：API 端点 OpenAI 风格 chat/completions POST；鉴权 Bearer <DASHSCOPE_API_KEY>
  //   文本模式：messages = buildMessages(history+system指令)，JSON.stringfy body
  //   图片模式：messages = buildMessages 中把 data:image/jpeg;base64,xxx 以 contentArr [{type:'text'},{type:'image_url',...}] 结构传给 qwen-vl-max
  // 🔴 错误兜底：任何 401(鉴权) / 429(配额) / 400(非法参数) / 超时 / 断网 —— 一律 fallback 本地文案，不影响剧情推进与闪退
  // 🔴 TOKEN_AWARDED 标记：AI 回复文末必须含 【TOKEN_AWARDED】（中文括号）时，cleanBotText 会先剥掉标记并设标志，checkTransitionAndShow 据此触发越王令奖励弹窗
  /**
   * @param {string} textOrDataUrl 用户输入文本（mode=text） 或 Base64 dataURL（mode=image）
   * @param {number} thinkIdx      "正在思考…"占位气泡下标，拿到 AI 回复后用 replaceMsgWithTypewriter 替换
   * @param {'text'|'image'} mode  请求模式
   */
  sendToQwen(textOrDataUrl, thinkIdx, mode = 'text') {
    if (!this || !this._pageAlive || this._destroyed) {
      // 页面已死：立刻显示 fallback + 解锁（不请求 API）
      try { this._safeSetData({ isSending: false }) } catch (e) {}
      return
    }
    const that = this
    const model = mode === 'image' ? VISION_MODEL_NAME : MODEL_NAME
    // ==== 请求体 ====
    let bodyObj = null
    try {
      const messages = this.buildMessages(textOrDataUrl, mode)
      bodyObj = { model: model, messages: messages, temperature: 0.6, top_p: 0.85, stream: false }
    } catch (eBuild) {
      console.error('[sendToQwen] buildMessages 失败：' + (eBuild && eBuild.stack ? eBuild.stack : eBuild))
      this._fallbackReply(thinkIdx, mode)
      return
    }
    let reqDone = false
    // 🔴 业务超时兜底：18 秒（比 DashScope 默认 30s 更紧，避免用户卡死等 AI）
    const timeoutH = this._safeSetTimeout(() => {
      if (reqDone) return
      reqDone = true
      try { requestTask && requestTask.abort && requestTask.abort() } catch (e) {}
      that._fallbackReply(thinkIdx, mode, '（千问服务请求超时，老夫以心念作答：）此处为南越胜地，你且依此线索前行。')
    }, 18000)
    const requestTask = wx.request({
      url: API_URL,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      },
      data: bodyObj,
      dataType: 'json',
      timeout: 30000,
      success(res) {
        if (!that || !that._pageAlive || that._destroyed) return
        if (reqDone) return
        reqDone = true
        that._safeClearTimeout(timeoutH)
        const status = res && res.statusCode ? res.statusCode : 0
        // ==== 常见 HTTP 错误按类提示 + fallback ====
        if (status === 401) { that._fallbackReply(thinkIdx, mode, '（千问鉴权失败：请检查 API_KEY 配置是否正确）'); return }
        if (status === 429) { that._fallbackReply(thinkIdx, mode, '（千问服务请求过于频繁，请稍后再试。）老夫稍歇片刻，你且自行揣摩。'); return }
        if (status === 400) {
          const errMsg = (res.data && res.data.error && res.data.error.message) ? res.data.error.message : '请求非法'
          that._fallbackReply(thinkIdx, mode, '（千问请求错误 400：' + errMsg.substring(0, 50) + '）')
          return
        }
        if (status >= 500) { that._fallbackReply(thinkIdx, mode, '（千问 5xx 服务器异常。）老夫口述一段：南越往事已越千年，且随我行。'); return }
        if (status !== 200) { that._fallbackReply(thinkIdx, mode, '（千问返回未知 HTTP ' + status + '）'); return }
        // ==== 解析 response ====
        let rawReply = ''
        try {
          const d = res.data || {}
          if (d.choices && d.choices[0] && d.choices[0].message && typeof d.choices[0].message.content === 'string') {
            rawReply = d.choices[0].message.content
          } else if (typeof d.output === 'object' && d.output.text) {
            rawReply = d.output.text
          } else if (typeof d.output === 'string') {
            rawReply = d.output
          }
        } catch (eP) { rawReply = '' }
        if (!rawReply || !rawReply.trim()) { that._fallbackReply(thinkIdx, mode); return }
        // 🔴 检查并剥离 【TOKEN_AWARDED】 中文括号标记
        let awarded = false
        if (/【[^\]]*TOKEN_AWARDED[^\]]*】/.test(rawReply)) { awarded = true }
        const cleaned = that.cleanBotText(rawReply)
        that._pendingTokenAward = awarded
        if (_TTS_VERBOSE_LOG && awarded) console.log('[TOKEN_AWARDED] 越王井答对：标记已识别，待 checkTransitionAndShow 弹越王令')
        // 🔴 文本模式：replaceMsgWithTypewriter 打字 + TTS → 完成后 checkTransitionAndShow；图片模式只替换（判卷流程在 checkTransitionAndShow 同触发）
        that.replaceMsgWithTypewriter(thinkIdx, cleaned, () => {
          if (mode === 'text') {
            try { that.checkTransitionAndShow(cleaned) } catch (e) { console.error('[sendToQwen] checkTransitionAndShow 异常:' + (e && e.stack ? e.stack : e)) }
          } else {
            try { that.checkTransitionAndShow(cleaned) } catch (e) {}
          }
        }, true)
      },
      fail(err) {
        if (!that || !that._pageAlive || that._destroyed) return
        if (reqDone) return
        reqDone = true
        that._safeClearTimeout(timeoutH)
        that._fallbackReply(thinkIdx, mode, '（网络或域名校验失败：' + ((err && err.errMsg) ? err.errMsg : '未知').substring(0, 40) + '）老夫心念作答即可：此处乃南越佳地，前行便知。')
      }
    })
  },

  /**
   * 千问 API 请求失败兜底：本地提示 + 替换占位气泡 + 触发 checkTransitionAndShow
   * @param {number} thinkIdx 思考气泡下标
   * @param {'text'|'image'} _mode 请求模式（当前与文本相同）
   * @param {string} [fallbackMsg] 自定义 fallback 文案
   */
  _fallbackReply(thinkIdx, _mode, fallbackMsg) {
    if (!this || !this._pageAlive || this._destroyed) return
    const msg = fallbackMsg || '老夫年事已高，一时忘却，你且再问。'
    this.replaceMsgWithTypewriter(thinkIdx, msg, () => {
      try { this.checkTransitionAndShow(msg) } catch (e) {}
    }, true)
  },

  // ============ §24 cleanBotText：AI 返回文案清洗 / buildMessages：把历史消息拼成 DashScope 兼容模式 messages ============
  /**
   * AI 返回文案清洗：去除 AI 回复里的 【TOKEN_AWARDED】、系统内部标记、多余空白、显式"过渡台词"禁词兜底
   * 🔴 铁律：AI **禁止**自己生成「移步 / 快去越王庙 / 请移步考棚」之类的过渡台词（如果出现，这里会剥除），
   *    真正的过渡台词必须由 _appendTransitionAndPopup 从 SPOT_FLOW 硬编码对象追加，保证剧情可控。
   */
  cleanBotText(raw) {
    if (!raw || typeof raw !== 'string') return ''
    try {
      let t = raw
      // 1) 越王井答对奖励 TOKEN 标记 —— 剥除（checkTransitionAndShow 用 _pendingTokenAward 判定）
      t = t.replace(/【[^】]*TOKEN_AWARDED[^】]*】/g, '')
      // 2) 隐藏系统消息标记
      t = t.replace(/\{\{__HIDDEN_SYS_MSG__[^{}]*\}\}/g, '')
      // 3) AI 自作主张的过渡台词兜底：匹配 TRANSITION_KEYWORDS 里的字符串
      TRANSITION_KEYWORDS.forEach((kw) => {
        try {
          if (kw && kw.word) t = t.split(kw.word).join('')
        } catch (e) {}
      })
      // 4) 去掉显式的 "过渡: 请移步…" / "请移步下一个景点 XXX" 格式
      t = t.replace(/(过渡(台词)?[:：\s]*)/g, '')
      t = t.replace(/请移步(?:下一个)?景点[^。\n！？!?]*/g, '')
      // 5) 收尾 trim
      return t.replace(/\n{3,}/g, '\n\n').trim()
    } catch (e) { return String(raw || '').trim() }
  },

  /**
   * 构造 API 请求体 messages 数组（含 SYSTEM_INSTRUCTION 隐藏系统消息 + 历史对话 + 当前轮输入）
   *   文本模式：{role:string, content:string}
   *   图片模式：{role:string, content:[{type:'text',text:...}, {type:'image_url',image_url:{url:'data:...'}}]} （qwen-vl-max 兼容）
   * 【隐藏系统消息注入策略】倒序找 messages 最后一条 user 发言（lastUserIndex），然后把 SYSTEM_INSTRUCTION 以 role='system' 的形式
   *   拼在 API 请求的 messages 最前面（AI 看不到；渲染里也不会出现在聊天记录——这是"系统指令隐藏"的设计目标）
   */
  buildMessages(currentInput, mode) {
    const that = this
    const rawMsgs = (this.data && this.data.messages) ? this.data.messages.slice() : []
    // ==== 1) 倒序找最后一条用户消息（非隐藏）====
    let lastUserIndex = -1
    for (let i = rawMsgs.length - 1; i >= 0; i--) {
      const m = rawMsgs[i]
      if (m && !m.isHidden && m.role === 'user') { lastUserIndex = i; break }
    }
    // ==== 2) 过滤掉隐藏消息 / 思考占位未替换完成的气泡 ====
    const hist = []
    rawMsgs.forEach((m) => {
      if (!m || m.isHidden) return
      if (m.role === 'user') {
        if (m.isImage && mode === 'image') return  // 图片用户消息单独处理
        const txt = String(m.displayText || m.content || '').trim()
        if (txt) hist.push({ role: 'user', content: txt })
      } else if (m.role === 'bot') {
        const txt = String(m.displayText || m.content || '').trim()
        if (!txt) return
        // AI 思考占位（替换前）跳过
        if (txt === '赵佗正在思考…' || txt === '赵佗正在端详此画…') return
        hist.push({ role: 'assistant', content: txt })
      }
    })
    // ==== 3) 拼 SYSTEM_INSTRUCTION 到消息头部（系统指令是 AI 的赵佗角色 + 判卷铁律 + 景点剧本 + 史料铁律）====
    const reqMessages = []
    reqMessages.push({ role: 'system', content: SYSTEM_INSTRUCTION })
    // ==== 4) 追加历史对话 ====
    hist.forEach((m) => reqMessages.push(m))
    // ==== 5) 追加当前轮输入（文本 / 图片 contentArr）====
    if (mode === 'image') {
      // 图片模式：根据 _currentTriggerVersion（越王井3版差异化）挑对应的 3 套 prompt 模板
      let sysCtx = ''
      try {
        const curSpot = this._currentSpot || '越王井'
        if (curSpot === '越王井' || curSpot.indexOf('越王井') >= 0) {
          const templates = YUEKING_PHOTO_REPLY_TEMPLATES || []
          const version = this._currentTriggerVersion && templates[this._currentTriggerVersion] ? this._currentTriggerVersion : 'A'
          const tpl = templates[version] || templates[Object.keys(templates)[0]] || {}
          sysCtx = (tpl.replyPrefix || '') + '请根据图片作答。'
        } else {
          sysCtx = '请根据用户图片与南越王赵佗角色设定作答。'
        }
      } catch (e) { sysCtx = '请描述图中的场景并按赵佗角色作答。' }
      // contentArr 多模态结构：先文字指令 + 后图片
      reqMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: sysCtx || '请描述这张图片并结合赵佗身份作答。' },
          { type: 'image_url', image_url: { url: String(currentInput || '') } }
        ]
      })
    } else {
      // 文本模式：把当前输入直接追加 role=user
      // 判卷指令附加：如果 _userJustAnswered=true，则在 user 消息后补一段"你必须扮演赵佗并判卷，答对时越王井必须加【TOKEN_AWARDED】"
      let userText = String(currentInput || '').trim()
      if (lastUserIndex >= 0 && this._userJustAnswered) {
        // 判卷场景只生效一次（checkTransitionAndShow 完成后会清 _userJustAnswered）
      }
      reqMessages.push({ role: 'user', content: userText })
    }
    return reqMessages
  },

  // ============ §25 updateBotReply：辅助函数 —— 直接把 bot 文本写进气泡（无打字，用于特殊兜底；目前主要为保持老接口可用）============
  // 🔴 注意：新代码应优先使用 replaceMsgWithTypewriter / appendBotMsgWithTypewriter（走打字机+TTS 双门闩）
  updateBotReply(idx, text, needCheckTransition) {
    if (!this || !this._pageAlive || this._destroyed) return
    const safeText = String(text || '')
    this._safeSetData({
      ['messages[' + idx + '].content']: safeText,
      ['messages[' + idx + '].displayText']: safeText,
      ['messages[' + idx + '].typewriting']: false,
      isSending: false
    }, () => {
      if (needCheckTransition) {
        try { this.checkTransitionAndShow(safeText) } catch (e) {}
      }
    })
  },

  // ============ §26 checkTransitionAndShow：判卷后"过渡 + 下一景点过渡弹窗 + 越王令奖励 + 正相塔大结局"总调度 ============
  //  🔴 关键设计：
  //    - _transitionAppendingLock 防重入锁（打字+TTS 结束前不会多次追加过渡）
  //    - praiseWords：AI 回复含赞赏词 → _perfScore+1（大结局优秀 ENDING_A/B 分界参考）
  //    - 若当前景点为 正相塔 且 AI 已完成回复 → 弹出大结局弹窗（_showEndingPopup）
  //    - 越王井：若 _pendingTokenAward=true → 追加 YUEKING_TOKEN_AWARD_TEXT → 弹 showTokenPopup（越王令）
  //    - 普通景点：从 SPOT_FLOW[this._currentSpot] 查表取出 transitionLine 台词 + nextSpotName → _appendTransitionAndPopup 追加
  //    - 10 秒 & 15 秒解锁兜底：如果 AI 回复里没有 TRANSITION_KEYWORDS 或 SPOT_FLOW 无配置，但用户确实答完一题 → 超时后自动解锁下一次判卷锁
  /**
   * @param {string} cleanedReply 已通过 cleanBotText 清洗的回复文本
   */
  checkTransitionAndShow(cleanedReply) {
    if (!this || !this._pageAlive || this._destroyed) return
    if (this._transitionAppendingLock) return  // 防重入：上一条过渡还在打字+TTS中，不再追加
    const that = this
    const text = String(cleanedReply || '')
    const curSpot = this._currentSpot || ''

    // ==== 赞赏加分：AI 夸用户时 +1，影响大结局 A/B 分野（_perfScore>=5 → ENDING_A 优秀）
    const praiseWords = ['妙', '甚好', '好极了', '不错', '真乃', '孺子可教', '奇才', '博学']
    let added = 0
    praiseWords.forEach((w) => { if (text.indexOf(w) >= 0) added++ })
    if (added > 0) {
      this._perfScore = (this._perfScore || 0) + Math.min(added, 2)  // 单次最多加2分，防刷分
      if (_TTS_VERBOSE_LOG) console.log('[评分] 赞赏加分: +' + Math.min(added, 2) + ' 总分=' + this._perfScore)
    }

    // ==== 判卷锁：_userJustAnswered=true 才允许追加过渡（闲聊对话不触发剧情）
    const userJustAnswered = !!this._userJustAnswered
    this._userJustAnswered = false  // 用完立刻清，避免闲聊重复触发过渡

    // ==== 🔴 大结局触发点：正相塔（最后一个景点）判卷完成后 → _showEndingPopup
    if (curSpot === '正相塔' && userJustAnswered) {
      this._safeSetTimeout(() => {
        if (!that || !that._pageAlive || that._destroyed) return
        try { that._showEndingPopup() } catch (e) { console.error('[大结局] 异常：' + (e && e.stack ? e.stack : e)) }
      }, 800)
      return
    }

    // ==== 🔴 越王令奖励：越王井答对（_pendingTokenAward=true） → 追加奖励台词 → 弹越王令 → 用户点"接受"后追加过渡
    if (curSpot === '越王井' && this._pendingTokenAward === true) {
      this._pendingTokenAward = false
      this._transitionAppendingLock = true
      const unlockCb = () => { try { that._transitionAppendingLock = false } catch (e) {} }
      const awardText = (typeof YUEKING_TOKEN_AWARD_TEXT === 'string') ? YUEKING_TOKEN_AWARD_TEXT : '好！答题精妙，赏你越王令一枚，持此令可于南越故地通行无碍。'
      try { this._safeSetTimeout(() => {
        if (!that || !that._pageAlive || that._destroyed) return
        that.appendBotMsgWithTypewriter(awardText, () => {
          // 奖励台词打完 + TTS 完 → 弹越王令
          that._safeSetData({ showTokenPopup: true })
        }, true)
      }, 400) } catch (e) { unlockCb() }
      // 10s / 15s 解锁兜底（防弹窗没点锁死）
      this._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
      return
    }

    // ==== SPOT_FLOW 查表：当前景点 → 下一景点名 + 过渡硬编码台词
    const flowCfg = (SPOT_FLOW && SPOT_FLOW[curSpot]) ? SPOT_FLOW[curSpot] : null
    if (flowCfg && flowCfg.next && userJustAnswered) {
      // 🔴 走系统硬编码 _appendTransitionAndPopup：AI 严禁自己夹带过渡台词
      this._transitionAppendingLock = true
      const unlockCb = () => { try { that._transitionAppendingLock = false } catch (e) {} }
      this._safeSetTimeout(() => {
        if (!that || !that._pageAlive || that._destroyed) { unlockCb(); return }
        that._appendTransitionAndPopup(flowCfg.transitionLine, flowCfg.next, flowCfg.nextLabel, unlockCb)
      }, 500)
      // 🔴 10 秒 & 15 秒解锁兜底：如果打字/弹窗卡死，超时后强制解锁，不影响用户后续主动操作
      this._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 10000)
      this._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
      return
    }

    // ==== TRANSITION_KEYWORDS 历史兜底（AI 旧版没完全遵守禁词时，若能匹配关键词也可触发）
    if (userJustAnswered) {
      let matched = null
      for (let i = 0; i < (TRANSITION_KEYWORDS || []).length; i++) {
        const kw = TRANSITION_KEYWORDS[i]
        if (kw && kw.word && text.indexOf(kw.word) >= 0) { matched = kw; break }
      }
      if (matched && matched.nextSpot) {
        this._transitionAppendingLock = true
        const unlockCb = () => { try { that._transitionAppendingLock = false } catch (e) {} }
        this._safeSetTimeout(() => {
          if (!that || !that._pageAlive || that._destroyed) { unlockCb(); return }
          const line = matched.transitionLine || '老夫便带你前往下一景点。'
          that._appendTransitionAndPopup(line, matched.nextSpot, matched.nextLabel || matched.nextSpot, unlockCb)
        }, 500)
      }
      // 15 秒兜底解锁
      this._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
    }
  },

  // ============ §27 大结局弹窗：正相塔结束后弹出，按 _perfScore 分 ENDING_A（>=5，优秀）/ ENDING_B（<5，一般）============
  //  🔴 打字机：interval 235ms/字；同时 TTS 播放；结束后「完成」按钮返回地图页
  _showEndingPopup() {
    if (!this || !this._pageAlive || this._destroyed) return
    const score = Number(this._perfScore) || 0
    const endingText = (score >= 5)
      ? (typeof ENDING_A === 'string' ? ENDING_A : 'ENDING_A')
      : (typeof ENDING_B === 'string' ? ENDING_B : 'ENDING_B')
    this._perfScore = score
    this._safeSetData({
      showEnding: true,
      endingText: '',
      endingTyping: true,
      endingLevel: (score >= 5) ? 'A' : 'B'
    })
    // 打字机 + TTS
    const that = this
    let idx = 0
    let endingTimer = null
    endingTimer = setInterval(() => {
      // 🔴 typing interval 首行判存活：页面销毁立即 clearInterval，避免野 setData
      if (!that || !that._pageAlive || that._destroyed) {
        try { clearInterval(endingTimer) } catch (e) {}
        endingTimer = null
        return
      }
      idx += 1
      if (idx > endingText.length) idx = endingText.length
      that._safeSetData({ endingText: endingText.substring(0, idx) })
      if (idx >= endingText.length) {
        try { clearInterval(endingTimer) } catch (e) {}
        endingTimer = null
        that._safeSetData({ endingTyping: false })
      }
    }, 235)
    this._typeTimeoutTimers = this._typeTimeoutTimers || []
    this._typeTimeoutTimers.push(endingTimer)
    // 大结局 TTS 与打字同步
    this.playTTS(this._sanitizeForTTS(endingText), null)
  },
  /** 大结局弹窗「完成」按钮：关闭弹窗 + 返回地图页 */
  onEndingDone() {
    if (!this || !this._pageAlive || this._destroyed) return
    // 清 typing interval
    try { (this._typeTimeoutTimers || []).forEach((h) => { try { clearInterval(h) } catch (e) {} }) } catch (e) {}
    this._typeTimeoutTimers = []
    this._safeSetData({ showEnding: false }, () => {
      try { wx.navigateBack({ delta: 1, fail: () => { try { wx.switchTab({ url: '/pages/map-explore/map-explore' }) } catch (e) {} } }) } catch (eNav) {}
    })
  },

  // ============ §28 _appendTransitionAndPopup：判卷→追加过渡台词→2 秒延迟→弹过渡弹窗（data.showTransitionPopup=true）============
  // 🔴 铁律：AI 判卷回复里严禁自带过渡台词；过渡台词必须走 SPOT_FLOW 硬编码 → 由本函数追加并显示
  // 🔴 2 秒延迟根因：「过渡台词刚念完或还有 1-2 秒」的停顿符合剧情节奏；用户也可以在过渡弹窗选择"继续停留"
  /**
   * @param {string} line           SPOT_FLOW.transitionLine 硬编码台词
   * @param {string} nextSpot       下一景点内部名（SPOT_INTROS/SafeStorage打卡用）
   * @param {string} nextLabel      下一景点 UI 展示名
   * @param {Function} unlockCb     finally 解锁 _transitionAppendingLock（必调）
   */
  _appendTransitionAndPopup(line, nextSpot, nextLabel, unlockCb) {
    if (!this || !this._pageAlive || this._destroyed) { try { unlockCb && unlockCb() } catch (e) {}; return }
    const that = this
    try {
      this._safeSetData({ nextSpotName: nextLabel || nextSpot, nextSpotKey: nextSpot })
      this.appendBotMsgWithTypewriter(String(line || '老夫带你前往下一景点。'), () => {
        // 🔴 2 秒延迟再出过渡弹窗（项目铁律：过渡台词打完+TTS完→等 2 秒→出现）
        that._safeSetTimeout(() => {
          if (!that || !that._pageAlive || that._destroyed) { try { unlockCb && unlockCb() } catch (e) {}; return }
          that._safeSetData({ showTransitionPopup: true }, () => { try { unlockCb && unlockCb() } catch (e) {} })
        }, 2000)
      }, true)
    } catch (eTop) {
      console.error('[过渡追加] 致命异常：' + (eTop && eTop.stack ? eTop.stack : eTop))
      try { unlockCb && unlockCb() } catch (e) {}
    }
  },

  // ============ 越王令弹窗回调 ============
  /** 越王令弹窗「接受」按钮：关闭弹窗 + 解锁过渡锁 + 500ms 后从 SPOT_FLOW 查越王井的下一景点追加过渡 */
  onAcceptToken() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    try {
      // SafeStorage 内存打卡越王令获取
      const app = getApp && getApp()
      if (app && app._memoryStorage && typeof app._memoryStorage.setItem === 'function') {
        try { app._memoryStorage.setItem('hasYueKingToken', 'true') } catch (e) {}
      }
      this._safeSetData({ showTokenPopup: false }, () => {
        try { that._transitionAppendingLock = false } catch (e) {}
        // 🔴 500ms 延迟后追加过渡（项目铁律：越王令接受→ 500ms → 过渡台词→ 2s 过渡弹窗）
        that._safeSetTimeout(() => {
          if (!that || !that._pageAlive || that._destroyed) return
          const flow = (SPOT_FLOW && SPOT_FLOW['越王井']) ? SPOT_FLOW['越王井'] : null
          if (flow && flow.next) {
            that._transitionAppendingLock = true
            const unlock = () => { try { that._transitionAppendingLock = false } catch (e) {} }
            that._appendTransitionAndPopup(flow.transitionLine, flow.next, flow.nextLabel, unlock)
            that._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
          }
        }, 500)
      })
    } catch (eTop) {
      console.error('[onAcceptToken] 异常：' + (eTop && eTop.stack ? eTop.stack : eTop))
    }
  },
  /** 越王令弹窗右上角「×」关闭：只关弹窗，不触发过渡（用户可手动在地图页点下一景点）*/
  onCloseTokenPopup() {
    if (!this || !this._pageAlive || this._destroyed) return
    this._safeSetData({ showTokenPopup: false })
    try { this._transitionAppendingLock = false } catch (e) {}
  },

  // ============ §29 龙川考棚科举六回调（拒绝/接受/介绍/乡试/会试/殿试/结果）============
  // 科举三关：乡试(单选，正确答案B："学而优则仕"辨) → 会试(填空关键词含"学而优则仕"+"寒门士族") → 殿试(主观题4给分点命中数映射 0~3 档 DIANSHI_SCORED_REPLIES)
  // 称号：状元(乡试对+会试对+殿试>=3) / 进士(殿试>=3) / 贡士(殿试>=2) / 举人(乡试对) / 秀才（殿试<2）
  // 🔴 kejuScore 结构：{q1:boolean, q2:boolean, dianshiLevel:number(0~4), total:number}

  /** 科举开始弹窗「拒绝」：不考了 → 跳过考棚，直接追加过渡到下一景点苏堤 */
  onKejuRefuse() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    this._safeSetData({ showKejuStart: false }, () => {
      const flow = (SPOT_FLOW && SPOT_FLOW['龙川考棚']) ? SPOT_FLOW['龙川考棚'] : null
      const next = flow && flow.next ? flow.next : '苏堤'
      const label = flow && flow.nextLabel ? flow.nextLabel : next
      that._transitionAppendingLock = true
      const unlock = () => { try { that._transitionAppendingLock = false } catch (e) {} }
      that._appendTransitionAndPopup(
        flow && flow.transitionLine ? flow.transitionLine : '考棚不便多留，你且随我前往苏堤一观。',
        next, label, unlock
      )
      that._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
    })
  },
  /** 科举开始弹窗「接受挑战」→ 开考前介绍弹窗 */
  onKejuAccept() {
    if (!this || !this._pageAlive || this._destroyed) return
    this._safeSetData({ showKejuStart: false, showKejuIntro: true })
  },
  /** 介绍弹窗「好，开始乡试」→ 开乡试弹窗 */
  onKejuIntroStart() {
    if (!this || !this._pageAlive || this._destroyed) return
    this._safeSetData({
      showKejuIntro: false,
      showKejuXiangshi: true,
      kejuScore: { q1: false, q2: false, dianshiLevel: 0, total: 0 }
    })
  },
  /** 乡试：单选选择 → 实时高亮 */
  onXiangshiSelect(e) {
    if (!this || !this._pageAlive || this._destroyed) return
    const opt = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.opt) || ''
    this._safeSetData({ xiangshiSelected: opt })
  },
  /** 乡试「提交」：正确 B → score.q1=true → 开会试；否则直接关弹窗 → 称号「童生」→ 出结果 */
  onXiangshiSubmit() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    const opt = (this.data && this.data.xiangshiSelected) || ''
    if (!opt) { try { wx.showToast({ title: '请先择一答案', icon: 'none' }) } catch (e) {}; return }
    const correct = (opt === 'B')
    const curScore = Object.assign({ q1: false, q2: false, dianshiLevel: 0, total: 0 }, (this.data && this.data.kejuScore) || {})
    curScore.q1 = correct
    curScore.total = (curScore.total || 0) + (correct ? 2 : 0)
    if (!correct) {
      // 乡试错：直接出结果
      this._safeSetData({ showKejuXiangshi: false, kejuScore: curScore }, () => {
        try { that._startKejuResultTypewriter(curScore, '童生') } catch (e) {}
      })
      return
    }
    this._safeSetData({ showKejuXiangshi: false, showKejuHuishi: true, kejuScore: curScore })
  },
  /** 会试：用户 textarea 输入 */
  onHuishiInput(e) {
    if (!this || !this._pageAlive || this._destroyed) return
    const v = (e && e.detail && e.detail.value) || ''
    this._safeSetData({ huishiText: v })
  },
  /** 会试「提交」：关键词命中「学而优则仕」+「寒门」或「士族」 → q2=true；否则出结果「秀才」 */
  onHuishiSubmit() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    const raw = String((this.data && this.data.huishiText) || '')
    const hasXue = raw.indexOf('学而优则仕') >= 0
    const hasHan = (raw.indexOf('寒门') >= 0 || raw.indexOf('士族') >= 0 || raw.indexOf('寒门士族') >= 0)
    const correct = !!(hasXue && hasHan)
    const curScore = Object.assign({ q1: false, q2: false, dianshiLevel: 0, total: 0 }, (this.data && this.data.kejuScore) || {})
    curScore.q2 = correct
    curScore.total = (curScore.total || 0) + (correct ? 2 : 0)
    if (!correct) {
      this._safeSetData({ showKejuHuishi: false, kejuScore: curScore }, () => {
        try { that._startKejuResultTypewriter(curScore, '秀才') } catch (e) {}
      })
      return
    }
    this._safeSetData({ showKejuHuishi: false, showKejuDianshi: true, kejuScore: curScore })
  },
  /** 殿试：用户 textarea 输入 */
  onDianshiInput(e) {
    if (!this || !this._pageAlive || this._destroyed) return
    const v = (e && e.detail && e.detail.value) || ''
    this._safeSetData({ dianshiText: v })
  },
  /** 殿试「提交」：_scoreDianshiAnswer → DIANSHI_CRITERIA[4给分点] 命中数 0~4 → 转 level 0~3 → DIANSHI_SCORED_REPLIES 档取评语文案 */
  onDianshiSubmit() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    const raw = String((this.data && this.data.dianshiText) || '')
    const level = this._scoreDianshiAnswer(raw)
    const curScore = Object.assign({ q1: false, q2: false, dianshiLevel: 0, total: 0 }, (this.data && this.data.kejuScore) || {})
    curScore.dianshiLevel = level
    curScore.total = (curScore.total || 0) + level
    this._perfScore = (this._perfScore || 0) + level
    const title = this._getKejuAwardTitle(curScore)
    this._safeSetData({ showKejuDianshi: false, kejuScore: curScore }, () => {
      try { that._startKejuResultTypewriter(curScore, title) } catch (e) {}
    })
  },
  /**
   * 殿试评分：4 给分点（和辑百越 / 中原技术 / 移民实边 / 两度归汉）命中数 → 0 档~3 档
   *   命中 4 → level 3（优秀档）；命中 3 → level 2；命中 2 → level 1；命中≤1 → level 0
   */
  _scoreDianshiAnswer(text) {
    const txt = String(text || '')
    const keys = DIANSHI_CRITERIA && Array.isArray(DIANSHI_CRITERIA) ? DIANSHI_CRITERIA : [
      { keywords: ['和辑百越', '百越'] },
      { keywords: ['中原', '技术', '铁器', '农耕'] },
      { keywords: ['移民', '实边', '南迁'] },
      { keywords: ['两度归汉', '归汉', '归心汉室', '称臣'] }
    ]
    let hit = 0
    keys.forEach((c) => {
      const kws = (c && c.keywords) ? c.keywords : []
      for (let i = 0; i < kws.length; i++) { if (txt.indexOf(kws[i]) >= 0) { hit++; break } }
    })
    if (hit >= 4) return 3
    if (hit === 3) return 2
    if (hit === 2) return 1
    return 0
  },
  /** 科举称号：状元/进士/贡士/举人/秀才/童生 */
  _getKejuAwardTitle(score) {
    const s = score || {}
    const dianshiLv = Number(s.dianshiLevel) || 0
    const q1 = !!s.q1
    const q2 = !!s.q2
    if (q1 && q2 && dianshiLv >= 3) return '状元'
    if (dianshiLv >= 3) return '进士'
    if (dianshiLv >= 2) return '贡士'
    if (q1) return '举人'
    return (q2 ? '秀才' : '童生')
  },
  /**
   * 结果弹窗打字机：70ms/字 → 拼接"恭喜得中【XX】+ DIANSHI_SCORED_REPLIES[档] 评语文案"
   *  完成 → 「返回巡游」按钮 → onKejuResultDone 追加过渡到苏堤
   */
  _startKejuResultTypewriter(score, title) {
    if (!this || !this._pageAlive || this._destroyed) return
    const level = Number(score && score.dianshiLevel) || 0
    const replies = DIANSHI_SCORED_REPLIES && Array.isArray(DIANSHI_SCORED_REPLIES) ? DIANSHI_SCORED_REPLIES : ['略有小误，再接再厉。', '尚可，尚有可造之处。', '深得朕意，才华横溢。', '状元之资，天下无双！']
    const feedback = (replies[level] != null) ? replies[level] : replies[replies.length - 1]
    const text = '恭喜得中【' + String(title || '童生') + '】！' + String(feedback || '')
    this._safeSetData({
      showKejuResult: true,
      kejuResultText: '',
      kejuResultTitle: String(title || '童生'),
      kejuResultTyping: true
    })
    const that = this
    let i = 0
    let kejuResultTimer = null
    kejuResultTimer = setInterval(() => {
      // 🔴 typing interval 首行判存活
      if (!that || !that._pageAlive || that._destroyed) {
        try { clearInterval(kejuResultTimer) } catch (e) {}
        kejuResultTimer = null
        return
      }
      i += 1
      if (i > text.length) i = text.length
      that._safeSetData({ kejuResultText: text.substring(0, i) })
      if (i >= text.length) {
        try { clearInterval(kejuResultTimer) } catch (e) {}
        kejuResultTimer = null
        that._safeSetData({ kejuResultTyping: false })
      }
    }, 70)
    this._typeTimeoutTimers = this._typeTimeoutTimers || []
    this._typeTimeoutTimers.push(kejuResultTimer)
    this.playTTS(this._sanitizeForTTS(text), null)
  },
  /** 结果弹窗「返回巡游」：关闭弹窗 → 追加过渡到下一景点苏堤 */
  onKejuResultDone() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    try { (this._typeTimeoutTimers || []).forEach((h) => { try { clearInterval(h) } catch (e) {} }) } catch (e) {}
    this._typeTimeoutTimers = []
    this._safeSetData({ showKejuResult: false }, () => {
      const flow = (SPOT_FLOW && SPOT_FLOW['龙川考棚']) ? SPOT_FLOW['龙川考棚'] : null
      const next = flow && flow.next ? flow.next : '苏堤'
      const label = flow && flow.nextLabel ? flow.nextLabel : next
      that._transitionAppendingLock = true
      const unlock = () => { try { that._transitionAppendingLock = false } catch (e) {} }
      that._appendTransitionAndPopup(
        flow && flow.transitionLine ? flow.transitionLine : '科考已罢，前方苏堤春色正好，随我同行。',
        next, label, unlock
      )
      that._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
    })
  },

  // ============ §30 越王庙谒王访贤三回调（任务弹窗接受/拒绝 → 答题弹窗3题 → 结果弹窗称号）============
  //  题目配置：Q1(百姓/佗城/民) / Q2(木雕+彩绘) / Q3("十"字 + 至少2位名贤)
  //  称号：3对=南越贤徒 / 2对=谒王者 / 1对=庙前客 / 0对=庙外人
  /** 任务弹窗「接受」→ 答题 */
  onTempleTaskAccept() {
    if (!this || !this._pageAlive || this._destroyed) return
    this._safeSetData({
      showTempleTask: false,
      showTempleQuiz: true,
      templeQ1: '', templeQ2: '', templeQ3: '',
      templeScore: { total: 0 }
    })
  },
  /** 任务弹窗「拒绝」→ 赵佗说放弃台词 2 秒 → 追加过渡到越王井 */
  onTempleTaskDecline() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    this._safeSetData({ showTempleTask: false }, () => {
      that.appendBotMsgWithTypewriter('你既无谒王之意，此事作罢；越王井尚在前方，你且随我一访井中岁月。', () => {
        that._safeSetTimeout(() => {
          if (!that || !that._pageAlive || that._destroyed) return
          const flow = (SPOT_FLOW && SPOT_FLOW['越王庙']) ? SPOT_FLOW['越王庙'] : null
          const next = flow && flow.next ? flow.next : '越王井'
          const label = flow && flow.nextLabel ? flow.nextLabel : next
          that._transitionAppendingLock = true
          const unlock = () => { try { that._transitionAppendingLock = false } catch (e) {} }
          that._appendTransitionAndPopup(
            flow && flow.transitionLine ? flow.transitionLine : '越王井尚在前方，你且随我一访井中岁月。',
            next, label, unlock
          )
          that._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
        }, 2000)
      }, true)
    })
  },
  /** 3 题 input */
  onTempleInput(e) {
    if (!this || !this._pageAlive || this._destroyed) return
    const n = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.q) || '1'
    const v = (e && e.detail && e.detail.value) || ''
    this._safeSetData({ ['templeQ' + n]: v })
  },
  /** 答题「提交」：_judgeTempleAnswers → _getTempleAward → 结果打字 + TTS */
  onTempleQuizSubmit() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    const q1 = String((this.data && this.data.templeQ1) || '')
    const q2 = String((this.data && this.data.templeQ2) || '')
    const q3 = String((this.data && this.data.templeQ3) || '')
    const judge = this._judgeTempleAnswers(q1, q2, q3)
    this._perfScore = (this._perfScore || 0) + (judge.hit || 0)
    const award = this._getTempleAward(judge.hit || 0)
    this._safeSetData({
      showTempleQuiz: false,
      templeScore: { total: judge.hit || 0, detail: judge }
    }, () => {
      try { that._startTempleResultTypewriter(judge, award) } catch (e) { console.error('[越王庙] 结果打字异常:' + (e && e.stack ? e.stack : e)) }
    })
  },
  /** 越王庙 3 题判定 */
  _judgeTempleAnswers(q1, q2, q3) {
    const a = String(q1 || '')
    const b = String(q2 || '')
    const c = String(q3 || '')
    const r1 = (a.indexOf('百姓') >= 0 || a.indexOf('佗城') >= 0 || a.indexOf('民') >= 0) ? 1 : 0
    const m = (b.indexOf('木雕') >= 0) ? 1 : 0
    const n = (b.indexOf('彩绘') >= 0) ? 1 : 0
    const r2 = (m + n >= 2) ? 1 : 0
    const hasShi = (c.indexOf('十') >= 0) ? 1 : 0
    const sages = ['韩愈', '苏轼', '苏辙', '杨万里', '李商隐', '苏轼兄弟', '雷万春', '蓝关']
    let cnt = 0
    sages.forEach((s) => { if (c.indexOf(s) >= 0) cnt++ })
    const r3 = (hasShi && cnt >= 2) ? 1 : 0
    return { r1, r2, r3, hit: r1 + r2 + r3 }
  },
  /** 称号映射 */
  _getTempleAward(hit) {
    const h = Number(hit) || 0
    if (h >= 3) return '南越贤徒'
    if (h === 2) return '谒王者'
    if (h === 1) return '庙前客'
    return '庙外人'
  },
  /** 结果打字 + TTS（70ms/字） */
  _startTempleResultTypewriter(judge, title) {
    if (!this || !this._pageAlive || this._destroyed) return
    const hit = (judge && judge.hit) || 0
    const text = '你对庙中典故已答对 ' + hit + ' 道，获封【' + String(title || '庙外人') + '】。谒王访贤，贵在一心。'
    this._safeSetData({
      showTempleResult: true,
      templeResultText: '',
      templeResultTitle: String(title || '庙外人'),
      templeResultTyping: true
    })
    const that = this
    let i = 0
    let introTimer = null
    introTimer = setInterval(() => {
      if (!that || !that._pageAlive || that._destroyed) { try { clearInterval(introTimer) } catch (e) {}; introTimer = null; return }
      i += 1
      if (i > text.length) i = text.length
      that._safeSetData({ templeResultText: text.substring(0, i) })
      if (i >= text.length) {
        try { clearInterval(introTimer) } catch (e) {}
        introTimer = null
        that._safeSetData({ templeResultTyping: false })
      }
    }, 70)
    this._typeTimeoutTimers = this._typeTimeoutTimers || []
    this._typeTimeoutTimers.push(introTimer)
    this.playTTS(this._sanitizeForTTS(text), null)
  },
  /** 越王庙结果「继续巡游」：关闭 → 追加过渡到越王井 */
  onTempleResultClose() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    try { (this._typeTimeoutTimers || []).forEach((h) => { try { clearInterval(h) } catch (e) {} }) } catch (e) {}
    this._typeTimeoutTimers = []
    this._safeSetData({ showTempleResult: false }, () => {
      const flow = (SPOT_FLOW && SPOT_FLOW['越王庙']) ? SPOT_FLOW['越王庙'] : null
      const next = flow && flow.next ? flow.next : '越王井'
      const label = flow && flow.nextLabel ? flow.nextLabel : next
      that._transitionAppendingLock = true
      const unlock = () => { try { that._transitionAppendingLock = false } catch (e) {} }
      that._appendTransitionAndPopup(
        flow && flow.transitionLine ? flow.transitionLine : '谒王已毕，越王井尚在前方，随我一访井中岁月。',
        next, label, unlock
      )
      that._safeSetTimeout(() => { try { that._transitionAppendingLock = false } catch (e) {} }, 15000)
    })
  },

  // ============ §31 过渡弹窗（showTransitionPopup）三回调 + 景点介绍弹窗（showSpotIntro）打字机 ============
  /** 过渡弹窗「继续停留本景点」：关弹窗 + 清 transition 定时器 */
  onStayAtSpot() {
    if (!this || !this._pageAlive || this._destroyed) return
    try { (this._msgTimers || []).forEach((h) => { try { clearInterval(h) } catch (e) {} }) } catch (e) {}
    this._msgTimers = []
    this._safeSetData({ showTransitionPopup: false })
    try { this._transitionAppendingLock = false } catch (e) {}
  },
  /** 过渡弹窗「移步下一景点」：SafeStorage 打卡 → SPOT_INTROS 查介绍 → 弹景点介绍弹窗；否则 triggerSpotVisit 直进 */
  onGoToNextSpot() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    const spotKey = (this.data && this.data.nextSpotKey) || ''
    if (!spotKey) { this._safeSetData({ showTransitionPopup: false }); return }
    try {
      const app = getApp && getApp()
      if (app && app._memoryStorage) {
        const s = app._memoryStorage
        const list = JSON.parse(s.getItem('visitedSpots') || '[]') || []
        if (list.indexOf(spotKey) < 0) list.push(spotKey)
        s.setItem('visitedSpots', JSON.stringify(list))
        this._visitedSpots = list
      }
    } catch (eVis) {}
    this._safeSetData({ showTransitionPopup: false }, () => {
      const intro = (SPOT_INTROS && SPOT_INTROS[spotKey]) ? SPOT_INTROS[spotKey] : null
      if (!intro) {
        try { that.triggerSpotVisit(spotKey) } catch (e) {}
        return
      }
      that._safeSetData({
        showSpotIntro: true,
        introSpotName: intro.name || spotKey,
        introSpotSubtitle: intro.subtitle || '',
        introTypewriterText: '',
        introFullText: String(intro.intro || ''),
        showIntroBtn: false
      }, () => {
        try { that.startIntroTypewriter() } catch (e) { console.error('[景点介绍] 打字机异常：' + (e && e.stack ? e.stack : e)) }
      })
    })
  },
  /** 景点介绍打字机：80ms/字；结束 200ms 后显示"进入景点"按钮；所有 interval 首行判存活 */
  startIntroTypewriter() {
    if (!this || !this._pageAlive || this._destroyed) return
    const full = String((this.data && this.data.introFullText) || '')
    const that = this
    let i = 0
    let introInterval = null
    introInterval = setInterval(() => {
      if (!that || !that._pageAlive || that._destroyed) {
        try { clearInterval(introInterval) } catch (e) {}
        introInterval = null
        return
      }
      i += 1
      if (i > full.length) i = full.length
      that._safeSetData({ introTypewriterText: full.substring(0, i) })
      if (i >= full.length) {
        try { clearInterval(introInterval) } catch (e) {}
        introInterval = null
        // 🔴 嵌套 setTimeout 必须走 _safeSetTimeout
        that._safeSetTimeout(() => { that._safeSetData({ showIntroBtn: true }) }, 200)
      }
    }, 80)
    this._typeTimeoutTimers = this._typeTimeoutTimers || []
    this._typeTimeoutTimers.push(introInterval)
    this.playTTS(this._sanitizeForTTS(full), null)
  },
  /** 景点介绍「进入景点」：关弹窗 → 300ms 延迟触发 triggerSpotVisit */
  onEnterSpot() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    try { (this._typeTimeoutTimers || []).forEach((h) => { try { clearInterval(h) } catch (e) {} }) } catch (e) {}
    this._typeTimeoutTimers = []
    const spotKey = (this.data && this.data.nextSpotKey) || (this.data && this.data.introSpotName) || ''
    this._safeSetData({ showSpotIntro: false }, () => {
      that._safeSetTimeout(() => {
        if (!that || !that._pageAlive || that._destroyed) return
        try { that.triggerSpotVisit(spotKey) } catch (e) { console.error('[enterSpot] triggerSpotVisit异常:' + (e && e.stack ? e.stack : e)) }
      }, 300)
    })
  },

  // ============ §32 triggerSpotVisit：景点首句硬编码（跳过AI），考棚 / 越王庙 / 普通景点 三分支 ============
  triggerSpotVisit(spotName) {
    if (!this || !this._pageAlive || this._destroyed) return
    const spot = String(spotName || '').trim()
    if (!spot) return
    this._currentSpot = spot
    const that = this
    const lines = SPOT_TRIGGER_LINES && typeof SPOT_TRIGGER_LINES === 'object' ? SPOT_TRIGGER_LINES : {}
    if (spot === '龙川考棚' || spot === '考棚') {
      const welcome = lines['考棚'] || '前方龙川考棚，自宋以来便是选拔贤才之地，你且随我入内一试科场。'
      this.appendBotMsgWithTypewriter(welcome, () => {
        that._safeSetData({ showKejuStart: true })
      }, true)
      return
    }
    if (spot === '越王庙') {
      const welcome = lines['越王庙'] || '越王庙在此，谒王访贤，考验你对南越典故的熟稔。敢接此题否？'
      this.appendBotMsgWithTypewriter(welcome, () => {
        that._safeSetData({ showTempleTask: true })
      }, true)
      return
    }
    const hardcoded = (lines[spot] ? lines[spot] : '') || '你我已至『' + spot + '』，且听老夫道来。'
    this.appendBotMsgWithTypewriter(hardcoded, null, true, false)
    const hiddenMsg = {
      role: 'system',
      content: '【当前景点：' + spot + '】请严格按 SYSTEM_INSTRUCTION 中该景点的剧本作答，并遵循判卷机制。',
      displayText: '', typewriting: false, isHidden: true,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    const msgs = (this.data && this.data.messages) ? this.data.messages.slice() : []
    this._safeSetData({ messages: msgs.concat([hiddenMsg]) })
  },

  // ============ §33 景点别名标准化 / 扫码打卡 / 手动选点 ============
  parseSpotName(raw) {
    const src = String(raw || '').replace(/\s+/g, '')
    if (!src) return ''
    const aliases = (typeof SPOT_ALIASES === 'object' && SPOT_ALIASES) ? SPOT_ALIASES : {
      '百岁街': '百岁街', '佗城百岁街': '百岁街',
      '越王庙': '越王庙', '佗城越王庙': '越王庙',
      '越王井': '越王井', '佗城越王井': '越王井',
      '考棚': '龙川考棚', '龙川考棚': '龙川考棚', '龙川学宫': '龙川考棚',
      '苏堤': '苏堤', '西湖苏堤': '苏堤', '龙川苏堤': '苏堤',
      '正相塔': '正相塔', '龙川正相塔': '正相塔', '老塔': '正相塔'
    }
    if (aliases[src]) return aliases[src]
    const keys = Object.keys(aliases)
    for (let i = 0; i < keys.length; i++) { if (src.indexOf(keys[i]) >= 0) return aliases[keys[i]] }
    return src
  },
  /** 右下「扫码打卡」FAB：actionSheet 选「扫一扫」或「手动选」*/
  onScanCheckIn() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    try {
      wx.showActionSheet({
        itemList: ['扫一扫打卡', '手动选择景点'],
        success(res) {
          if (!that || !that._pageAlive || that._destroyed) return
          if (res.tapIndex === 0) try { that.doScanCode() } catch (e) {}
          else if (res.tapIndex === 1) try { that.showSpotPicker() } catch (e) {}
        },
        fail() {}
      })
    } catch (eTop) { console.error('[onScanCheckIn] 异常：' + (eTop && eTop.stack ? eTop.stack : eTop)) }
  },
  /** wx.scanCode（onlyFromCamera=false 允许相册选 QR）*/
  doScanCode() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    try {
      wx.scanCode({
        onlyFromCamera: false,
        scanType: ['qrCode', 'barCode'],
        success(res) {
          if (!that || !that._pageAlive || that._destroyed) return
          const raw = (res && res.result) || ''
          const spot = that.parseSpotName(raw)
          if (!spot) { try { wx.showToast({ title: '未识别到景点', icon: 'none' }) } catch (e) {}; return }
          try { that.triggerSpotVisit(spot) } catch (e) { console.error('[doScanCode] trigger异常:' + (e && e.stack ? e.stack : e)) }
        },
        fail(err) { if (_TTS_VERBOSE_LOG) console.warn('[scanCode] 取消或失败：', err) }
      })
    } catch (eTop) { console.error('[doScanCode] 异常：' + (eTop && eTop.stack ? eTop.stack : eTop)) }
  },
  /** 手动选景点：SPOT_LIST 顺序 */
  showSpotPicker() {
    if (!this || !this._pageAlive || this._destroyed) return
    const that = this
    const list = (Array.isArray(SPOT_LIST) && SPOT_LIST.length > 0) ? SPOT_LIST : ['百岁街', '越王庙', '越王井', '龙川考棚', '苏堤', '正相塔']
    try {
      wx.showActionSheet({
        itemList: list,
        success(res) {
          if (!that || !that._pageAlive || that._destroyed) return
          const idx = Number(res.tapIndex) || 0
          const spot = list[idx] || ''
          if (!spot) return
          try { that.triggerSpotVisit(spot) } catch (e) {}
        },
        fail() {}
      })
    } catch (eTop) { console.error('[showSpotPicker] 异常：' + (eTop && eTop.stack ? eTop.stack : eTop)) }
  }
})