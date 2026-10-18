# dsh-relay-reasoning

[English](README.md) | 中文

给你的 OpenAI 兼容中转站的每个模型加上 **关 / 低 / 中 / 高** 四档推理等级，直接出现在 DSH 的模型选择器里。

## 为什么需要它

像自建网关那样一个地址挂很多模型的中转站，是接受 `reasoning_effort` 请求参数的，但 DSH 对它们不显示任何推理控制。原因是结构性的：`@deepseek-ai/dsh-llm-pi-ai` 只会给声明了 `reasoningEfforts` 字段的模型提供可选档位，所以手工配置的路由什么也不显示。

手工声明意味着每个模型重复七行——而且每次模型列表变动都要重来一遍。

## 它做什么

插件激活时会把 `reasoningEfforts` 写进 `llm-pi-ai` 条目的每个模型，选择器立刻出现这些档位。不用重启，也不用改你的模型列表。中转站支持时可以把 `max` 一起纳入。

## 为什么默认四档，max 去哪了

pi-ai 认识七档，但中转站并不能把七档都区分开。用三道题、跑两轮测出的各档推理 token 中位数：

| 档位 | 推理 token 中位数 |
|---|---|
| 关 | 0 |
| minimal | 108 |
| 低 | 122 |
| 中 | 155 |
| 高 | 142 |
| xhigh | 125 |
| max | 359 |

由此有两点。

`max` 是一个真实更强的档位——大约是其它档的两倍，值得提供。它做成**可选**，因为不是每个中转站都认它；声明一个路由会忽略的档位，只会在选择器里多一个点不动的选项。要开启它，配置 `levels: [off, low, medium, high, max]`。

中间五档（`minimal` 到 `xhigh`）在这条路由上互相落在噪声范围内，放出来只是重复选项，所以默认不提供；如果你的路由确实能区分，可以通过 `levels` 自行指定。

因此默认是 `off / low / medium / high`，你的中转站支持时再加上 `max`。

## 安装

在 DSH 创意工坊（设置 → 创意工坊 → 插件）里安装，或者直接：

```
plugin_manager install_bundle → dsh-relay-reasoning
```

开发版也可以直接从本地检出安装：

```
plugin_manager install_bundle → <本仓库路径>
```

## 配置

插件行支持这些可选配置：

```yaml
- insert:
    - id: relay-reasoning
      name: dsh-relay-reasoning
      config:
        target: llm-pi-ai              # 要配置的 profile 条目 id
        providers: []                  # 空 = 该条目下所有 provider
        levels: [off, low, medium, high]  # 要提供的档位（自动按升序排列）
        force: false                   # true = 即使已经正确也重写
        debugLog: ""                   # 可选：诊断日志文件路径
```

`providers: []` 表示覆盖该条目上所有 provider，所以你以后再加中转站不用改插件。

`levels` 默认是 `off, low, medium, high`。如果中转站支持，加上 `max`：

```yaml
levels: [off, low, medium, high, max]
```

`off, minimal, low, medium, high, xhigh, max` 的任意子集都可用；档位会按升序写入，无法识别的名字会被丢弃。

## 幂等

如果每个模型都已经是配置的那几档，重跑不会改动任何东西。所以更新插件不会反复折腾你的配置；手工留下的其它档位声明也会被识别并改写。

改动 `levels` 会重写受影响的模型，因为现有声明已经对不上。

## 实现要点

读源码时有两个细节值得知道。

**它不覆盖 `llm-pi-ai` 行。** Cordis 的 loader patch 是整体替换该行的 `config`，而不是合并，所以用 patch 加 `reasoningEfforts` 会把 `baseURL`、密钥引用和整个模型列表冲掉。插件改用 `settings.mutate()` 做路径级写入，只碰 `providers.<name>.models[i].reasoningEfforts` 一个字段。

**它在激活事务之外写入。** HMR 配置编辑器拒绝嵌套事务，而它的守卫读的是 `AsyncLocalStorage`，该上下文会跨 await 和 timer 传播，所以单纯延后无效。插件会等 Loader 稳定后，通过 `hmr.executing.exit()` 在无事务上下文中执行写入——这也正是 `dsh-hmr` 自己在事务中接 watcher 时用的机制。

## 兼容性

- 需要 DSH `>=0.2.1-rc.1`。
- 零运行时依赖：只用 `node:fs` 和宿主提供的服务。
- 适用于 `llm-pi-ai` 条目上任何 OpenAI 兼容路由，不限于某一家中转站。

## 许可证

MIT
