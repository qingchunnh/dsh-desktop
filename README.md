# dsh-desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(以下简称 dsh)的桌面端启动器，基于 Electron。

不内置 dsh，需先在本机安装(见[环境要求](#环境要求))。启动后自动检测 `127.0.0.1:3080` 上的 dsh Web UI:

- 服务在线 → 直接进入
- 未启动 → 一键代为运行 `dsh web`，或在终端手动启动后重试连接

> 本项目为社区维护的第三方启动器，非 DeepSeek 官方出品。

## 功能特性

- **启动即检测**:服务在线则直接加载 dsh Web UI，无需任何操作
- **一键启动**:服务未启动时，由桌面端代为运行 `dsh web`，实时显示进程日志，就绪后自动进入
- **重试连接**:适合习惯在终端手动启动 dsh 的用户
- **检查更新**:手动检查 dsh 新版本，发现新版本时给出更新命令并支持一键复制
- **环境引导**:
  - 未安装 Node.js → 提供官网下载链接
  - Node.js 版本不满足 `^22.19.0 || >=24.0.0` → 提示升级
  - 未安装 dsh → 提供安装命令并支持一键复制
- **自动回退**:在线期间服务掉线，自动回到启动器页
- **单实例运行**:重复启动应用时聚焦已有窗口，不会开出第二个实例
- **外链保护**:窗口内只允许访问 dsh，外部链接一律交给系统浏览器打开
- **配色跟随**:与 dsh Web UI 保持一致，跟随系统深浅色自动切换

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`(23.x 不受支持)
- DeepSeek Harness:

  ```sh
  npm install -g @deepseek-ai/dsh
  ```

## 下载

从 [Releases](https://github.com/qingchunnh/dsh-desktop/releases) 页面下载对应平台的安装包。

## 说明

- Logo 来自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(MIT)

## License

[MIT](LICENSE)
