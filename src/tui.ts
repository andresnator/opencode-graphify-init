import type { Plugin } from "@opencode/plugin/tui"
import {
  ATTACH_METHOD,
  DRAIN_METHOD,
  GRAPHIFY_INIT_PLUGIN_ID,
  GraphifyInitRpc,
  TOAST_EVENT,
  isGraphifyToast,
  queuedToasts,
  type GraphifyToast,
} from "./rpc.js"

const LOG_PREFIX = "[graphify-init]"
// Ids already rendered; a toast arrives both live and through the next drain.
const MAX_SEEN_TOASTS = 200

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Renders the server plugin's toasts for the location this terminal opened. Toasts raised for
// other directories served by the same background service belong to their own terminals.
export const GraphifyInitTuiPlugin: Plugin.Definition = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  setup(context) {
    const location = context.location ?? context.data.location.default()
    const rpc = context.client.rpc(GraphifyInitRpc)
    const seen = new Set<string>()
    const abort = new AbortController()

    const show = (toasts: readonly GraphifyToast[]) => {
      for (const toast of toasts) {
        if (seen.has(toast.id)) continue
        seen.add(toast.id)
        if (seen.size > MAX_SEEN_TOASTS) seen.delete(seen.values().next().value!)
        context.ui.toast.show({ message: toast.message, variant: toast.variant, duration: toast.duration })
      }
    }
    const collect = async (method: typeof ATTACH_METHOD | typeof DRAIN_METHOD) => {
      try {
        show(queuedToasts(await rpc[method]({}, { location, signal: abort.signal })))
      } catch (error) {
        if (!abort.signal.aborted) console.error(`${LOG_PREFIX} cannot collect toasts: ${errorMessage(error)}`)
      }
    }

    // Subscribe before attaching so nothing emitted in between is missed.
    const unsubscribe = rpc.events.on(
      TOAST_EVENT,
      (event) => {
        if (event.location.directory !== location.directory || !isGraphifyToast(event.data)) return
        show([event.data])
        // Acknowledge: the delivered toast must not be replayed to a later terminal.
        void collect(DRAIN_METHOD)
      },
      { signal: abort.signal },
    )
    void collect(ATTACH_METHOD)

    return () => {
      abort.abort()
      unsubscribe()
    }
  },
}

export default GraphifyInitTuiPlugin
