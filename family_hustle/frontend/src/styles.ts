import { css } from "lit";

/** Solid, quiet surfaces shared by all Hustle views. */
export const glassCardStyle = css`
  ha-card {
    --ha-card-background: var(--card-background-color, #fff);
    --ha-card-border-radius: 18px;
    --ha-card-border-width: 1px;
    --ha-card-border-color: var(--divider-color, #e2e7e9);
    --ha-card-box-shadow: none;
  }
`;

/** Shared form/button/badge primitives used across every view, so each view
 * file doesn't have to re-declare the same input/button/badge rules. */
export const formStyles = css`
  :host { line-height: 1.5; }
  * { box-sizing: border-box; }
  h1, h2, h3 { letter-spacing: -.025em; }
  h1 { font-size: 1.75rem; margin: 0 0 8px; font-weight: 750; }
  h2 { font-size: 1.05rem; font-weight: 650; }
  h3 { font-size: 1rem; margin: 0; }
  .col { display: flex; flex-direction: column; gap: 3px; }
  .spread { flex-wrap: wrap; gap: 12px; }
  details summary { cursor: pointer; min-height: 44px; }
  details summary:focus-visible { outline: 3px solid var(--primary-color, #168064); outline-offset: 3px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

  button { min-height: 44px; color: inherit; font-family: inherit; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
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
    padding: 11px 12px;
    border-radius: 10px;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-size: 1rem;
    font-family: inherit;
  }
  button.primary {
    background: var(--hustle-accent, #23765c);
    color: #fff;
    border: none;
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 0.95rem;
    cursor: pointer;
  }
  button.primary[disabled] {
    opacity: 0.6;
    cursor: default;
  }
  button.secondary {
    background: none;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    padding: 10px 16px;
    cursor: pointer;
  }
  button.secondary.danger {
    color: var(--error-color, #c62828);
    border-color: color-mix(in srgb, var(--error-color, #c62828) 96%, transparent);
  }
  button.secondary.danger:hover {
    background: color-mix(in srgb, var(--error-color, #c62828) 10%, transparent);
  }
  button.secondary[disabled] {
    opacity: 0.6;
    cursor: default;
  }
  button.link {
    background: none;
    border: 1px solid color-mix(in srgb, var(--primary-color, #03a9f4) 45%, transparent);
    border-radius: 10px;
    color: var(--primary-color, #03a9f4);
    cursor: pointer;
    padding: 6px 12px;
    font-size: 0.9rem;
  }
  button.link:hover {
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 10%, transparent);
  }
  button.link.danger {
    color: var(--error-color, #c62828);
    border-color: color-mix(in srgb, var(--error-color, #c62828) 45%, transparent);
  }
  button.link.danger:hover {
    background: color-mix(in srgb, var(--error-color, #c62828) 10%, transparent);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
  .badge {
    display: inline-block;
    font-size: 0.75rem;
    padding: 3px 8px;
    border-radius: 12px;
    text-transform: capitalize;
    white-space: nowrap;
    background: var(--secondary-background-color, #eeeeee);
    color: var(--secondary-text-color, #616161);
  }
  .badge.info { background: #e3f2fd; color: #1565c0; }
  .badge.success { background: #e8f5e9; color: #2e7d32; }
  .badge.warning { background: #fff8e1; color: #f57f17; }
  .badge.error { background: #ffebee; color: #c62828; }
  .empty {
    color: var(--secondary-text-color, #727272);
    padding: 12px 0;
  }
  .muted {
    color: var(--secondary-text-color, #727272);
  }
  .small {
    font-size: 0.85rem;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
    gap: 16px;
  }
`;

