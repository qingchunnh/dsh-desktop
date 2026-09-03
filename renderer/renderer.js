/**
 * 渲染进程脚本:根据主进程返回的状态切换视图并响应按钮操作。
 *
 * 视图清单:data-view = checking / offline / starting / start-error /
 * node-missing / node-outdated / dsh-missing
 * (连接成功后主进程会把整个窗口切换到 http://127.0.0.1:3080,本页即被替换)
 *
 * 视图之外还有一个独立的更新结果面板(data-role="update-panel"),
 * 由 footer 的「检查 dsh 更新」触发,叠加展示在卡片下方,不影响当前视图。
 */
'use strict'

/** Node.js 官网下载地址(未安装 / 版本过低时引导) */
const NODE_DOWNLOAD_URL = 'https://nodejs.org/zh-cn/download'

/** 桌面端源码仓库地址(footer 应用名点击跳转) */
const REPO_URL = 'https://github.com/qingchunnh/dsh-desktop'

const api = window.dshDesktop

// preload 注入失败(如打包路径异常)时无法与主进程通信,
// 显示明确错误而不是永远停在「检测中」
if (!api) {
  const checking = document.querySelector('[data-view="checking"]')
  checking.querySelector('.spinner').hidden = true
  checking.querySelector('h2').textContent = '初始化失败'
    checking.querySelector('.desc').textContent = '与主进程通信失败，请尝试重启应用'
  throw new Error('dshDesktop API 未注入')
}

// ---- 视图切换 ----

const views = document.querySelectorAll('[data-view]')

function show(name) {
  views.forEach(view => {
    view.hidden = view.dataset.view !== name
  })
}

function role(name) {
  return document.querySelector(`[data-role="${name}"]`)
}

/** 在未启动页顶部展示提示条(断连、端口被占用等) */
function showNotice(text) {
  const notice = role('offline-notice')
  notice.textContent = text
  notice.hidden = false
}

/** 隐藏提示条(开始新一轮探测/重试时调用,避免过期信息残留) */
function hideNotice() {
  role('offline-notice').hidden = true
}

/**
 * 根据环境检测结果选择对应的问题视图。
 * 优先级:node 未安装 > node 版本过低 > dsh 未安装。
 */
function showEnvProblem(env) {
  if (!env || !env.node.installed) return show('node-missing')
  if (!env.node.ok) {
    role('node-current').textContent = env.node.version ? `v${env.node.version}` : '未知'
    return show('node-outdated')
  }
  if (!env.dsh.installed) return show('dsh-missing')
  show('offline')
}

/** 最近一次环境检测的 dsh 安装状态(footer「检查 dsh 更新」按钮的禁用依据) */
let dshInstalled = false

/** 更新 footer 的 dsh 版本号,并按安装状态禁用/启用「检查 dsh 更新」按钮;内容就绪后展示 footer */
function renderDshVersion(env) {
  dshInstalled = Boolean(env && env.dsh.installed)
  role('update-btn').disabled = !dshInstalled
  const version = dshInstalled ? env.dsh.version : null
  if (!version) {
    role('dsh-version').textContent = '未安装 dsh'
  } else {
    // 解析失败时 version 是 `dsh -V` 的原始输出,可能自带 v 前缀,避免重复拼接
    role('dsh-version').textContent = `dsh ${version.startsWith('v') ? version : `v${version}`}`
  }
  role('foot').hidden = false
}

/** 处理 bootstrap / recheck-env 的返回结果 */
function handleStatus(result) {
  // IPC 返回空(防御分支):footer 按「未安装 dsh」收场,问题视图交给 showEnvProblem
  if (!result) {
    renderDshVersion(null)
    return showEnvProblem(null)
  }
  if (result.status === 'online') return // 主进程已把窗口切到 Web UI,无需处理
  renderDshVersion(result.env)
  // 3080 有程序监听但不是 dsh,提示用户端口被占用(仅在落到未启动页时才有意义)
  if (result.portOccupied && result.status === 'ready') {
    showNotice('检测到 127.0.0.1:3080 被其他程序占用，而非 dsh。请先释放该端口')
  }
  if (result.status === 'ready') return show('offline')
  showEnvProblem(result.env)
}

