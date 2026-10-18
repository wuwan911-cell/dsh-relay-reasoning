import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait past the plugin's activation pass. */
const afterActivation = () => sleep(80);

/** Wait past the plugin's debounced configuration-reload pass. */
const afterReload = () => sleep(260);

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Apply one path-scoped op the way the settings service persists it. */
function setAt(root, path, value) {
  let node = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (node[key] === undefined) {
      node[key] = /^(0|[1-9][0-9]*)$/.test(path[index + 1]) ? [] : {};
    }
    node = node[key];
  }
  node[path[path.length - 1]] = clone(value);
}

const levels = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' };

function model(id, extra = {}) {
  return { id, name: id, ...extra };
}

function fixture() {
  return {
    providers: {
      relay: {
        displayName: 'relay',
        api: 'openai-completions',
        baseURL: 'https://relay.example/v1',
        models: [model('model-a'), model('model-b', { reasoningEfforts: clone(levels) })],
      },
      other: {
        displayName: 'other',
        api: 'openai-completions',
        baseURL: 'https://other.example/v1',
        models: [model('model-c')],
      },
    },
  };
}

/**
 * Build the smallest Host surface the plugin touches: a settings service that
 * persists path ops and bumps its revision, an optional HMR service whose
 * AsyncLocalStorage store can be simulated, and an event bus.
 */
function createHarness({
  value = fixture(),
  entryId = 'llm-pi-ai',
  hmr = true,
  storeAlwaysSet = false,
  conflictOnce = false,
  describeThrows = false,
} = {}) {
  const state = {
    value: clone(value),
    revision: 1,
    entryId,
    mutations: [],
    describes: 0,
    nestedError: false,
    conflictOnce,
    insideTransaction: storeAlwaysSet,
    listeners: new Map(),
    disposers: [],
  };

  const settings = {
    describe() {
      if (describeThrows) throw new Error('describe boom');
      state.describes += 1;
      return [{ ns: entryId, revision: state.revision, value: clone(state.value) }];
    },
    async mutate(ns, ops, expected) {
      if (state.insideTransaction) {
        state.nestedError = true;
        throw new Error('HMR transactions cannot be nested');
      }
      if (state.conflictOnce) {
        state.conflictOnce = false;
        state.revision += 1;
        throw new Error('settings conflict');
      }
      if (expected !== state.revision) {
        throw new Error(`settings conflict: expected ${expected}, now ${state.revision}`);
      }
      state.mutations.push({ ns, ops: clone(ops), expected });
      for (const op of ops) setAt(state.value, op.path, op.value);
      state.revision += 1;
    },
  };

  const executing = storeAlwaysSet
    ? {
      getStore: () => state.insideTransaction,
      exit(callback) {
        const previous = state.insideTransaction;
        state.insideTransaction = false;
        const result = callback();
        if (result !== null && typeof result?.then === 'function') {
          return result.finally(() => {
            state.insideTransaction = previous;
          });
        }
        state.insideTransaction = previous;
        return result;
      },
    }
    : {
      getStore: () => undefined,
      exit(callback) {
        return callback();
      },
    };

  const logger = { info() {} };
  const child = {
    logger,
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'hmr') return hmr ? { executing } : undefined;
      return undefined;
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') state.disposers.push(disposer);
      return disposer;
    },
    on(name, listener) {
      const list = state.listeners.get(name) ?? [];
      list.push(listener);
      state.listeners.set(name, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };

  const ctx = {
    logger,
    root: { loader: { await: () => Promise.resolve() } },
    inject(_dependencies, callback) {
      callback(child);
    },
  };

  const harness = {
    state,
    emit(name) {
      for (const listener of state.listeners.get(name) ?? []) listener();
    },
    /** The plugin's own writes complete through their own async chain. */
    addProvider(name, provider) {
      state.value.providers[name] = clone(provider);
      state.revision += 1;
    },
    dispose() {
      for (const disposer of state.disposers.splice(0)) disposer();
    },
  };
  harness.ctx = ctx;
  harness.settings = settings;
  return harness;
}

test('activation declares the default levels on models that lack them', async () => {
  const harness = createHarness();
  apply(harness.ctx, undefined);
  await afterActivation();

  assert.equal(harness.state.mutations.length, 1);
  const [mutation] = harness.state.mutations;
  assert.equal(mutation.ns, 'llm-pi-ai');
  assert.deepEqual(
    mutation.ops.map((op) => op.path.join('.')),
    [
      'providers.relay.models.0.reasoningEfforts',
      'providers.other.models.0.reasoningEfforts',
    ],
    'only the models without a declaration are written',
  );
  assert.deepEqual(mutation.ops[0].value, levels);
  assert.deepEqual(
    harness.state.value.providers.relay.models[1].reasoningEfforts,
    levels,
    'an already-correct model keeps its declaration and is not rewritten',
  );
  harness.dispose();
});

