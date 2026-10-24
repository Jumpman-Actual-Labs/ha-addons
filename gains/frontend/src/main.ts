import "./shims/ha-elements";
import "./gains-panel";
import { AddonConnection } from "./addon-hass";
import { followHaTheme } from "./ha-theme";
import type { GainsPanel } from "./gains-panel";

// Ingress page entry point - mounts the same <gains-panel> HA used to host
// as a custom panel, and feeds it a `hass` from the add-on backend instead.
const panel = document.createElement("gains-panel") as GainsPanel;
const narrowQuery = window.matchMedia("(max-width: 870px)");
panel.narrow = narrowQuery.matches;
narrowQuery.addEventListener("change", (e) => (panel.narrow = e.matches));

let mounted = false;
const connection = new AddonConnection((hass) => {
  panel.hass = hass;
  if (!mounted) {
    document.body.replaceChildren(panel);
    mounted = true;
  }
});
followHaTheme(() => connection.refresh());
connection.connect();
