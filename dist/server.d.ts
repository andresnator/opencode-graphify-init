import type { Config, Plugin } from "@opencode-ai/plugin";
export declare const GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init";
export declare function registerGraphifyIndexCommand(config: Config): Promise<void>;
export declare const GraphifyInitPlugin: Plugin;
declare const _default: {
    id: string;
    server: Plugin;
};
export default _default;
