export declare const GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init";
export declare const notificationSchema: {
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
            readonly enum: readonly ["info", "success", "warning", "error"];
        };
        readonly duration: {
            readonly type: "integer";
        };
    };
    readonly required: readonly ["id", "message", "variant", "duration"];
    readonly additionalProperties: false;
};
export type Notification = {
    id: string;
    message: string;
    variant: "info" | "success" | "warning" | "error";
    duration: number;
};
export declare const notificationsRpc: {
    readonly id: "andresnator.graphify-init";
    readonly methods: {
        readonly notifications: {
            readonly input: {
                readonly type: "object";
                readonly additionalProperties: false;
            };
            readonly output: {
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
                            readonly enum: readonly ["info", "success", "warning", "error"];
                        };
                        readonly duration: {
                            readonly type: "integer";
                        };
                    };
                    readonly required: readonly ["id", "message", "variant", "duration"];
                    readonly additionalProperties: false;
                };
            };
        };
    };
    readonly events: {
        readonly notification: {
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
                        readonly enum: readonly ["info", "success", "warning", "error"];
                    };
                    readonly duration: {
                        readonly type: "integer";
                    };
                };
                readonly required: readonly ["id", "message", "variant", "duration"];
                readonly additionalProperties: false;
            };
        };
    };
};
export declare function isNotification(value: unknown): value is Notification;
