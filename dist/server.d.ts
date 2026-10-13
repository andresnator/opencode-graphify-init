import type { Plugin } from "@opencode/plugin";
export { GRAPHIFY_INIT_PLUGIN_ID } from "./notifications.js";
export declare function registerGraphifyIndexCommand(ctx: Pick<Plugin.Context, "command" | "session">): Promise<void>;
export declare const GraphifyInitPlugin: {
    id: string;
    setup(ctx: Plugin.Context): Promise<() => Promise<void>>;
};
export default GraphifyInitPlugin;
