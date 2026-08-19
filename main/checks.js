/**
 * 环境检测模块:检测 TCP 端口连通性、Node.js 与 DeepSeek Harness(dsh)的安装情况。
 *
 * GUI 应用(尤其是 macOS 上从 Dock/Finder 启动的应用)拿到的 PATH 非常有限,
 * 往往不包含 nvm / Homebrew 等用户级 bin 目录,因此这里会通过用户的登录 shell
 * 提取 PATH 并缓存,供后续所有子进程(检测与启动 dsh)使用。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

/** dsh Web UI 的默认监听地址(见 deepseek-harness 仓库 packages/bundle/web-app) */
const DSH_HOST = '127.0.0.1'
const DSH_PORT = 3080

/** dsh Web UI 的身份指纹:PWA manifest 里的固定名称(见 apps/web/public/manifest.webmanifest) */
const DSH_MARKER_PATH = '/manifest.webmanifest'
const DSH_MARKER = '"DeepSeek Harness"'

/**
 * 检测 TCP 端口是否可连接。
 * @param {string} host 主机地址
 * @param {number} port 端口
 * @param {number} [timeoutMs] 超时时间
 * @returns {Promise<boolean>} 可连接返回 true
 */
function isPortReachable(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    const done = ok => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

/**
 * 校验指定端口上运行的确实是 dsh,而非其他占用端口的程序。
 * 先确认 TCP 可连接,再请求 PWA manifest 校验特征字符串。
 * (指纹跟随 dsh 当前的 Web 构建;未来 dsh 若移除该 manifest 需同步调整)
 * @returns {Promise<boolean>} 确认是 dsh 返回 true
 */
async function isDshRunning(host = DSH_HOST, port = DSH_PORT, timeoutMs = 2000) {
  if (!await isPortReachable(host, port, timeoutMs)) return false
  return new Promise(resolve => {
    const request = http.get({ host, port, path: DSH_MARKER_PATH, timeout: timeoutMs }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
        // manifest 正常仅数百字节,异常大的响应直接判定不是 dsh;
        // resolve 幂等,先落定再销毁,避免 destroy 后无人 resolve 导致悬挂
        if (body.length > 16384) {
          resolve(false)
          request.destroy()
        }
      })
      response.on('end', () => resolve(response.statusCode === 200 && body.includes(DSH_MARKER)))
      response.on('error', () => resolve(false))
    })
    request.on('error', () => resolve(false))
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
  })
}

/**
 * 跨平台执行一条短命令。
 * Windows 下 npm 全局安装出来的是 .cmd shim,不经 shell 无法直接执行。
 */
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    shell: process.platform === 'win32',
    ...options,
  })
}

/**
 * 从用户的登录 shell 中提取 PATH。
 * 同时加上 -i 以覆盖把 nvm 等配置写在交互式 rc 文件(如 .zshrc)里的情况。
 * 用 printenv 而非 echo "$PATH":fish 会把 $PATH 展开为空格分隔的列表,
 * 而 printenv 读的是导出环境,任何 shell 下都是冒号分隔。
 * rc 文件可能输出杂项内容,因此取输出中最后一个像 PATH 的行。
 */
function resolveShellPath() {
  if (process.platform === 'win32') return process.env.PATH || ''
  const userShell = process.env.SHELL || '/bin/zsh'
  try {
    const result = spawnSync(userShell, ['-l', '-i', '-c', 'printenv PATH'], {
      encoding: 'utf8',
      timeout: 8000,
    })
    const lines = (result.stdout || '').split('\n').map(line => line.trim())
    const pathLine = lines.filter(line => line.includes('/')).pop()
    if (pathLine) return pathLine
  } catch {
    /* shell 探测失败时退回进程自带 PATH */
  }
  return process.env.PATH || ''
}

/** 常见的全局 bin 目录兜底(shell PATH 提取失败时也能覆盖 Homebrew / npm 全局等位置) */
function fallbackBinDirs() {
  const home = os.homedir()
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'bin'),
  ].filter(dir => fs.existsSync(dir))
}

/** 缓存的增强环境变量,避免每次检测都 fork 一次 shell */
let cachedEnv = null

/** 获取合并了登录 shell PATH 的环境变量(检测与启动 dsh 统一使用) */
function getEnhancedEnv() {
  if (cachedEnv) return cachedEnv
  const segments = []
  const seen = new Set()
  const push = list => {
    for (const dir of list) {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        segments.push(dir)
      }
    }
  }
  push(resolveShellPath().split(path.delimiter))
  push((process.env.PATH || '').split(path.delimiter))
  push(fallbackBinDirs())
  cachedEnv = { ...process.env, PATH: segments.join(path.delimiter) }
  return cachedEnv
}

/** 清空 PATH 缓存(用户安装完 node/dsh 后点击「重新检测」时调用) */
function refreshEnhancedEnv() {
  cachedEnv = null
}