// ---- 日志面板 ----

/** 追加日志到面板,只保留最后约 400 行并自动滚到底部 */
function appendLog(el, text) {
  el.hidden = false
  el.textContent += text
  const lines = el.textContent.split('\n')
  if (lines.length > 400) {
    el.textContent = lines.slice(-400).join('\n')
  }
  el.scrollTop = el.scrollHeight
}

// ---- 按钮操作 ----

/** 操作进行中标记,防止重复点击 */
let busy = false

/** 带 busy 守卫的异步操作包装 */
async function guard(fn) {
  if (busy) return
  busy = true
  try {
    await fn()
  } finally {
    busy = false
  }
}

/** 启动 dsh:切到启动中视图,订阅进程日志,等待主进程结果 */
async function handleStart() {
  const logEl = role('start-log')
  logEl.textContent = ''
  logEl.hidden = true
  show('starting')
  const unsubscribe = api.onDshLog(text => appendLog(logEl, text))
  try {
    const result = await api.startDsh()
    if (result.ok) return // 主进程已切到 Web UI
    if (result.cancelled) return show('offline')
    showStartError(result.error || '未知错误', result.log)
  } catch (error) {
    // IPC 层面的异常(主进程 handler 抛错),同样落到启动失败视图
    showStartError(String((error && error.message) || error), '')
  } finally {
    unsubscribe()
  }
}

/** 展示启动失败视图:错误描述 + 可选的日志尾部 */
function showStartError(message, log) {
  role('start-error-text').textContent = message
  const errorLog = role('start-error-log')
  errorLog.textContent = log || ''
  errorLog.hidden = !log
  errorLog.scrollTop = errorLog.scrollHeight
  show('start-error')
}

/** 重试连接:仅探测 3080(用户在终端手动启动 dsh 的场景) */
async function handleRetry() {
  const errorEl = role('retry-error')
  errorEl.hidden = true
  hideNotice() // 旧提示(端口占用/断连)已过期,先清掉
  try {
    const result = await api.retryConnection()
    // 端口被其他程序占用时换成提示条,语义比普通连接失败更强
    if (!result.ok && result.occupied) {
      showNotice('127.0.0.1:3080 被其他程序占用，而非 dsh。请先释放该端口')
      return
    }
    if (!result.ok) errorEl.hidden = false
  } catch {
    errorEl.hidden = false
  }
}

/** 重新检测环境(用户安装/升级完 node 或 dsh 后点击) */
async function handleRecheck() {
  hideNotice() // 同上,清掉过期提示
  show('checking')
  try {
    handleStatus(await api.recheckEnv())
  } catch {
    // IPC 异常时落到未启动页,用户可继续重试;footer 按「未安装 dsh」收场
    renderDshVersion(null)
    show('offline')
  }
}

/** 复制命令行文本(安装/更新命令共用),并在按钮上给出短暂反馈 */
async function handleCopyCommand(button) {
  const row = button.closest('.command')
  const textEl = row && row.querySelector('.command-text')
  if (!textEl) return
  try {
    await navigator.clipboard.writeText(textEl.textContent)
  } catch {
    // 剪贴板不可用时退化为选中文本,方便用户手动复制
    const range = document.createRange()
    range.selectNodeContents(textEl)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return
  }
  const original = button.textContent
  button.textContent = '已复制'
  setTimeout(() => {
    button.textContent = original
  }, 1500)
}

// ---- 检查更新 ----

/** 切换更新面板的三态:checking(转圈)/ message(单行文本)/ available(新版本+更新命令) */
function setUpdateState(state) {
  role('update-checking').hidden = state !== 'checking'
  role('update-message').hidden = state !== 'message'
  role('update-available').hidden = state !== 'available'
}

