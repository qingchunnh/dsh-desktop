/**
 * dsh web 进程管理模块:负责启动、日志收集与退出清理。
 *
 * 桌面端不内置 dsh,这里启动的是用户本机已安装的 `dsh` 命令;
 * 若用户选择自己在终端启动,本模块不会被使用。
 */
const { spawn, spawnSync } = require('node:child_process')

/** 日志尾部保留的最大字符数(长时间运行防止内存膨胀,启动失败时用于展示) */
const LOG_TAIL_LIMIT = 64 * 1024

/** 终端 ANSI 转义序列(颜色、光标控制等),日志进面板前先剥离 */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g

class DshRunner {
  constructor() {
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** 用户主动取消/退出应用时为 true,用于区分「被取消」与「启动失败」 */
    this.stopRequested = false
    /** 进程退出码(未退出为 null) */
    this.exitCode = null
    /** spawn 失败(如 dsh 命令不存在)时的错误;此时 exit 不保证触发,需单独记录 */
    this.spawnError = null
    /** stdout + stderr 的合并日志尾部 */
    this.logTail = ''
  }

  get running() {
    return this.child !== null
  }

  /** 追加日志并只保留尾部 */
  appendLog(chunk) {
    this.logTail = (this.logTail + chunk).slice(-LOG_TAIL_LIMIT)
  }

  /**
   * 启动 `dsh web`。
   * @param {NodeJS.ProcessEnv} env 增强了 PATH 的环境变量
   * @param {(text: string) => void} [onLog] 日志回调(转发给渲染进程实时展示)
   */
  start(env, onLog) {
    if (this.child) throw new Error('dsh 已在启动或运行中')
    this.stopRequested = false
    this.exitCode = null
    this.spawnError = null
    this.logTail = ''

    const isWin = process.platform === 'win32'
    const child = spawn('dsh', ['web'], {
      env,
      shell: isWin, // Windows 下 dsh 是 .cmd shim,必须经 shell 执行
      detached: !isWin, // POSIX 下独立成进程组,便于退出时整组清理
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    const handleData = data => {
      // 剥离终端转义序列,避免日志面板显示原始控制字符
      const text = data.toString().replace(ANSI_PATTERN, '')
      this.appendLog(text)
      if (onLog) onLog(text)
    }
    child.stdout.on('data', handleData)
    child.stderr.on('data', handleData)
    // 两个事件处理器都先校验身份:stop() 立即释放引用后若迅速重启,
    // 旧进程迟到的 exit/error 不能误伤新进程的引用
    child.on('error', error => {
      if (this.child !== child) return
      // spawn 失败(如 ENOENT)时 exit 不保证触发(Node 文档明确 may or may not fire),
      // 必须在此置空 child,否则 running 永远为 true,后续启动请求会一直被拒绝
      this.spawnError = error
      this.child = null
      this.appendLog(String(error))
      if (onLog) onLog(String(error))
    })
    child.on('exit', code => {
      if (this.child !== child) return
      this.exitCode = code
      this.child = null
    })
  }

  /**
   * 停止 dsh;POSIX 杀整个进程组,Windows 用 taskkill 杀进程树。
   * Windows 分支必须同步执行:应用退出(before-quit / process exit)时事件循环
   * 即将关闭,异步 spawn 来不及完成会导致 dsh 进程残留(任务管理器可见)。
   * 注意:引用是立即释放的,若进程无视 SIGTERM 残留,本实例会失去它的句柄
   * (表现为 3080 仍被占用);下次启动会经指纹检测直接连上,属于预期的自愈行为。
   */
  stop() {
    const child = this.child
    this.stopRequested = true
    if (!child) return
    // 立即释放引用(不等 exit 到达),取消启动后可以马上重新开始
    this.child = null
    try {
      if (process.platform === 'win32') {
        // 同步等待 taskkill 完成,保证返回时进程树已被终止;
        // 失败(如进程已退出、pid 无效)时静默忽略,下次启动会经指纹检测直接连上。
        // timeout 兜底:极端情况下 taskkill 挂起不至于卡死退出流程
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 5000,
        })
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
    }
  }
}

module.exports = { DshRunner }
