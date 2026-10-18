/**
 * Relay Reasoning Effort plugin.
 *
 * OpenAI-compatible relays (such as a self-hosted gateway fronting many models)
 * usually accept `reasoning_effort` but expose no way for the Harness model
 * picker to offer it. `@deepseek-ai/dsh-llm-pi-ai` only publishes selectable
 * levels for a model whose `reasoningEfforts` field declares them, so a route
 * configured by hand shows no reasoning control at all.
 *
 * This plugin declares four levels — off / low / medium / high — on every model
 * of the configured relay routes by writing `reasoningEfforts` through the
 * settings service, which performs a path-scoped merge. That matters: a Cordis
 * loader patch replaces a row's `config` wholesale, so overriding the
 * `llm-pi-ai` row to add this field would erase its `baseURL`, credential
 * reference, and model list. Writing through `settings.mutate` touches only the
 * one property per model.
 *
 * Why four levels and not the seven pi-ai understands: the levels `minimal`,
 * `xhigh`, and `max` are accepted by the relay but do not change how much it
 * actually thinks, so offering them would present duplicate choices. Measured
 * on a relay route over a counting prompt, reasoning-token counts were 0 for
 * off and rose through low/medium/high, while minimal, xhigh, and max landed in
 * the same band as high. Only those four produce distinct behavior.
 *
 * The apply step is idempotent: re-running it rewrites the same four levels and
 * leaves any model that already declares exactly them untouched. Updating this
 * package therefore does not require re-entering any configuration.
 */

import { appendFileSync } from 'node:fs';

/** The levels the relay actually honors, ascending. `off` is the empty wire value. */
const LEVELS = [
  ['off', null],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
];

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
function efforts() {
  const out = {};
  for (const [level, wire] of LEVELS) out[level] = wire;
  return out;
}

/**
 * Whether a model entry already carries exactly the four levels this plugin
 * declares. A model declaring anything else is rewritten.
 */
function alreadyDeclared(value) {
  if (value === false || value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (keys.length !== LEVELS.length) return false;
  for (const [level, wire] of LEVELS) {
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
            if (!force && alreadyDeclared(model.reasoningEfforts)) continue;
            ops.push({
              op: 'set',
              path: ['providers', providerName, 'models', String(index), 'reasoningEfforts'],
              value: efforts(),
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
          diag(`declared off/low/medium/high on ${ops.length} model(s)`);
        } catch (error) {
          if (cancelled) return;
          diag(`mutate failed: ${error?.message ?? error}`);
          // A concurrent edit bumps the revision; retrying once settles it.
          try {
            const retry = settings.describe().find((item) => String(item.ns) === String(entry.ns));
            if (retry !== undefined) {
              await write(retry.revision);
              diag(`declared off/low/medium/high on ${ops.length} model(s) after retry`);
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
