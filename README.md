# deepseek-peak-guard

给 magpie 用的一个小插件：**DeepSeek 官方 API 的峰值计价时段开始时，把 `DeepSeek Official` 供应商关掉；峰值时段结束时再打开。**

关掉的是供应商，不是模型组——`group/deepseek-flash`、`group/deepseek-v4-pro` 这类路由组会自动落到下一个成员（opencode-go / lingsuan-other / workbuddy），所以 agent 不会断，只是不再走 DeepSeek 官方那条峰谷差价最大的线路。

## 峰值时段是哪两段

DeepSeek 官方文档的口径（UTC）：**每周一到周五 01:00–04:00、06:00–10:00**，中国法定节假日不算；其余时间（含周末）都是平峰价。

换到本插件默认的 `Asia/Shanghai`，就是工作日里的两段：

```
09:00-12:00   14:00-18:00
```

## 它怎么工作

一天只跑四次，而且这四次是**装一次就固定的**：

```
Mon..Fri   09:00  12:00  14:00  18:00
```

- **不轮询**：两次边界之间没有任何进程、定时器或循环在跑。没有 `setInterval`，也没有「跑完再排下一次」。
- **不自己改自己的时间表**：1.x 让每次运行把下一次边界写回 systemd/计划任务，结果是在定时器拉起的服务里调 `systemctl`，把用户级 systemd 卡死、进程级联——两台机器都因此挂过。2.0 移除了这条路径：`install-schedule` 写一次 schedule，之后只有操作系统按表执行，运行中的 tick 只读时钟、只动供应商开关。
- **不弹窗**：Windows 上任务不直接起解释器，而是 `wscript.exe "<state>\run-hidden.vbs" tick`。`wscript` 是窗口程序，脚本用窗口样式 0 起 node，node 再起的 `magpie.exe` 继承同一个隐藏控制台，所以整条链路都看不到窗口。
- **读文件，不跑 `magpie providers`**：判断开关状态直接读 `~/.config/magpie/providers.json` 的 `off` 字段。`magpie providers` 会起一整个 magpie 进程（连带插件宿主），对一个「现在是开还是关」的问题太重了。
- **最多一次 magpie 调用**：只有开关和时钟不一致时才执行 `magpie provider off|on <id>`，执行完再把 `providers.json` 读回来核对；不一致会记日志，但不会重试成环。
- **幂等**：已经到了该在的状态就什么都不做（`action: none`）。
- **串行**：`tick` 拿一个 `<state>/tick.lock`，重叠的第二次直接退出，不会两个 tick 抢着翻开关。
- **漏跑补偿**：Linux timer 带 `Persistent=true`，Windows 任务带 `StartWhenAvailable`——机器关机/休眠错过那一刻，醒来会补跑一次，tick 会把状态对齐到当时该有的样子。

状态目录：`~/.config/magpie/deepseek-peak-guard/`

| 文件 | 作用 |
| --- | --- |
| `cli.txt` | 两行：解释器路径、CLI 脚本路径。调度器的 shim 每次运行都读它。`install-schedule` 优先选系统 node（`/usr/bin/node`、`/usr/local/bin/node`、`C:\Program Files\nodejs\node.exe`），免得 nvm 或 magpie 自带的 bun 换版本后 path 失效 |
| `run-hidden.vbs` / `tick.sh` | 调度器真正启动的东西：读 `cli.txt`，静默 exec |
| `state.json` | 最近 20 次 tick 的动作和历史 |
| `logs/guard.log` | 每次 tick 一行；切换时多一行 magpie 的回复 |

`magpie plugin update` 会替换插件目录，所以计划任务/unit 不指向插件目录里的任何文件，只指向上面这两个 shim；插件加载时如果发现 `cli.txt` 或 shim 丢了/旧了，会就地重写（纯文件操作，不 shell out），这就是 1.2 那类「找不到 run-hidden.vbs」的永久修复。

## 装上

```bash
magpie plugin add github:para1lel/deepseek-peak-guard
magpie plugin list                                  # 看到 deepseek-peak-guard 就是装好了
node ~/.config/magpie/plugins/.../bin/deepseek-peak-guard.mjs install-schedule
```

