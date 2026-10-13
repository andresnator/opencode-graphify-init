// Portable JSON schemas keep the published plugin free of runtime npm dependencies.
export const GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init"
export const notificationSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    message: { type: "string" },
    variant: { type: "string", enum: ["info", "success", "warning", "error"] },
    duration: { type: "integer" },
  },
  required: ["id", "message", "variant", "duration"],
  additionalProperties: false,
} as const

export type Notification = {
  id: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration: number
}

export const notificationsRpc = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  methods: {
    notifications: {
      input: { type: "object", additionalProperties: false },
      output: { type: "array", items: notificationSchema },
    },
  },
  events: { notification: { schema: notificationSchema } },
} as const

export function isNotification(value: unknown): value is Notification {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<Notification>
  return typeof item.id === "string" && typeof item.message === "string" &&
    ["info", "success", "warning", "error"].includes(item.variant ?? "") &&
    Number.isInteger(item.duration)
}
