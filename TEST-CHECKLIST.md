# DeepSeek FlowLoom v0.13.0 — 功能测试清单

> 实测前确保：`npm run build` 编译通过，`.env` 中已配置 `DEEPSEEK_API_KEY`

---

## 1. CLI 入口

- [ ] `floom --version` / `floom -v` 显示版本号
- [ ] `floom --help` 显示帮助信息
- [ ] `floom "一句中文任务"` 执行单次任务并退出
- [ ] `floom`（无参数）进入交互 REPL
- [ ] `floom -C /path/to/project` 切换到指定目录

---

## 2. 交互 REPL 基础

- [ ] 欢迎界面正确显示（版本、模型、Node版本、用户、CWD、项目类型检测）
- [ ] 提示符 `❯ ` 正常显示
- [ ] 输入文本后 Enter 提交，agent 开始工作
- [ ] Ctrl+C 清空当前输入（非空行），再按一次退出
- [ ] Ctrl+D 空行时退出
- [ ] 退出时显示 `session_stop` 状态栏
- [ ] NO_COLOR=1 时颜色禁用
- [ ] TERM=dumb 时颜色禁用
- [ ] 管道输入时颜色禁用（`echo "help" | floom`）

---

## 3. Slash 命令菜单（滚动式）

- [ ] 输入 `/` 弹出命令下拉菜单，显示上边框 `───`
- [ ] 默认显示 12 项，带 `/命令名` + 描述
- [ ] ↑↓ 键在菜单中循环导航（到底回顶，到顶回底）
- [ ] 输入字符过滤命令（如 `/c` 只显示以 c 开头的命令）
- [ ] 当匹配项超过 12 个时，顶部显示 `↑ N more`
- [ ] 当滚动到底部时，底部显示 `↓ N more`
- [ ] Tab 键补全当前高亮命令
- [ ] Enter 键补全并提交
- [ ] Esc 键收起菜单
- [ ] 收起后继续输入字符，菜单重新弹出

---

## 4. Slash 命令

- [ ] `/help` — 显示所有命令列表
- [ ] `/model` — 显示当前模型
- [ ] `/model deepseek-chat` — 切换模型
- [ ] `/effort` — 显示当前 effort
- [ ] `/effort high` — 切换到 thinking 模型
- [ ] `/plan` — 开启计划模式（提示符变为 `❯(plan) `）
- [ ] `/plan` 再次 — 关闭计划模式
- [ ] `/plan revise` — 计划模式下显示修订提示
- [ ] `/clear` — 清空对话历史，显示清除消息数
- [ ] `/compact` — 手动压缩对话历史
- [ ] `/usage` — 显示 token 用量
- [ ] `/save` — 保存当前会话
- [ ] `/sessions` — 交互式会话列表（方向键选择→Resume/Delete）
- [ ] `/memory` — 显示持久记忆
- [ ] `/config` — 显示当前配置
- [ ] `/config set model deepseek-chat` — 修改配置并保存
- [ ] `/config reload` — 重载配置
- [ ] `/config reset` — 恢复默认配置
- [ ] `/cron` — 显示定时任务列表
- [ ] `/status` — 切换状态栏 ON/OFF
- [ ] `/retry` — 重试上一次失败的 turn
- [ ] `/code-review` — 启动代码审查技能
- [ ] `/simplify` — 启动简化技能
- [ ] `/architect` — 启动架构分析技能
- [ ] `/deep-review` — 启动对抗审查技能
- [ ] `/exit` / `/quit` — 退出 REPL

---

## 5. 命令别名

- [ ] `/fix` → 等同于 `/code-review`
- [ ] `/test` → 等同于 `/code-review`
- [ ] `/pr` → 等同于 `/code-review`

---

## 6. 命令历史

- [ ] ↑ 键回退到上一条命令
- [ ] ↓ 键前进到下一条
- [ ] 历史文件 `~/.floom/history.json` 正确读写
- [ ] 连续相同命令去重（不重复记录）
- [ ] 跨会话持久化（退出后重新进入，↑仍可访问历史）

---

## 7. Ctrl+R 历史搜索

- [ ] Ctrl+R 进入搜索模式，提示符变为 `(reverse-i-search''):`
- [ ] 输入字符实时过滤历史
- [ ] Ctrl+R 再次跳转到更早的匹配
- [ ] Enter 接受当前匹配
- [ ] Esc / Ctrl+C 退出搜索模式

---

## 8. 多行编辑

