import variant from '@jitl/quickjs-singlefile-cjs-release-sync'
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSHandle,
} from 'quickjs-emscripten-core'

// The WASM binary is embedded in the variant module (single file), so no .wasm needs shipping.
let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined

export interface SandboxOptions {
  /** Extension source (CommonJS-style: assign to `module.exports`). */
  code: string
  /** Host side of `ctx.*` calls. Resolves with a JSON string `{ok:true,value}` or `{ok:false,error}`. */
  onCall(op: string, argsJson: string): Promise<string>
  memoryLimitBytes?: number
  /** Total wall time allowed for one invocation. */
  invokeTimeoutMs?: number
}

const BOOTSTRAP = `
(function () {
  const raw = globalThis.__call;
  delete globalThis.__call;
  const call = async (op, args) => {
    const r = JSON.parse(await raw(op, JSON.stringify(args === undefined ? [] : args)));
    if (!r.ok) throw new Error(String(r.error));
    return r.value;
  };
  const ctx = Object.freeze({
    clipboard: Object.freeze({ read: () => call('clipboard.read'), write: (t) => call('clipboard.write', [String(t)]) }),
    notify: (title, body) => call('notify', [String(title), body === undefined ? undefined : String(body)]),
    storage: Object.freeze({ get: (k) => call('storage.get', [String(k)]), set: (k, v) => call('storage.set', [String(k), v]) }),
    fs: Object.freeze({ read: (p) => call('fs.read', [String(p)]), write: (p, d) => call('fs.write', [String(p), String(d)]) }),
    exec: (file, args) => call('exec', [String(file), (args || []).map(String)]),
    fetch: (url, opts) => call('fetch', [String(url), opts || {}]),
  });
  const module = { exports: {} };
  globalThis.__ctx = ctx;
  globalThis.__module = module;
})();
`

/**
 * Runs extension code inside QuickJS (WebAssembly): no Node APIs, no filesystem, no network, no
 * access to the host. The only way out is `ctx.*`, which the host checks against granted permissions.
 * Memory and run time are bounded.
 */
export async function createSandbox(opts: SandboxOptions): Promise<{
  invoke(method: string, args: unknown[]): Promise<unknown>
  dispose(): void
}> {
  const QuickJS = await (modulePromise ??= newQuickJSWASMModuleFromVariant(variant))
  const rt: QuickJSRuntime = QuickJS.newRuntime()
  rt.setMemoryLimit(opts.memoryLimitBytes ?? 32 * 1024 * 1024)
  rt.setMaxStackSize(512 * 1024)
  let deadline = Infinity
  rt.setInterruptHandler(() => Date.now() > deadline)
  const vm: QuickJSContext = rt.newContext()

  type Deferred = ReturnType<QuickJSContext['newPromise']>
  const pending = new Set<Deferred>()
  const callFn = vm.newFunction('__call', (opH: QuickJSHandle, argsH: QuickJSHandle) => {
    const op = vm.getString(opH)
    const args = vm.getString(argsH)
    const def = vm.newPromise()
    pending.add(def)
    void opts
      .onCall(op, args)
      .catch((e: unknown) =>
        JSON.stringify({ ok: false, error: e instanceof Error ? e.message : 'call failed' }),
      )
      .then((json) => {
        if (!vm.alive) return
        const s = vm.newString(json)
        def.resolve(s)
        s.dispose()
        pending.delete(def)
        rt.executePendingJobs()
      })
    return def.handle
  })
  vm.setProp(vm.global, '__call', callFn)
  callFn.dispose()

  const run = (code: string, name: string): void => {
    deadline = Date.now() + 2000
    const r = vm.evalCode(code, name)
    if (r.error) {
      const err = vm.dump(r.error) as { message?: string }
      r.error.dispose()
      throw new Error(`extension failed to load: ${err?.message ?? 'error'}`)
    }
    r.value.dispose()
  }
  run(BOOTSTRAP, 'bootstrap.js')
  // Run the extension with only `module`/`exports` in scope.
  run(
    `(function (module, exports) {\n${opts.code}\n})(globalThis.__module, globalThis.__module.exports); globalThis.__ext = globalThis.__module.exports;`,
    'extension.js',
  )

  let queue: Promise<unknown> = Promise.resolve()
  const invokeTimeout = opts.invokeTimeoutMs ?? 2000

  async function invokeNow(method: string, args: unknown[]): Promise<unknown> {
    deadline = Date.now() + invokeTimeout
    const argsJson = JSON.stringify(JSON.stringify(args))
    const fnCode = `(async () => {
      const e = globalThis.__ext;
      if (!e || typeof e[${JSON.stringify(method)}] !== 'function') return JSON.stringify({ missing: true });
      const a = JSON.parse(${argsJson});
      const v = await e[${JSON.stringify(method)}](...a, globalThis.__ctx);
      return JSON.stringify({ value: v === undefined ? null : v });
    })()`
    const r = vm.evalCode(fnCode, 'invoke.js')
    if (r.error) {
      const err = vm.dump(r.error) as { message?: string }
      r.error.dispose()
      throw new Error(err?.message ?? 'extension error')
    }
    const timer = setTimeout(() => (deadline = 0), invokeTimeout)
    try {
      const settling = vm.resolvePromise(r.value)
      rt.executePendingJobs() // run the async function's in-VM continuations
      const settled = await settling
      r.value.dispose()
      if (settled.error) {
        const err = vm.dump(settled.error) as { message?: string }
        settled.error.dispose()
        throw new Error(err?.message ?? 'extension error')
      }
      const out = vm.getString(settled.value)
      settled.value.dispose()
      const parsed = JSON.parse(out) as { value?: unknown; missing?: boolean }
      if (parsed.missing) throw new Error(`extension does not implement ${method}()`)
      return parsed.value
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    invoke(method, args) {
      // One invocation at a time per VM keeps job execution predictable.
      const next = queue.then(() => invokeNow(method, args))
      queue = next.catch(() => undefined)
      return next
    },
    dispose() {
      for (const d of pending) d.dispose()
      pending.clear()
      vm.dispose()
      rt.dispose()
    },
  }
}
