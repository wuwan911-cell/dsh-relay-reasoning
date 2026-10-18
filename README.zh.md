# dsh-relay-reasoning

[English](README.md) | 中文

给你的 OpenAI 兼容中转站的每个模型加上 **关 / 低 / 中 / 高** 四档推理等级，直接出现在 DSH 的模型选择器里。

## 为什么需要它

像自建网关那样一个地址挂很多模型的中转站，是接受 `reasoning_effort` 请求参数的，但 DSH 对它们不显示任何推理控制。原因是结构性的：`@deepseek-ai/dsh-llm-pi-ai` 只会给声明了 `reasoningEfforts` 字段的模型提供可选档位，所以手工配置的路由什么也不显示。

手工声明意味着每个模型重复七行——而且每次模型列表变动都要重来一遍。

## 它做什么

插件激活时会把 `reasoningEfforts` 写进 `llm-pi-ai` 条目的每个模型，选择器立刻出现四档。不用重启，也不用改你的模型列表。

## 为什么是四档，不是七档

pi-ai 认识七档，但中转站只对其中一部分有反应。用一道多步算术题实测：

| 档位 | 推理 token |
|---|---|
| 关 | 0 |
| 低 | 482 |
| 中 | 276 |
| 高 | 808 |
| minimal / xhigh / max | 与「高」无法区分 |

`minimal`、`xhigh`、`max` 中转站照收，但不会让它想得更多，放进选择器只是重复选项。这个插件只发布真正有区别的四档。

## 安装

在 DSH 创意工坊（设置 → 创意工坊 → 插件）里安装，或者：

```
plugin_manager install_bundle → dsh-relay-reasoning
```

## 配置

插件行支持这些可选配置：

```yaml
- insert:
    - id: relay-reasoning
      name: dsh-relay-reasoning
      config:
        target: llm-pi-ai     # 要配置的 profile 条目 id
        providers: []         # 空 = 该条目下所有 provider
        force: false          # true = 即使已经是四档也重写
        debugLog: ""          # 可选：诊断日志文件路径
```

`providers: []` 表示覆盖该条目上所有 provider，所以你以后再加中转站不用改插件。

## 幂等

如果每个模型都已经是这四档，重跑不会改动任何东西。所以更新插件不会反复折腾你的配置；手工留下的七档块也会被识别并改写成四档。

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
