# deepseek-peak-guard

给 magpie 用的一个小插件：**DeepSeek 官方 API 的峰值计价时段开始时，把 `DeepSeek Official` 供应商关掉；峰值时段结束时再打开。**

关掉的是供应商，不是模型组——`group/deepseek-flash`、`group/deepseek-v4-pro` 这类路由组会自动落到下一个成员（opencode-go / lingsuan-other），所以 agent 不会断，只是不再走 DeepSeek 官方那条峰谷差价最大的线路。

## 峰值时段是哪两段

DeepSeek 官方文档的口径（UTC）：**每周一到周五 01:00–04:00、06:00–10:00**，中国法定节假日不算；其余时间（含周末）都是平峰价。

换到本插件默认的 `Asia/Shanghai`，就是工作日里的两段：

```
09:00-12:00   14:00-18:00
```

也就是说：这两个时段内供应商关闭，其余时间开启。

## 它怎么工作

- **不轮询**：插件平时什么都不跑。它只把「下一个价格边界」作为**一次性**任务放到操作系统调度器上（Linux `systemd --user` timer 的 `OnCalendar=<那一刻>`，Windows 计划任务的一次性触发器），到点执行一次，执行完再把下一次放上去。两个边界之间机器是闲的。
- **不弹窗**：Windows 上那个任务不直接起解释器，而是经一个生成的 `run-hidden.vbs`——`wscript.exe` 是窗口程序，脚本用窗口样式 0 起进程，控制台窗口根本不会出现（即使一次运行要几秒）。
- 为什么不用插件宿主里的 `setInterval`：magpie 装载插件的那次宿主进程很短命，进程一走定时器就没了（第一版踩过的坑）。
- 漏跑补偿：Linux 的 timer 带 `Persistent=true`，Windows 的任务带 `StartWhenAvailable`，机器休眠/关机错过那一刻的话，醒来会补跑一次。
- 只改 magpie 自己的开关：所有动作都走 `magpie provider off|on <id>`，不写 magpie 的任何文件。
- 每次动作都记日志：`~/.config/magpie/deepseek-peak-guard/logs/guard.log`，状态在 `state.json`。
- 幂等：已经到了该在的状态就不调用任何切换命令。

## 装上

```bash
magpie plugin add github:para1lel/deepseek-peak-guard
magpie plugin list                 # 看到 deepseek-peak-guard 就是装好了
magpie tool deepseek-peak-guard_deepseek_peak_status
```

插件加载时会把下一次边界排上（`status` 里能看到 `schedule` 那一行），之后每次执行自己续下一次。

## 配置

`~/.config/magpie/deepseek-peak-guard/config.json`（不存在就用默认值；改完等下一次边界执行时生效）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek` | 要开关的供应商 id（`magpie providers` 里的那一列） |
| `timezone` | `Asia/Shanghai` | 按哪个时区读钟 |
| `windows` | `["09:00-12:00","14:00-18:00"]` | 峰值时段，可多段，每段必须在同一天内 |
| `weekdays` | `[1,2,3,4,5]` | ISO 星期，1=周一 |
| `holidays` | `[]` | 平峰日，`YYYY-MM-DD`（上面时区的日期）；填上法定节假日就不会在假期里关供应商 |
| `dryRun` | `false` | 只报告不改开关 |
| `respectManualOff` | `false` | 平峰时如果供应商是别人手动关的，是否不去打开它 |
| `magpie` | `""` | magpie 可执行文件路径；为空时用 PATH，再退回 `~/.local/bin/magpie` |

`holidays` 是唯一需要人维护的一项：DeepSeek 的规则里法定节假日算平峰，插件默认只认周末。填 2026 年的假期可以这样：

```json
{ "holidays": ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"] }
```

## 命令行

插件宿主没跑的时候（或者只想看一眼）也能用：

```bash
node bin/deepseek-peak-guard.mjs status          # 现在是不是峰值、下一次切换在几分钟后
node bin/deepseek-peak-guard.mjs status --json
node bin/deepseek-peak-guard.mjs tick            # 立刻按规则对齐一次，并排上下一段边界
node bin/deepseek-peak-guard.mjs tick --now 2026-11-03T09:05:00+08:00   # 按指定时间演练
node bin/deepseek-peak-guard.mjs install-schedule     # 把下一次边界排成一次性任务
node bin/deepseek-peak-guard.mjs schedule-status      # 下一次是几点、任务在不在
node bin/deepseek-peak-guard.mjs uninstall-schedule   # 卸掉
node bin/deepseek-peak-guard.mjs config          # 看当前配置和状态目录
```

## 两个工具（agent 可直接调）

- `deepseek_peak_status` — 当前时钟、是否峰值、下一次切换、供应商状态。
- `deepseek_peak_sync` — 立刻对齐一次，不等下一次 tick。

## 测试

```bash
npm test
```

覆盖两段窗口的开闭边界、午休、周末、工作日里的节假日，以及「周五晚上之后下一次切换是周一早上」这类跨天跳转。

## 许可

MIT
