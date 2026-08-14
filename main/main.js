/**
 * dsh-desktop 主进程入口:窗口管理、启动流程编排与 IPC。
 *
 * 启动顺序:
 *   1. 探测 127.0.0.1:3080 —— 可连接则直接加载 dsh Web UI;
 *   2. 否则检测 Node.js 与 dsh 环境 —— 缺失/版本过低时由渲染层给出对应引导;
 *   3. 环境就绪则展示「未启动」页,用户可选择由桌面端代为 `dsh web`,或在终端
 *      手动启动后点击「重试连接」。
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron')
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function createWindow() {
  // 图标文件缺失时退回系统默认图标,不影响启动
  const icon = fs.existsSync(APP_ICON) ? nativeImage.createFromPath(APP_ICON) : undefined
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
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
    if (url.startsWith('https://')) shell.openExternal(url)
  })

  // 拒绝一切新窗口(target=_blank / window.open),https 链接同样交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadFile(LAUNCHER_PAGE)
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

/** 连接 dsh Web UI 并开启在线轮询;窗口已关闭或加载失败会向上抛错 */
async function connectToDsh() {
  if (!mainWindow) throw new Error('窗口已关闭')
  stopOnlinePoll()
  await mainWindow.loadURL(DSH_URL)
  startOnlinePoll()
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
  if (isDsh) {
    try {
      await connectToDsh()
      return { status: 'online' }
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

/** 仅重试连接 3080(用户在终端手动启动 dsh 后点击),校验 dsh 指纹 */
ipcMain.handle('retry-connection', async () => {
  try {
    if (await isDshRunning(DSH_HOST, DSH_PORT, 2000)) {
      await connectToDsh()
      return { ok: true }
    }
  } catch {
    /* 落入下方失败返回 */
  }
  // 区分失败原因:端口无程序监听,还是有程序监听但不是 dsh
  const occupied = await isPortReachable(DSH_HOST, DSH_PORT)
  return { ok: false, occupied }
})

/** 由桌面端代为启动 dsh web,端口就绪后自动连接 */
ipcMain.handle('start-dsh', async () => {
  if (!runner) runner = new DshRunner()
  if (runner.running) return { ok: false, error: 'dsh 正在启动或运行中' }
  // 用户可能在终端抢先启动了 dsh:已在线则直接连接,避免拉起重复实例造成端口冲突
  if (await isDshRunning()) {
    try {
      await connectToDsh()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
  try {
    runner.start(getEnhancedEnv(), text => {
      if (mainWindow) mainWindow.webContents.send('dsh-log', text)
    })
    await waitForDshReady()
    await connectToDsh()
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

/** 用系统浏览器打开链接(仅允许 https,防止被滥用) */
ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url)
  }
})

// ---- 应用生命周期 ----

app.whenReady().then(() => {
  // macOS 开发模式下 Dock 默认显示 Electron 图标,需单独设置为应用图标
  if (process.platform === 'darwin' && fs.existsSync(APP_ICON)) {
    app.dock.setIcon(nativeImage.createFromPath(APP_ICON))
  }
  createWindow()
})

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
