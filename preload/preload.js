/**
 * 预加载脚本:在 contextIsolation 开启的前提下,
 * 以最小 API 面把主进程能力暴露给渲染进程。
 *
 * preload 对窗口加载的所有页面生效,因此仅当页面是本地启动器页
 * (file:// 协议 + 精确路径)时才暴露 API;连接后加载的 dsh Web UI
 * (http://127.0.0.1:3080)与其他本地文件都拿不到这些能力。
 */
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/index.html')) {
  contextBridge.exposeInMainWorld('dshDesktop', {
    /** 启动引导:online(已直连)/ ready(环境就绪待启动)/ env-error(环境缺失) */
    bootstrap: () => ipcRenderer.invoke('bootstrap'),
    /** 重新检测环境(用户安装完 node/dsh 后点击) */
    recheckEnv: () => ipcRenderer.invoke('recheck-env'),
    /** 仅重试连接 127.0.0.1:3080(用户在终端手动启动 dsh 后点击) */
    retryConnection: () => ipcRenderer.invoke('retry-connection'),
    /** 由桌面端启动 dsh web,端口就绪后自动连接 */
    startDsh: () => ipcRenderer.invoke('start-dsh'),
    /** 取消进行中的启动 */
    cancelStart: () => ipcRenderer.invoke('cancel-start'),
    /** 用系统浏览器打开链接 */
    openExternal: url => ipcRenderer.invoke('open-external', url),
    /** 订阅 dsh 进程日志;返回取消订阅函数 */
    onDshLog: callback => {
      const listener = (_event, text) => callback(text)
      ipcRenderer.on('dsh-log', listener)
      return () => ipcRenderer.removeListener('dsh-log', listener)
    },
  })
}