- [ ] Alt+Enter 在输入中插入换行符
- [ ] 多行粘贴保留换行
- [ ] Enter 提交整个多行文本
- [ ] Ctrl+C 清空整个多行输入

---

## 9. 模型调用核心

- [ ] 流式输出：模型回复逐字打印
- [ ] 思考链折叠（默认不显示 CoT，显示 `Thinking... (Xs) · ctrl+o to expand`）
- [ ] `--verbose` 模式下思考链实时流式打印
- [ ] Ctrl+O 展开上一个折叠块（思考链/tool输出）
- [ ] Ctrl+E 展开全部折叠块
- [ ] 工具调用紧凑行显示（`● tool_name(args) (Xs)`）
- [ ] 文件编辑后显示 unified diff（`---/+++` + `@@` hunks）
- [ ] 每轮 turn 结束显示汇总行（`── N tools · M tokens · X.Xs ──`）
- [ ] 每轮 turn 编号（`── turn N ──`）
- [ ] 思考链结束后显示 `── Response ──` 分区标记
- [ ] 状态栏显示模型名、token in/out/cache、plan 模式、会话时长
- [ ] 流式超时保护生效（网络断开60s内 AbortController 中断）

---

## 10. 工具执行

### 基础工具
- [ ] `read_file` — 读取文件，大文件 (>2MB) 拒绝
- [ ] `write_file` — 创建文件+父目录，返回路径
- [ ] `edit_file` — 精确字符串替换，原子写入
- [ ] `multi_edit` — 批量精确替换，原子写入
- [ ] `run_shell` — 执行 shell 命令，输出截断到 `FLOOM_TOOL_OUTPUT_LIMIT`
- [ ] `glob` — 文件名模式匹配
- [ ] `grep` — 内容正则搜索
- [ ] `web_fetch` — 获取 URL 内容
- [ ] `web_search` — DuckDuckGo 搜索

### Git 工具
- [ ] `git_diff` — 工作区变更
- [ ] `git_log` — 提交历史
- [ ] `git_branch` — 分支列表
- [ ] `git_commit` — 创建提交（需确认）
- [ ] `git_status` — 工作区状态
- [ ] `git_stash` — 暂存管理
- [ ] `git_push` / `git_pull` — 推送/拉取（需确认）
- [ ] `git_bisect` — 二分查找
- [ ] 其余 git 工具：worktree, fetch, merge, rebase, reset, revert, blame, tag

### 任务工具
- [ ] `task_create` — 创建任务，支持 priority (high/medium/low)
- [ ] `task_update` — 更新状态/结果
- [ ] `task_list` — 列表，按状态+优先级排序，显示进度摘要 (N/M completed)
- [ ] 非法 priority 返回错误

### Cron 工具
- [ ] `cron_create` — 创建定时任务
- [ ] `cron_list` — 列出任务
- [ ] `cron_delete` — 删除任务

---

## 11. 子 Agent

- [ ] `dispatch_agent` 派发子 agent 执行子任务
- [ ] 树形进度显示（`╭─ sub-agent` / `├─ tool_name` / `╰─ done`）
- [ ] 子 agent 跑完后清理后台进程
- [ ] 子 agent 工具白名单过滤正确

---

## 12. 计划模式

- [ ] 计划模式下只读工具放行，写工具拦截
- [ ] 模型调 `exit_plan_mode` 提交计划
- [ ] 方向键批准/拒绝计划
- [ ] 批准后计划保存到 `.floom/plan-{sessionId}.md`
- [ ] 批准后关闭计划模式，解锁全工具

---

## 13. 会话管理

- [ ] `/save` 持久化会话到 `.floom/sessions/`
- [ ] `--list-sessions` 列出已保存会话
- [ ] `-r` / `--resume` 恢复最近会话
- [ ] `-r <id>` 恢复指定会话
- [ ] 超过 50 个会话时自动清理旧会话
- [ ] 空目录下 `/sessions` 显示无会话提示

---

## 14. Workflow 执行

- [ ] `floom run script.mjs` 执行工作流脚本
- [ ] `--budget N` 限制 token 预算
- [ ] `--sandbox vm` 使用 NodeVmRuntime（需 `--unsafe-sandbox`）
- [ ] `--sandbox isolated` 默认（需 `npm install isolated-vm`）
- [ ] `--unsafe-sandbox` 允许回退到 vm
- [ ] 无 `--unsafe-sandbox` 且无 isolated-vm 时报错退出
- [ ] `FLOOM_WORKFLOW_CONCURRENCY` 控制并发数
- [ ] 负值并发自动回退默认值

---

## 15. 安全与权限

