import "./shims/ha-elements";
import "./garage-panel";
import { AddonConnection } from "./addon-hass";
import type { GaragePanel } from "./garage-panel";

// Ingress page entry point - mounts the same <garage-panel> HA used to host
// as a custom panel, and feeds it a `hass` from the add-on backend instead.
const panel = document.createElement("garage-panel") as GaragePanel;
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
