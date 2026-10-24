/* The logged-in user's Home Assistant theme, carried into the ingress iframe.
 *
 * As a custom panel, Gains sat inside HA's own page and inherited the user's
 * theme: every CSS custom property HA puts on <html> (the accent
 * --primary-color, --success-color, the --ha-card-* look - theme.ts still
 * overrides the backgrounds, as it always did) plus `hass.themes.darkMode`,
 * which gains-panel.ts uses to pick light or dark. An ingress iframe inherits
 * none of that, but it's served from Home Assistant's own origin
 * (/api/hassio_ingress/...), so it can read both straight off the HA page
 * around it and follow along when the user switches theme or dark mode.
 *
 * Opened outside HA (a dev run, or an embedding we can't read), nothing is
 * copied and index.html's defaults apply. */

interface HaRootElement extends HTMLElement {
  hass?: { themes?: { darkMode?: boolean } };
}

function parentDocument(): Document | null {
  try {
    if (window.parent === window) return null;
    // Throws if the parent isn't same-origin.
    return window.parent.document;
  } catch {
    return null;
  }
}

function customProperties(style: CSSStyleDeclaration): string[] {
  const names: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith("--")) names.push(name);
  }
  return names;
}

let copied = new Set<string>();

function copyThemeVariables(source: HTMLElement): void {
  const computed = window.parent.getComputedStyle(source);
  // HA puts a selected theme inline on <html>; its default variables come
  // from a stylesheet, which only the computed style lists.
  const names = new Set([...customProperties(source.style), ...customProperties(computed)]);
  const target = document.documentElement.style;
  for (const name of copied) {
    if (!names.has(name)) target.removeProperty(name);
  }
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value) target.setProperty(name, value);
    else target.removeProperty(name);
  }
  copied = names;
}

/** HA's own `hass.themes.darkMode` for the logged-in user, or undefined
 * when there's no readable HA page around this one. */
export function haDarkMode(): boolean | undefined {
  const doc = parentDocument();
  if (!doc) return undefined;
  try {
    const root = doc.querySelector("home-assistant") as HaRootElement | null;
    return root?.hass?.themes?.darkMode;
  } catch {
    return undefined;
  }
}

/** Copies the HA theme in now, and again whenever HA re-applies it (a new
 * theme, a dark/light switch, the device's color scheme changing), calling
 * `onChange` after each copy so the panel can re-render for dark mode. */
export function followHaTheme(onChange: () => void): void {
  const doc = parentDocument();
  if (!doc) return;
  const source = doc.documentElement;
  const sync = () => {
    try {
      copyThemeVariables(source);
    } catch {
      return;
    }
    onChange();
  };
  sync();
  // HA applies a theme by rewriting <html>'s inline style, and toggles
  // dark mode the same way.
  new MutationObserver(sync).observe(source, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  // An "auto" theme follows the device; HA's own update of <html> lands
  // after this fires, so check again once it has.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => window.setTimeout(sync, 100));
}
