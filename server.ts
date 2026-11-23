import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Auto Compact is a frontend-only feature: all behaviour lives in the
 * `auto-compact-composer` content script (see content-script.ts).
 *
 * bb 0.48 still requires a backend entry for a plugin package, so this factory
 * exists only to satisfy the manifest. It registers nothing.
 */
export default async function plugin(_bb: BbPluginApi) {}
