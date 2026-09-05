/**
 * dsh-desktop 主进程入口:窗口管理、启动流程编排与 IPC。
 *
 * 启动顺序:
 *   1. 探测 127.0.0.1:3080 —— 可连接则直接加载 dsh Web UI;
 *   2. 否则检测 Node.js 与 dsh 环境 —— 缺失/版本过低时由渲染层给出对应引导;
 *   3. 环境就绪则展示「未启动」页,用户可选择由桌面端代为 `dsh web`,或在终端
 *      手动启动后点击「重试连接」。
 *
 * 浏览器鉴权:dsh ≥ 0.1.2-alpha.1 起,Web UI 要求启动令牌(见
 * deepseek-harness packages/client/connection/src/browser-auth.ts)。
 * 桌面端代启动时从 `dsh web` 打印的 URL 行解析 token 并用完整地址加载;
 * 带 token 访问一次后服务端会种下签名 Cookie,后续裸地址重连即可放行。
 * 用户在终端自行启动时桌面端拿不到 token(仅存于 dsh 进程内存),
 * 需用户把终端打印的完整带 token 地址粘贴进来,由桌面端加载种 Cookie。
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  DSH_HOST,
  DSH_PORT,
  checkEnvironment,
  isPortReachable,
  isDshRunning,
  getEnhancedEnv,
  refreshEnhancedEnv,
  checkDshUpdate,
} = require('./checks')
const { DshRunner } = require('./runner')

const DSH_URL = `http://${DSH_HOST}:${DSH_PORT}`
const LAUNCHER_PAGE = path.join(__dirname, '..', 'renderer', 'index.html')
/** 启动器页的完整 file:// URL(带回退 reason query 时仍以前缀匹配) */
const LAUNCHER_URL = pathToFileURL(LAUNCHER_PAGE).href
/** 应用图标(PNG):macOS 用于 Dock,Windows/Linux 用于窗口与任务栏 */
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png')

/** 等待 dsh web 就绪的最长时间(首次启动需要初始化 profile,给足余量) */
const START_TIMEOUT_MS = 120000
/** 在线状态下的端口探测间隔;连续两次探测失败判定为服务已停止 */
const ONLINE_POLL_INTERVAL_MS = 5000

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {DshRunner | null} */
let runner = null
let onlinePollTimer = null
/**
 * 已知当前 3080 上的 dsh 缺启动令牌(≥ 0.1.2)时为 true。
 * connectToDsh 探测到 401 会回启动页,而启动页 bootstrap 会重新探测;
 * 若无此标记,bootstrap 对仍在跑的 dsh 会再次裸连 → 401 → 再回启动页,
 * 死循环。置位后 bootstrap 直接返回 authRequired 让渲染层展示粘贴区,
 * 直到用户粘贴带令牌 URL 成功连接(connectToDsh 返回 true)后清除。
 */
let dshAuthRequired = false

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 默认窗口尺寸:按主屏工作区比例计算并钳制在合理区间。
 * 固定像素在 Windows 缩放下观感差异大(1080p@150% 逻辑分辨率仅 1280×720),
 * 按比例取则小屏本不撑出屏幕、高分屏自动放大,各平台表现一致。
 * (workAreaSize 返回的是 DIP,已含系统缩放;需在 app ready 后调用)
 */
function defaultWindowSize() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.min(Math.max(Math.round(width * 0.62), 1120), 1440),
    height: Math.min(Math.max(Math.round(height * 0.74), 720), 960),
  }
}