/**
 * 解析 `v22.19.0` / `22.19.0` / `0.1.0-rc.8` 形式的版本号(可含预发布号)。
 * @returns {{ major: number, minor: number, patch: number, prerelease: string, raw: string } | null}
 */
function parseVersion(text) {
  const match = /v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text || '')
  if (!match) return null
  const [, major, minor, patch, prerelease] = match
  return {
    major: +major,
    minor: +minor,
    patch: +patch,
    prerelease: prerelease || '',
    raw: `${+major}.${+minor}.${+patch}${prerelease ? `-${prerelease}` : ''}`,
  }
}

/** 校验 Node.js 版本是否满足 `^22.19.0 || >=24.0.0`(注意 23.x 不受支持) */
function isNodeVersionOk(version) {
  if (!version) return false
  if (version.major === 22) return version.minor >= 19
  return version.major >= 24
}

/**
 * 检测 Node.js 安装情况。
 * @returns {{ installed: boolean, version: string | null, ok: boolean }}
 */
function checkNode(env) {
  try {
    const result = run('node', ['--version'], { env })
    if (result.error || result.status !== 0) {
      return { installed: false, version: null, ok: false }
    }
    const version = parseVersion(result.stdout)
    return { installed: true, version: version ? version.raw : null, ok: isNodeVersionOk(version) }
  } catch {
    return { installed: false, version: null, ok: false }
  }
}

/**
 * 检测 dsh(DeepSeek Harness CLI)安装情况,通过 `dsh -V` 输出版本号判断。
 * @returns {{ installed: boolean, version: string | null, skipped?: boolean }}
 */
function checkDsh(env) {
  try {
    const result = run('dsh', ['-V'], { env, timeout: 30000 })
    if (result.error || result.status !== 0) {
      return { installed: false, version: null }
    }
    const version = parseVersion(result.stdout)
    return { installed: true, version: version ? version.raw : (result.stdout || '').trim() }
  } catch {
    return { installed: false, version: null }
  }
}

/**
 * 完整环境检测:先 node 后 dsh。
 * node 缺失或版本不满足时 dsh 必然无法运行,直接跳过 dsh 检测以节省时间。
 */
function checkEnvironment() {
  const env = getEnhancedEnv()
  const node = checkNode(env)
  const dsh = node.installed && node.ok
    ? checkDsh(env)
    : { installed: false, version: null, skipped: true }
  return { node, dsh, ok: node.installed && node.ok && dsh.installed }
}

/**
 * 查询 npm registry 上 dsh 的最新版本号。
 * 走 `npm view` 而非直连 registry.npmjs.org:跟随用户自己配置的
 * registry(国内用户常配 npmmirror 镜像);断网/超时等失败返回 null。
 */
function checkLatestDshVersion(env) {
  try {
    const result = run('npm', ['view', '@deepseek-ai/dsh', 'version'], { env, timeout: 20000 })
    if (result.error || result.status !== 0) return null
    const version = parseVersion(result.stdout)
    return version ? version.raw : null
  } catch {
    return null
  }
}

/**
 * 比较预发布号(semver §11):无预发布号者优先级更高(0.1.0 > 0.1.0-rc.8);
 * 双方都有时逐段比较,数字段按数值且小于字母段,段数多者更大。
 * @returns {number} a < b 返回负数,相等返回 0
 */
function comparePrerelease(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    if (i >= as.length) return -1
    if (i >= bs.length) return 1
    const na = /^\d+$/.test(as[i]) ? Number(as[i]) : null
    const nb = /^\d+$/.test(bs[i]) ? Number(bs[i]) : null
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1
    } else if (na !== null) {
      return -1
    } else if (nb !== null) {
      return 1
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1
    }
  }
  return 0
}

/** 判断版本 a 是否落后于 b(含预发布号比较:0.1.0-rc.8 < 0.1.0-rc.9 < 0.1.0) */
function isVersionOlder(a, b) {
  if (!a || !b) return false
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key]
  }
  return comparePrerelease(a.prerelease, b.prerelease) < 0
}

/**
 * 检查 dsh 更新(由用户在启动器页手动触发):本地 `dsh -V` 对比 registry 最新版本。
 * @returns {{ installed: boolean, current?: string | null, latest?: string, updateAvailable?: boolean, error?: boolean }}
 *   installed=false:未安装 dsh;error=true:已安装但查询 registry 失败(多为网络问题)
 */
function checkDshUpdate() {
  const env = getEnhancedEnv()
  const local = checkDsh(env)
  if (!local.installed) return { installed: false }
  const latest = checkLatestDshVersion(env)
  if (!latest) return { installed: true, current: local.version, error: true }
  const current = local.version ? parseVersion(local.version) : null
  return {
    installed: true,
    current: local.version,
    latest,
    updateAvailable: isVersionOlder(current, parseVersion(latest)),
  }
}

module.exports = {
  DSH_HOST,
  DSH_PORT,
  isPortReachable,
  isDshRunning,
  getEnhancedEnv,
  refreshEnhancedEnv,
  checkEnvironment,
  checkDshUpdate,
}
