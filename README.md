# dsh-relay-reasoning

English | [中文](README.zh.md)

Four real reasoning levels — **off / low / medium / high** — on every model of your OpenAI-compatible relay, right in the DSH model picker.

## The problem

Relays such as a self-hosted gateway fronting many models accept the `reasoning_effort` request parameter, but DSH offers no reasoning control for them. The reason is structural: `@deepseek-ai/dsh-llm-pi-ai` only publishes selectable levels for a model whose `reasoningEfforts` field declares them, so a route configured by hand shows nothing.

Declaring those levels by hand means repeating seven lines for every model — and re-doing it whenever the model list changes.

## What this plugin does

On activation it writes `reasoningEfforts` into the `llm-pi-ai` profile entry for every model on the configured providers, and the picker immediately offers the four levels. No restart, and no editing of your model list.

## Why four levels and not seven

pi-ai understands seven levels, but a relay only reacts to some of them. Measured on a relay route with a multi-step arithmetic prompt:

| Level | reasoning tokens |
|---|---|
| off | 0 |
| low | 482 |
| medium | 276 |
| high | 808 |
| minimal / xhigh / max | not distinguishable from high |

`minimal`, `xhigh` and `max` are accepted by the relay but do not change how much it actually thinks, so offering them would put duplicate choices in the picker. This plugin publishes only the four that produce different behavior.

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
        target: llm-pi-ai     # profile entry id to configure
        providers: []         # empty = every provider on that entry
        force: false          # true = rewrite even if already four levels
        debugLog: ""          # optional file path for diagnostics
```

`providers: []` means the plugin covers every provider on the entry, so adding a new relay needs no plugin change.

## Idempotent

Re-running the plugin rewrites nothing when every model already declares exactly these four levels. Updating the package therefore never churns your configuration, and any seven-level block left over from a manual setup is detected and rewritten to four.

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
