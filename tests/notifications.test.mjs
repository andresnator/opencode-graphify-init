import assert from "node:assert/strict"
import { mock } from "node:test"
import tui from "../dist/tui.js"

function fixture() {
  let location = { directory: "/repo/a" }
  let handler
  let offCalls = 0
  const handlers = new Map()
  const toasts = []
  const snapshots = []
  let load = async () => []
  const state = { seen: [] }
  const ctx = {
    get location() { return location },
    storage: { memory: () => [state, (mutate) => mutate(state)] },
    data: {
      location: { default: () => location },
      on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type) },
    },
    client: { rpc: () => ({
      events: { on: (_name, fn) => { handler = fn; return () => { offCalls++; handler = undefined } } },
      notifications: async (_input, options) => { snapshots.push(options); return load(options) },
    }) },
    ui: { toast: { show: (value) => toasts.push(value) } },
  }
  return {
    ctx, toasts, snapshots, state, handlers,
    emit: (notification, directory = location.directory) => handler?.({ location: { directory }, data: notification }),
    load: (fn) => { load = fn },
    move: (directory) => { location = { directory } },
    offCalls: () => offCalls,
  }
}

const hint = { id: "generation-1:1", message: "Consent required", variant: "info", duration: 8000 }
const finished = { id: "generation-1:2", message: "Graph ready", variant: "success", duration: 5000 }
const tick = async () => { await new Promise((resolve) => setImmediate(resolve)) }

async function shouldRecoverAndDeduplicateNotificationsWhenTheTuiConnectsLate() {
  // Given the server already emitted a hint, and emits it again while reading the snapshot.
  const f = fixture()
  f.load(async () => { f.emit(hint); return [hint] })

  // When
  const cleanup = await tui.setup(f.ctx)
  f.emit(finished)
  f.emit(finished)
  f.emit({ ...hint, id: "foreign" }, "/repo/other")
  f.emit({ id: "malformed" })

  // Then
  assert.deepEqual(f.toasts.map((toast) => toast.message), [hint.message, finished.message])
  await cleanup()
  assert.equal(f.offCalls(), 1)
  assert.equal(f.snapshots[0].signal.aborted, true)
  assert.equal(f.handlers.size, 0)
}

async function shouldRecoverANewProjectWhenTheTuiNavigatesWithoutReloading() {
  // Given
  mock.timers.enable({ apis: ["setInterval"] })
  const f = fixture()
  f.load(async () => [hint])
  const cleanup = await tui.setup(f.ctx)
  try {
    // When
    f.move("/repo/b")
    f.load(async () => [{ ...finished, id: "generation-b:1" }])
    mock.timers.tick(1_000)
    await tick()
    f.emit({ ...hint, id: "foreign" }, "/repo/a")

    // Then
    assert.equal(f.snapshots.at(-1).location.directory, "/repo/b")
    assert.deepEqual(f.toasts.map((toast) => toast.message), [hint.message, finished.message])
  } finally { cleanup(); mock.timers.reset() }
}

async function shouldPreserveReceiptsWhenTheCompanionReloads() {
  // Given ephemeral TUI memory survives plugin reloads.
  const f = fixture()
  f.load(async () => [hint])
  const cleanup = await tui.setup(f.ctx)
  cleanup()

  // When
  const nextCleanup = await tui.setup(f.ctx)
  f.emit({ ...hint, id: "generation-2:1" })

  // Then the original receipt is not repeated, but a new server generation is visible.
  assert.equal(f.toasts.length, 2)
  nextCleanup()
}

async function shouldDiscardALateSnapshotWhenTheCompanionUnloads() {
  // Given initial recovery completed, but a reconnect request is still pending.
  const f = fixture()
  const cleanup = await tui.setup(f.ctx)
  let resolve
  f.load(() => new Promise((done) => { resolve = done }))
  f.handlers.get("server.connected")()

  // When
  cleanup()
  resolve([hint])
  await tick()

  // Then
  assert.deepEqual(f.toasts, [])
  assert.equal(f.snapshots.at(-1).signal.aborted, true)
}

await shouldRecoverAndDeduplicateNotificationsWhenTheTuiConnectsLate()
await shouldRecoverANewProjectWhenTheTuiNavigatesWithoutReloading()
await shouldPreserveReceiptsWhenTheCompanionReloads()
await shouldDiscardALateSnapshotWhenTheCompanionUnloads()
process.stdout.write("PASS: 4 v2 TUI notification lifecycle contracts.\n")
