import "./shims/ha-elements";
import "./finance-panel";
import { AddonConnection } from "./addon-hass";
import type { FinancePanel } from "./finance-panel";

// Ingress page entry point - mounts the same <finance-panel> HA used to host
// as a custom panel, and feeds it a `hass` from the add-on backend instead.
const panel = document.createElement("finance-panel") as FinancePanel;
const narrowQuery = window.matchMedia("(max-width: 870px)");
panel.narrow = narrowQuery.matches;
narrowQuery.addEventListener("change", (e) => (panel.narrow = e.matches));

// Light or dark, matching Home Assistant. Ingress serves this page in an
// iframe on HA's own origin, so the parent's <home-assistant> element is
// readable and knows the user's actual choice (including a fixed light or
// dark theme). Opened on its own, fall back to the OS/browser preference.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function haDarkMode(): boolean | undefined {
  try {
    const ha = window.parent?.document.querySelector("home-assistant") as
      | { hass?: { themes?: { darkMode?: unknown } } }
      | null;
    const darkMode = ha?.hass?.themes?.darkMode;
    return typeof darkMode === "boolean" ? darkMode : undefined;
  } catch {
    return undefined; // not embedded in HA, or a different origin
  }
}

function applyTheme(): void {
  const dark = haDarkMode() ?? darkQuery.matches;
  panel.toggleAttribute("light", !dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

applyTheme();
darkQuery.addEventListener("change", applyTheme);
// HA doesn't tell an iframe when its theme changes - a cheap re-check
// keeps the panel in step when someone flips HA between light and dark.
window.setInterval(applyTheme, 2000);

let mounted = false;
new AddonConnection((hass) => {
  panel.hass = hass;
  if (!mounted) {
    document.body.replaceChildren(panel);
    mounted = true;
  }
}).connect();