`install-schedule` 做三件事：写 shim 和 `cli.txt`、把四条边界写进 systemd timer 或 Windows 任务、立刻跑一次 tick 把当前状态对齐。**装一次就够了**，它不会在运行时再排下一次。

装完检查：

```bash
node bin/deepseek-peak-guard.mjs status
node bin/deepseek-peak-guard.mjs schedule-status      # matches: yes 表示 config 和已安装的表一致
systemctl --user list-timers deepseek-peak-guard.timer   # Linux
Get-ScheduledTaskInfo -TaskName DeepSeekPeakGuard        # Windows
```

## 配置

`~/.config/magpie/deepseek-peak-guard/config.json`（不存在就用默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek` | 要开关的供应商 id（`providers.json` 里的 `id`） |
| `timezone` | `Asia/Shanghai` | 按哪个时区读钟 |
| `windows` | `["09:00-12:00","14:00-18:00"]` | 峰值时段，可多段，每段必须在同一天内 |
| `weekdays` | `[1,2,3,4,5]` | ISO 星期，1=周一 |
| `holidays` | `[]` | 平峰日，`YYYY-MM-DD`（上面时区的日期）；填上法定节假日就不会在假期里关供应商 |
| `dryRun` | `false` | 只报告不改开关 |
| `respectManualOff` | `false` | 平峰时如果供应商是别人手动关的，是否不去打开它 |
| `magpie` | `""` | magpie 可执行文件路径；为空时用 PATH，再退回 `~/.local/bin/magpie` |

改 `windows` / `weekdays` 之后要重跑一次 `install-schedule`——调度表是静态的，不会自己跟着配置变（`schedule-status` 的 `matches: no` 就是在提醒这件事）。`holidays` 不用重装，tick 每次都读。

`holidays` 是唯一需要人维护的一项：DeepSeek 的规则里法定节假日算平峰，插件默认只认周末。填 2026 年的假期可以这样：

```json
{ "holidays": ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"] }
```

## 命令行

调度器跑的是 `tick`；其余命令给人用：

```bash
node bin/deepseek-peak-guard.mjs status [--json] [--now 2026-11-03T09:05:00+08:00]
node bin/deepseek-peak-guard.mjs tick [--now …] [--dry-run] [--json]
node bin/deepseek-peak-guard.mjs install-schedule [--no-converge] [--json]
node bin/deepseek-peak-guard.mjs uninstall-schedule
node bin/deepseek-peak-guard.mjs schedule-status [--json]
node bin/deepseek-peak-guard.mjs config [--json]
```

演练不碰真开关：

```bash
node bin/deepseek-peak-guard.mjs tick --now 2026-11-03T09:00:30+08:00 --dry-run   # would-off
node bin/deepseek-peak-guard.mjs tick --now 2026-11-03T13:00:00+08:00 --dry-run   # none
```

## 三个工具（agent 可直接调）

- `deepseek_peak_status` — 当前时钟、是否峰值、下一次切换、`providers.json` 里的开关、调度表是否与配置一致。
- `deepseek_peak_sync` — 立刻对齐一次（读文件 + 最多一次 magpie 调用），不涉及调度。
- `deepseek_peak_install` — 安装/修复调度表，然后对齐一次。幂等。

## 已知边界

- **时区**：调度器按本机本地时间触发，`timezone` 只决定 tick 怎么解释这个钟。本机时区不是 `Asia/Shanghai` 时，要么把系统时区改对，要么改 `windows`。
- **假期**：静态调度表不知道假期，假期里的 09:00 tick 会看到「非峰值」，因此不会关；这是对的。真正需要补的是「假期结束当天 09:00」——那天会正常关。
- **手动改开关**：`respectManualOff: false`（默认）意味着 18:00 的 tick 会把任何人手动关掉的供应商重新打开。想保留手动操作就设成 `true`。
- **macOS**：没有 launcher（只支持 systemd `--user` 和 Windows 计划任务），`install-schedule` 会报错；`tick` 本身在任何平台都能跑。

## 测试

```bash
npm test
```

40 项，覆盖两段窗口的开闭、午休、周末、工作日假期、跨天/跨周跳转，四条边界的 systemd/Windows 两种写法、`24:00` 的跨日移位、shim 的生成与幂等，以及 tick 的「该关就关、该开就开、不该动就不动、只说一次、失败不重试」。

## 许可

MIT
