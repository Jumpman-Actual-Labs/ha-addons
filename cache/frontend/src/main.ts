import "./shims/ha-elements";
import "./cache-panel";
import { AddonConnection } from "./addon-hass";
import type { CachePanel } from "./cache-panel";

// Ingress page entry point - mounts the same <cache-panel> HA used to host
// as a custom panel, and feeds it a `hass` from the add-on backend instead.
const panel = document.createElement("cache-panel") as CachePanel;
const narrowQuery = window.matchMedia("(max-width: 870px)");
panel.narrow = narrowQuery.matches;
narrowQuery.addEventListener("change", (e) => (panel.narrow = e.matches));

let mounted = false;
new AddonConnection((hass) => {
  panel.hass = hass;
  if (!mounted) {
    document.body.replaceChildren(panel);
    mounted = true;
  }
}).connect();