test('a provider added after activation gets its levels on the next config reload', async () => {
  const harness = createHarness();
  apply(harness.ctx, undefined);
  await afterActivation();
  const before = harness.state.mutations.length;

  harness.addProvider('fresh', {
    displayName: 'fresh',
    api: 'openai-completions',
    baseURL: 'https://fresh.example/v1',
    models: [model('fresh-1'), model('fresh-2')],
  });
  harness.emit('app-boot/config-reload');
  await afterReload();

  assert.equal(harness.state.mutations.length, before + 1);
  const written = harness.state.mutations.at(-1).ops.map((op) => op.path.join('.'));
  assert.deepEqual(written, [
    'providers.fresh.models.0.reasoningEfforts',
    'providers.fresh.models.1.reasoningEfforts',
  ]);
  assert.deepEqual(harness.state.value.providers.fresh.models[0].reasoningEfforts, levels);
  harness.dispose();
});

test('a model added to an existing provider is picked up too', async () => {
  const harness = createHarness();
  apply(harness.ctx, undefined);
  await afterActivation();
  const before = harness.state.mutations.length;

  harness.state.value.providers.relay.models.push(model('model-d'));
  harness.state.revision += 1;
  harness.emit('app-boot/config-reload');
  await afterReload();

  assert.equal(harness.state.mutations.length, before + 1);
  assert.deepEqual(harness.state.mutations.at(-1).ops.map((op) => op.path.join('.')), [
    'providers.relay.models.2.reasoningEfforts',
  ]);
  harness.dispose();
});

test('a reload with nothing to declare writes nothing, so its own write settles', async () => {
  const harness = createHarness();
  apply(harness.ctx, undefined);
  await afterActivation();
  const before = harness.state.mutations.length;

  harness.emit('app-boot/config-reload');
  await afterReload();
  harness.emit('app-boot/config-reload');
  await afterReload();

  assert.equal(harness.state.mutations.length, before, 'the idempotent pass never re-writes');
  harness.dispose();
});

test('force rewrites on activation but does not loop on later reloads', async () => {
  const harness = createHarness();
  apply(harness.ctx, { force: true });
  await afterActivation();

  assert.equal(harness.state.mutations.length, 1);
  assert.deepEqual(
    harness.state.mutations[0].ops.map((op) => op.path.join('.')),
    [
      'providers.relay.models.0.reasoningEfforts',
      'providers.relay.models.1.reasoningEfforts',
      'providers.other.models.0.reasoningEfforts',
    ],
    'activation rewrites even the already-correct declaration',
  );

  for (let index = 0; index < 3; index += 1) {
    harness.emit('app-boot/config-reload');
    await afterReload();
  }
  assert.equal(harness.state.mutations.length, 1, 'reloads never rewrite the same declaration again');
  harness.dispose();
});

test('a configured level subset is written instead of the default', async () => {
  const harness = createHarness();
  apply(harness.ctx, { levels: ['max', 'off', 'high'] });
  await afterActivation();

  assert.deepEqual(harness.state.mutations[0].ops[0].value, { off: null, high: 'high', max: 'max' });
  harness.dispose();
});

test('a provider filter narrows the write', async () => {
  const harness = createHarness();
  apply(harness.ctx, { providers: ['other'] });
  await afterActivation();

  assert.deepEqual(harness.state.mutations[0].ops.map((op) => op.path.join('.')), [
    'providers.other.models.0.reasoningEfforts',
  ]);
  harness.dispose();
});

test('a revision conflict is retried once against the fresh revision', async () => {
  const harness = createHarness({ conflictOnce: true });
  apply(harness.ctx, undefined);
  await sleep(400);

  assert.equal(harness.state.mutations.length, 1);
  assert.deepEqual(harness.state.value.providers.relay.models[0].reasoningEfforts, levels);
  harness.dispose();
});

test('the write escapes the HMR transaction that scheduled it', async () => {
  const harness = createHarness({ storeAlwaysSet: true });
  apply(harness.ctx, undefined);
  await afterActivation();

  assert.equal(harness.state.nestedError, false, 'the write must not run inside the HMR transaction');
  assert.equal(harness.state.mutations.length, 1);
  harness.dispose();
});

test('disposing the plugin before the activation pass writes nothing', async () => {
  const harness = createHarness();
  apply(harness.ctx, undefined);
  harness.dispose();
  await afterActivation();

  assert.equal(harness.state.mutations.length, 0);
});

test('a failing describe is reported instead of throwing through activation', async () => {
  const harness = createHarness({ describeThrows: true });
  apply(harness.ctx, undefined);
  await afterActivation();

  assert.equal(harness.state.mutations.length, 0);
  harness.dispose();
});

test('the configured entry is matched exactly before by substring', async () => {
  const harness = createHarness({ entryId: 'relay/llm-pi-ai-v2' });
  apply(harness.ctx, undefined);
  await afterActivation();

  assert.equal(harness.state.mutations.length, 1);
  assert.equal(harness.state.mutations[0].ns, 'relay/llm-pi-ai-v2');
  harness.dispose();
});
