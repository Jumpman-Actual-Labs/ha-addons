import { css } from "lit";

/** Solid surfaces, kept under the existing export name for view compatibility. */
export const glassCardStyle = css`
  ha-card {
    --ha-card-background: var(--card-background-color, #fff);
    --ha-card-border-radius: 22px;
    --ha-card-border-width: 1px;
    --ha-card-border-color: var(--divider-color, #dfe5ee);
    --ha-card-box-shadow: none;
  }
`;

/** Shared form/button/badge/grid primitives used across every view, so each
 * view file doesn't have to re-declare the same input/button/badge rules. */
export const formStyles = css`
  :host { line-height: 1.5; font-variant-numeric: tabular-nums; }
  * { box-sizing: border-box; }
  button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
  h1 { font-size: clamp(28px, 4vw, 38px); line-height: 1.12; font-weight: 750; }
  h1, h2, h3 { letter-spacing: -0.4px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  label {
    display: block;
    font-size: 0.85rem;
    color: var(--secondary-text-color, #727272);
    margin: 12px 0 4px;
  }
  input,
  select,
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-size: 1rem;
    font-family: inherit;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  input:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: var(--primary-color, #03a9f4);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color, #03a9f4) 20%, transparent);
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
  button {
    min-height: 44px;
    font-family: inherit;
  }
  button.primary {
    background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
    border: none;
    border-radius: 999px;
    padding: 12px 22px;
    font-size: 0.95rem;
    font-weight: 750;
    cursor: pointer;
    box-shadow: none;
    transition:
      transform 0.1s ease,
      box-shadow 0.15s ease,
      opacity 0.15s ease;
  }
  button.primary:hover {
    filter: brightness(1.08);
  }
  button.primary:active {
    transform: scale(0.97);
  }
  button.primary[disabled] {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
    transform: none;
  }
  button.secondary {
    background: color-mix(in srgb, var(--card-background-color, #fff) 70%, transparent);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 999px;
    padding: 8px 16px;
    font-size: 0.9rem;
    cursor: pointer;
    color: var(--primary-text-color, #212121);
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }
  button.secondary:hover {
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 10%, transparent);
    border-color: var(--primary-color, #03a9f4);
  }
  button.secondary[disabled] {
    opacity: 0.5;
    cursor: default;
  }
  .icon-button {
    background: none;
    border: none;
    border-radius: 50%;
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--secondary-text-color, #727272);
    transition: background-color 0.15s ease;
  }
  .icon-button:hover {
    background: color-mix(in srgb, var(--primary-text-color, #212121) 8%, transparent);
  }
  /* Restyles a native checkbox into an iOS-style toggle switch, keeping
   * real checkbox semantics/accessibility -- no extra wrapper markup
   * needed, just add class="toggle" to an existing input[type=checkbox]. */
  input.toggle {
    appearance: none;
    -webkit-appearance: none;
    width: 44px;
    height: 26px;
    min-width: 44px;
    border-radius: 13px;
    padding: 0;
    background: color-mix(in srgb, var(--secondary-text-color, #727272) 35%, transparent);
    border: none;
    position: relative;
    cursor: pointer;
    transition: background-color 0.2s ease;
    flex-shrink: 0;
  }
  input.toggle::before {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform 0.2s ease;
  }
  input.toggle:checked {
    background: var(--primary-color, #03a9f4);
  }
  input.toggle:checked::before {
    transform: translateX(18px);
  }
  input.toggle:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 2px;
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
    font-size: 0.75rem;
    padding: 3px 9px;
    border-radius: 12px;
    text-transform: capitalize;
    white-space: nowrap;
    background: var(--secondary-background-color, #eeeeee);
    color: var(--secondary-text-color, #616161);
    font-weight: 500;
  }
  .badge.success {
    background: var(--gains-success-bg, #eef8f2);
    color: var(--gains-success, #167750);
  }
  .muted {
    color: var(--secondary-text-color, #727272);
  }
  .small {
    font-size: 0.85rem;
  }
  section {
    margin-bottom: 28px;
  }
  section h2 {
    font-size: 1.05rem;
    font-weight: 500;
    margin: 0 0 10px;
  }
`;