function createWindow() {
  // 图标文件缺失时退回系统默认图标,不影响启动
  const icon = fs.existsSync(APP_ICON) ? nativeImage.createFromPath(APP_ICON) : undefined
  mainWindow = new BrowserWindow({
    ...defaultWindowSize(),
    minWidth: 840,
    minHeight: 560,
    // 隐藏 Windows/Linux 的窗口菜单栏(File/Edit...),界面无菜单需求;
    // 按 Alt 可临时唤出(开发时仍可用菜单里的 DevTools)。macOS 无窗口菜单,不受影响
    autoHideMenuBar: true,
    icon, // Windows/Linux 的窗口与任务栏图标;macOS 的 Dock 图标在 whenReady 里设置
    // 与 dsh 浅色主题的模块底色一致,避免启动白闪
    backgroundColor: '#f5f6f7',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 加载 dsh Web UI 失败(如服务中途退出)时回到本地启动器页面
  mainWindow.webContents.on('did-fail-load', (_event, _code, _desc, validatedURL) => {
    if (validatedURL.startsWith(DSH_URL)) backToLauncher('connect-failed')
  })

  // 外链防护:窗口只允许停留在启动器页(精确路径,而非整个 file:// 协议)
  // 与 dsh Web UI,其他导航(如 dsh 界面里的外部链接)一律拦截并交给系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(DSH_URL) || url.startsWith(LAUNCHER_URL)) return
    event.preventDefault()
    openExternalHttp(url)
  })

  // 拒绝一切新窗口(target=_blank / window.open),http/https 链接同样交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttp(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadFile(LAUNCHER_PAGE)
}

/**
 * 从 `dsh web` 的日志输出中提取带启动令牌的 URL。
 * dsh ≥ 0.1.2-alpha.1 会打印 `dsh web: http://127.0.0.1:3080/?token=... (LAN: ...)`,
 * 取第一个 http(s) 地址;旧版本无令牌输出,返回 null 走裸地址兼容路径。
 */
function extractAuthenticatedUrl(text) {
  const match = /dsh web:\s*(https?:\/\/\S+)/.exec(text)
  if (!match) return null
  // 仅接受本机回环地址:LAN 地址的端口可能不是 3080,且桌面端只连本机
  try {
    const url = new URL(match[1])
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
    return url.href
  } catch {
    return null
  }
}

/**
 * 回到本地启动器页面,reason 通过 query 传给渲染层用于展示提示。
 * (每次加载启动器页面,渲染层都会重新走一遍 bootstrap 流程)
 */
function backToLauncher(reason) {
  stopOnlinePoll()
  if (mainWindow) {
    mainWindow.loadFile(LAUNCHER_PAGE, { search: `reason=${reason}` })
  }
}

/**
 * 连接 dsh Web UI 并开启在线轮询;窗口已关闭或加载失败会向上抛错。
 * url 默认裸地址;代启动场景传入带启动令牌的完整 URL(令牌见文件头说明),
 * 加载一次后服务端种下 Cookie,后续裸地址重连即可放行。
 *
 * 401 探测:dsh ≥ 0.1.2 对无 Cookie 的裸地址返回 401 + 一行文本,这不是
 * 网络错误,did-fail-load 不触发,loadURL 正常 resolve。需加载后探测页面
 * 是否有 #root 根节点(401 页没有)。探测到 401 时置 dshAuthRequired 并回
 * 启动页(渲染层已随 401 页卸载,必须重新加载启动页才能展示粘贴区),
 * 由 bootstrap 的 dshAuthRequired 短路避免重复裸连造成死循环。
 * @returns {Promise<boolean>} true=已进入 Web UI;false=服务在跑但缺令牌(已回启动页)
 */
async function connectToDsh(url = DSH_URL) {
  if (!mainWindow) throw new Error('窗口已关闭')
  stopOnlinePoll()
  await mainWindow.loadURL(url)
  const rejected = await mainWindow.webContents.executeJavaScript(
    "document.getElementById('root') === null"
  )
  if (rejected) {
    dshAuthRequired = true
    backToLauncher('auth-required')
    return false
  }
  dshAuthRequired = false
  startOnlinePoll()
  return true
}

/** 在线后轮询端口,服务掉线则回到启动器页面(已连接过,此处只看端口存活即可) */
function startOnlinePoll() {
  stopOnlinePoll()
  let misses = 0
  onlinePollTimer = setInterval(async () => {
    if (await isPortReachable(DSH_HOST, DSH_PORT)) {
      misses = 0
      return
    }
    misses += 1
    if (misses >= 2) backToLauncher('disconnected')
  }, ONLINE_POLL_INTERVAL_MS)
}

function stopOnlinePoll() {
  if (onlinePollTimer) {
    clearInterval(onlinePollTimer)
    onlinePollTimer = null
  }
}

