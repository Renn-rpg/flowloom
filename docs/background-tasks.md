# 后台任务 / Monitor

长跑命令(dev server、文件监听、构建)不该阻塞 agent。`run_shell` 支持 `background:true`:立即返回一个任务句柄,agent 继续干别的,随时用 `bash_output` 轮询输出、用 `kill_shell` 终止。对位 Claude Code 的 `run_in_background` / `BashOutput` / `KillShell`。

## 工具

| 工具 | 作用 |
|------|------|
| `run_shell({ command, background: true })` | 后台启动,立即返回 `Started background shell bg_N …` |
| `bash_output({ id })` | 读取**自上次以来的新输出** + 状态(`[running]` / `[exited exit=N]` / `[killed]`) |
| `kill_shell({ id })` | SIGTERM 终止该后台进程 |

典型用法:`run_shell(npm run dev, background:true)` → 拿到 `bg_1` → 干别的 → `bash_output({id:'bg_1'})` 看是否 "listening on…" → 用完 `kill_shell({id:'bg_1'})`。

## 运行时行为

- 前台 `run_shell`(默认)不变:阻塞到命令结束,120s 超时,输出截断 10k。
- 后台进程的输出累积进**环形缓冲(单任务上限 100k,超出丢最旧)**;`bash_output` 增量读取(推进游标,只给新内容)。任务表也有上限(默认 100),超出淘汰最旧的**已结束**任务(运行中的永不淘汰)。
- 后台命令**仍走 shell 权限门禁**(策略拒绝 / 用户未批准则不启动),仍受路径围栏等既有约束。
- **整树终止**:`kill_shell` 先 SIGTERM(优雅),5s 未退出升级 SIGKILL;连同包装 shell 的子进程一起杀(posix 走进程组,win32 走 `taskkill /T`),不会只杀掉包装而漏掉真正的 dev server。状态由**进程真实退出**落定——一个忽略 SIGTERM 的进程不会被谎报为已终止。
- **退出必清理**:floom 任何方式退出(一次性跑完 / `/exit` / Ctrl-C / 运行中 turn 抛错 / OS SIGINT·SIGTERM)都经 `killAll()` 强制终止所有在跑后台进程——`try/finally` + 信号处理器双保险,不留孤儿。
- **子 agent 隔离**:子 agent 用**独立的后台管理器**,该子 agent 一结束就 `killAll`——子 agent 不会留下父 agent 看不见、控制不了的后台进程。

## 实现与边界

- `src/tools/shell-manager.ts` —— `BackgroundShells`(`start`/`read` 增量/`kill`/`killAll`/`list`,spawner 可注入便于单测)+ `makeBashOutputTool`/`makeKillShellTool`。
- `src/tools/bash.ts` —— `makeBashTool(shell, manager?)`,`background:true` 时交给管理器。
- `src/cli.ts` —— 会话级单例,`makeRegistry(policy, shells)` 注册三件套,退出 `killAll`。
- **架构不变式**:纯 `child_process`,在 `src/tools/`,不 import openai。

### 已知边界

- **Windows 退出码**:后台命令经 `pwsh -NoProfile -Command` 启动,`bash_output` 报的是 **pwsh 的退出码**,它会把子进程的具体非零码压成 `1`。因此**「成功(0)/失败(非零)」可靠,但具体非零码在 Windows 上不保真**(如子进程 `exit 3` 会显示 `exit=1`)。非 Windows(bash)下退出码保真。
- 后台进程随 floom 生命周期管理,退出即 `killAll`(整树)。需要**跨会话**长存的守护进程请用系统工具(`pm2`/`systemd` 等)。
- 子 agent 的后台任务在该子 agent 结束时即被清理,不会跨回主 agent;需要长存的后台任务请由主 agent 直接启动。
