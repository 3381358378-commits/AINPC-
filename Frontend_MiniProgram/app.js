/**
 * ============================================================================
 *  赵佗历史文化之旅 · 微信小程序
 *  全局应用入口 (App Entry Point)
 * ============================================================================
 *
 * 【项目简介】
 *  本小程序以"南越王赵佗"为主角，通过 AI 对话 + 地图探索的形式，
 *  带领用户穿越千年历史，沉浸式游览广东佗城六大历史景点（百岁街、
 *  越王庙、越王井、龙川考棚、苏堤、正相塔），融合科举答题、
 *  谒王访贤、语音播报（TTS）等互动玩法。
 *
 * 【技术栈】
 *  - 前端框架：微信原生小程序 (WeChat Mini Program)
 *  - AI 大模型：阿里云 · 通义千问 (qwen-plus)
 *  - 语音合成：阿里云 CosyVoice TTS (cosyvoice-v3-flash)
 *  - 数据存储：纯内存 SafeStorage（规避微信基础库 3.17.0 灰度版兼容性问题）
 *
 * 【文件职责】
 *  本文件是小程序全局入口，负责：
 *  1. 应用生命周期管理 (onLaunch / onError / onUnhandledRejection)
 *  2. 提供跨页面共享的 SafeStorage 内存存储 API
 *  3. 全局异常兜底与自动化测试的崩溃钩子
 *  4. 注册调试日志转发回调（供 chat 页错误面板展示）
 * ============================================================================
 *
 * @开源说明  本文件及整个项目后续将开源，所有注释均采用 JSDoc + 中文说明，
 *           便于二次开发者快速理解架构设计与历史兼容处理逻辑。
 */

