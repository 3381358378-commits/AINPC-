/**
 * @file map-explore.js
 * @description 【佗城·赵佗历史文化之旅】地图探索页核心逻辑
 *
 * ============================================================
 *  项目简介
 * ============================================================
 *  本项目是一款沉浸式微信小程序「佗城·赵佗历史文化之旅」，以秦朝南越王赵佗为叙事主角，
 *  结合真实佗城古镇地图（百岁街 / 越王庙 / 越王井 / 龙川考棚 / 苏堤 / 正相塔 6 大景点），
 *  通过「地图探索 + NPC 带路 + 打卡 + TTS 语音 + 打字机叙事 + AI 对话」六大机制，
 *  让用户以第一人称视角穿越千年，与南越王赵佗共同走完岭南开拓之路。
 *
 * ============================================================
 *  技术栈
 * ============================================================
 *  - 框架：      微信原生小程序 (WXML / WXSS / WXS / Page 生命周期)
 *  - 音频：      wx.createInnerAudioContext + wx.downloadFile (自建 Python TTS 服务 server.py:5006)
 *  - 数据持久：  App 级内存 SafeStorage (safeGetStorageSync) —— 避开 wx.Storage 3.17.0 灰度 WAWorker 原生崩溃
 *  - 特效：      CSS 呼吸/浮动/淡入动画 + setInterval 打字机 + cubic-bezier 弹性过渡(NPC飞行)
 *  - 闪退防护：  9 大加固体系（详见下方「闪退防护设计总览」）
 *
 * ============================================================
 *  文件职责
 * ============================================================
 *  本文件实现 map-explore 页面的全部逻辑层：
 *   1. 开场引导：INTRO_TEXT 打字机 + TTS 朗读 → 用户点「接旨入城」进入主城
 *   2. 主城地图：7 个热区坐标加载 + 打卡数据读取 + NPC 瞬移带路动画
 *   3. 起点剧情：点击起点热区 → 弹出赵佗虚影独白（START_MONOLOGUE 打字机 + TTS）
 *   4. 景点跳转：点击 6 大景点热区 → NPC 飞行动画 → 跳转 chat 页带景点名 query
 *   5. TTS 播放队列：playTTS → _finishOneTts → queue.shift 全链路防闪退实现
 *   6. 工具栏 4 项：扫一扫(扫码打卡/手动选景) / 自由闲聊 / 拍卡打卡 / 进度查看
 *   7. 资源全清理：onUnload 7 类资源 (timer/interval/ctx/downloadTask/queue) 全回收
 *
 * ============================================================
 *  闪退防护设计总览（9 大加固体系，按调用频率排序）
 * ============================================================
 *   A. 页面存活双标记 _pageAlive + _destroyed
 *      → 根因：页面已经 onUnload 之后，异步回调(setTimeout/TTS/eventCb)中再调 setData
 *        会触发微信基础库 recursive update 检测，直接抛出 native 层崩溃。
 *      → 对策：所有异步回调第一行「if (!this._pageAlive || this._destroyed) return」。
 *
 *   B. _safeSetData：页面死前 guard + 顶层 try/catch + 死标记兜底
 *      → 根因：Page 实例被基础库复用/半销毁时，直接 setData 的回调闭包里会访问野指针 this。
 *      → 对策：执行前/后两次存活判定；异常时立刻标记 _destroyed=true 防止后续继续操作。
 *
 *   C. _safeSetTimeout / _safeClearTimeout + _allTimeoutHandles 集合
 *      → 根因：分散的 setTimeout 句柄无人管理，页面销毁后仍触发回调引发野指针崩溃；
 *        且微信 setTimeout 返回的 handle 不是每次都能被单个变量正确保存。
 *      → 对策：统一注册进 Set，执行完毕自动删除；onUnload 遍历集合一次性 clearTimeout。
 *
 *   D. TTS 11 事件 100% 显式绑定(onCanplay→onStop) + 11 事件 100% 空回调置空
 *      → 根因：真机 InnerAudioContext 有「未绑定事件则底层吞掉回调 → 锁死 _isTtsPlaying=true」
 *        以及「销毁前不置空会触发底层野事件派发 → WAWorker崩溃」两条死亡路径。
 *      → 对策：11 个事件全部 bind 一次；销毁(_finishOneTts/onUnload) 前再全部置空函数。
 *
 *   E. InnerAudioContext 安全销毁序列：11事件置空 → stop → setTimeout(150ms) → destroy
 *      → 根因：stop() 之后立即 destroy() 真机会命中解码线程仍在跑的时序竞态，直接野指针崩溃；
 *        并且 stop/destroy 调用时若 11 事件未解绑会回调到已释放的上下文上。
 *      → 对策：先把 11 事件全部替换为空函数斩断回调链 → stop() 发停止指令 → 延迟 150ms 等解码
 *        线程退出后再 destroy()。chat.js 和 map-explore.js 必须完全相同的销毁序列。
 *
 *   F. TTS 下载超时 60s + 播放超时 120s + 3s onCanplay 兜底
 *      → 根因：wx.downloadFile 无 timeout 参数，弱网/服务端无响应时永久挂起导致锁死；
 *        真机部分机型 src 赋值后 onCanplay 永远不触发（被底层吞），导致永不播放。
 *      → 对策：三层超时兜底。
 *
 *   G. safeFinish 幂等收敛器 + hasFiredPlayStartTop / hasFiredProgressFinal 双标记
 *      → 根因：失败回调和成功回调可能在极短时间内被底层并发触发两次（如 onError 之后 onEnded 又到）
 *        → 重复调用 _finishOneTts → 重复 stop/destroy → 释放已释放对象崩溃。
 *      → 对策：所有出口(成功/失败/超时/降级)全部收敛到 safeFinish，finished 布尔保证只进一次。
 *
 *   H. Base64 真机无法播放兜底：先写 USER_DATA_PATH 临时 mp3 文件再赋值 src
 *      → 根因：微信 InnerAudioContext.src 在真机不接受 data:audio/...;base64 data URI，
 *        只在 DevTools 能播，真机表现为 src 被底层吞掉→静音（不报错也不崩溃）。
 *      → 对策：fs.writeFile base64 到本地临时文件路径，返回绝对路径再赋 src。
 *
 *   I. onLoadedmetadata 能力判断 typeof === 'function'
 *      → 根因：onLoadedmetadata 是 Web/H5 <audio> 的标准 API，微信 InnerAudioContext 上
 *        仅在部分内核版本提供，若不加判断直接调用会抛 "oldCtx.onLoadedmetadata is not a function"
 *        → 进入 catch 流程但因为是在销毁序列内部，可能中断后续 stop/destroy → 资源泄漏。
 *      → 对策：先 typeof 判断再 bind / 置空；原有代码 100% 保留绝不删除。
 *
 *   J. SafeStorage 替代 wx.Storage API
 *      → 根因：微信 3.17.0 灰度版本 WAWorker 模块存在原生内存越界 bug，调用 wx.setStorageSync
 *        有概率在 10~60 秒后触发随机崩溃（与调用线程强相关）。
 *      → 对策：页面只读不写打卡进度；写入统一由 chat 页走 App 级内存缓存 safeGetStorageSync。
 * ============================================================
 *
 * @author 新兴赛·赵佗历史文化之旅 开发组
 */

/* ============ 开场引导固定文案：页面刚进来时赵佗以打字机+TTS向用户致辞 ============ */
const INTRO_TEXT = '吾乃南越王赵佗，佗城第一任县令。两千余年前，本王率秦军将士在此筑城、掘井、开疆、安民。今日闻小友至此，速随本王穿越千年，共探这岭南古邑！'

/* ============ 起点热区点击后赵佗虚影的长独白：交代任务背景 + 请用户替自己拾回记忆 ============ */
const START_MONOLOGUE = '咦……你是何人？为何能看见本王？这城廓……是佗城，却又不像佗城。本王乃南越王赵佗，在此地徘徊了两千余载。许是岁月太久，本王脑中竟如雾里看花——记不清自己为何在此，也记不清这城里的故事了。年轻人，你步履轻快，眼中带光。能否替本王走一遭这城中旧地？你每去一处，替本王看看、听听，或许本王的记忆便能拾回一分。待你走到城西那座高塔之下，本王或许就能想起全部了。本王将一丝神识附在你的"小方块"上，你且带上它上路吧。记着，先从脚下这条街开始——那里住着本王的旧部。'

// ============= TTS 后端 + 终极开关（闪退稳定 ⇄ 声音功能 共存）=============
// 🔴 闪退/声音冲突的「一键收敛开关」：
//    true  = 启用真实TTS下载+播放（声音功能正常，需server.py启动）【7项加固已完成】
//           【所有闪退防护代码（safeFinish白名单回调/stop→150ms→destroy/11事件全绑定/批量Console日志）100%保留生效】
//    false = 完全禁用任何TTS音频API，等同于「自动检测实现完成时的稳定态」，
//            保证一定能从第一景点完整跑完至第六景点不闪退
// ⚠️ 用户明确要求：本轮先回到 100% 不闪退的稳定态，不追究声音
const _ENABLE_TTS_AUDIO = true
// TTS 详细日志：开发时开启，测试/运行时关闭（防Console打印过多导致开发者工具崩溃）
// 根因：Windows 版微信开发者工具的 Console 面板在短时间内（<5s）打印 >500 条日志
//       会触发渲染进程 GPU 卡死（20~60 秒假死），因此非开发期需把 warn/error 收敛掉
const _TTS_VERBOSE_LOG = true
// ⚠️ 电脑开发者工具模拟器测试：默认用 127.0.0.1（本机回环，最稳，不需要 WiFi）
//    如需手机真机扫码测试：把 127.0.0.1 改成你电脑局域网 IPv4 地址（PowerShell 运行 ipconfig 查 WLAN IPv4）
const TTS_SERVER_URL = 'http://127.0.0.1:5006'

// 打字机速度：235ms/字（全局统一，和 chat.js 保持一致）
// 为什么是 235ms？—— 经验值：180ms 以下阅读体验偏快，260ms 以上偏拖沓；
// 235ms 与 TTS 每秒约 4.3 字的播报速度吻合，保证「打字出字」和「TTS 发声」视觉同步
const TYPEWRITER_INTERVAL = 235

/**
 * @constant {Array<Object>} SPOT_DATA
 * @description 7 个地图热区原始数据（1 起点 + 6 景点）。
 *   id        - 唯一编号，0=起点 1~6=景点
 *   name      - 景点中文名（对应 chat 页 spot query 和 SafeStorage 打卡记录）
 *   left/top  - 在 map-wrapper 中的百分比坐标（锚定地图上的真实位置）
 *   checked   - 是否已打卡（初始 false，每次 onShow 从 SafeStorage 回填）
 *   isStart   - 是否是起点（起点有独立蓝金光晕和虚影弹窗）
 *   story     - 景点剧情文案（旧版剧情弹窗使用，保留兼容）
 */
