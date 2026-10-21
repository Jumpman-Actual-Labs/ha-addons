import { css } from "lit";

/**
 * "Smoked transparent glass" treatment for `ha-card` - a genuinely
 * translucent panel (real `backdrop-filter: blur()` over a mostly-see-
 * through fill, `--card-background-color` / `cache-panel.ts`'s `--hud-
 * panel-bg` is `rgba(22, 24, 27, 0.46)`) with a thin neutral border,
 * needed here because `cache-panel.ts`'s `:host::before`/`::after`
 * ambient highlight + grain is what the blur actually has to refract; a
 * frosted-glass card over a perfectly flat, uniform background is
 * visually indistinguishable from an opaque one, since blur has nothing
 * to blur. Applied via `ha-card`'s own supported CSS custom properties
 * rather than reaching into its shadow DOM for the fill/border/shadow
 * itself. Import into each view's own static styles (shadow DOM scoping
 * means this can't just be set once at the panel root and expected to
 * style descendant components' ha-card elements via a plain selector).
 *
 * `--ha-card-box-shadow` is four soft layers, not one, for a sense of a
 * physical pane of glass sitting a few pixels above the page - an inset
 * top highlight (light catching the glass's top edge), a faint inset
 * bottom vignette (the glass reads as having actual thickness), a tight
 * "contact" shadow close beneath it, and a soft ambient shadow further
 * out. Deliberately RESTRAINED (low alpha throughout) - the brief this
 * pass is built against explicitly wants "barely visible" material cues
 * ("those cards look like glass," not "those cards are glowing" or
 * "those cards are floating dramatically"); an earlier pass had these
 * same four layers at roughly double the alpha, which read as too bold
 * for the "Apple-level restraint" this pass asks for. The same recipe
 * (scaled to each element's own size) is used by `cache-dialog`'s
 * `.surface` and `attachment-bar`'s cards, so every glass surface in the
 * app reads consistently 3D rather than each having its own one-off
 * shadow. `ha-card::before` adds one more restrained material cue: a
 * barely-visible diagonal sheen (a 145deg white-to-transparent gradient,
 * peak alpha 0.035) simulating a glass edge reflection - this is a
 * *material* highlight, distinct from and layered UNDER the inset top
 * highlight in the box-shadow, which is a *lighting* cue.
 *
 * No corner-accent marks - an earlier pass drew bracket/reticle-style
 * corners here (and on cache-dialog's `.surface` and attachment-bar's
 * cards) via `::before`/`::after`/real child `<div class="corner">`
 * elements; removed on request for a plainer glass-panel look with
 * nothing drawn on top of the card edges. `ha-card::before` reuses that
 * freed-up pseudo-element for the sheen gradient instead.
 */
export const glassCardStyle = css`
  ha-card {
    position: relative;
    --ha-card-background: var(--card-background-color, #16181b);
    --ha-card-border-radius: var(--hud-radius, 10px);
    --ha-card-border-width: 1px;
    --ha-card-border-color: var(--divider-color, rgba(255, 255, 255, 0.1));
    --ha-card-box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), inset 0 -14px 22px -18px rgba(0, 0, 0, 0.22),
      0 2px 8px rgba(0, 0, 0, 0.18), 0 16px 36px -14px rgba(0, 0, 0, 0.34);
    backdrop-filter: blur(var(--hud-blur, 18px)) saturate(118%);
    -webkit-backdrop-filter: blur(var(--hud-blur, 18px)) saturate(118%);
    transition: transform 200ms ease, box-shadow 200ms ease;
  }
  ha-card::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    z-index: 1;
    background: linear-gradient(145deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.006) 45%, rgba(255, 255, 255, 0.02));
  }
  /* Shared across every browsing-grid card (firearms-view.ts's .firearm,
     inventory-view.ts's .item) that represents a wishlist firearm/part -
     a subtle purple tint on the glass itself, not just the badge, so a
     wishlist entry reads as visually distinct at a glance while scanning
     a full grid. Same --ha-card-* custom-property override mechanism the
     :hover rules already use (see the doc comment above); a card that
     also defines its own :hover state needs a higher-specificity
     .wishlist:hover companion rule to keep this tint from being
     clobbered on hover - see ha-card.firearm.wishlist:hover in
     firearms-view.ts. */
  ha-card.wishlist {
    --ha-card-background: color-mix(in srgb, var(--hud-purple, #a78bfa) 10%, var(--card-background-color, #16181b));
    --ha-card-border-color: color-mix(in srgb, var(--hud-purple, #a78bfa) 35%, transparent);
  }
`;