### 沙箱
- [ ] `--sandbox vm` 无 `--unsafe-sandbox` 报错退出
- [ ] `isolated-vm` 不可用时有清晰安装指引
- [ ] `NodeVmRuntime` 阻断 Date.now()/Math.random()/constructor/__proto__

### Hooks
- [ ] `.floom/hooks.json` PreToolUse allow/deny/ask 生效
- [ ] PostToolUse shell 命令执行
- [ ] hook 命令模板变量正确展开

### MCP
- [ ] `.floom/mcp.json` 配置的 server 正常连接
- [ ] 单 server 失败不阻塞其他 server
- [ ] MCP 工具以 `mcp_<server>_<tool>` 命名注册

---

## 16. 首次运行向导

- [ ] 无 API key 时交互式提示输入 key
- [ ] key 保存到 `~/.floom/.env`
- [ ] key 中特殊字符正确转义
- [ ] 向导拒绝空输入后仍能启动

---

## 17. Token 与成本

- [ ] 每个 turn 后 stderr 输出 `[usage] in=... out=... cacheHit=...`
- [ ] 前缀缓存命中正确报告
- [ ] 状态栏实时更新 token 统计

---

## 18. 错误处理

- [ ] 网络断开时显示 `[ERR-xxx] [Network Error]` + retryable 提示
- [ ] 429 限流显示 `[Rate Limited]` + 自动重试
- [ ] 5xx 服务端错误显示 `[Server Error]` + 自动重试
- [ ] 4xx 客户端错误不自动重试
- [ ] 熔断器连续失败后打开，拒绝请求
- [ ] 熔断器半开后探测成功则恢复

---

## 19. 权限审计

- [ ] PreToolUse deny/ask 决策写入 `.floom/permissions.log`
- [ ] 日志 JSONL 格式，含时间戳+工具名+决策+用户选择
- [ ] 超过 1000 行自动轮转

---

## 20. 配置热重载

- [ ] `/config` 显示当前配置（model, maxTokens, effort 等）
- [ ] `/config set <key> <value>` 写入 `.floom/settings.json`
- [ ] `/config reload` 重新加载
- [ ] `/config reset` 删除项目配置文件
- [ ] 嵌套键（`permissions.yolo`）正确写入
- [ ] `__proto__`/`constructor`/`prototype` 键被拒绝

---

## 21. 兼容性

- [ ] Windows PowerShell / CMD 正常工作
- [ ] Windows Terminal 正常显示 braille 动画
- [ ] Linux/macOS 终端正常
- [ ] 管道/CI 环境（无 TTY）不崩溃
- [ ] Node.js >= 24

---

## 测试结果

| 编号 | 测试项 | 结果 | 备注 |
|------|--------|------|------|
| 1 | CLI 入口 | ✅ | --version, --help, 管道输入, --list-sessions |
| 2 | 交互 REPL | ✅ | NO_COLOR, 欢迎界面(项目检测OK), 管道降级 |
| 3 | Slash 菜单 | ⏳ | 需 TTY 实测 |
| 4 | Slash 命令 | ✅ | /help(20cmd) /model /usage /config /cron /memory /save /sessions 管道通过; /code-review 需模型 |
| 5 | 命令别名 | ⏳ | 需 TTY 实测 |
| 6 | 命令历史 | ⏳ | 需 TTY 实测 |
| 7 | Ctrl+R | ⏳ | 需 TTY 实测 |
| 8 | 多行编辑 | ⏳ | 需 TTY 实测 |
| 9 | 模型调用 | ⬜ | 需 API key 实测 |
| 10 | 工具执行 | ✅ | 自动测试覆盖 (506 tests) |
| 11 | 子 Agent | ✅ | 自动测试覆盖 |
| 12 | 计划模式 | ✅ | 自动测试覆盖 |
| 13 | 会话管理 | ✅ | /save, --list-sessions(35会话), cleanOldSessions |
| 14 | Workflow | ✅ | 自动测试覆盖 |
| 15 | 安全权限 | ⏳ | 需 TTY 实测 hooks/MCP |
| 16 | 首次向导 | ⬜ | 需无 key 环境实测 |
| 17 | Token成本 | ⬜ | 需 API key 实测 |
| 18 | 错误处理 | ✅ | 自动测试覆盖 (classifyError/formatApiError) |
| 19 | 权限审计 | ✅ | auditLog 代码已验证 |
| 20 | 配置热重载 | ✅ | /config set 管道通过 |
| 21 | 兼容性 | ✅ | Windows 编译+测试通过
