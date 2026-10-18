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
 * It stays current: the first pass runs at activation, and every later profile
 * configuration reload (adding a relay, adding a model, editing a route) runs
 * the same pass again, so a route added from the settings UI gets its levels
 * without a restart. The pass is idempotent — a model that already declares
 * exactly the configured levels is left untouched, and a reload caused by the
 * plugin's own write therefore settles after one inspection.
 *
 * Which levels: the default is off / low / medium / high / max, and a narrower or
 * wider set can be requested through the `levels` option. pi-ai understands
 * seven levels, but a relay does not distinguish all of them. Measured over
 * three prompts and two passes on one relay route, median reasoning tokens were
 * 0 for off, ~108-155 for minimal through xhigh, and 359 for max: max is a
 * genuinely stronger tier, while the five middle levels sit inside each other's
 * noise and are therefore left out, since they would only duplicate choices.
 */

import { appendFileSync } from 'node:fs';

/**
 * The levels to publish by default. `off` is the empty wire value. `max` is
 * included because it measures roughly double every other level, so it is a real
 * tier rather than a duplicate; `minimal` through `xhigh` land inside each
 * other's noise and stay out, since they would only duplicate choices.
 */
const DEFAULT_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

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

/**
 * How long to wait after a profile reload before inspecting the configuration
 * again. A reload triggered by the settings UI (or by this plugin's own write)
 * arrives while HMR still owns the profile, and a short delay also coalesces a
 * burst of edits into one inspection.
 */
const RELOAD_DELAY_MS = 120;

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

/** Read a service without assuming it is registered. */
function service(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The settings descriptor to write. The configured id is matched exactly first,
 * then by substring so a deployment whose entry id grew a prefix keeps working.
 */
function matchingEntry(described, target) {
  const rows = Array.isArray(described) ? described : [];
  return (
    rows.find((item) => String(item.ns) === target) ??
    rows.find((item) => String(item.ns).includes(target))
  );
}

/**
 * Path-scoped set operations for every model that needs a declaration. Only
 * `providers.<name>.models[i].reasoningEfforts` is touched, so a write can
 * never disturb a route's address, credential reference, or model list.
 */
function operationsFor(value, { providers, levels, force }) {
  const routes = value?.providers ?? {};
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
  return ops;
}

export const name = 'relay-reasoning';

/** Settings is optional so the plugin stays inert in profiles without it. */
export const inject = [];

export function apply(ctx, config) {
  const target = config?.target ?? 'llm-pi-ai';
  // An empty list means "every provider on the row", which keeps this working
  // when a new relay is added without touching the plugin configuration.
  const providers = Array.isArray(config?.providers) ? config.providers.map(String) : [];
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

    /** Inspect the live entry and return the write it needs, if any. */
    const inspect = (applyForce) => {
      const settings = service(child, 'settings');
      if (!settings) return undefined;

      let described;
      try {
        described = settings.describe();
      } catch (error) {
        diag(`describe failed: ${error?.message ?? error}`);
        return undefined;
      }

      const entry = matchingEntry(described, target);
      if (!entry) {
        diag(`no settings entry matching "${target}"`);
        return undefined;
      }

      const ops = operationsFor(entry.value, { providers, levels, force: applyForce });
      if (ops.length === 0) return undefined;
      return { settings, entry, ops };
    };

    /** Write one inspection, retrying once when a concurrent edit bumped the revision. */
    const commit = async ({ settings, entry, ops }, applyForce) => {
      try {
        await settings.mutate(String(entry.ns), ops, entry.revision);
        diag(`declared ${levelNames} on ${ops.length} model(s)`);
        return;
      } catch (error) {
        diag(`mutate failed: ${error?.message ?? error}`);
      }

      // A concurrent edit bumps the revision; inspecting again settles it.
      let retry;
      try {
        retry = matchingEntry(settings.describe(), target);
      } catch (error) {
        diag(`retry describe failed: ${error?.message ?? error}`);
        return;
      }
      if (retry === undefined) return;
      const retryOps = operationsFor(retry.value, { providers, levels, force: applyForce });
      if (retryOps.length === 0) return;
      try {
        await settings.mutate(String(retry.ns), retryOps, retry.revision);
        diag(`declared ${levelNames} on ${retryOps.length} model(s) after retry`);
      } catch (second) {
        diag(`retry failed: ${second?.message ?? second}`);
      }
    };

    let cancelled = false;
    let timer = null;
    let running = null;
    let pending = false;
    let runs = 0;

    /**
     * One inspection-and-write pass, run outside any HMR transaction.
     *
     * Writing configuration goes through the HMR config editor, whose
     * `runExclusive` refuses to nest inside the transaction that installed this
     * plugin or that applied the configuration change being handled. That guard
     * reads an AsyncLocalStorage store, which survives awaits and timers, so
     * deferring inside the call chain never escapes it. The escape is the HMR
     * service's own `exit` helper, which runs a callback with no store attached
     * — the same mechanism dsh-hmr uses when it wires a config watcher from
     * inside a transaction.
     */
    const pass = async (applyForce) => {
      if (cancelled) return;
      const work = () => {
        if (cancelled) return undefined;
        const job = inspect(applyForce);
        return job === undefined ? undefined : commit(job, applyForce);
      };
      const store = service(child, 'hmr')?.executing;
      await (store && typeof store.exit === 'function' ? store.exit(work) : work());
    };

    /** Queue a pass; a pass already running makes this a single trailing rerun. */
    const schedule = (delay) => {
      if (cancelled || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        if (running !== null) {
          pending = true;
          return;
        }
        // `force` is honoured on activation only: honouring it on every reload
        // would rewrite the same declaration forever and reload in a loop.
        const applyForce = runs === 0 && force;
        runs += 1;
        running = pass(applyForce)
          .catch((error) => diag(`apply failed: ${error?.message ?? error}`))
          .finally(() => {
            running = null;
            if (pending && !cancelled) {
              pending = false;
              schedule(0);
            }
          });
      }, delay);
      if (typeof timer?.unref === 'function') timer.unref();
    };

    child.effect(() => {
      // Every profile configuration reload — a relay or model added from the
      // settings UI included — inspects again, so a new route never waits for
      // a restart to get its levels.
      const off = child.on('app-boot/config-reload', () => schedule(RELOAD_DELAY_MS));

      const loader = ctx.root?.loader;
      const start = loader && typeof loader.await === 'function' ? loader.await() : Promise.resolve();
      start
        .then(() => schedule(0))
        .catch((error) => diag(`activation deferred failed: ${error?.message ?? error}`));

      return () => {
        cancelled = true;
        if (typeof off === 'function') off();
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    });
  });
}