/** 轮询端口直到 dsh web 就绪(进程由桌面端拉起,TCP 连通即视为就绪);进程提前退出或超时则抛错 */
async function waitForDshReady() {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    // spawn 失败(如 dsh 不在 PATH 上)时立即失败,不空等超时
    if (runner.spawnError) {
      throw new Error(`无法启动 dsh:${runner.spawnError.message}`)
    }
    if (!runner.running) {
      throw new Error(`dsh 进程已退出(退出码 ${runner.exitCode ?? '未知'})`)
    }
    if (await isPortReachable(DSH_HOST, DSH_PORT)) return
    await sleep(500)
  }
  throw new Error(`等待 ${DSH_HOST}:${DSH_PORT} 就绪超时`)
}

/** 端口上确认是 dsh 则直连,否则做环境检测并把结果交给渲染层 */
async function probeThenReport() {
  const occupied = await isPortReachable(DSH_HOST, DSH_PORT)
  // TCP 连通后再校验 dsh 指纹,避免误连其他占用 3080 的程序
  const isDsh = occupied && (await isDshRunning())
  // 已知缺令牌(此前 401 回启动页):不再裸连,直接让渲染层展示粘贴区。
  // 短路必须在 connectToDsh 之前,否则 bootstrap 会再次 401 → 死循环。
  if (isDsh && dshAuthRequired) {
    const env = checkEnvironment()
    return { status: env.ok ? 'ready' : 'env-error', env, authRequired: true }
  }
  if (isDsh) {
    try {
      const connected = await connectToDsh()
      if (connected) return { status: 'online' }
      // 缺令牌:connectToDsh 已回启动页并置 dshAuthRequired,本次返回可忽略
      // (渲染层已随 backToLauncher 重新加载并重新 bootstrap,走上方短路)。
      return { status: 'ready', env: checkEnvironment(), authRequired: true }
    } catch {
      /* 指纹匹配但页面加载失败,继续走离线流程 */
    }
  }
  const env = checkEnvironment()
  const result = env.ok ? { status: 'ready', env } : { status: 'env-error', env }
  // 有程序监听但指纹不符:3080 被其他程序占用,交给渲染层提示
  if (occupied && !isDsh) result.portOccupied = true
  return result
}

// ---- IPC:渲染进程驱动的主流程 ----

/** 启动引导:online(已直连)/ ready(环境就绪待启动)/ env-error(环境缺失) */
ipcMain.handle('bootstrap', () => probeThenReport())

/** 重新检测环境(用户安装完 node/dsh 后点击),重置 PATH 缓存 */
ipcMain.handle('recheck-env', () => {
  refreshEnhancedEnv()
  return probeThenReport()
})

/**
 * 仅重试连接 3080(用户在终端手动启动 dsh 后点击),校验 dsh 指纹。
 * 裸地址直连的前提是 Cookie 已种下(此前用带令牌 URL 成功连接过);
 * 无 Cookie 时 connectToDsh 探测到 401 会回启动页并返回 false,
 * 此处据此前置 authRequired,由渲染层展示粘贴 URL 入口。
 */
ipcMain.handle('retry-connection', async () => {
  try {
    if (await isDshRunning(DSH_HOST, DSH_PORT, 2000)) {
      // 即使已知缺令牌也尝试裸连:Cookie 绑定的是 dsh 持久化 secret 而非进程
      // token,dsh 重启后旧 Cookie 仍可能有效,值得一试;无效则 connectToDsh
      // 探测 401 回启动页并维持 dshAuthRequired,由重载后的 bootstrap 展示粘贴区
      const connected = await connectToDsh()
      if (connected) return { ok: true }
      return { ok: false, authRequired: true }
    }
  } catch {
    /* 落入下方失败返回 */
  }
  // 区分失败原因:端口无程序监听,还是有程序监听但不是 dsh
  const occupied = await isPortReachable(DSH_HOST, DSH_PORT)
  return { ok: false, occupied }
})

/**
 * 用用户粘贴的带启动令牌 URL 连接(终端启动 dsh 的场景)。
 * 校验:必须是 http(s) 协议、指向本机 3080、带 token 参数。
 * 加载一次后服务端种下 Cookie,后续裸地址重连即可放行。
 */
