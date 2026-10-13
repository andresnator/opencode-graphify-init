// src/notifications.ts
var GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init";
var notificationSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    message: { type: "string" },
    variant: { type: "string", enum: ["info", "success", "warning", "error"] },
    duration: { type: "integer" }
  },
  required: ["id", "message", "variant", "duration"],
  additionalProperties: false
};
var notificationsRpc = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  methods: {
    notifications: {
      input: { type: "object", additionalProperties: false },
      output: { type: "array", items: notificationSchema }
    }
  },
  events: { notification: { schema: notificationSchema } }
};
function isNotification(value) {
  if (!value || typeof value !== "object") return false;
  const item = value;
  return typeof item.id === "string" && typeof item.message === "string" && ["info", "success", "warning", "error"].includes(item.variant ?? "") && Number.isInteger(item.duration);
}

// src/tui.ts
var tui_default = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  async setup(ctx) {
    const controller = new AbortController();
    const rpc = ctx.client.rpc(notificationsRpc);
    const [memory, updateMemory] = ctx.storage.memory("notifications", { initial: { seen: [] } });
    let loadedDirectory;
    let pending = false;
    const currentLocation = () => ctx.location ?? ctx.data.location.default();
    const show = (value) => {
      if (controller.signal.aborted || !isNotification(value) || memory.seen.includes(value.id)) return;
      updateMemory((draft) => {
        draft.seen.push(value.id);
        if (draft.seen.length > 200) draft.seen.shift();
      });
      ctx.ui.toast.show({ message: value.message, variant: value.variant, duration: value.duration });
    };
    const off = rpc.events.on("notification", (event) => {
      if (event.location.directory === currentLocation().directory) show(event.data);
    }, { signal: controller.signal });
    const recover = async () => {
      const location = currentLocation();
      if (pending || controller.signal.aborted || loadedDirectory === location.directory) return;
      pending = true;
      try {
        const backlog = await rpc.notifications({}, { location, signal: controller.signal });
        if (currentLocation().directory !== location.directory || controller.signal.aborted) return;
        if (Array.isArray(backlog)) backlog.forEach(show);
        loadedDirectory = location.directory;
      } catch (error) {
        if (!controller.signal.aborted) console.error(`[graphify-init] notification recovery failed: ${String(error)}`);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => {
      void recover();
    }, 1e3);
    const offReconnect = ctx.data.on("server.connected", () => {
      loadedDirectory = void 0;
      void recover();
    });
    const offReload = ctx.data.on("plugin.updated", () => {
      loadedDirectory = void 0;
      void recover();
    });
    await recover();
    return () => {
      controller.abort();
      clearInterval(timer);
      off();
      offReconnect();
      offReload();
    };
  }
};
export {
  tui_default as default
};
