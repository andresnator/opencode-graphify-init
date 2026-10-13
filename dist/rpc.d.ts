export declare const GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init";
export declare const TOAST_EVENT = "toast";
export declare const ATTACH_METHOD = "attach";
export declare const DRAIN_METHOD = "drain";
export type ToastVariant = "error" | "info" | "success" | "warning";
export type GraphifyToast = {
    id: string;
    message: string;
    variant: ToastVariant;
    duration: number;
};
export declare const GraphifyInitRpc: {
    readonly id: "andresnator.graphify-init";
    readonly methods: {
        readonly attach: {
            readonly input: {
                readonly type: "object";
                readonly properties: {};
            };
            readonly output: {
                readonly type: "object";
                readonly properties: {
                    readonly toasts: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly id: {
                                    readonly type: "string";
                                };
                                readonly message: {
                                    readonly type: "string";
                                };
                                readonly variant: {
                                    readonly type: "string";
                                    readonly enum: readonly ["error", "info", "success", "warning"];
                                };
                                readonly duration: {
                                    readonly type: "number";
                                };
                            };
                            readonly required: readonly ["id", "message", "variant", "duration"];
                        };
                    };
                };
                readonly required: readonly ["toasts"];
            };
        };
        readonly drain: {
            readonly input: {
                readonly type: "object";
                readonly properties: {};
            };
            readonly output: {
                readonly type: "object";
                readonly properties: {
                    readonly toasts: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly id: {
                                    readonly type: "string";
                                };
                                readonly message: {
                                    readonly type: "string";
                                };
                                readonly variant: {
                                    readonly type: "string";
                                    readonly enum: readonly ["error", "info", "success", "warning"];
                                };
                                readonly duration: {
                                    readonly type: "number";
                                };
                            };
                            readonly required: readonly ["id", "message", "variant", "duration"];
                        };
                    };
                };
                readonly required: readonly ["toasts"];
            };
        };
    };
    readonly events: {
        readonly toast: {
            readonly schema: {
                readonly type: "object";
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly message: {
                        readonly type: "string";
                    };
                    readonly variant: {
                        readonly type: "string";
                        readonly enum: readonly ["error", "info", "success", "warning"];
                    };
                    readonly duration: {
                        readonly type: "number";
                    };
                };
                readonly required: readonly ["id", "message", "variant", "duration"];
            };
        };
    };
};
export declare function isGraphifyToast(value: unknown): value is GraphifyToast;
export declare function queuedToasts(output: unknown): GraphifyToast[];
