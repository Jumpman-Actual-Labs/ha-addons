import "./shims/ha-elements";
import "./family-app";
import { AddonConnection } from "./addon-hass";
import type { FamilyApp } from "./family-app";

// Ingress page entry point - mounts <family-app> and feeds it a `hass` from
// the add-on backend. Light/dark theming is family-app's job.
const app = document.createElement("family-app") as FamilyApp;
const narrowQuery = window.matchMedia("(max-width: 870px)");
app.narrow = narrowQuery.matches;
narrowQuery.addEventListener("change", (e) => (app.narrow = e.matches));

let mounted = false;
new AddonConnection((hass) => {
  app.hass = hass;
  if (!mounted) {
    document.body.replaceChildren(app);
    mounted = true;
  }
}).connect();
