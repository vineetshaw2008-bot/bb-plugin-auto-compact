// Auto Compact — frontend entry.
//
// The plugin has no visible UI. Its only job is the trusted content script that
// collapses the thread follow-up composer according to CLOUDROOM_HANDOFF.md
// Part 2 (§18). Built by `bb plugin build` into dist/app.js + dist/app.css.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { startAutoCompact } from "./content-script";
import "./app.css";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "auto-compact-composer",
    mount({ signal }) {
      return startAutoCompact(signal);
    },
  });
});
