// OpenCode V2 server plugins have no TUI client: toasts belong to the terminal UI, which runs
// in a different process (possibly against a remote server). The server plugin therefore
// publishes each notification through this plugin-owned RPC contract and the bundled TUI
// plugin renders it. RPC events are live-only, so the server also queues every toast until a
// TUI drains it — a toast raised before the TUI subscribes is delivered, not dropped.
export const GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init"
export const TOAST_EVENT = "toast"
// `attach` is called once when a TUI starts; `drain` after every live toast. Both hand over the
// queued toasts, and `attach` additionally marks a new terminal session for the server.
export const ATTACH_METHOD = "attach"
export const DRAIN_METHOD = "drain"

export type ToastVariant = "error" | "info" | "success" | "warning"

export type GraphifyToast = {
  id: string
  message: string
  variant: ToastVariant
  duration: number
}

const toastSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    message: { type: "string" },
    variant: { type: "string", enum: ["error", "info", "success", "warning"] },
    duration: { type: "number" },
  },
  required: ["id", "message", "variant", "duration"],
} as const

// Rpc.define is an identity function that only validates error names; the literal is kept
// dependency-free so neither bundle carries a runtime import of @opencode/plugin.
const queuedToastsMethod = {
  // The host requires an input schema even for argument-less methods.
  input: { type: "object", properties: {} },
  output: {
    type: "object",
    properties: { toasts: { type: "array", items: toastSchema } },
    required: ["toasts"],
  },
} as const

export const GraphifyInitRpc = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  methods: {
    [ATTACH_METHOD]: queuedToastsMethod,
    [DRAIN_METHOD]: queuedToastsMethod,
  },
  events: {
    [TOAST_EVENT]: { schema: toastSchema },
  },
} as const

const TOAST_VARIANTS: readonly unknown[] = toastSchema.properties.variant.enum

// RPC typing does not infer types from JSON Schema, and the TUI may talk to a server running
// another plugin version, so received payloads are narrowed rather than trusted.
export function isGraphifyToast(value: unknown): value is GraphifyToast {
  if (typeof value !== "object" || value === null) return false
  const toast = value as Record<string, unknown>
  return (
    typeof toast.id === "string" &&
    typeof toast.message === "string" &&
    TOAST_VARIANTS.includes(toast.variant) &&
    typeof toast.duration === "number"
  )
}

export function queuedToasts(output: unknown): GraphifyToast[] {
  if (typeof output !== "object" || output === null) return []
  const { toasts } = output as { toasts?: unknown }
  return Array.isArray(toasts) ? toasts.filter(isGraphifyToast) : []
}
