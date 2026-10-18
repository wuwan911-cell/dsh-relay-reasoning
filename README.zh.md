# dsh-relay-reasoning

[English](README.md) | 中文

给你的 OpenAI 兼容中转站的每个模型加上 **关 / 低 / 中 / 高 / max** 五档推理等级，直接出现在 DSH 的模型选择器里。

## 为什么需要它

像自建网关那样一个地址挂很多模型的中转站，是接受 `reasoning_effort` 请求参数的，但 DSH 对它们不显示任何推理控制。原因是结构性的：`@deepseek-ai/dsh-llm-pi-ai` 只会给声明了 `reasoningEfforts` 字段的模型提供可选档位，所以手工配置的路由什么也不显示。

手工声明意味着每个模型重复七行——而且每次模型列表变动都要重来一遍。

## 它做什么

插件会把 `reasoningEfforts` 写进 `llm-pi-ai` 条目的每个模型，选择器立刻出现这些档位。不用重启，也不用改你的模型列表。

**它会一直跟着配置走。** 激活时写一次，之后每次 profile 配置重载（在设置里新加一个中转站、加一个模型、改一条路由）都会再检查一遍并补上缺的档位。所以你在设置界面里接入一个新 API，它的模型会自动拿到思考等级，不用重启 DSH。

## 为什么是这五档

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

`max` 大约是其它档的两倍，是真实更强的一档，所以默认提供。

中间五档（`minimal` 到 `xhigh`）在这条路由上互相落在噪声范围内，放出来只是重复选项，所以默认不提供；如果你的路由确实能区分，可以通过 `levels` 自行指定。

如果你的中转站其实不认 `max`，用 `levels: [off, low, medium, high]` 去掉它，免得选择器里留一个点不动的档位。

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
        target: llm-pi-ai                 # 要配置的 profile 条目 id
        providers: []                     # 空 = 该条目下所有 provider
        levels: [off, low, medium, high, max]  # 要提供的档位（自动按升序排列）
        force: false                      # true = 激活时即使已经正确也重写一次
        debugLog: ""                      # 可选：诊断日志文件路径
```

`providers: []` 表示覆盖该条目上所有 provider，所以你以后再加中转站不用改插件。

`levels` 默认是 `off, low, medium, high, max`。如果中转站不认某一档，去掉它即可：

```yaml
levels: [off, low, medium, high]
```

`off, minimal, low, medium, high, xhigh, max` 的任意子集都可用；档位会按升序写入，无法识别的名字会被丢弃。

## 幂等

如果每个模型都已经是配置的那几档，检查一次就结束，不会写任何东西。所以更新插件、以及插件自己写入后触发的那次配置重载，都不会反复折腾你的配置；手工留下的其它档位声明也会被识别并改写。

改动 `levels` 会重写受影响的模型，因为现有声明已经对不上。

`force: true` 只在插件激活时生效（重写一次，包括已经正确的声明）；之后的重载不会因为 `force` 再写一遍，否则会和配置重载互相触发、来回刷新。

## 实现要点

读源码时有三个细节值得知道。

**它不覆盖 `llm-pi-ai` 行。** Cordis 的 loader patch 是整体替换该行的 `config`，而不是合并，所以用 patch 加 `reasoningEfforts` 会把 `baseURL`、密钥引用和整个模型列表冲掉。插件改用 `settings.mutate()` 做路径级写入，只碰 `providers.<name>.models[i].reasoningEfforts` 一个字段。

**它在事务之外写入。** HMR 配置编辑器拒绝嵌套事务，而它的守卫读的是 `AsyncLocalStorage`，该上下文会跨 await 和 timer 传播，所以单纯延后无效。插件通过 `hmr.executing.exit()` 在无事务上下文中执行写入——这也正是 `dsh-hmr` 自己在事务中接 watcher 时用的机制。

**它监听 `app-boot/config-reload`。** 每一次成功的配置重载都会发这个事件（包括设置界面里加中转站、加模型）。插件在事件后稍等片刻再检查一遍，写完后自身触发的重载只会看到"已经正确"而结束，不会形成循环；重复事件会合并成一次检查。

## 兼容性

- 需要 DSH `>=0.2.1-rc.1`。
- 零运行时依赖：只用 `node:fs` 和宿主提供的服务。
- 适用于 `llm-pi-ai` 条目上任何 OpenAI 兼容路由，不限于某一家中转站。

## 许可证

MIT
