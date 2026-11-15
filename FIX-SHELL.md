# 任务：修复 Windows 上 `pwsh` 无法启动（0xC0000142）

> 交给外部编码助手（Claude Code 等）执行。
> 请用你自己的 shell（cmd / bash），**不要**用 DSH 的命令工具——它本身就是坏的。

---

## 0. 一句话

这台机器上，**任何**通过 `pwsh -Command "<任意命令>"` 启动的进程都会立即失败：
无标准输出，退出码 `3221225794`（十六进制 `0xC0000142` = `STATUS_DLL_INIT_FAILED`）。

目标是让 `pwsh -Command "echo hi"` 能正常返回 `hi`。

---

## 1. 环境事实

| 项 | 值 |
|---|---|
| 系统 | Windows（中文环境，代码页 936） |
| 工作目录 | `E:\qsc\玄武AI检测` |
| 用户 shell | cmd.exe 正常工作，能跑 node / python |
| DSH 自带 Node | `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| DSH 自带 Python | `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（已装 numpy 2.3.5） |
| DSH 安装位置 | **未知**。文档说在 `D:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\`，但该路径不存在，`C:\...\Programs\` 下也没有。请自行定位（见 §5.1） |
| 其他已装 | VS Code（含 `@microsoft/mxc-sdk`、`wxc-windows-sandbox-*` 组件）、Julia 1.12 |

---

## 2. 现象（精确复现）

在 DSH 的命令工具里执行**任何**命令，包括最简单的：

```
echo hi
```

返回：

```
(no output)
[exit code: 3221225794]
```

- `3221225794` = `0xC0000142` = `STATUS_DLL_INIT_FAILED`
- 含义：进程在加载 DLL / 初始化阶段就死了，**还没开始执行任何命令**
- 现象稳定复现，与命令内容无关

---

## 3. 首要未知项（请最先确认）

**问题到底在 PowerShell 7 本身，还是在 DSH 启动子进程的环境？**

请在**普通 cmd 窗口**（完全不经过 DSH）依次执行，并记录每条的实际输出：

```bat
where pwsh
pwsh -v
pwsh -Command "echo hi"
where powershell
powershell -v
powershell -Command "echo hi"
echo %DOTNET_ROOT%
echo %PSModulePath%
```

判读表：

| 结果 | 结论 | 跳到 |
|---|---|---|
| `pwsh` 在 cmd 里正常 | PowerShell 没坏，是 DSH 的子进程环境问题 | §4.3 |
| `pwsh` 报同样的错，`powershell`(5.1) 正常 | PowerShell 7 安装损坏 | §4.2 |
| 两个都报错 | 系统级问题（DLL / 环境变量 / 杀软） | §4.1 §5.2 |
| `where pwsh` 无输出 | PATH 里没有 pwsh | §4.2 |

---

## 4. 候选根因与修复（按概率排序）

### 4.1 `DOTNET_ROOT` 指向不存在的路径 ★最可能

PowerShell 7 是 .NET 应用。若 `DOTNET_ROOT` 指向已删除的 SDK 目录，启动会直接返回 `0xC0000142`。
这是这个错误码最常见的成因。

验证：

```bat
echo %DOTNET_ROOT%
dir "%DOTNET_ROOT%"
```

修复（若目录不存在）：

```bat
setx DOTNET_ROOT ""
```

然后**关闭并重开** cmd，再测 `pwsh -Command "echo hi"`。

### 4.2 PowerShell 7 安装损坏

```bat
winget uninstall --id Microsoft.PowerShell
winget install --id Microsoft.PowerShell --source winget
```

若 winget 不可用，从 https://github.com/PowerShell/PowerShell/releases 下载对应 MSI 安装。

安装后重开终端再测。

### 4.3 DSH 的子进程环境限制

仅在「pwsh 在 cmd 里正常、只在 DSH 里失败」时适用。可能原因：

- 桌面堆（Desktop Heap）耗尽 → **重启系统**后重试
- DSH 的沙箱模式（进程可能运行在受限令牌 / AppContainer 中，无法完成 DLL 初始化）
  - 查找 DSH 是否有「沙箱 / sandbox」设置项可关闭
  - 机器上装有 `@microsoft/mxc-sdk`（`wxc-windows-sandbox-*.exe`），可能与沙箱机制相关
- DSH 本体位于 `app.asar` 内，源码不可直接读取；如需改配置，先定位到用户级配置文件（见 §5.1）

---

## 5. 补充排查

### 5.1 定位 DSH 安装位置与配置

```bat
wmic process where "name='electron.exe'" get ExecutablePath,CommandLine
```
或任务管理器 → 详细信息 → 找到 DSH 进程 → 右键「打开文件所在位置」。

配置文件通常在：`%APPDATA%`、`%LOCALAPPDATA%`、`C:\Users\Administrator\.dsh\` 下，找 `.json` / `.toml` / `.yaml`。

### 5.2 系统完整性

```bat
sfc /scannow
DISM /Online /Cleanup-Image /RestoreHealth
```

### 5.3 事件日志

事件查看器 → Windows 日志 → 应用程序，筛选来源 `Application Error` 或 `SideBySide`，
查找 `pwsh.exe` 相关的错误记录，通常会指出缺哪个 DLL。

### 5.4 直接跑 pwsh 看错误

```bat
"C:\Program Files\PowerShell\7\pwsh.exe" -Command "echo hi"
echo %errorlevel%
```

若报「找不到 xxx.dll」「应用程序无法正常启动(0xc0000142)」，可确定是依赖缺失。

---

## 6. 验收标准

在 **DSH 的命令工具**里（不是 cmd）执行：

```
echo hi
```
→ 输出 `hi`，exit code 0

```
node --version
```
→ 输出版本号

两条都过，任务完成。

---

## 7. 约束（不要做）

- ❌ 不要修改 `E:\qsc\玄武AI检测\` 下的任何文件（项目数据：`samples.jsonl` / `model.json` / `calibration.json` / `*.bat` 都不要动）
- ❌ 不要卸载或升级 DSH 本体
- ❌ 不要关闭杀毒软件（可临时加白名单，完成后恢复）
- ❌ 不要删除 `C:\Users\Administrator\.dsh\dsh-runtimes\`（那是 DSH 的 Node/Python 运行时）
- ✅ 只修环境，不改业务

---

## 8. 回报格式

请按下面结构回报，便于下一步决策：

```
【第3节诊断输出】
<逐条粘贴实际输出>

【根因】
<一句话>

【做了什么】
<命令 + 结果>

【验收】
echo hi        -> <实际结果>
node --version -> <实际结果>
```

若确认无法从外部修复（例如必须改 DSH 源码），请明确说明：
「需要 DSH 侧修改，原因是 ……」，并给出你定位到的证据。