/**
 * 渲染含版本号的文案:字符串原样拼接,{ version } 渲染为主题蓝色高亮。
 * 版本号来自外部命令输出(可能未过版本正则),一律走 textContent,不拼 HTML。
 */
function renderVersionText(el, parts) {
  el.textContent = ''
  for (const part of parts) {
    if (typeof part === 'string') {
      el.appendChild(document.createTextNode(part))
      continue
    }
    const span = document.createElement('span')
    span.className = 'update-version'
    span.textContent = part.version
    el.appendChild(span)
  }
}

/** 以单行文本收场(检查失败 / 未安装) */
function setUpdateMessage(text) {
  role('update-message').textContent = text
  setUpdateState('message')
}

/** 检查更新:结果渲染在卡片下方的独立面板,不打断当前视图 */
async function handleCheckUpdate() {
  const button = role('update-btn')
  button.disabled = true
  // 检查期间禁用卡片内的操作按钮(启动/重试连接/返回等):
  // busy 守卫会阻止并发操作,此处显式置灰使禁用状态可见
  const cardButtons = document.querySelectorAll('.card [data-action]')
  cardButtons.forEach(item => {
    item.disabled = true
  })
  role('update-panel').hidden = false
  setUpdateState('checking')
  try {
    const result = await api.checkUpdate()
    if (!result || !result.installed) {
      setUpdateMessage('尚未安装 DeepSeek Harness，请先按上方指引完成安装')
    } else if (result.error) {
      setUpdateMessage('检查失败，请检查网络连接后重试')
    } else if (result.updateAvailable) {
      renderVersionText(role('update-available-text'), result.current
        ? ['发现新版本 ', { version: result.latest }, '（当前版本 ', { version: result.current }, '）']
        : ['发现新版本 ', { version: result.latest }])
      setUpdateState('available')
    } else {
      const message = role('update-message')
      if (result.current) {
        renderVersionText(message, ['当前已是最新版本（', { version: result.current }, '）'])
      } else {
        message.textContent = '当前已是最新版本'
      }
      setUpdateState('message')
    }
  } catch {
    // IPC 层面的异常(主进程 handler 抛错),按检查失败处理
    setUpdateMessage('检查失败，请检查网络连接后重试')
  } finally {
    // 卡片按钮此前没有其他禁用来源,统一恢复为可点
    cardButtons.forEach(item => {
      item.disabled = false
    })
    // 恢复按钮时跟随 dsh 安装状态:未安装保持禁用,不能无条件恢复为可点
    button.disabled = !dshInstalled
  }
}

// ---- 事件绑定 ----

const actions = {
  start: () => guard(handleStart),
  retry: () => guard(handleRetry),
  recheck: () => guard(handleRecheck),
  'cancel-start': () => api.cancelStart(),
  'back-offline': () => show('offline'),
  'open-nodejs': () => api.openExternal(NODE_DOWNLOAD_URL),
  'open-repo': () => api.openExternal(REPO_URL),
  'copy-command': (_event, button) => handleCopyCommand(button),
  'check-update': () => guard(handleCheckUpdate),
  'dismiss-update': () => {
    role('update-panel').hidden = true
  },
}

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', event => {
    const action = actions[button.dataset.action]
    if (action) action(event, button)
  })
})

// ---- 入口:展示断连提示(如有),然后开始引导流程 ----

// footer 应用名后填充桌面端自身版本号
api.getAppVersion().then(version => {
  role('app-version').textContent = `v${version}`
})

// 主进程在「连接断开 / 加载失败」回到本页时会带上 reason query
const reason = new URLSearchParams(location.search).get('reason')
if (reason) {
    showNotice(reason === 'disconnected'
      ? '与 127.0.0.1:3080 的连接已断开，DeepSeek Harness 可能已停止'
      : '无法加载 127.0.0.1:3080 页面，请检查 dsh 状态')
}

show('checking')
// IPC 异常时落到未启动页,避免永远停在转圈界面;footer 按「未安装 dsh」收场
api.bootstrap().then(handleStatus).catch(() => {
  renderDshVersion(null)
  show('offline')
})
