# dsh-relay-reasoning

English | [中文](README.zh.md)

Real reasoning levels — **off / low / medium / high / max** — on every model of your OpenAI-compatible relay, right in the DSH model picker.

## The problem

Relays such as a self-hosted gateway fronting many models accept the `reasoning_effort` request parameter, but DSH offers no reasoning control for them. The reason is structural: `@deepseek-ai/dsh-llm-pi-ai` only publishes selectable levels for a model whose `reasoningEfforts` field declares them, so a route configured by hand shows nothing.

Declaring those levels by hand means repeating seven lines for every model — and re-doing it whenever the model list changes.

## What this plugin does

It writes `reasoningEfforts` into the `llm-pi-ai` profile entry for every model on the configured providers, and the picker immediately offers those levels. No restart, and no editing of your model list.

**It keeps up with your configuration.** The first pass runs at activation, and every later profile configuration reload — adding a relay or a model from the settings UI, editing a route — runs it again and fills in whatever is missing. A relay you connect while DSH is running gets its levels without a restart.

## Why these five levels

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

`max` is roughly double every other level, so it is a genuinely stronger tier and is included by default.

The five middle levels (`minimal` through `xhigh`) land within each other's noise on this route, so publishing them would only duplicate choices. They stay out by default but can be requested through `levels` if a route of yours does distinguish them.

If your relay turns out to ignore `max`, drop it with `levels: [off, low, medium, high]` so the picker does not offer a level that does nothing.

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
        target: llm-pi-ai                 # profile entry id to configure
        providers: []                     # empty = every provider on that entry
        levels: [off, low, medium, high, max]  # published levels, ascending
        force: false                      # true = rewrite once at activation even if already correct
        debugLog: ""                      # optional file path for diagnostics
```

`providers: []` means the plugin covers every provider on the entry, so adding a new relay needs no plugin change.

`levels` defaults to `off, low, medium, high, max`. Narrow it if your relay ignores a level:

```yaml
levels: [off, low, medium, high]
```

Any subset of `off, minimal, low, medium, high, xhigh, max` is accepted; names are published in ascending order and unknown names are dropped.

## Idempotent

A pass writes nothing when every model already declares exactly the configured levels; it inspects and stops. Updating the package, and the configuration reload caused by the plugin's own write, therefore never churn your configuration, and any leftover declaration from a manual setup is detected and rewritten.

Changing `levels` does rewrite the affected models, because their current declaration no longer matches.

`force: true` is honoured at activation only — it rewrites once, including declarations that are already correct. Later reloads ignore it, because honouring it every time would rewrite the same declaration and reload in a loop.

## How it works

Three details are worth knowing if you read the source.

**It does not override the `llm-pi-ai` row.** A Cordis loader patch replaces a row's `config` wholesale rather than merging it, so a patch that added `reasoningEfforts` would erase `baseURL`, the credential reference, and the whole model list. The plugin instead calls `settings.mutate()` with path-scoped operations, touching only `providers.<name>.models[i].reasoningEfforts`.

**It writes outside the transaction.** The HMR config editor refuses to nest transactions, and its guard reads an `AsyncLocalStorage` store that survives awaits and timers, so deferring is not enough. The plugin runs the write through `hmr.executing.exit()` — the same mechanism `dsh-hmr` uses when wiring a config watcher from inside a transaction.

**It listens to `app-boot/config-reload`.** Every successful profile reload emits that event — including a relay added from the settings UI. The plugin inspects once shortly afterwards; a reload caused by its own write only finds everything already correct and stops, so there is no loop, and a burst of events collapses into one inspection.

## Compatibility

- Requires DSH `>=0.2.1-rc.1`.
- No runtime dependencies: only `node:fs` and Host-provided services.
- Works with any OpenAI-compatible route declared on the `llm-pi-ai` entry, not just one relay.

## License

MIT