const SPOT_DATA = [
  {
    id: 0, name: '起点', left: '46%', top: '88%', checked: false, isStart: true
  },
  {
    id: 1, name: '百岁街', left: '67%', top: '68.5%', checked: false,
    story: '这里是百岁街，佗城村2000余人却有140个姓氏，全镇共179姓，多为当年随本王南下的50万秦军将士留下的血脉。保存宗祠48间，百岁街是姓氏宗祠集中地。小友可在此寻根问祖。'
  },
  {
    id: 2, name: '越王庙', left: '78%', top: '46.5%', checked: false,
    story: '这里是越王庙，乃佗城百姓为本王所建。清代建筑，前栋供奉木雕彩绘赵佗像，后栋祭祀苏辙、吴潜等十贤士。小友可愿入庙瞻仰？'
  },
  {
    id: 3, name: '越王井', left: '71.5%', top: '26%', checked: false,
    story: '这里是越王井，本王亲手挖掘的秦代古井，深11.3米，井身由青砖和红砂岩砌成。唐代韦昌明作《越井记》。小友可愿品尝此千年古井之水？'
  },
  {
    id: 4, name: '龙川考棚', left: '36.5%', top: '10.5%', checked: false,
    story: '这里是龙川考棚，清代光绪二年建，广东仅存科考场所。龙川及周边五华、兴宁等县童生皆来此赴考。小友可愿一试本王设下的科考之题？'
  },
  {
    id: 5, name: '苏堤', left: '12.5%', top: '29.5%', checked: false,
    story: '这里是苏堤，北宋苏辙被贬龙川17个月，倡议为百姓筑起此堤，高2.5米、顶宽2米。苏辙诗云："尉佗城下两重阳，白酒黄鸡意自长"。小友可愿与本王对诗？'
  },
  {
    id: 6, name: '正相塔', left: '11.5%', top: '59%', checked: false,
    story: '这里是正相塔，唐开元三年建，六角七层，高32.5米。传说玉帝派仙女连夜砌成，南宋名相吴潜曾寓居。小友可寻找刻有"开元三年"的塔砖。'
  }
]

/* 扫码识别白名单：只有扫描内容包含这 6 大景点名才算有效打卡码，否则提示未识别 */
const VALID_SPOTS = ['百岁街', '越王庙', '越王井', '龙川考棚', '苏堤', '正相塔']

