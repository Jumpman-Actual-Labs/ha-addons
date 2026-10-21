import { css } from "lit";

/** Shared raised panel treatment; imported in each view for shadow DOM scoping. */
export const glassCardStyle = css`
  ha-card {
    position: relative;
    --ha-card-background: var(--card-background-color, #16181b);
    --ha-card-border-radius: var(--hud-radius, 10px);
    --ha-card-border-width: 1px;
    --ha-card-border-color: var(--divider-color, rgba(255, 255, 255, 0.1));
    --ha-card-box-shadow: var(--cache-shadow);
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

  ha-card.wishlist {
    --ha-card-background: color-mix(in srgb, var(--hud-purple, #a78bfa) 10%, var(--card-background-color, #16181b));
    --ha-card-border-color: color-mix(in srgb, var(--hud-purple, #a78bfa) 35%, transparent);
  }
`;

/** Shared controls, badges, focus states and responsive layout primitives. */
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
    background: var(--cache-gunmetal, #1B2023);
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

  button.primary {
    background: var(--cache-button, #59643B);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--cache-text, #F0F2F2);
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: var(--hud-radius-sm, 8px);
    padding: 10px 16px;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease;
  }
  button.primary:hover:not([disabled]) {
    background: var(--cache-button-hover, #626F42);
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
  /* Square icon-only button (an ha-icon inside, plus a title/aria-label
     for the text it doesn't show) - for small, frequent card actions where
     a labelled button would crowd the card. */
  button.icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: none;
    border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
    border-radius: var(--hud-radius-sm, 8px);
    color: var(--primary-text-color, #f2f4f6);
    cursor: pointer;
    --mdc-icon-size: 18px;
    transition: border-color 180ms ease, background 180ms ease;
  }
  button.icon:hover {
    border-color: var(--hud-border-hover, rgba(255, 255, 255, 0.16));
    background: color-mix(in srgb, var(--primary-color, #f2f4f6) 8%, transparent);
  }
  button.icon.bare {
    border-color: transparent;
    color: var(--secondary-text-color, #a1a7b0);
  }
  button.icon.bare:hover {
    color: var(--primary-text-color, #f2f4f6);
  }
  /* Overflow ("three dots") menu anchored to a card's top-right corner -
     the card itself needs position: relative, and the open card a raised
     z-index so the menu isn't painted under the next card in the grid
     (each glass card is its own stacking context via backdrop-filter). */
  .card-menu {
    position: relative;
  }
  .card-menu .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 10;
    min-width: 140px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    background: var(--hud-bg-2, #0d0f11);
    border: 1px solid var(--hud-border-hover, rgba(255, 255, 255, 0.16));
    border-radius: var(--hud-radius-sm, 8px);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
  }
  .card-menu .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--primary-text-color, #f2f4f6);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
    --mdc-icon-size: 18px;
  }
  .card-menu .menu button:hover {
    background: color-mix(in srgb, var(--primary-color, #f2f4f6) 10%, transparent);
  }
  .card-menu .menu button.danger {
    color: var(--error-color, #e5484d);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
    flex-wrap: wrap;
  }

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
    background: var(--cache-coyote);
    color: var(--text-primary-color, #0a0a0b);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
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
  button:focus-visible, a:focus-visible { outline: 2px solid var(--cache-coyote); outline-offset: 3px; }
  button { min-height: 40px; font-family: inherit; }
  option { background: var(--cache-gunmetal); color: var(--cache-text); }
  section h2 { color: var(--cache-text); }
  .segmented { max-width: 100%; overflow-x: auto; }
  @media (max-width: 600px) {
    .filters input, .filters select { min-width: 0; flex: 1 1 130px; }
    .field-row { grid-template-columns: 1fr; }
    button { min-height: 44px; }
    input, select, textarea { font-size: 16px; }
    .grid, .stats-grid { gap: 12px; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;

