import type { Plugin } from "@opencode/plugin/tui"
import { GRAPHIFY_INIT_PLUGIN_ID, isNotification, notificationsRpc } from "./notifications.js"

export default {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  async setup(ctx) {
    const controller = new AbortController()
    const rpc = ctx.client.rpc(notificationsRpc)
    const [memory, updateMemory] = ctx.storage.memory("notifications", { initial: { seen: [] as string[] } })
    let loadedDirectory: string | undefined
    let pending = false
    const currentLocation = () => ctx.location ?? ctx.data.location.default()
    const show = (value: unknown) => {
      if (controller.signal.aborted || !isNotification(value) || memory.seen.includes(value.id)) return
      updateMemory((draft) => {
        draft.seen.push(value.id)
        if (draft.seen.length > 200) draft.seen.shift()
      })
      ctx.ui.toast.show({ message: value.message, variant: value.variant, duration: value.duration })
    }
    // Subscribe before reading the backlog; notification IDs deduplicate the overlap.
    const off = rpc.events.on("notification", (event) => {
      if (event.location.directory === currentLocation().directory) show(event.data)
    }, { signal: controller.signal })
    const recover = async () => {
      const location = currentLocation()
      if (pending || controller.signal.aborted || loadedDirectory === location.directory) return
      pending = true
      try {
        const backlog = await rpc.notifications({}, { location, signal: controller.signal })
        if (currentLocation().directory !== location.directory || controller.signal.aborted) return
        if (Array.isArray(backlog)) backlog.forEach(show)
        loadedDirectory = location.directory
      } catch (error) {
        if (!controller.signal.aborted) console.error(`[graphify-init] notification recovery failed: ${String(error)}`)
      } finally {
        pending = false
      }
    }
    // TUI plugins remain loaded across project navigation. Recover each new location,
    // and retry transient connection failures without disabling the companion.
    const timer = setInterval(() => { void recover() }, 1_000)
    const offReconnect = ctx.data.on("server.connected", () => {
      loadedDirectory = undefined
      void recover()
    })
    const offReload = ctx.data.on("plugin.updated", () => {
      loadedDirectory = undefined
      void recover()
    })
    await recover()
    return () => {
      controller.abort()
      clearInterval(timer)
      off()
      offReconnect()
      offReload()
    }
  },
} satisfies Plugin.Definition