ipcMain.handle('connect-with-token', async (_event, rawUrl) => {
  if (typeof rawUrl !== 'string') return { ok: false, error: 'URL 必须是字符串' }
  let url
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return { ok: false, error: 'URL 格式不正确' }
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, error: '仅支持 http/https 协议' }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return { ok: false, error: '仅支持本机地址(127.0.0.1 / localhost)' }
  }
  if (url.port !== String(DSH_PORT)) return { ok: false, error: `端口必须是 ${String(DSH_PORT)}` }
  if (!url.searchParams.has('token')) return { ok: false, error: 'URL 缺少 token 参数' }
  try {
    const connected = await connectToDsh(url.href)
    // 令牌错误:connectToDsh 探测到 401 已回启动页并置 dshAuthRequired,
    // 重载后的 bootstrap 会走短路展示粘贴区;返回值随旧页面卸载
    if (!connected) return { ok: false, authRequired: true }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

/** 由桌面端代为启动 dsh web,端口就绪后自动连接 */
ipcMain.handle('start-dsh', async () => {
  if (!runner) runner = new DshRunner()
  if (runner.running) return { ok: false, error: 'dsh 正在启动或运行中' }
  // 用户可能在终端抢先启动了 dsh:已在线则直接连接,避免拉起重复实例造成端口冲突
  if (await isDshRunning()) {
    try {
      const connected = await connectToDsh()
      if (connected) return { ok: true }
      // 缺令牌:connectToDsh 已回启动页并置 dshAuthRequired,重载后的
      // bootstrap 会走短路展示粘贴区;返回值随旧页面卸载
      return { ok: false, authRequired: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
  try {
    runner.start(getEnhancedEnv(), text => {
      if (mainWindow) mainWindow.webContents.send('dsh-log', text)
    })
    await waitForDshReady()
    // 优先使用 dsh 打印的带令牌 URL(≥ 0.1.2-alpha.1);旧版本无此输出,退而直连裸地址
    const connected = await connectToDsh(extractAuthenticatedUrl(runner.logTail) || DSH_URL)
    // 令牌 URL 必然有效(token 来自 dsh 自身日志),false 仅在极端时序下出现;
    // 此时 connectToDsh 已回启动页, runner 仍在跑,按缺令牌流程交渲染层处理
    if (!connected) return { ok: false, authRequired: true }
    return { ok: true }
  } catch (error) {
    const cancelled = runner.stopRequested
    runner.stop()
    return { ok: false, cancelled, error: error.message, log: runner.logTail }
  }
})

/** 取消进行中的启动(start-dsh 会随后以 cancelled 收场) */
ipcMain.handle('cancel-start', () => {
  if (runner) runner.stop()
  return true
})

/** 手动检查 dsh 更新(启动器页「检查 dsh 更新」触发):本地版本对比 npm registry 最新版本 */
ipcMain.handle('check-update', () => checkDshUpdate())

/** 桌面端自身版本号(footer 展示用),取自 package.json */
ipcMain.handle('get-app-version', () => app.getVersion())

/**
 * 把 http/https 链接交给系统浏览器打开,其余协议一律拦截。
 * dsh 界面里的模型输出可能包含 http 链接(如本地起的服务),一并放行;
 * file://、javascript: 等协议仍被拒绝,避免渲染层借此外跳。
 */
function openExternalHttp(url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
}

/** 用系统浏览器打开链接(http/https) */
ipcMain.handle('open-external', (_event, url) => openExternalHttp(url))

// ---- 应用生命周期 ----

// 单实例锁:已有实例在运行时,后启动的进程直接退出,由首实例聚焦已有窗口。
// 双开会导致两个启动器各自管理 dsh 进程与在线轮询,退出时互相干扰,必须阻止
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // macOS 开发模式下 Dock 默认显示 Electron 图标,需单独设置为应用图标
    if (process.platform === 'darwin' && fs.existsSync(APP_ICON)) {
      app.dock.setIcon(nativeImage.createFromPath(APP_ICON))
    }
    createWindow()
  })
}

// 退出前清理:只回收由桌面端启动的 dsh 进程,用户在终端手动启动的不受影响
app.on('before-quit', () => {
  stopOnlinePoll()
  if (runner) runner.stop()
})

// 兜底:before-quit 覆盖不到的退出路径(如开发模式 Ctrl+C、关闭终端)。
// exit 事件中只允许同步代码,runner.stop() 内部同步执行(taskkill 为 spawnSync),
// 且幂等(before-quit 已清理过时 child 为 null,直接返回)
process.on('exit', () => {
  if (runner) runner.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
