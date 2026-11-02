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

- 插件宿主（magpie 进程里的 bun host）每 `tickSeconds`（默认 30 秒）看一次时钟，并顺手对齐一次状态；宿主重启、magpie 重启、插件更新后都会重新开始。
- magpie 可能同时加载多份插件宿主，所以用 `owner.json` 的租约只让一个进程看钟，其余待命；持有者停写心跳后，下一个 tick 由别的宿主接手。
- 只改 magpie 自己的开关：所有动作都走 `magpie provider off|on <id>`，不写 magpie 的任何文件。
- 每次动作都记日志：`~/.config/magpie/deepseek-peak-guard/logs/guard.log`，状态在 `state.json`。
- 幂等：已经到了该在的状态就不调用任何切换命令。

## 装上

```bash
magpie plugin add github:para1lel/deepseek-peak-guard
magpie plugin list                 # 看到 deepseek-peak-guard 就是装好了
magpie tool deepseek-peak-guard_deepseek_peak_status
```

插件会立刻跑一次，之后每 30 秒一次。

## 配置

`~/.config/magpie/deepseek-peak-guard/config.json`（不存在就用默认值；改完等下一次 tick 生效）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek` | 要开关的供应商 id（`magpie providers` 里的那一列） |
| `timezone` | `Asia/Shanghai` | 按哪个时区读钟 |
| `windows` | `["09:00-12:00","14:00-18:00"]` | 峰值时段，可多段，每段必须在同一天内 |
| `weekdays` | `[1,2,3,4,5]` | ISO 星期，1=周一 |
| `holidays` | `[]` | 平峰日，`YYYY-MM-DD`（上面时区的日期）；填上法定节假日就不会在假期里关供应商 |
| `tickSeconds` | `30` | 多久看一次钟（最小 5） |
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
node bin/deepseek-peak-guard.mjs tick            # 立刻按规则对齐一次
node bin/deepseek-peak-guard.mjs tick --now 2026-11-03T09:05:00+08:00   # 按指定时间演练
node bin/deepseek-peak-guard.mjs schedule        # 在前台常驻（不给插件宿主用）
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
