/**
 * Relay Reasoning Effort plugin.
 *
 * OpenAI-compatible relays (such as a self-hosted gateway fronting many models)
 * usually accept `reasoning_effort` but expose no way for the Harness model
 * picker to offer it. `@deepseek-ai/dsh-llm-pi-ai` only publishes selectable
 * levels for a model whose `reasoningEfforts` field declares them, so a route
 * configured by hand shows no reasoning control at all.
 *
 * This plugin declares reasoning levels on every model of the configured relay
 * routes by writing `reasoningEfforts` through the settings service, which
 * performs a path-scoped merge. That matters: a Cordis loader patch replaces a
 * row's `config` wholesale, so overriding the `llm-pi-ai` row to add this field
 * would erase its `baseURL`, credential reference, and model list. Writing
 * through `settings.mutate` touches only the one property per model.
 *
 * Which levels: the default is off / low / medium / high, and `max` is offered
 * on request through the `levels` option. pi-ai understands seven levels, but a
 * relay does not distinguish all of them. Measured over three prompts and two
 * passes on one relay route, median reasoning tokens were 0 for off, ~108-155
 * for minimal through xhigh, and 359 for max: max is a genuinely stronger tier,
 * while the five middle levels sit inside each other's noise. Those five are
 * therefore not published by default, since they would only duplicate choices.
 *
 * The apply step is idempotent: re-running it rewrites the same levels and
 * leaves any model that already declares exactly them untouched. Updating this
 * package therefore does not require re-entering any configuration.
 */

import { appendFileSync } from 'node:fs';

/**
 * The levels to publish. `off` is the empty wire value. `max` is a real tier on
 * relays that honor it, so it is offered on request; `minimal` and `xhigh` are
 * accepted by relays but measure the same as the levels around them, so they
 * stay out by default.
 */
const DEFAULT_LEVELS = ['off', 'low', 'medium', 'high'];

/** Every level pi-ai knows, in ascending order, with the wire spelling to send. */
const ALL_LEVELS = [
  ['off', null],
  ['minimal', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
];

/** Narrow ALL_LEVELS down to the named levels, preserving ascending order. */
function selectedLevels(names) {
  const want = new Set(names);
  return ALL_LEVELS.filter(([level]) => want.has(level));
}

/**
 * Build the diagnostic sink for one activation. The Host logger is used when it
 * is available; `debugLog` appends to a file as well, for deployments where no
 * logger output is reachable.
 */
function makeDiag(logger, debugLog) {
  return (message) => {
    try {
      logger?.info?.(`relay-reasoning: ${message}`);
    } catch {
      // A logger that throws must not break activation.
    }
    if (typeof debugLog !== 'string' || debugLog.length === 0) return;
    try {
      appendFileSync(debugLog, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Diagnostics must never break activation.
    }
  };
}

/** Build the reasoningEfforts object for one model. */
function efforts(levels) {
  const out = {};
  for (const [level, wire] of levels) out[level] = wire;
  return out;
}

/**
 * Whether a model entry already carries exactly the levels to publish. A model
 * declaring anything else is rewritten.
 */
function alreadyDeclared(value, levels) {
  if (value === false || value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (keys.length !== levels.length) return false;
  for (const [level, wire] of levels) {
    if (!Object.prototype.hasOwnProperty.call(value, level)) return false;
    if ((value[level] ?? null) !== wire) return false;
  }
  return true;
}

export const name = 'relay-reasoning';

/** Settings is optional so the plugin stays inert in profiles without it. */
export const inject = [];

export function apply(ctx, config) {
  const target = config?.target ?? 'llm-pi-ai';
  // An empty list means "every provider on the row", which keeps this working
  // when a new relay is added without touching the plugin configuration.
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const force = config?.force ?? false;
  const debugLog = config?.debugLog;
  // An explicit level list replaces the default; unknown names are dropped.
  const requested = Array.isArray(config?.levels) && config.levels.length > 0
    ? selectedLevels(config.levels.map(String))
    : selectedLevels(DEFAULT_LEVELS);
  const levels = requested.length > 0 ? requested : selectedLevels(DEFAULT_LEVELS);
  const levelNames = levels.map(([level]) => level).join('/');

  ctx.inject(['settings'], (child) => {
    const diag = makeDiag(child.logger ?? ctx.logger, debugLog);

    child.effect(() => {
      let cancelled = false;

      const run = async () => {
        const settings = child.get('settings');
        if (!settings) return;

        let described;
        try {
          described = settings.describe();
        } catch (error) {
          diag(`describe failed: ${error?.message ?? error}`);
          return;
        }

        const entry =
          described.find((item) => String(item.ns) === target) ??
          described.find((item) => String(item.ns).includes(target));
        if (!entry) {
          diag(`no settings entry matching "${target}"`);
          return;
        }

        const routes = (entry.value ?? {}).providers ?? {};
        const ops = [];
        for (const [providerName, route] of Object.entries(routes)) {
          if (providers.length > 0 && !providers.includes(providerName)) continue;
          const models = Array.isArray(route?.models) ? route.models : [];
          for (let index = 0; index < models.length; index += 1) {
            const model = models[index];
            if (model === null || typeof model !== 'object') continue;
            if (!force && alreadyDeclared(model.reasoningEfforts, levels)) continue;
            ops.push({
              op: 'set',
              path: ['providers', providerName, 'models', String(index), 'reasoningEfforts'],
              value: efforts(levels),
            });
          }
        }

        if (ops.length === 0) return;
        if (cancelled) return;

        const write = async (revision) => {
          await settings.mutate(target, ops, revision);
        };

        try {
          await write(entry.revision);
          diag(`declared ${levelNames} on ${ops.length} model(s)`);
        } catch (error) {
          if (cancelled) return;
          diag(`mutate failed: ${error?.message ?? error}`);
          // A concurrent edit bumps the revision; retrying once settles it.
          try {
            const retry = settings.describe().find((item) => String(item.ns) === String(entry.ns));
            if (retry !== undefined) {
              await write(retry.revision);
              diag(`declared ${levelNames} on ${ops.length} model(s) after retry`);
            }
          } catch (second) {
            diag(`retry failed: ${second?.message ?? second}`);
          }
        }
      };

      // Writing configuration goes through the HMR config editor, whose
      // `runExclusive` refuses to nest inside the transaction that installed
      // this plugin. That guard reads an AsyncLocalStorage store, which survives
      // awaits and timers, so deferring inside this call chain never escapes it.
      // The escape is the HMR service's own `exit` helper, which runs a callback
      // with no store attached — the same mechanism dsh-hmr uses when it wires
      // a config watcher from inside a transaction.
      const later = () =>
        new Promise((resolve) => {
          const schedule = typeof setImmediate === 'function' ? setImmediate : setTimeout;
          schedule(resolve);
        });

      const finish = () => {
        if (cancelled) return Promise.resolve();
        const hmr = typeof child.get === 'function' ? child.get('hmr') : undefined;
        const store = hmr?.executing;
        if (store && typeof store.exit === 'function') return store.exit(run);
        return run();
      };

      const loader = ctx.root?.loader;
      const start =
        loader && typeof loader.await === 'function' ? loader.await() : Promise.resolve();

      start
        .then(later)
        .then(finish)
        .catch((error) => diag(`scheduled run failed: ${error?.message ?? error}`));

      return () => {
        cancelled = true;
      };
    });
  });
}
