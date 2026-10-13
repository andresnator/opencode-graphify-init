import type { Plugin } from "@opencode/plugin";
import { GRAPHIFY_INIT_PLUGIN_ID } from "./rpc.js";
export { GRAPHIFY_INIT_PLUGIN_ID };
export declare function renderIndexCommand(template: string, argumentsText: string): string;
export declare function registerGraphifyIndexCommand(context: Pick<Plugin.Context, "command" | "session">): Promise<import("@opencode/plugin/promise/registration").Registration>;
export declare const GraphifyInitPlugin: Plugin.Plugin;
export default GraphifyInitPlugin;