/** Shared form/button/badge/grid primitives used across every view, so each
 * view file doesn't have to re-declare the same input/button/badge rules.
 * Flat monochrome: uppercase tracked labels, cleanly rounded corners, a
 * plain white/gray primary/focus/active state with no glow, a normal
 * system sans-serif (inherited from cache-panel.ts's `:host`
 * font-family - nothing here sets its own font; monospace was tried
 * early on and dropped, see cache-panel.ts's theme comment). Non-
 * semantic color is still just the one accent (white/gray) - warning/
 * error keep their own separate functional colors, and `--hud-good`
 * green (cache-panel.ts) is reserved for status-good text, not used
 * here as an interactive color. */
export const formStyles = css`
  label {
    display: block;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--secondary-text-color, #a3adb6);
    margin: 12px 0 4px;
  }
  input,
  select,
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: var(--hud-radius-sm, 8px);
    border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
    background: color-mix(in srgb, var(--card-background-color, #16181b) 70%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: var(--primary-text-color, #f2f4f6);
    font-size: 0.95rem;
    font-family: inherit;
    transition: border-color 180ms ease, background 180ms ease;
  }
  input:hover,
  select:hover,
  textarea:hover {
    border-color: var(--hud-border-hover, rgba(255, 255, 255, 0.16));
  }
  input:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: var(--primary-color, #f2f4f6);
    box-shadow: 0 0 0 1px var(--primary-color, #f2f4f6);
  }
  textarea {
    resize: vertical;
    min-height: 60px;
  }
  fieldset {
    border: none;
    padding: 0;
    margin: 0;
  }
  .field-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0 12px;
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0;
  }
  .checkbox-row input {
    width: auto;
    accent-color: var(--primary-color, #f2f4f6);
  }
  button {
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* The primary CTA (e.g. "+ Add Firearm") stands out through CONTRAST,
     not a solid opaque fill or a glow - still the brightest surface in
     the UI, but a translucent glass one like everything else, so it
     reads as the same material system rather than a plain HTML button
     dropped on top of it. */
  button.primary {
    background: color-mix(in srgb, var(--primary-color, #f2f4f6) 92%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--text-primary-color, #0a0a0b);
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: var(--hud-radius-sm, 8px);
    padding: 10px 16px;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease;
  }
  button.primary:hover:not([disabled]) {
    background: var(--primary-color, #f2f4f6);
  }
  button.primary[disabled] {
    opacity: 0.4;
    cursor: default;
  }
  button.secondary {
    background: color-mix(in srgb, var(--card-background-color, #16181b) 55%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
    border-radius: var(--hud-radius-sm, 8px);
    padding: 10px 16px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    color: var(--primary-text-color, #f2f4f6);
    transition: border-color 180ms ease, background 180ms ease;
  }
  button.secondary:hover:not([disabled]) {
    border-color: var(--hud-border-hover, rgba(255, 255, 255, 0.16));
    background: color-mix(in srgb, var(--card-background-color, #16181b) 75%, transparent);
  }
  button.secondary.danger {
    color: var(--error-color, #e5484d);
    border-color: color-mix(in srgb, var(--error-color, #e5484d) 55%, transparent);
  }
  button.secondary.danger:hover {
    background: color-mix(in srgb, var(--error-color, #e5484d) 12%, transparent);
  }
  button.secondary[disabled] {
    opacity: 0.4;
    cursor: default;
  }
  button.link {
    background: none;
    border: 1px solid color-mix(in srgb, var(--primary-color, #f2f4f6) 40%, transparent);
    border-radius: 8px;
    color: var(--primary-color, #f2f4f6);
    cursor: pointer;
    padding: 6px 12px;
    font-size: 0.8rem;
    font-weight: 600;
  }
  button.link:hover {
    background: color-mix(in srgb, var(--primary-color, #f2f4f6) 10%, transparent);
  }
  button.link.danger {
    color: var(--error-color, #e5484d);
    border-color: color-mix(in srgb, var(--error-color, #e5484d) 45%, transparent);
  }
  button.link.danger:hover {
    background: color-mix(in srgb, var(--error-color, #e5484d) 10%, transparent);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
    flex-wrap: wrap;
  }
  /* Tiny inset glass chips, not solid pill tags - a neutral metadata
     badge (firearm type, caliber) should read as a small control
     embedded IN the glass, not a separate colored tag competing with
     the firearm name for attention. Semantic variants (info/success/
     warning/error) still carry their own hue, just at low enough alpha
     to stay in the same restrained register. */
  .badge {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 999px;
    white-space: nowrap;
    background: rgba(255, 255, 255, 0.05);
    color: var(--secondary-text-color, #a3adb6);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .badge.info {
    background: color-mix(in srgb, var(--primary-color, #f2f4f6) 10%, transparent);
    color: var(--primary-color, #f2f4f6);
    border-color: color-mix(in srgb, var(--primary-color, #f2f4f6) 30%, transparent);
  }
  .badge.success {
    background: color-mix(in srgb, var(--hud-good, #7bc98f) 14%, transparent);
    color: var(--hud-good, #7bc98f);
    border-color: color-mix(in srgb, var(--hud-good, #7bc98f) 40%, transparent);
  }
  .badge.warning {
    background: color-mix(in srgb, var(--secondary-color, #e8b34c) 16%, transparent);
    color: var(--secondary-color, #e8b34c);
    border-color: color-mix(in srgb, var(--secondary-color, #e8b34c) 40%, transparent);
  }
  .badge.error {
    background: color-mix(in srgb, var(--error-color, #e5484d) 14%, transparent);
    color: var(--error-color, #e5484d);
    border-color: color-mix(in srgb, var(--error-color, #e5484d) 40%, transparent);
  }
  /* Wishlist's own variant, not .badge.warning - warning is still used
     for unrelated states (low ammo, "installed elsewhere") that can
     appear on the same card as a wishlist tag, so they need distinct
     hues to stay legible together. */
  .badge.wishlist {
    background: color-mix(in srgb, var(--hud-purple, #a78bfa) 16%, transparent);
    color: var(--hud-purple, #a78bfa);
    border-color: color-mix(in srgb, var(--hud-purple, #a78bfa) 40%, transparent);
  }
  .error-banner {
    background: color-mix(in srgb, var(--error-color, #e5484d) 14%, transparent);
    color: var(--error-color, #e5484d);
    border: 1px solid color-mix(in srgb, var(--error-color, #e5484d) 45%, transparent);
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 14px;
    font-size: 0.85rem;
  }
  .empty {
    color: var(--secondary-text-color, #a3adb6);
    padding: 24px 0;
    text-align: center;
  }
  .muted {
    color: var(--secondary-text-color, #a3adb6);
  }
  .small {
    font-size: 0.85rem;
  }
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .filters {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .filters input,
  .filters select {
    width: auto;
    min-width: 140px;
  }
  /* A 3-way owned/both/wishlist toggle, used in place of a <select> where
     there are only a few mutually-exclusive options worth seeing all at
     once rather than opening a dropdown for. Same glass-control register
     as the filter inputs/selects it sits alongside - the active segment
     is a lighter glass fill, not a solid opaque one, so it doesn't jump
     out of the material system the way a fully-opaque pill would. */
  .segmented {
    display: inline-flex;
    border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
    border-radius: var(--hud-radius-sm, 8px);
    overflow: hidden;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--card-background-color, #16181b) 55%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .segmented button {
    background: none;
    border: none;
    padding: 8px 14px;
    font-size: 0.8rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    color: var(--secondary-text-color, #a3adb6);
    transition: background 180ms ease, color 180ms ease;
  }
  .segmented button:hover:not(.active) {
    color: var(--primary-text-color, #f2f4f6);
    background: rgba(255, 255, 255, 0.04);
  }
  .segmented button + button {
    border-left: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
  }
  .segmented button.active {
    background: color-mix(in srgb, var(--primary-color, #f2f4f6) 82%, transparent);
    color: var(--text-primary-color, #0a0a0b);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 18px;
    margin-bottom: 28px;
  }
  section {
    margin-bottom: 28px;
  }
  section h2 {
    font-size: 0.95rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 10px;
    color: var(--primary-color, #f2f4f6);
  }
`;
