# dsh-relay-reasoning

English | [中文](README.zh.md)

Four real reasoning levels — **off / low / medium / high** — on every model of your OpenAI-compatible relay, right in the DSH model picker.

## The problem

Relays such as a self-hosted gateway fronting many models accept the `reasoning_effort` request parameter, but DSH offers no reasoning control for them. The reason is structural: `@deepseek-ai/dsh-llm-pi-ai` only publishes selectable levels for a model whose `reasoningEfforts` field declares them, so a route configured by hand shows nothing.

Declaring those levels by hand means repeating seven lines for every model — and re-doing it whenever the model list changes.

## What this plugin does

On activation it writes `reasoningEfforts` into the `llm-pi-ai` profile entry for every model on the configured providers, and the picker immediately offers those levels. No restart, and no editing of your model list. `max` can be included on any relay that honors it.

## Why four levels by default, and where `max` went

pi-ai understands seven levels, but a relay does not distinguish all of them. Measured over three prompts and two passes on one relay route, median reasoning tokens per level:

| Level | median reasoning tokens |
|---|---|
| off | 0 |
| minimal | 108 |
| low | 122 |
| medium | 155 |
| high | 142 |
| xhigh | 125 |
| max | 359 |

Two things follow.

`max` is a genuinely stronger tier — roughly double everything else — so it is worth offering. It is **opt-in** because not every relay honors it, and declaring a level a route ignores would put a dead choice in the picker. Turn it on with `levels: [off, low, medium, high, max]`.

The five middle levels (`minimal` through `xhigh`) land within each other's noise on this route, so publishing them would only duplicate choices. They stay out by default but can be requested through `levels` if a route of yours does distinguish them.

The default is therefore `off / low / medium / high`; add `max` when your relay supports it.

## Install

From the DSH workshop (Settings → Workshop → Plugins), or directly:

```
plugin_manager install_bundle → dsh-relay-reasoning
```

Development builds can also be installed from a checkout:

```
plugin_manager install_bundle → <path to this repository>
```

## Configuration

The plugin row takes an optional config:

```yaml
- insert:
    - id: relay-reasoning
      name: dsh-relay-reasoning
      config:
        target: llm-pi-ai              # profile entry id to configure
        providers: []                  # empty = every provider on that entry
        levels: [off, low, medium, high]  # published levels, ascending
        force: false                   # true = rewrite even if already correct
        debugLog: ""                   # optional file path for diagnostics
```

`providers: []` means the plugin covers every provider on the entry, so adding a new relay needs no plugin change.

`levels` defaults to `off, low, medium, high`. Add `max` if your relay honors it:

```yaml
levels: [off, low, medium, high, max]
```

Any subset of `off, minimal, low, medium, high, xhigh, max` is accepted; names are published in ascending order and unknown names are dropped.

## Idempotent

Re-running the plugin rewrites nothing when every model already declares exactly the configured levels. Updating the package therefore never churns your configuration, and any leftover declaration from a manual setup is detected and rewritten.

Changing `levels` does rewrite the affected models, because their current declaration no longer matches.

## How it works

Two details are worth knowing if you read the source.

**It does not override the `llm-pi-ai` row.** A Cordis loader patch replaces a row's `config` wholesale rather than merging it, so a patch that added `reasoningEfforts` would erase `baseURL`, the credential reference, and the whole model list. The plugin instead calls `settings.mutate()` with path-scoped operations, touching only `providers.<name>.models[i].reasoningEfforts`.

**It writes outside the activation transaction.** The HMR config editor refuses to nest transactions, and its guard reads an `AsyncLocalStorage` store that survives awaits and timers, so deferring is not enough. The plugin waits for the Loader to settle, then runs the write through `hmr.executing.exit()` — the same mechanism `dsh-hmr` uses when wiring a config watcher from inside a transaction.

## Compatibility

- Requires DSH `>=0.2.1-rc.1`.
- No runtime dependencies: only `node:fs` and Host-provided services.
- Works with any OpenAI-compatible route declared on the `llm-pi-ai` entry, not just one relay.

## License

MIT
