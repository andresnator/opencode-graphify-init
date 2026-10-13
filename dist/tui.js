// src/rpc.ts
var GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init";
var TOAST_EVENT = "toast";
var ATTACH_METHOD = "attach";
var DRAIN_METHOD = "drain";
var toastSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    message: { type: "string" },
    variant: { type: "string", enum: ["error", "info", "success", "warning"] },
    duration: { type: "number" }
  },
  required: ["id", "message", "variant", "duration"]
};
var queuedToastsMethod = {
  // The host requires an input schema even for argument-less methods.
  input: { type: "object", properties: {} },
  output: {
    type: "object",
    properties: { toasts: { type: "array", items: toastSchema } },
    required: ["toasts"]
  }
};
var GraphifyInitRpc = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  methods: {
    [ATTACH_METHOD]: queuedToastsMethod,
    [DRAIN_METHOD]: queuedToastsMethod
  },
  events: {
    [TOAST_EVENT]: { schema: toastSchema }
  }
};
var TOAST_VARIANTS = toastSchema.properties.variant.enum;
function isGraphifyToast(value) {
  if (typeof value !== "object" || value === null) return false;
  const toast = value;
  return typeof toast.id === "string" && typeof toast.message === "string" && TOAST_VARIANTS.includes(toast.variant) && typeof toast.duration === "number";
}
function queuedToasts(output) {
  if (typeof output !== "object" || output === null) return [];
  const { toasts } = output;
  return Array.isArray(toasts) ? toasts.filter(isGraphifyToast) : [];
}

// src/tui.ts
var LOG_PREFIX = "[graphify-init]";
var MAX_SEEN_TOASTS = 200;
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var GraphifyInitTuiPlugin = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  setup(context) {
    const location = context.location ?? context.data.location.default();
    const rpc = context.client.rpc(GraphifyInitRpc);
    const seen = /* @__PURE__ */ new Set();
    const abort = new AbortController();
    const show = (toasts) => {
      for (const toast of toasts) {
        if (seen.has(toast.id)) continue;
        seen.add(toast.id);
        if (seen.size > MAX_SEEN_TOASTS) seen.delete(seen.values().next().value);
        context.ui.toast.show({ message: toast.message, variant: toast.variant, duration: toast.duration });
      }
    };
    const collect = async (method) => {
      try {
        show(queuedToasts(await rpc[method]({}, { location, signal: abort.signal })));
      } catch (error) {
        if (!abort.signal.aborted) console.error(`${LOG_PREFIX} cannot collect toasts: ${errorMessage(error)}`);
      }
    };
    const unsubscribe = rpc.events.on(
      TOAST_EVENT,
      (event) => {
        if (event.location.directory !== location.directory || !isGraphifyToast(event.data)) return;
        show([event.data]);
        void collect(DRAIN_METHOD);
      },
      { signal: abort.signal }
    );
    void collect(ATTACH_METHOD);
    return () => {
      abort.abort();
      unsubscribe();
    };
  }
};
var tui_default = GraphifyInitTuiPlugin;
export {
  GraphifyInitTuiPlugin,
  tui_default as default
};