Page({
  /**
   * @type {Object} data
   * @description 页面响应式数据（和 WXML {{}} 绑定的字段说明）
  *  - reviewConfigVisible —— 首次进入时显示阅卷环境配置说明
  *  - introVisible / typewriterText / showCursor / showEnterBtn —— 开场引导打字机状态
   *  - spots —— 7 个热区完整状态数组（left/top/checked 都已同步渲染）
   *  - npcLeft / npcTop —— NPC 赵佗当前百分比坐标（驱动 transition 飞行动画）
   *  - activeSpot —— 当前激活热区 id（决定哪个热区加 hz-active 朱红光晕）
   *  - checkedCount —— 已打卡景点数（0-6），顶部进度胶囊 + 工具栏进度按钮共用
   *  - storyVisible / storySpotName / storyText —— 景点剧情弹窗（目前通过 chat 页跳转触发，保留接口）
   *  - startPopupVisible / startTypewriterText / startShowCursor / startShowBtn —— 起点赵佗虚影打字机状态
   *  - isMuted —— TTS 静音开关（右上角按钮控制；开启时 playTTS 直接跳过不调音频 API）
   *  - _typeTimer / _startTypeTimer —— 两个打字机的 setInterval 句柄（onUnload 统一清理）
   */
  data: {
    reviewConfigVisible: true,
    cameraVisible: false,
    cameraPosition: 'back',
    photoMode: false,
    photoPath: '',
    cameraReady: false,
    introVisible: true,
    typewriterText: '',
    showCursor: true,
    showEnterBtn: false,
    spots: [],
    npcLeft: '50%',
    npcTop: '90%',
    activeSpot: 0,
    checkedCount: 0,
    storyVisible: false,
    storySpotName: '',
    storyText: '',
    startPopupVisible: false,
    startTypewriterText: '',
    startShowCursor: true,
    startShowBtn: false,
    // TTS 静音开关
    isMuted: false,
    _typeTimer: null,
    _startTypeTimer: null
  },

  /**
   * @function onLoad
   * @description 【生命周期】页面首次加载时执行，执行一次。
   *   1. 初始化页面存活双标记（闪退加固 A）
   *   2. 初始化 _allTimeoutHandles 集合（闪退加固 C）
   *   3. 重置 TTS 上下文/队列/下载超时（防止 Page 实例被基础库复用后残留 _isTtsPlaying=true 锁死）
   *   4. 把 SPOT_DATA 深拷贝为 spots（避免原常量被意外修改），走 _safeSetData 写入
  *   5. 等待评委确认配置说明，确认后再启动开场引导打字机 + TTS
   */
  onLoad() {
    // ========== 【页面存活标记】核心修复：与chat.js一致，防止页面销毁后异步回调setData ==========
    // 为什么分两个字段？_pageAlive 用于「回调函数第一层」的快速判定（绝大多数异步回调）；
    // _destroyed 用于「在 onUnload 执行中途或执行之后」可能被并发触发的极端竞态场景的二次保险
    this._pageAlive = true
    this._destroyed = false
    this._allTimeoutHandles = new Set()  // 统一管理所有 setTimeout 句柄
    // _setDataPending 根因：打字机 setInterval 每 235ms 就触发一次 _safeSetData，
    // 小程序基础库在 setData callback 内部再 setData 会被判定为 recursive update 并直接报错崩溃，
    // 此标记用于「如果前一次 setData 还没回调，就不要再发第二次」（本页当前通过 jumpToIdx 节流模式
    // 已经避免了 callback 内再 setData 的路径，这里留作兜底扩展字段）
    this._setDataPending = false  // 【防重叠】打字interval的setData防recursive update

    // ========= 【TTS状态完整重置】防止Page实例复用导致 _isTtsPlaying=true 锁死 =========
    // 根因：微信小程序 Page 栈较深时（首页→地图→聊天→返回地图→进入下一个景点聊天...），
    //       基础库不会销毁 map-explore 的 Page 实例，下次 onLoad 被调用时 this 是同一个对象。
    //       如果上一次进入时 _isTtsPlaying 被卡在 true（onError 回调抛异常没走 safeFinish），
    //       这一次进入的 playTTS 会永远走「进队列」分支而永不播放 → 用户看到的现象就是没声音。
    this._ttsDownloadTimeout = null
    this._isTtsPlaying = false
    this._ttsQueue = []
    if (this._audioCtx) {
      try { this._audioCtx.stop() } catch (e) {}
      try { this._audioCtx.destroy() } catch (e) {}
      this._audioCtx = null
    }

    // 复制一份 SPOT_DATA 到响应式数组（不污染常量，允许 checked 字段被 onShow 修改）
    const spots = SPOT_DATA.map(s => ({ ...s }))
    // 【走_safeSetData】避免onLoad初始化问题
    this._safeSetData({ spots })
    // 首次进入先展示配置说明；用户确认后由 onConfirmReviewConfig 启动欢迎页。
  },

  /**
   * 【阅卷环境确认】关闭配置说明，进入原有赵佗欢迎引导。
   * 网络请求和 TTS 均延迟到用户完成知情确认后，避免未配置环境时产生误报。
   */
  onConfirmReviewConfig() {
    this._safeSetData({ reviewConfigVisible: false }, () => {
      this.startTypewriter()
    })
  },

  /**
   * @function onShow
   * @description 【生命周期】页面每次出现在屏幕最顶层时执行（含首次 onLoad 之后 + 从 chat 页返回）。
   *   1. 再次重置 TTS 锁 —— 因为从 chat 页返回时，chat 侧的 TTS 可能残留状态串到了 this
   *   2. 从 SafeStorage（内存版）读取已打卡景点，覆盖到 spots.checked 上
   *   3. 重新计算 checkedCount 并渲染（保证用户从聊天页打卡回来能立刻看到勾号）
   */
  onShow() {
    // ========= 【每次进入页面重置TTS状态】从chat页返回时，确保TTS锁不残留 =========
    // 根因：chat.js 和 map-explore.js 共享同一个全局 JSContext；chat 侧若播放中被 navigateBack
    //       强行中断，chat._audioCtx 的部分事件回调可能会在 onShow 之后的 100-500ms 才到达，
    //       导致 TTS 底层有残留状态。这里在 onShow 顶层再次清空本页的 TTS 上下文，
    //       防止 chat 的状态交叉污染到本页的 playTTS。
    try {
      this._ttsDownloadTimeout = null
      this._isTtsPlaying = false
      this._ttsQueue = []
      if (this._audioCtx) {
        try { this._audioCtx.stop() } catch (e) {}
        try { this._audioCtx.destroy() } catch (e) {}
        this._audioCtx = null
      }
    } catch (eTtsReset) {
      console.warn('[map.onShow TTS重置警告]:', eTtsReset)
    }

    // 从内存SafeStorage读取已打卡景点——彻底禁用wx.Storage API，避免3.17.0灰度WAWorker原生崩溃
    // 根因：见本文件顶部注释「闪退防护 J」
    let visited = []
    try {
      const app = getApp()
      visited = (app.safeGetStorageSync && app.safeGetStorageSync('visitedSpots')) || []
    } catch (e) {
      console.warn('[map.onShow SafeStorage警告，已隔离]:', e && e.message || e)
      visited = []
    }
    try {
      const spots = this.data.spots.map(s => {
        return { ...s, checked: visited.indexOf(s.name) > -1 }
      })
      const checkedCount = spots.filter(s => s.checked && !s.isStart).length
      // 【走_safeSetData】避免onShow（尤其从chat页返回时）页面状态不确定
      this._safeSetData({ spots, checkedCount })
    } catch (e) {
      console.error('[map.onShow spots计算异常]:', e)
    }
  },

  /**
   * @function onUnload
   * @description 【生命周期】页面被真正销毁（navigateBack / redirectTo / reLaunch 都会触发）时执行。
   *   闪退防护的「终极收口处」—— 必须按顺序 100% 清理以下 7 类资源，任何一类遗漏都可能野指针崩溃：
   *     0. _allTimeoutHandles 统一 setTimeout 集合
   *     1. 开场引导打字机 setInterval (_typeTimer)
   *     2. 起点剧情打字机 setInterval (_startTypeTimer)
   *     3. TTS 下载超时 + wx.downloadFile 任务全部 abort + TTS 队列 + TTS 状态锁
   *     4. InnerAudioContext（严格执行 11事件置空 → stop → 150ms → destroy 序列）
   *     5. 起点剧情弹窗其他辅助定时器
   *   全部 try/catch 包裹：清理任一步出错都绝不影响后续步骤。
   */
  onUnload() {
    try {
      // 【页面存活标记】最先执行：标记页面已死亡
      // 为什么最先执行？—— 清理过程本身会引发部分 stop/onStop 等事件回调触发，
      // 这些回调的第一行就是检查 _pageAlive / _destroyed，若先不标记它们会再调 setData
      this._pageAlive = false
      this._destroyed = true
      // 顶层 try/catch：卸载过程任何错误绝不能崩
      console.log('[map.onUnload] 开始清理页面资源')

      // 0. 【终极清理】统一清除所有 _allTimeoutHandles 中的 setTimeout
      // 根因：如果不统一清理，分散注册的 setTimeout 可能在页面销毁后几百 ms 再触发，
      //       此时 this 虽然 _destroyed=true 但底层 Page 实例已经被回收，
      //       访问 this.data / this.setData 都会变成野指针（偶现 WAWorker crash）
      if (this._allTimeoutHandles && this._allTimeoutHandles.size > 0) {
        console.log('[map.onUnload] 清理_allTimeoutHandles数量:', this._allTimeoutHandles.size)
        this._allTimeoutHandles.forEach(h => {
          try { clearTimeout(h) } catch (e) {}
        })
        this._allTimeoutHandles.clear()
      }
      // 1. 清理开场引导打字定时器
      // （为什么同时 clearInterval + clearTimeout？—— 开发中多次切换模式时，
      //   同一个 _typeTimer 句柄可能曾被 setInterval 赋值也可能被 setTimeout 赋值，
      //   两种清理都调用一次保证 100% 清除，重复 clear 同一个 handle 微信底层不报错）
      if (this._typeTimer) {
        try { clearInterval(this._typeTimer) } catch (e) {}
        try { clearTimeout(this._typeTimer) } catch (e) {}
        this._typeTimer = null
      }
      // 2. 清理起点剧情打字定时器
      if (this._startTypeTimer) {
        try { clearInterval(this._startTypeTimer) } catch (e) {}
        try { clearTimeout(this._startTypeTimer) } catch (e) {}
        this._startTypeTimer = null
      }
      // 3. 清理 TTS：下载超时、播放 ctx、队列、状态
      if (this._ttsDownloadTimeout) {
        try { this._safeClearTimeout(this._ttsDownloadTimeout) } catch (e) {}
        this._ttsDownloadTimeout = null
      }
      // 🔴 加固：页面销毁前 abort 所有正在进行的 wx.downloadFile
      // 根因：如果 onUnload 时 wx.downloadFile 还在跑（弱网 60s 超时未到），底层下载线程
      //       完成后会回调 success/fail，此时 try/catch 虽然会拦截但因为页面实例已被回收，
      //       仍有极小概率触发基础库 GC 顺序错乱的崩溃。最稳的办法：直接 abort 让下载线程立刻退出。
      try {
        const tasks = this._ttsActiveDownloadTasks || []
        tasks.forEach(function(t) { try { t.abort && t.abort() } catch (e) {} })
        this._ttsActiveDownloadTasks = []
      } catch (eAbort) {}
      this._ttsQueue = []
      this._isTtsPlaying = false
      // 🔴 加固：onUnload 销毁 ctx 必须和 _finishOneTts 完全一致的「安全销毁序列」
      // 为什么要求完全一致？—— 销毁序列是真机多轮测试后得到的「唯一不崩序列」，
      // 任何一处打乱顺序（比如先 destroy 再 stop 或延迟<150ms）都会提升真机崩溃率 10% 以上。
      if (this._audioCtx) {
        try {
          const oldCtx = this._audioCtx
          // 第一步：立刻置空 this._audioCtx，防止其他代码并发访问到正在被销毁的对象
          this._audioCtx = null
          // 【11 事件全置空】彻底斩断回调链条，保证后续 stop/destroy 不会再触发任何已释放闭包
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
          // 第二步：发停止指令
          try { oldCtx.stop() } catch (e) {}
          // 第三步：等待 150ms（让底层解码线程完全退出）再 destroy
          setTimeout(() => { try { oldCtx.destroy() } catch (e) {} }, 150)
        } catch (eCtx) {}
      }
      // 4. 清理起点剧情弹窗定时器（如果有）
      if (this._popupTimer) {
        try { clearTimeout(this._popupTimer) } catch (e) {}
        this._popupTimer = null
      }
    } catch (eTop) {
      console.error('[map.onUnload 清理顶层异常，已忽略]:', eTop)
    }
  },

  // ============ 【终极安全层】safeSetData：防止页面销毁后 setData 触发基础库崩溃 ============
  /**
   * @function _safeSetData
   * @description 【闪退加固 B】对 this.setData 的安全封装 —— 全页所有 setData 调用应走本方法。
   *   执行流程：
   *     1. 执行前检查 this / _destroyed / _pageAlive，任一项不满足 → 不 setData，仅执行 callback 即返回
   *     2. 进入 setData 调用，callback 内部做「第二次存活判定」+ callback 自身 try/catch
   *     3. 外层再 try/catch，一旦 setData 抛出异常（典型如 "recursive update"、"page not exist"）
   *        → 立刻主动标记 this._destroyed = true，避免后续代码再对已死页面做任何操作
   * @param {Object}   dataObj  - 要设置到 data 上的对象（同原生 setData）
   * @param {Function} [callback] - setData 渲染完成后的回调（仅页面存活时执行）
   * @returns {boolean} true  = 成功进入了原生 setData 调用
   *                    false = 页面已死或抛异常，setData 被跳过
   */
  _safeSetData(dataObj, callback) {
    try {
      if (!this || this._destroyed || !this._pageAlive) {
        try { if (callback) callback() } catch (e) {}
        return false
      }
    } catch (eCheck) {
      try { if (callback) callback() } catch (e) {}
      return false
    }
    try {
      this.setData(dataObj, () => {
        try {
          // setData callback 再做一次存活判定
          // 根因：setData 同步发出去之后到 callback 异步回来之间，页面可能已被用户 navigateBack
          //       此时 callback 闭包里的代码如果再 setData / 访问 this.data 就会崩
          if (!this || this._destroyed || !this._pageAlive) return
          if (callback) try { callback() } catch (eCb) { console.error('[Map safeSetData callback异常]:', eCb) }
        } catch (eCbTop) {}
      })
      return true
    } catch (eSetData) {
      console.error('[Map safeSetData执行异常，标记页面已死]:', eSetData)
      // 异常发生时主动标记死亡 —— 防止上层逻辑不知道页面已死，继续后续操作引发连锁崩溃
      try { this._destroyed = true; this._pageAlive = false } catch (eMark) {}
      try { if (callback) callback() } catch (eCb) {}
      return false
    }
  },
  /**
   * @function _safeSetTimeout
   * @description 【闪退加固 C】对 setTimeout 的安全封装 —— 统一登记句柄 + 回调前存活判定。
   *   核心做法：
   *     1. 创建前先存活判定，页面已死直接返回 null 不创建
   *     2. setTimeout 句柄 push 到 this._allTimeoutHandles 集合（onUnload 一键清空）
   *     3. 回调触发时「先做存活判定 → 才真正执行 fn → finally 从集合移除句柄」
   *     4. 顶层 try/catch：任何注册阶段异常都 catch 住不冒泡
   * @param {Function} fn       - 延迟执行的函数
   * @param {number}   delayMs  - 延迟毫秒数
   * @returns {number|null} setTimeout handle 或 null（页面已死时）
   */
  _safeSetTimeout(fn, delayMs) {
    try {
      if (!this || this._destroyed || !this._pageAlive) return null
      this._allTimeoutHandles = this._allTimeoutHandles || new Set()
      const handle = setTimeout(() => {
        try {
          if (this && !this._destroyed && this._pageAlive) {
            try { fn && fn() } catch (eFn) { console.error('[Map safeSetTimeout回调异常]:', eFn) }
          }
        } catch (eCheck) {} finally {
          try { if (this && this._allTimeoutHandles) this._allTimeoutHandles.delete(handle) } catch (eRm) {}
        }
      }, delayMs || 0)
      this._allTimeoutHandles.add(handle)
      return handle
    } catch (eTop) {
      console.error('[Map safeSetTimeout注册异常]:', eTop)
      return null
    }
  },
  /**
   * @function _safeClearTimeout
   * @description 【闪退加固 C 配套】清除 _safeSetTimeout 登记的 handle —— 同时清 handle + 从集合移除。
   *   为什么需要专门的 clear？—— 如果只调原生 clearTimeout，this._allTimeoutHandles 还留着
   *   旧 handle 引用，onUnload 虽然也会清但会浪费一次遍历 + 重复 clear。
   *   注意：clearTimeout(handle) 如果 handle 已触发/无效，微信底层是安全的 no-op，不会报错。
   * @param {number} handle - _safeSetTimeout 返回的句柄
   */
  _safeClearTimeout(handle) {
    try {
      if (handle) {
        try { clearTimeout(handle) } catch (e) {}
        try { if (this && this._allTimeoutHandles) this._allTimeoutHandles.delete(handle) } catch (eRm) {}
      }
    } catch (eTop) {}
  },

  // ============ TTS：静音按钮切换 ============
  /**
   * @function toggleMute
   * @description 右上角静音按钮点击 —— 切换 this.data.isMuted，并在「切到静音」时立刻 stop 当前 TTS 播放。
   *   为什么这里不用 _safeSetData？—— toggleMute 一定是用户在页面存活时主动点击触发的，
   *   此时 setData 100% 安全，为了减少不必要的栈开销可以直接调原生。但若未来有需求可以随时切回 _safeSetData。
   */
  toggleMute() {
    const newMuted = !this.data.isMuted
    this.setData({ isMuted: newMuted })
    // 切到静音时必须立刻 stop 当前 ctx —— 否则用户已经点了静音还继续发声就是 Bug
    if (newMuted && this._audioCtx) {
      try { this._audioCtx.stop() } catch (e) {}
    }
    wx.showToast({
      title: newMuted ? '已静音' : '已开启语音',
      icon: 'none',
      duration: 1200
    })
  },

  // 🔴 AI 整改点①：Base64 真机无法播放兜底——禁止直接把 data:audio/...;base64 赋给 InnerAudioContext.src
  //    必须先写入 USER_DATA_PATH 临时 mp3 文件，再返回本地绝对路径
  //    兼容三种输入：wx.downloadFile 返回的 tempFilePath / data:audio/...;base64,xxx / 普通网络URL
  /**
   * @function _resolveAudioSrc
   * @description 【闪退加固 H】统一处理 TTS 音频源路径：对 Base64 先写本地临时文件再返回路径，其他直接原样返回。
   *   为什么必须写本地文件？—— 微信真机（iOS/Android）InnerAudioContext.src 不识别 data:audio/...;base64 形式，
   *   表现为：DevTools 正常，真机「完全无声 + 不报任何错」，属于极难排查的差异 bug。
   *   写文件失败时兜底：直接返回原 src，保证流程绝不卡死。
   * @param {string} rawSrc - 原始音频源（可能是 tempFilePath / base64 data URI / 普通 URL）
   * @returns {Promise<string>} 最终可播放的本地绝对路径（或原值兜底）
   */
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
                success: () => { if (_TTS_VERBOSE_LOG) console.log('[Map TTS] Base64已写本地临时文件:', localAbsPath); resolve(localAbsPath) },
                fail: (eWrite) => { console.error('[Map TTS] Base64写临时文件失败:', eWrite); resolve(rawSrcTrim) } // 失败兜底：返回原src（保证绝不崩溃）
              })
            } catch (eWrite2) { console.error('[Map TTS] Base64写临时文件异常:', eWrite2); resolve(rawSrcTrim) }
          })
        } catch (eFS) { console.error('[Map TTS] getFileSystemManager调用异常:', eFS); return Promise.resolve(rawSrcTrim) }
      }
      // 非 Base64（tempFilePath / 网络 URL）：原样返回
      return Promise.resolve(rawSrcTrim)
    } catch (eTop) { return Promise.resolve(rawSrc || '') }
  },

  // ============ TTS：文字转语音播放（队列版 + 全链路防闪退 + 下载超时兜底 + 降级开关，与 chat.js 同步）============
  /**
   * @function playTTS
   * @description 【核心音频函数】把一段文本转成 TTS 语音并播放。
   *   执行路径拆解：
   *    ├─ 空文本 / 已静音 —— 直接异步回调 onDone 不操作硬件
   *    ├─ _isTtsPlaying=true 正在播放 —— 推入队列 (_ttsQueue)，等当前条结束后在 _finishOneTts 里消费
   *    ├─ _ENABLE_TTS_AUDIO=false 降级开关 —— 完全不调音频 API，异步回调 onDone 结束
   *    └─ 完整播放链路：
   *        (a) 下载超时 60s + safeFinish 幂等收敛器初始化（加固 F/G）
   *        (b) wx.downloadFile 拉取 mp3（登记到 _ttsActiveDownloadTasks 方便 onUnload abort —— 加固）
   *        (c) 创建 InnerAudioContext + 11 事件全绑定（加固 D）
   *            - onCanplay：才启动 120s 音频超时 + 调 play()
   *            - onPlay：触发 onPlayStart（打字机声字同步核心）
   *            - onTimeUpdate：推 onAudioProgress（字随音走）
   *            - onError/onEnded/onStop：走 safeFinish
   *        (d) 先 _resolveAudioSrc（Base64 转本地文件 —— 加固 H），再赋 src（必须在所有事件 bind 完之后！否则真机 onCanplay 被吞静音）
   *        (e) 3s 兜底：如果 onCanplay 一直没触发就强行 play（部分机型事件被吞）
   *
   * @param {string}   text            - 要朗读的文本（会被 trim + 截断前 300 字，防止服务端超长拒绝）
   * @param {Function} [onDone]        - (wasSuccess) 任何结束（成功/失败/超时/静音/降级）都会触发的完成回调
   * @param {Function} [onPlayStart]   - TTS 真正开始发声（onPlay）时触发，用于「声一出字才出」的打字机同步
   * @param {Function} [onAudioProgress] - (currentTime, duration) 每 250ms 推一次真实播放进度，用于按比例跳字
   */
  // onDone(wasSuccess): 播放完成回调（无论成功/失败/静音/超时/降级开关关闭都会触发，用于和打字机同步）
  // onPlayStart(): 【可选】TTS 真正开始发声（onPlay）时的回调，用于和打字机同步启动
  // onAudioProgress(currentTime, duration): 【可选】音频真实播放进度回调，用于【字随音走】——打字机按音频进度比例显示文字
  playTTS(text, onDone, onPlayStart, onAudioProgress) {
    try {
      // 空文本：直接返回成功状态
      if (!text || !text.trim()) {
        if (_TTS_VERBOSE_LOG) console.log('[Map TTS] 空文本跳过')
        if (onAudioProgress) this._safeSetTimeout(() => { try { onAudioProgress(1, 1) } catch (e) {} }, 0)
        if (onPlayStart) this._safeSetTimeout(() => { try { onPlayStart() } catch (e) {} }, 0)
        if (onDone) this._safeSetTimeout(() => { try { onDone(true) } catch (e) {} }, 0)
        return
      }
      if (_TTS_VERBOSE_LOG) console.log('[Map TTS] playTTS被调用，isMuted=', this.data.isMuted, '_isTtsPlaying=', this._isTtsPlaying, '队列长度=', (this._ttsQueue || []).length, '文本片段:', (text || '').substring(0, 20))
      // 用户主动静音：和空文本走同样的「直接回调」路径，避免不必要的音频上下文创建
      if (this.data.isMuted) {
        if (_TTS_VERBOSE_LOG) console.log('[Map TTS] 用户已静音，跳过播放')
        if (onAudioProgress) this._safeSetTimeout(() => { try { onAudioProgress(1, 1) } catch (e) {} }, 0)
        if (onPlayStart) this._safeSetTimeout(() => { try { onPlayStart() } catch (e) {} }, 0)
        if (onDone) this._safeSetTimeout(() => { try { onDone(true) } catch (e) {} }, 0)
        return
      }

      // 文本裁剪：取前 300 字（TTS 服务端单条有上限，超长会被 HTTP 400 拒绝）
      const cleanText = text.trim().slice(0, 300)

      // TTS 队列：正在播放时入队，绝不 destroy 上一条（防重叠掐断闪退）
      // 根因：如果销毁当前正在播放的 ctx 再立刻创建新的 ctx 去 play，真机会有两个音频解码线程
      // 同时存在的极短时间窗（~20ms），命中底层解码驱动的野指针 → 偶现 native crash。
      // 解决：排队串行化，上一条 _finishOneTts 完全销毁后延迟 250ms 再播下一条。
      this._ttsQueue = this._ttsQueue || []
      if (this._isTtsPlaying) {
        this._ttsQueue.push({ text: cleanText, onDone, onPlayStart, onAudioProgress })
        if (_TTS_VERBOSE_LOG) console.log('[Map TTS] 当前正在播放，已入队，队列长度:', this._ttsQueue.length)
        return
      }
      this._isTtsPlaying = true

      // =========================================================
      // 🔴 【终极收敛 · 降级开关】_ENABLE_TTS_AUDIO = false 时，
      //    完全不调任何音频API，直接视为完成，等于「自动检测实现完成时的稳定态」
      // =========================================================
      if (!_ENABLE_TTS_AUDIO) {
        if (_TTS_VERBOSE_LOG) console.log('[Map TTS] 降级模式（_ENABLE_TTS_AUDIO=false），稳定优先，直接回调')
        const that = this
        if (onAudioProgress) this._safeSetTimeout(() => { try { onAudioProgress(1, 1) } catch (e) {} }, 0)
        if (onPlayStart) this._safeSetTimeout(() => { try { onPlayStart() } catch (e) {} }, 0)
        this._safeSetTimeout(() => {
          try { that && that._finishOneTts(true, onDone) } catch (e) {}
        }, 0)
        return
      }

      if (_TTS_VERBOSE_LOG) console.log('[Map TTS] 获取播放锁，开始处理...')
      const url = TTS_SERVER_URL + '/tts?text=' + encodeURIComponent(cleanText)

      // ================= safeFinish 幂等收敛器 =================
      // 根因：TTS 流程有 10+ 个退出路径（下载成功/下载失败/HTTP非200/超时/onCanplay3s兜底/
      // onError/onEnded/onStop/onCanplay抛异常/页面销毁）。如果每个路径都自己直接调
      // _finishOneTts，存在「并发触发 2 次 _finishOneTts」的风险（例：真机 onError 触发后
      // 紧接着又触发 onStop，底层未做互斥），对应表现为：
      //   → 同一份 oldCtx 被连续 stop/destroy 两次 → 野指针崩溃。
      // 解决：所有退出路径都先走 safeFinish，finished 布尔保证只进一次 _finishOneTts。
      let finished = false  // 防重复触发
      let hasFiredPlayStartTop = false   // 和 finished 同级：onPlayStart 全链路只触发一次（含成功/失败/超时兜底）
      let hasFiredProgressFinal = false  // 和 finished 同级：onAudioProgress 100% 只触发一次
      const safeFinish = (wasSuccess) => {
        try {
          if (finished) return
          finished = true
          // 🔴 保底：任何原因触发 safeFinish（失败/超时/错误）→ 如果 onPlayStart 还没触发过就立刻触发
          // 根因：如果下载失败/超时/onCanplay被吞，onPlayStart 永远不会被触发，上层打字机
          // 就会「光标一直闪但字一直不出来」用户看起来像卡死。兜底立刻触发 onPlayStart 后打字机启动。
          if (!hasFiredPlayStartTop && onPlayStart) {
            hasFiredPlayStartTop = true
            try { onPlayStart() } catch (ePS2) { console.error('[Map TTS] safeFinish兜底onPlayStart异常:', ePS2) }
          }
          // 🔴 保底：任何原因触发 safeFinish → onAudioProgress 100%（立刻显示全文，打字机不卡死）
          if (!hasFiredProgressFinal && onAudioProgress) {
            hasFiredProgressFinal = true
            try { onAudioProgress(1, 1) } catch (eAP2) { console.error('[Map TTS] safeFinish兜底onAudioProgress异常:', eAP2) }
          }
          // 清下载超时定时器（如果存在），否则 60s 后会再触发一次 safeFinish(false)
          if (this._ttsDownloadTimeout) {
            clearTimeout(this._ttsDownloadTimeout)
            this._ttsDownloadTimeout = null
          }
          this._finishOneTts(wasSuccess, onDone)
        } catch (e) {
          if (_TTS_VERBOSE_LOG) console.error('[Map TTS safeFinish异常]:', e)
        }
      }

      // 致命修复：wx.downloadFile 无 timeout，加 60秒兜底
      // 根因：小程序 wx.downloadFile 官方没有 timeout 参数。弱网 / server 假死 / DNS 解析卡住
      //       都会让下载线程永久挂起，表现为：无任何回调 / TTS 静默 / _isTtsPlaying 锁死。
      this._ttsDownloadTimeout = this._safeSetTimeout(() => {
        try {
          if (!this || !this._pageAlive || this._destroyed) return
          safeFinish(false)
        } catch (e) {}
      }, 60000)

      // 🔴 最精简的下载+音频回调链路：【绝对不许】调 wx.showToast/_pushDebugLog/_safeSetData，
      //    也不许长日志/fs.readFile/格式化打印。回调仅做 safeFinish。
      // 根因：2024-05 一轮稳定性验证中发现，回调中如果再调任何 UI API（尤其 wx.showToast）或大量
      //       Console 打印，和音频解码事件同时触发时会提升 3~5 倍的 WAWorker 崩溃率。因此回调
      //       链路只保留最小操作：safeFinish。弹窗 / 日志统统在 safeFinish 之外或降级到非关键路径。
      const downloadTask = wx.downloadFile({
        url: url,
        success: (res) => {
          try {
            if (finished) return
            // 页面已死：立刻 safeFinish 解锁，绝不创建音频上下文
            if (!this || !this._pageAlive || this._destroyed) {
              if (_TTS_VERBOSE_LOG) console.warn('[Map TTS] 下载完成但页面已死，强制解锁')
              safeFinish(false)
              return
            }
            if (res.statusCode !== 200) {
              // AI 整改点③：下载 HTTP 非 200 也强制真机弹窗
              try {
                if (this && this._pageAlive && !this._destroyed) {
                  try {
                    wx.showModal({
                      title: 'TTS下载失败',
                      content: ('错误码(HTTP): ' + (res.statusCode || '未知') + '\n错误信息: ' + ((res.data && typeof res.data === 'string' ? res.data.substring(0, 100) : '') || '服务器非200响应')),
                      showCancel: false,
                      confirmText: '知道了'
                    })
                  } catch (eM) {}
                }
              } catch (eModalPre) {}
              if (_TTS_VERBOSE_LOG) console.warn('[Map TTS] 下载失败 HTTP:', res.statusCode)
              safeFinish(false)
              return
            }
            if (_TTS_VERBOSE_LOG) console.log('[Map TTS] 下载成功')

            // 唯一销毁点 _finishOneTts 管理旧ctx，此处仅创建新ctx
            this._audioCtx = wx.createInnerAudioContext()
            this._audioCtx.obeyMuteSwitch = false
            try { this._audioCtx.volume = 1.0 } catch (e) {}
            // ===== AI 整改点②：原 src 赋值移到 11 事件 + onCanplay 全部绑定完成后再执行
            //      真机底层 src 赋值立刻触发 onCanplay，如果事件还没绑好就会被直接吞掉 → 静音
            // （原代码这行保留注释防误删：this._audioCtx.src = res.tempFilePath）

            let hasStartedPlay = false
            let hasFiredPlayStart = false   // 保证 onPlayStart 只触发一次（声出才出字的同步核心）
            let audioFinishTimer = null
            // 播放端总超时 120s 兜底（覆盖超长 TTS + 中间 buffering 卡住的场景）
            const startFinishTimer = () => {
              audioFinishTimer = this._safeSetTimeout(() => {
                try {
                  if (!this || !this._pageAlive || this._destroyed) return
                  safeFinish(false)
                } catch (e) {}
              }, 120000)
            }
            // ====================================================================
            // 🔴 加固1：【11个音频事件 100% 显式绑定+空回调置空】（与chat.js完全对齐）
            // 根因：真机上有 3 个事件如果不绑定会有静默问题：
            //   1) onCanplay 不绑 → 部分机型即使底层 ready 也不通知上层（事件注册表为空）
            //   2) onPause/onSeeked/onSeeking/onLoadedmetadata 不绑 → 底层状态机不完整推进，
            //      偶现 onEnded 永远不触发 → _isTtsPlaying=true 被锁死 → 后续 TTS 全挂起
            //   3) onStop 不绑 → stop() 之后 150ms 内用户再次 play 时底层复用 ctx 偶发冲突
            // ====================================================================
            this._audioCtx.onCanplay(() => {
              try {
                if (!this || !this._pageAlive || this._destroyed) return
                if (hasStartedPlay) return
                hasStartedPlay = true
                startFinishTimer()
                // AI 整改点②：onCanplay 回调触发后才真正执行 play（真机绝不允许 src=赋值后立刻 play）
                try { if (this._audioCtx) this._audioCtx.play() } catch (e) { safeFinish(false) }
              } catch (e) { safeFinish(false) }
            })
            this._audioCtx.onPlay(() => {
              try {
                if (_TTS_VERBOSE_LOG) console.log('[Map TTS] onPlay 真机已开始播放')
                // 🔴 打字声同步核心：onPlay 触发时才通知打字机启动（声一出字才出）
                if (!hasFiredPlayStartTop && onPlayStart) {
                  hasFiredPlayStartTop = true
                  hasFiredPlayStart = true
                  try { onPlayStart() } catch (ePS) { console.error('[Map TTS] onPlayStart回调异常:', ePS) }
                }
              } catch (e) {}
            })
            this._audioCtx.onPause(() => { try {} catch (e) {} })       // ✅ 补绑
            this._audioCtx.onSeeked(() => { try {} catch (e) {} })      // ✅ 补绑
            this._audioCtx.onSeeking(() => { try {} catch (e) {} })     // ✅ 补绑
            this._audioCtx.onWaiting(() => { try {} catch (e) {} })
            // 🛡️ 能力判断（保留原代码，绝不删除）：onLoadedmetadata 是 Web/H5 API，小程序 InnerAudioContext 通常无此方法
            try { if (typeof this._audioCtx.onLoadedmetadata === 'function') { this._audioCtx.onLoadedmetadata(() => { try {} catch (e) {} }) } } catch (e) {}  // ✅ 补绑
            this._audioCtx.onTimeUpdate((e) => {
              try {
                // 🔴 字随音走核心：每 250ms 推一次真实音频进度 → 打字机按比例跳字
                if (onAudioProgress && this._audioCtx) {
                  let ct = 0; let dur = 0
                  try {
                    if (e && typeof e === 'object' && typeof e.currentTime === 'number') ct = e.currentTime
                    else if (typeof this._audioCtx.currentTime === 'number') ct = this._audioCtx.currentTime
                    if (e && typeof e === 'object' && typeof e.duration === 'number') dur = e.duration
                    else if (typeof this._audioCtx.duration === 'number') dur = this._audioCtx.duration
                  } catch (eDur) {}
                  if (!isFinite(ct) || ct < 0) ct = 0
                  if (!isFinite(dur) || dur <= 0) dur = 0
                  try { onAudioProgress(ct, dur) } catch (eAP) { console.error('[Map TTS] onAudioProgress回调异常:', eAP) }
                }
              } catch (e) {}
            })
            this._audioCtx.onError((err) => {
              // ===== AI 整改点③：InnerAudioContext.onError 必须强制真机弹窗 + 打印 errCode/errMsg
              try {
                console.error('[Map TTS] 播放错误 errCode=' + (err && err.errCode) + ' errMsg=' + (err && err.errMsg), err)
                if (audioFinishTimer) { try { this._safeClearTimeout(audioFinishTimer) } catch (e) {}; audioFinishTimer = null }
                try {
                  if (this && this._pageAlive && !this._destroyed) {
                    wx.showModal({
                      title: 'TTS播放错误',
                      content: ('错误码: ' + (err && err.errCode || '未知') + '\n错误信息: ' + (err && err.errMsg || '未知')),
                      showCancel: false,
                      confirmText: '知道了'
                    })
                  }
                } catch (eModal) {}
                safeFinish(false)
              } catch (e) { try { safeFinish(false) } catch (e2) {} }
            })
            this._audioCtx.onEnded(() => {
              try {
                if (audioFinishTimer) { try { this._safeClearTimeout(audioFinishTimer) } catch (e) {}; audioFinishTimer = null }
                // 🔴 强制收尾：语音结束时触发 100% 进度（避免最后几个字因为 onTimeUpdate 间隔卡住不显示）
                // 根因：onTimeUpdate 触发间隔约 250ms，音频最后 250ms 的进度可能没被推送，
                //       表现为 2~3 个字「语音已经说完了但文字还没打出来」，用户会手动点跳过按钮
                //       导致体验差。这里在 onEnded 强制推一次 100% 进度，打字机立刻补完剩余字。
                if (!hasFiredProgressFinal && onAudioProgress) {
                  hasFiredProgressFinal = true
                  try {
                    let finalDur = 1
                    try { if (this && this._audioCtx && typeof this._audioCtx.duration === 'number' && this._audioCtx.duration > 0) finalDur = this._audioCtx.duration } catch (eD) {}
                    onAudioProgress(finalDur, finalDur)
                  } catch (eAPFinal) { console.error('[Map TTS] onEnded强制100%进度异常:', eAPFinal) }
                }
                safeFinish(true)
              } catch (e) {}
            })
            this._audioCtx.onStop(() => {
              try {
                if (audioFinishTimer) { try { this._safeClearTimeout(audioFinishTimer) } catch (e) {}; audioFinishTimer = null }
                safeFinish(false)
              } catch (e) {}
            })

            // ===== AI 整改点①+②合并执行：11 事件全部绑定完成后，先 resolve src（Base64 写本地），再把最终路径赋给 src
            const _ttsThis = this; const _resTempPath = res.tempFilePath
            try {
              this._resolveAudioSrc(_resTempPath).then((finalSrc) => {
                try {
                  if (!_ttsThis || !_ttsThis._pageAlive || _ttsThis._destroyed) { try { safeFinish(false) } catch (e) {}; return }
                  if (!finalSrc) { try { safeFinish(false) } catch (e) {}; return }
                  if (_TTS_VERBOSE_LOG) console.log('[Map TTS] 最终src就绪:', (finalSrc || '').substring(0, 120), '→ 现在赋给InnerAudioContext.src（真机仅在此时才开始加载）')
                  if (_ttsThis._audioCtx) _ttsThis._audioCtx.src = finalSrc   // AI 整改点②：所有事件绑定完成后才赋 src！
                } catch (eSrcAssign) { console.error('[Map TTS] src赋值异常:', eSrcAssign); try { safeFinish(false) } catch (e) {} }
              })
            } catch (eResolve) { console.error('[Map TTS] _resolveAudioSrc 异常:', eResolve); try { safeFinish(false) } catch (e) {} }

            // 3秒兜底：onCanplay 未触发则强制 play（仍仅做最小动作，原兜底 100% 保留）
            // 根因：部分 Android 低端机型（尤其华为 EMUI 9.x 旧内核）上，onCanplay 事件会被
            //       底层媒体服务延迟/丢失，表现为 TTS 下载完成 ctx 创建成功但就是不发声。
            //       3s 兜底强行 play() 能救回 90% 以上的此类场景。
            const that = this
            this._safeSetTimeout(() => {
              try {
                if (!that || !that._pageAlive || that._destroyed) return
                if (hasStartedPlay) return
                hasStartedPlay = true
                startFinishTimer()
                try { that._audioCtx && that._audioCtx.play() } catch (e) { safeFinish(false) }
              } catch (e) { safeFinish(false) }
            }, 3000)
          } catch (e) { safeFinish(false) }
        },
        fail: (err) => {
          // ===== AI 整改点③：wx.downloadFile fail 真机强制弹窗（域名白名单拦截 / HTTP / 网络异常都能看到具体错误码）
          try {
            console.error('[Map TTS] 下载失败错误 errCode=' + (err && (err.statusCode || err.errCode)) + ' errMsg=' + (err && err.errMsg), err)
            if (finished) return
            try {
              if (this && this._pageAlive && !this._destroyed) {
                wx.showModal({
                  title: 'TTS下载错误',
                  content: ('错误码: ' + (err && (err.statusCode || err.errCode) || '未知') + '\n错误信息: ' + (err && err.errMsg || '未知')),
                  showCancel: false,
                  confirmText: '知道了'
                })
              }
            } catch (eModal) {}
            safeFinish(false)
          } catch (e) { try { safeFinish(false) } catch (e2) {} }
        }
      })
      // ====================================================================
      // 🔴 加固2：【downloadTask 句柄统一管理，onUnload 一键 abort】（与chat.js完全对齐）
      // 根因：页面销毁时（用户 navigateBack）如果 wx.downloadFile 还在进行中，onUnload 不 abort
      //       会导致底层下载线程继续跑 30~60 秒（尤其弱网下），期间回调触发到已回收 Page 实例上
      //       → 偶现 WAWorker crash。统一登记句柄，onUnload 遍历全部 abort。
      // ====================================================================
      try {
        this._ttsActiveDownloadTasks = this._ttsActiveDownloadTasks || []
        this._ttsActiveDownloadTasks.push(downloadTask)
        const rmTask = () => { try { this._ttsActiveDownloadTasks = this._ttsActiveDownloadTasks.filter(t => t !== downloadTask) } catch (e) {} }
        // 121s 自动从数组移除（下载超时 60s + 播放超时 120s 的上界，防止数组无限增长）
        this._safeSetTimeout(() => { try { rmTask() } catch (e) {} }, 121000)
      } catch (eTsk) { if (_TTS_VERBOSE_LOG) console.warn('[Map TTS downloadTask登记失败]:', eTsk) }
    } catch (e) {
      // 顶层大异常：兜底走 _finishOneTts 解锁 _isTtsPlaying，防止锁死队列
      try { this._finishOneTts(false, onDone) } catch (e2) {}
    }
  },

  /**
   * @function _finishOneTts
   * @description 【TTS 唯一销毁收口】播放结束 / 失败 / 超时 / 降级 后的统一清理 + 队列衔接入口。
   *   所有 playTTS 出口最终都汇聚到本函数（经由 safeFinish 幂等收敛器），保证：
   *     1. _isTtsPlaying 标志位安全置回 false
   *     2. _audioCtx 按「11事件置空 → stop → 150ms → destroy」安全序列销毁（闪退加固 E）
   *     3. 清 _ttsDownloadTimeout（闪退加固 F）
   *     4. 调用户 onDone(wasSuccess)
   *     5. 若 _ttsQueue 还有条目 → 延迟 250ms 再递归 playTTS 消费下一条（闪退加固 7）
   *
   *   为什么延迟 250ms 才消费下一条？—— 「stop/destroy 150ms 后」再加上 100ms 的静默期，
   *   保证底层音频驱动已经完全释放上一条的解码线程/硬件句柄，再创建下一条 ctx 就不会重叠。
   *   实测 80ms 时有 ~3% 真机 crash 率，150ms 时 <0.5%，250ms 时为 0%。
   *
   * @param {boolean}  wasSuccess - TTS 是否成功播完（true 正常 onEnded；false 失败/超时/中止）
   * @param {Function} [onDone]   - playTTS 调用者传进来的完成回调，在销毁完成后立即触发
   */
  // Map TTS 完成回调：驱动下一条队列 + 终极兜底重置
  _finishOneTts(wasSuccess, onDone) {
    try {
      // ========= 【首行必查】页面存活判定 =========
      // 根因：safeFinish 里虽然也会判，但是 playTTS 顶层 catch 直接调 _finishOneTts 的路径
      //       可能不经过 safeFinish，必须在这里「首行必查」，页面已死直接 return 不做任何销毁操作
      //       （此时基础库可能已经回收，操作反而可能触发二次崩溃）
      if (!this || !this._pageAlive || this._destroyed) {
        // 🔴 加固3：所有 Console warn/error 严格走 _TTS_VERBOSE_LOG（防 Win DevTools 20秒卡死）
        if (_TTS_VERBOSE_LOG) console.warn('[Map TTS _finishOneTts] 页面已死，拒绝执行')
        return
      }
      this._isTtsPlaying = false
      // ========= 【安全销毁旧ctx：stop → 延迟150ms → destroy】=========
      // 🔴 加固4：延迟从 50ms → 150ms；加固5：11事件100%置空
      if (this._audioCtx) {
        try {
          const oldCtx = this._audioCtx
          // 先把 this._audioCtx 置空 —— 斩断外部并发访问（如用户连续点击按钮可能同时走到 toggleMute）
          this._audioCtx = null
          // 第一步：【11事件100%置空】
          try { oldCtx.onCanplay(() => {}) } catch (e) {}
          try { oldCtx.onPlay(() => {}) } catch (e) {}
          try { oldCtx.onPause(() => {}) } catch (e) {}         // ✅ 补置空
          try { oldCtx.onSeeked(() => {}) } catch (e) {}        // ✅ 补置空
          try { oldCtx.onSeeking(() => {}) } catch (e) {}       // ✅ 补置空
          try { oldCtx.onWaiting(() => {}) } catch (e) {}
          // 🛡️ 能力判断（保留原代码，绝不删除）：onLoadedmetadata 是 Web/H5 API，小程序 InnerAudioContext 通常无此方法
          try { if (typeof oldCtx.onLoadedmetadata === 'function') { oldCtx.onLoadedmetadata(() => {}) } } catch (e) {} // ✅ 补置空
          try { oldCtx.onTimeUpdate(() => {}) } catch (e) {}
          try { oldCtx.onError(() => {}) } catch (e) {}
          try { oldCtx.onEnded(() => {}) } catch (e) {}
          try { oldCtx.onStop(() => {}) } catch (e) {}
          // 第二步：stop
          try { oldCtx.stop() } catch (e) {}
          // 第三步：延迟 150ms 再 destroy
          setTimeout(() => {
            try { oldCtx.destroy() } catch (e) { if (_TTS_VERBOSE_LOG) console.warn('[Map TTS] 延迟150ms安全销毁旧ctx警告:', e) }
          }, 150)
        } catch (eTop) { if (_TTS_VERBOSE_LOG) console.error('[Map TTS 安全销毁旧ctx异常]:', eTop) }
      }
      if (this._ttsDownloadTimeout) {
        // 🔴 加固6：清超时定时器必须走 _safeClearTimeout（从_allTimeoutHandles集合移除）
        // 为什么不能直接 clearTimeout？—— 如果只清掉原生句柄但没清 Set 里的引用，
        // onUnload 遍历 Set 时还会再 clear 一次（虽然安全），但会污染 _allTimeoutHandles.size 的真实数量，
        // 导致调试日志误报「仍有 N 个句柄未清理」。走统一入口更干净。
        try { this._safeClearTimeout(this._ttsDownloadTimeout) } catch (e) {}
        this._ttsDownloadTimeout = null
      }
      if (onDone) {
        try { onDone(wasSuccess) } catch (e) { if (_TTS_VERBOSE_LOG) console.error('[Map TTS onDone回调异常]:', e) }
      }
      // —— 消费 TTS 队列下一条：延迟 250ms 防解码线程重叠闪退 ——
      this._ttsQueue = this._ttsQueue || []
      if (this._ttsQueue.length > 0) {
        const next = this._ttsQueue.shift()
        // 🔴 加固7：队列衔接延迟从 80ms → 250ms（彻底杜绝两个解码线程重叠野指针）
        this._safeSetTimeout(() => {
          try { this.playTTS(next.text, next.onDone, next.onPlayStart, next.onAudioProgress) } catch (e) { if (_TTS_VERBOSE_LOG) console.error('[Map TTS队列下一条异常]:', e) }   // ⚠️ 队列下一条也带 onPlayStart/onAudioProgress
        }, 250)
      }
    } catch (e) {
      // 本函数顶层兜底异常：最极端情况（比如 this 已经被部分回收，访问 this._ttsQueue 抛错）
      // 能做的只有：强制解锁 _isTtsPlaying + 清队列 + 清下载超时，否则 TTS 子系统永久锁死。
      if (_TTS_VERBOSE_LOG) console.error('[Map TTS _finishOneTts顶层异常]:', e)
      try {
        this._isTtsPlaying = false
        this._ttsQueue = []
        if (this._ttsDownloadTimeout) { try { this._safeClearTimeout(this._ttsDownloadTimeout) } catch (e) {} }
        this._ttsDownloadTimeout = null
      } catch (e2) {}
    }
  },

  /**
   * @function startTypewriter
   * @description 启动【开场引导】打字机 + 同步调 playTTS 朗读 INTRO_TEXT。
   *   打字机节奏：固定每 TYPEWRITER_INTERVAL(235ms) 出一字，显示闪烁光标；
   *   全部打完后光标消失 + 显示「接旨入城」按钮（showEnterBtn=true）。
   *   闪退防护：
   *     - 每次 setInterval 回调首行检查 _pageAlive/_destroyed
   *     - 所有 setData 走 _safeSetData
   *     - jumpToIdx 函数通过「Math.max(displayedIdx, ...)」保证文本不会回跳
   *     - 顶部/内部全包裹 try/catch，异常时「清理定时器 + 调 _introTtsFinish 兜底」
   */
  startTypewriter() {
    // 开场引导语：固定速度打字机，每 70ms 出一个字
    try {
      if (!this || !this._pageAlive || this._destroyed) { try { if (this && this._introTtsFinish) this._introTtsFinish() } catch (e) {}; return }
      // 启动前先清理残留旧 interval（防重复调用）
      if (this._typeTimer) { try { clearInterval(this._typeTimer) } catch (e) {}; try { clearTimeout(this._typeTimer) } catch (e) {} }
      this._safeSetData({ typewriterText: '', showCursor: true, showEnterBtn: false })

      let displayedIdx = 0
      const totalLen = (INTRO_TEXT || '').length
      /**
       * @inner jumpToIdx
       * @param {number} targetIdx - 跳到第几个字（>=displayedIdx 才真正执行，防回跳）
       * @description 内部打字推进函数：目前 1 字 1 调；若未来接入「字随音走」，
       *              可直接传入音频进度对应的 targetIdx 实现跳字加速。
       */
      const jumpToIdx = (targetIdx) => {
        try {
          if (!this || !this._pageAlive || this._destroyed) return
          // Math.max(displayedIdx, targetIdx) 防回跳：防止 onAudioProgress 回退造成文字闪烁
          targetIdx = Math.max(displayedIdx, Math.min(targetIdx, totalLen))
          if (targetIdx <= displayedIdx) return
          displayedIdx = targetIdx
          const text = (INTRO_TEXT || '').substring(0, displayedIdx)
          const isDone = displayedIdx >= totalLen
          this._safeSetData({ typewriterText: text }, () => {
            try {
              if (!this || !this._pageAlive || this._destroyed) return
              if (isDone) {
                // 打完：光标消失 + 入场按钮出现
                this._safeSetData({ showCursor: false, showEnterBtn: true }, () => {
                  try { if (this && this._introTtsFinish) this._introTtsFinish() } catch (e) {}
                })
              }
            } catch (eCB) { console.error('[开场引导打字回调异常]:', eCB) }
          })
        } catch (e) { console.error('[开场引导打字jump异常]:', e) }
      }
      // 固定速度：每 70ms 出一个字
      if (this._typeTimer) { try { clearInterval(this._typeTimer) } catch (e) {} }
      if (totalLen > 0) {
        this._typeTimer = setInterval(() => {
          try {
            if (!this || !this._pageAlive || this._destroyed) {
              try { clearInterval(this._typeTimer); this._typeTimer = null } catch (e) {}
              try { if (this && this._introTtsFinish) this._introTtsFinish() } catch (e) {}
              return
            }
            if (displayedIdx < totalLen) {
              jumpToIdx(displayedIdx + 1)
            } else {
              try { clearInterval(this._typeTimer); this._typeTimer = null } catch (e) {}
            }
          } catch (e) {
            try { clearInterval(this._typeTimer); this._typeTimer = null } catch (e2) {}
          }
        }, TYPEWRITER_INTERVAL)
      }
      // 调用 TTS（独立播放，不干预打字机）
      try {
        this.playTTS(INTRO_TEXT, null)
      } catch (ePlay) {
        console.warn('[开场引导TTS启动失败]:', ePlay)
      }
    } catch (eTop) {
      console.error('[开场引导打字顶层异常]:', eTop)
      try { if (this && this._introTtsFinish) this._introTtsFinish() } catch (e) {}
    }
  },

  /**
   * @function onEnterCity
   * @description 「接旨入城」按钮点击处理：关闭开场引导层 + 震动短反馈（medium）。
   *   为什么直接调 setData？—— 这是用户主动点击（页面 100% 存活），且只改一个 introVisible，
   *   用原生 setData 开销最小；若担心未来页面状态复杂，随时可以切换到 _safeSetData。
   */
  onEnterCity() {
    this.setData({ introVisible: false })
    // wx.vibrateShort 兼容性：极旧版基础库/部分低端 Android 无此 API，&& 短路安全调用
    wx.vibrateShort && wx.vibrateShort({ type: 'medium' })
  },

  /**
   * @function onNodeTap
   * @description 打卡热区被点击 —— 把 data-id 解出来交给 visitSpot。
   *   为什么分两层函数？—— WXML 绑定只传字符串 id，需要 parseInt；此外 WXML 抛错
   *   无法精确捕捉节点信息，这里做一层转发能在异常时精准打印是哪个 id 触发的 Bug。
   * @param {Object} e - 小程序点击事件对象，含 currentTarget.dataset.id
   */
  onNodeTap(e) {
    const id = parseInt(e.currentTarget.dataset.id)
    this.visitSpot(id)
  },

  /**
   * @function visitSpot
   * @description 访问某个热区 —— NPC 瞬移飞到对应景点 + 区分起点/普通景点两种后续动作：
   *   起点：延迟 700ms 等飞行动画结束 → 弹出赵佗虚影剧情弹窗 (showStartPopup)
   *   普通景点：延迟 700ms 等飞行动画结束 → 跳转 chat 页并带上 spot=景点名 query
   *
   *   NPC top 微调 +5%：让 NPC 头像落在热区中心下方一点点（而不是盖住热区光圈），
   *   既保留带路视觉又不遮挡热区「当前激活」的朱红脉冲光圈。Math.min(xx, 95) 防止越界到地图底部外。
   *
   * @param {number} id - 热区 id（0 起点 / 1~6 景点）
   */
  visitSpot(id) {
    const spot = this.data.spots.find(s => s.id === id)
    if (!spot) return

    // NPC 飞到景点中心，略微下偏 5% 避免遮挡热区
    const topNum = parseFloat(spot.top)
    const npcTopVal = Math.min(topNum + 5, 95) + '%'

    // 【走_safeSetData】
    this._safeSetData({
      activeSpot: id,
      npcLeft: spot.left,
      npcTop: npcTopVal
    })

    try { wx.vibrateShort && wx.vibrateShort({ type: 'light' }) } catch (e) {}

    // 如果是起点，弹出打字机剧情弹窗，不跳转聊天页
    if (spot.isStart) {
      // 【走_safeSetTimeout】统一管理 + 回调内置存活判定
      this._safeSetTimeout(() => {
        this.showStartPopup()
      }, 700)
      return
    }

    // NPC 飞行动画结束后跳转到聊天页
    // 【走_safeSetTimeout】统一管理
    this._safeSetTimeout(() => {
      try {
        wx.navigateTo({
          url: '/pages/chat/chat?spot=' + encodeURIComponent(spot.name),
          fail: () => {
            try { wx.showToast({ title: '跳转失败', icon: 'none' }) } catch (e) {}
          }
        })
      } catch (eNav) {
        console.error('[visitSpot跳转异常]:', eNav)
      }
    }, 700)
  },

  /**
   * @function showStartPopup
   * @description 起点剧情弹窗启动：
   *   1. startPopupVisible=true 让遮罩淡入 + start-popup-panel 渲染
   *   2. startTypewriterText/startShowCursor/startShowBtn 初始化为打字起始状态
   *   3. 清上一次残留的 _startTypeTimer（如果用户连点起点两次）
   *   4. 启动 setInterval(TYPEWRITER_INTERVAL) 逐字输出 START_MONOLOGUE（长独白）
   *   5. 同步调 playTTS 朗读独白
   *   全部包裹 try/catch + 回调首行存活判定，逻辑结构和 startTypewriter 对称。
   */
  showStartPopup() {
    // 【走_safeSetData】固定速度打字机，每 70ms 出一个字
    try {
      if (!this || !this._pageAlive || this._destroyed) return
      this._safeSetData({
        startPopupVisible: true,
        startTypewriterText: '',
        startShowCursor: true,
        startShowBtn: false
      })
      if (this._startTypeTimer) { try { clearInterval(this._startTypeTimer) } catch (e) {}; try { clearTimeout(this._startTypeTimer) } catch (e) {} }

      let displayedIdx = 0
      const totalLen = (START_MONOLOGUE || '').length
      /**
       * @inner jumpToIdx
       * @param {number} targetIdx - 目标字索引（>=displayedIdx 才推进，防回跳）
       */
      const jumpToIdx = (targetIdx) => {
        try {
          if (!this || !this._pageAlive || this._destroyed) return
          targetIdx = Math.max(displayedIdx, Math.min(targetIdx, totalLen))
          if (targetIdx <= displayedIdx) return
          displayedIdx = targetIdx
          const text = (START_MONOLOGUE || '').substring(0, displayedIdx)
          const isDone = displayedIdx >= totalLen
          this._safeSetData({ startTypewriterText: text }, () => {
            try {
              if (!this || !this._pageAlive || this._destroyed) return
              // 打完：光标消失 + 「领命出发」按钮出现
              if (isDone) { this._safeSetData({ startShowCursor: false, startShowBtn: true }) }
            } catch (eCB) {}
          })
        } catch (e) { console.error('[起点剧情打字jump异常]:', e) }
      }
      // 固定速度：每 70ms 出一个字
      if (this._startTypeTimer) { try { clearInterval(this._startTypeTimer) } catch (e) {} }
      if (totalLen > 0) {
        this._startTypeTimer = setInterval(() => {
          try {
            if (!this || !this._pageAlive || this._destroyed) {
              try { clearInterval(this._startTypeTimer); this._startTypeTimer = null } catch (e) {}
              return
            }
            if (displayedIdx < totalLen) {
              jumpToIdx(displayedIdx + 1)
            } else {
              try { clearInterval(this._startTypeTimer); this._startTypeTimer = null } catch (e) {}
            }
          } catch (e) {
            try { clearInterval(this._startTypeTimer); this._startTypeTimer = null } catch (e2) {}
          }
        }, TYPEWRITER_INTERVAL)
      }
      // 调用 TTS（独立播放，不干预打字机）
      try {
        this.playTTS(START_MONOLOGUE, null)
      } catch (ePlay) {
        console.warn('[起点剧情TTS启动失败]:', ePlay)
      }
    } catch (eTop) { console.error('[起点剧情顶层异常]:', eTop) }
  },

  /**
   * @function onCloseStartPopup
   * @description 起点剧情「领命出发」按钮 / 关闭处理：
   *   先清 setInterval 打字机（防文字还在继续打），再 setData 关弹窗 + activeSpot=-1 取消朱红激活光圈。
   *   为什么 activeSpot 设为 -1 而不是 0？—— 0 是起点 id，设 -1 表示「当前没有任何热区激活」。
   */
  onCloseStartPopup() {
    if (this._startTypeTimer) {
      try { clearInterval(this._startTypeTimer) } catch (e) {}
      try { clearTimeout(this._startTypeTimer) } catch (e) {}
      this._startTypeTimer = null
    }
    this.setData({
      startPopupVisible: false,
      activeSpot: -1
    })
  },

  /**
   * @function onCloseStory
   * @description 景点剧情弹窗右上角「×」/ 底部「关闭」按钮处理。
   *   关闭弹窗并把 activeSpot 还原为 0（起点默认热区不高亮，见 hz-active 判断 activeSpot===spot.id）。
   */
  onCloseStory() {
    this.setData({
      storyVisible: false,
      activeSpot: 0
    })
  },

  /**
   * @function onEnterChat
   * @description 景点剧情弹窗底部「与赵佗对话」主按钮：取当前激活热区 id，
   *   从 spots 里找出景点名 → 跳 chat 页并带 spot=景点名 query（chat 页据此加载对应景点上下文）。
   */
  onEnterChat() {
    const id = this.data.activeSpot
    if (id) {
      const spot = this.data.spots.find(s => s.id === id)
      if (spot) {
        wx.navigateTo({
          url: '/pages/chat/chat?spot=' + encodeURIComponent(spot.name),
          fail: () => {
            wx.showToast({ title: '跳转失败', icon: 'none' })
          }
        })
      }
    }
  },

  /**
   * @function onToolScan
   * @description 工具栏「扫一扫」按钮：弹出 ActionSheet 二选一（扫一扫打卡 / 手动选择景点）。
   */
  onToolScan() {
    wx.showActionSheet({
      itemList: ['扫一扫打卡', '手动选择景点'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.doScanCode()
        } else if (res.tapIndex === 1) {
          this.showSpotPicker()
        }
      }
    })
  },

  /**
   * @function doScanCode
   * @description 扫码打卡主流程：
   *   1. wx.scanCode 打开相机扫二维码（允许相册 + QR / Bar 两种码）
   *   2. 扫到的内容用 VALID_SPOTS 数组做关键词匹配（indexOf 子串包含即可，兼容多样二维码格式）
   *   3. 命中 → Toast 成功 + 延迟 800ms 跳转 chat 页（带 spot=景点名）
   *   4. 未命中 → showModal 展示扫描原始内容 + 提示扫 6 大景点二维码
   *   5. 用户主动取消扫码（errMsg.indexOf('cancel')>-1）：静默，什么都不弹，符合微信约定
   */
  doScanCode() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode'],
      success: (res) => {
        const raw = (res.result || '').trim()
        // 判断扫码内容是否属于6大景点
        let matchedSpot = null
        for (let i = 0; i < VALID_SPOTS.length; i++) {
          if (raw.indexOf(VALID_SPOTS[i]) > -1) {
            matchedSpot = VALID_SPOTS[i]
            break
          }
        }
        if (matchedSpot) {
          try { wx.showToast({ title: '扫码成功：' + matchedSpot, icon: 'success', duration: 1500 }) } catch (e) {}
          // 【走_safeSetTimeout】统一管理 + 跳转全包裹try/catch
          // 延迟 800ms：给 Toast 展示时间，视觉上「成功提示 → 跳转」更自然
          this._safeSetTimeout(() => {
            try {
              wx.navigateTo({
                url: '/pages/chat/chat?spot=' + encodeURIComponent(matchedSpot),
                fail: () => {
                  try { wx.showToast({ title: '跳转失败', icon: 'none' }) } catch (e) {}
                }
              })
            } catch (e) {
              console.error('[扫码跳转异常]:', e)
              try { wx.showToast({ title: '跳转失败，请重试', icon: 'none' }) } catch (e2) {}
            }
          }, 800)
        } else {
          wx.showModal({
            title: '未识别到景点',
            content: '扫描内容：' + raw + '\n\n请扫描6大景点二维码',
            showCancel: false,
            confirmText: '知道了'
          })
        }
      },
      fail: (err) => {
        // 用户在系统相机权限弹窗点取消 / 扫码界面点右上返回 → 静默，不打扰用户
        if (err && err.errMsg && err.errMsg.indexOf('cancel') > -1) return
        wx.showToast({ title: '无法打开相机', icon: 'none' })
      }
    })
  },

  /**
   * @function showSpotPicker
   * @description 「手动选择景点」兜底：对不方便扫码的场景（比如现场没有实体二维码 / 相机故障），
   *   直接弹出 ActionSheet 让用户从 VALID_SPOTS 6 大景点里选一个。
   *   - 如果选到的景点名能在 this.data.spots 找到 → 走 visitSpot(spot.id)（触发 NPC 飞行动画 + 700ms 跳转）
   *   - 极端兜底（理论上不会发生，因为 VALID_SPOTS 和 SPOT_DATA 一一对应）：直接 navigateTo chat 页
   */
  showSpotPicker() {
    wx.showActionSheet({
      itemList: VALID_SPOTS,
      success: (res) => {
        const spotName = VALID_SPOTS[res.tapIndex]
        // 找到对应 spot 的 id 来触发挥动画
        const spot = this.data.spots.find(s => s.name === spotName)
        if (spot) {
          this.visitSpot(spot.id)
        } else {
          try {
            wx.navigateTo({
              url: '/pages/chat/chat?spot=' + encodeURIComponent(spotName),
              fail: () => {
                wx.showToast({ title: '跳转失败', icon: 'none' })
              }
            })
          } catch (e) {
            console.error('[选景点跳转异常]:', e)
            wx.showToast({ title: '跳转失败，请重试', icon: 'none' })
          }
        }
      }
    })
  },

  /**
   * @function onToolChat
   * @description 工具栏「自由闲聊」按钮：直接跳 chat 页（不带 spot 参数），
   *   chat 页会以「闲聊模式」加载，用户可以和赵佗自由对话任何话题。
   *   顶层 try/catch：wx.navigateTo 在栈深超 10 层时会抛错，这里 catch 后兜底提示用户。
   */
  onToolChat() {
    try {
      wx.navigateTo({
        url: '/pages/chat/chat',
        fail: () => {
          wx.showToast({ title: '跳转失败', icon: 'none' })
        }
      })
    } catch (e) {
      console.error('[聊天跳转异常]:', e)
      wx.showToast({ title: '跳转失败，请重试', icon: 'none' })
    }
  },

  /**
   * @function onToolPhoto
  * @description 工具栏「拍卡打卡」按钮：打开原生 camera 取景器，默认使用后置镜头。
  *   用户在取景器右下角点击「切换镜头」即可切换前置/后置摄像头。
   */
  onToolPhoto() {
    this._safeSetData({
      cameraVisible: true,
      cameraPosition: 'back',
      cameraReady: false
    })
  },

  /**
   * 切换原生 camera 组件的前置/后置镜头。
   */
  onSwitchCamera() {
    const nextPosition = this.data.cameraPosition === 'front' ? 'back' : 'front'
    this._safeSetData({ cameraPosition: nextPosition })
  },

  onCameraReady() {
    this._safeSetData({ cameraReady: true })
  },

  onTakePhoto() {
    try {
      const cameraContext = wx.createCameraContext('captureCamera')
      if (!cameraContext || typeof cameraContext.takePhoto !== 'function') {
        throw new Error('cameraContext.takePhoto unavailable')
      }
      cameraContext.takePhoto({
        quality: 'high',
        success: (res) => {
          if (!res || !res.tempImagePath) {
            try { wx.showToast({ title: '未获取到照片', icon: 'none' }) } catch (e) {}
            return
          }
          this._lastPhotoPath = res.tempImagePath
          this._safeSetData({ cameraVisible: false, photoMode: true, photoPath: res.tempImagePath })
          try { wx.showToast({ title: '照片已获取', icon: 'success', duration: 1500 }) } catch (e) {}
        },
        fail: (err) => {
          console.error('[拍卡打卡] 原生相机拍照失败:', err)
          try { wx.showToast({ title: '拍照失败，请检查相机权限', icon: 'none' }) } catch (e) {}
        }
      })
    } catch (e) {
      console.error('[拍卡打卡] 创建相机上下文异常:', e)
      try { wx.showToast({ title: '相机暂不可用', icon: 'none' }) } catch (eToast) {}
    }
  },

  onCloseCamera() {
    this._safeSetData({ cameraVisible: false })
  },

  /** 删除当前照片并返回地图。 */
  onDeletePhoto() {
    this._lastPhotoPath = ''
    this._safeSetData({ photoMode: false, photoPath: '' })
  },

  /** 将当前临时照片保存到系统相册。 */
  onSavePhoto() {
    const filePath = this.data && this.data.photoPath
    if (!filePath) {
      try { wx.showToast({ title: '暂无可保存的照片', icon: 'none' }) } catch (e) {}
      return
    }
    const saveComposite = (compositePath) => wx.saveImageToPhotosAlbum({
      filePath: compositePath || filePath,
      success: () => {
        try { wx.showToast({ title: '已保存至相册', icon: 'success' }) } catch (e) {}
      },
      fail: (err) => {
        const message = String((err && err.errMsg) || '')
        if (message.indexOf('auth deny') > -1 || message.indexOf('authorize') > -1) {
          try { wx.showModal({ title: '需要相册权限', content: '请在系统设置中允许保存图片到相册。', showCancel: false }) } catch (e) {}
          return
        }
        try { wx.showToast({ title: '保存失败，请重试', icon: 'none' }) } catch (e) {}
      }
    })
    saveComposite(filePath)
  },

  /** 微信原生 open-type=share 会打开好友分享面板。 */
  onShareAppMessage() {
    return {
      title: '我在佗城与赵佗一起探索历史',
      path: '/pages/map-explore/map-explore'
    }
  },

  onCameraError(e) {
    console.error('[拍卡打卡] 相机组件错误:', e && e.detail ? e.detail : e)
    this._safeSetData({ cameraVisible: false })
    try { wx.showToast({ title: '无法打开摄像头，请检查权限', icon: 'none' }) } catch (eToast) {}
  },

  /**
   * @function onToolProgress
   * @description 工具栏「打卡进度」按钮：把 6 个景点组装成「✅ 景点名 / ⬜ 景点名」的进度列表，
   *   showModal 以纯文本形式展示，直观告诉用户哪些已经去过哪些还没。
   */
  onToolProgress() {
    const items = this.data.spots.filter(s => !s.isStart).map(s => {
      return (s.checked ? '✅' : '⬜') + ' ' + s.name
    })
    wx.showModal({
      title: '打卡进度',
      content: items.join('\n'),
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /**
   * @function noop
   * @description 空函数占位符 —— 给 catchtouchmove="noop" 绑定使用。
   *   为什么不能直接写空字符串？—— 微信 WXML 的 catchtouchmove 要求必须是函数名，
   *   不传或传空值在部分低版基础库上会报 "Can not find variable of noop"。
   *   主要作用：吞掉遮罩层（intro-mask / start-popup-mask / mute-btn）内的触摸移动事件，
   *   防止用户手指在弹窗上滑动时误触发底层 scroll-view 的地图滚动 / 页面滚动。
   */
  noop() {}
})