App({

  /**
   * 小程序启动时触发的生命周期钩子
   * 🔴 关键：顶层 try/catch 包裹，任何启动阶段异常绝不向上抛出
   *     否则微信系统会直接跳回欢迎页，体验极差。
   */
  onLaunch() {
    try {
      // ------------------------------------------------------------------
      // 1. 关闭真机调试模式下的 vConsole 绿浮窗（若已开启）
      //    - 注意：如果是强制真机调试扫码进入，浮窗仍会显示，需用户手动关闭
      // ------------------------------------------------------------------
      try {
        if (typeof wx.setEnableDebug === 'function') {
          wx.setEnableDebug({ enableDebug: false })
        }
      } catch (eVC) { /* 静默吞掉：此 API 非所有基础库都有 */ }

      // ------------------------------------------------------------------
      // 2. SafeStorage 初始化：完全替代 wx.Storage API 的纯内存实现
      // ------------------------------------------------------------------
      // [根因] 微信基础库 3.17.0 灰度版本的 wx.Storage 内部会调用
      //        WAWorker.reportRealtimeAction，抛出 "not support" 原生异常
      //        → 该异常发生在 Worker 底层，不进入 JS onError，直接 kill 小程序进程
      //        → 表现为：无任何提示闪退到微信聊天列表
      // [方案] 100% 弃用 wx.Storage，统一用 globalData._memoryStorage 内存对象
      //        代价：小程序冷启动后数据丢失（打卡/日志等非核心功能不影响体验）
      // ------------------------------------------------------------------
      if (!this.globalData._memoryStorage) {
        this.globalData._memoryStorage = {}
      }

      // 3. 初始化内存版 logs 日志（兼容微信模板的用法，实际无持久化）
      try {
        const logs = this.safeGetStorageSync('logs') || []
        logs.unshift(Date.now())
        this.safeSetStorageSync('logs', logs)
      } catch (e) {
        console.warn('[App onLaunch SafeStorage警告，已隔离]:', e && e.message || e)
      }
    } catch (eTop) {
      console.error('[App onLaunch 启动顶层异常，已忽略]:', eTop)
    }
  },

  // ============================================================================
  // SafeStorage：纯内存版，永不调用 wx.Storage API
  // ============================================================================
  // 两个方法的设计严格对标 wx.getStorageSync / wx.setStorageSync 的签名，
  // 方便业务代码只需改函数名即可平滑迁移。所有调用均有 try/catch 保护。

  /**
   * 内存版同步读取 Storage（替代 wx.getStorageSync）
   * @param {string} key - 存储键名
   * @returns {*} 存储的值，不存在时返回空字符串 ''
   */
  safeGetStorageSync(key) {
    try {
      if (!this.globalData || !this.globalData._memoryStorage) return ''
      const val = this.globalData._memoryStorage[key]
      return val === undefined ? '' : val
    } catch (e) {
      return ''
    }
  },

  /**
   * 内存版同步写入 Storage（替代 wx.setStorageSync）
   * @param {string} key   - 存储键名
   * @param {*}      value - 要存储的值
   */
  safeSetStorageSync(key, value) {
    try {
      if (!this.globalData._memoryStorage) {
        this.globalData._memoryStorage = {}
      }
      this.globalData._memoryStorage[key] = value
    } catch (e) {
      console.warn('[SafeStorage set警告，已忽略]:', e && e.message || e)
    }
  },

  // ============================================================================
  // 全局错误兜底：【绝对禁止任何路由跳转 / reLaunch！】
  // ============================================================================
  // [核心铁律] onError / onUnhandledRejection 中绝对不能执行
  //   wx.reLaunch / navigateBack / redirectTo！
  // [根因分析] chat 页面运行时会同时存在：
  //   · 打字机 setTimeout 递归链
  //   · TTS InnerAudioContext 的 11 个事件回调
  //   · 各种超时解锁定时器 (checkTransitionAndShow 10秒/15秒 等)
  // 此时若强制 reLaunch 销毁页面 → 上述异步回调仍尝试 setData
  //   → 触发 "__wcc_version_info__ of null" / "recursive update detected"
  //   → 基础库渲染层崩溃 → 微信系统层 kill 小程序 → 闪退！
  // [策略] 小错误让页面静默继续跑（_safeSetData 会拦截），绝不乱跳路由。

  /**
   * 全局 JS 异常捕获
   * @param {Error|string} err - 错误对象或错误字符串
   */
  onError(err) {
    console.error('[Global Error] 捕获全局异常:', err)

    // ------------------------------------------------------------------
    // ① 自动化测试崩溃钩子：把闪退信息抛给 chat 页记录到报告
    // ------------------------------------------------------------------
    try {
      if (this._autoTestCrashHook) {
        const emsg = (err && (err.message || err.stack))
          ? (err.message || err.stack)
          : String(err || '')
        const estk = (err && err.stack)
          ? err.stack
          : (emsg.substring(0, 500))
        try { this._autoTestCrashHook(emsg, estk) } catch (exx) { /* 静默 */ }
      }
    } catch (eAuto) { /* 静默 */ }

    // ------------------------------------------------------------------
    // ② 调试日志转发：把错误抛给 chat 页的错误日志面板（如果页面仍存活）
    // ------------------------------------------------------------------
    // [致命修复] 页面已销毁时，绝不调用 _appDebugLogHandler → _pushDebugLog
    //   → setData → recursive update → 无限递归 → 彻底崩溃
    try {
      if (this._appDebugLogHandler) {
        const errMsg = (err && (err.stack || err.message))
          ? (err.stack || err.message)
          : String(err || '')
        try { this._appDebugLogHandler('全局错误', errMsg) } catch (e) { /* 静默 */ }
      }
    } catch (eHook) { /* 静默 */ }

    // ------------------------------------------------------------------
    // ③ 分级处理：按错误类型决定是否需要用户提示
    // ------------------------------------------------------------------
    try {
      const errStr = String(err || '')

      // 分类 A：WAWorker 内部埋点失败警告 → 完全静默（底层 bug，我们无能为力）
      const isWorkerWarn = (
        errStr.indexOf('reportRealtimeAction') > -1 ||
        errStr.indexOf('WAWorker') > -1 ||
        errStr.indexOf('not support') > -1
      )
      if (isWorkerWarn) {
        console.warn('[Global Error] WAWorker内部警告，静默忽略')
        return
      }

      // 分类 B：页面渲染层已死亡错误 → 静默（此时绝不能触发任何 setData）
      const isPageDead = (
        errStr.indexOf('__wcc_version_info__') > -1 ||
        errStr.indexOf('__subPageFrameEndTime__') > -1 ||
        errStr.indexOf('recursive update') > -1
      )
      if (isPageDead) {
        console.warn('[Global Error] 页面渲染层错误，静默忽略（页面可能已销毁）')
        return
      }

      // 分类 C：其他真实异常 → 轻 Toast 提示用户，绝不跳路由绝不 reLaunch
      try {
        wx.showToast({
          title: '出现小异常，已自动处理',
          icon: 'none',
          duration: 1500
        })
      } catch (e) { /* 静默 */ }
    } catch (eTop) {
      console.error('[Global onError 顶层异常，静默处理]:', eTop)
    }
  },

  /**
   * 全局 Promise 未捕获异常 (Unhandled Promise Rejection)
   * @param {Object} res        - Promise reject 事件对象
   * @param {*}      res.reason - reject 的原因
   */
  onUnhandledRejection(res) {
    console.warn('[Global Promise] 未处理的 Promise reject:', res && res.reason)

    // 同样转发给 chat 页调试日志面板
    try {
      if (this._appDebugLogHandler) {
        const reason = res && res.reason
        const content = (reason && (reason.stack || reason.message))
          ? (reason.stack || reason.message)
          : String(res && res.reason || JSON.stringify(res) || '')
        try { this._appDebugLogHandler('Promise未捕获', content) } catch (e) { /* 静默 */ }
      }
    } catch (eHook) { /* 静默 */ }

    try {
      const reason = String(res && res.reason || '')
      // WAWorker 内部警告 → 静默，其他情况给个轻提示
      const isWorkerWarn = (
        reason.indexOf('reportRealtimeAction') > -1 ||
        reason.indexOf('WAWorker') > -1
      )
      if (!isWorkerWarn) {
        try {
          wx.showToast({
            title: '异步小异常，已忽略',
            icon: 'none',
            duration: 1200
          })
        } catch (e) { /* 静默 */ }
      }
    } catch (e) { /* 静默 */ }
  },

  // ============================================================================
  // 全局共享数据 (Global Data)
  // ============================================================================
  globalData: {
    // [历史遗留字段] 微信官方 demo 模板初始值，未实际使用，保留避免潜在引用报错
    settimeout: ['Robinson'],

    /**
     * SafeStorage 纯内存存储容器
     * 彻底替代 wx.Storage，避免微信基础库 3.17.0 灰度版 WAWorker 原生崩溃
     * @type {Object.<string, *>}
     */
    _memoryStorage: {}
  }
})
