import { css } from "lit";

/** Garage's scoped automotive workshop palette, aligned with Stash and Cache's dark shells. */
export const themeStyles = css`
  :host {
    color-scheme: dark;
    --garage-bg: #111315;
    --garage-surface: #1b1e21;
    --garage-raised: #272b2f;
    --garage-inset: #15181b;
    --garage-border: #3b4046;
    --garage-accent: #f6a45b;
    --garage-text: #f0f0ed;
    --garage-muted: #aaaeb2;
    --garage-success: #83d5ad;
    --garage-warning: #edc27e;
    --garage-danger: #f5a0a5;
    --garage-font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --garage-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    --primary-color: var(--garage-accent);
    --text-primary-color: #251608;
    --primary-background-color: var(--garage-bg);
    --secondary-background-color: var(--garage-raised);
    --card-background-color: var(--garage-surface);
    --primary-text-color: var(--garage-text);
    --secondary-text-color: var(--garage-muted);
    --divider-color: var(--garage-border);
    --error-color: var(--garage-danger);
    --warning-color: var(--garage-warning);
    font-family: var(--garage-font);
    color: var(--garage-text);
    font-size: 14px;
    line-height: 1.5;
  }
`;

export const glassCardStyle = css`
  ha-card {
    --ha-card-background: var(--garage-surface, #1b1e21);
    --ha-card-border-radius: 16px;
    --ha-card-border-width: 1px;
    --ha-card-border-color: var(--garage-border, #3b4046);
    --ha-card-box-shadow: inset 0 1px 0 #ffffff06, 0 8px 28px #00000018;
    position: relative;
  }
`;

export const controlStyles = css`
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; }
  button { min-height: 44px; cursor: pointer; transition: background 160ms ease, border-color 160ms ease, color 160ms ease; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--primary-color, #f6a45b); outline-offset: 3px;
  }
  input:not([type="checkbox"]), select, textarea {
    min-height: 44px; padding: 11px 13px;
    border: 1px solid var(--divider-color, #3b4046); border-radius: 9px;
    background: var(--garage-inset, #15181b); color: var(--primary-text-color, #f0f0ed);
    font-size: .9rem; max-width: 100%;
  }
  input::placeholder, textarea::placeholder { color: var(--secondary-text-color, #aaaeb2); opacity: .75; }
  input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--primary-color, #f6a45b); flex-shrink: 0; }
  button.primary, button.link {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid var(--primary-color, #f6a45b); border-radius: 9px; padding: 10px 16px;
    background: var(--primary-color, #f6a45b); color: var(--text-primary-color, #251608);
    font-size: .82rem; font-weight: 650;
  }
  button.primary:hover:not(:disabled), button.link:hover:not(:disabled) { background: #ffc18a; border-color: #ffc18a; }
  button.secondary, button.secondary-link {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid var(--divider-color, #3b4046); border-radius: 9px; padding: 10px 16px;
    background: var(--garage-raised, #272b2f); color: var(--primary-text-color, #f0f0ed);
    font-size: .82rem; font-weight: 550;
  }
  button.secondary:hover:not(:disabled), button.secondary-link:hover:not(:disabled), button.icon:hover:not(:disabled) {
    background: #33383d; border-color: #626970;
  }
  button.ghost {
    border: 0; background: transparent; color: var(--primary-color, #f6a45b);
    font-size: .8rem; font-weight: 550; padding: 8px 0; text-align: left;
  }
  button.icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; flex-shrink: 0; padding: 0;
    border: 1px solid transparent; border-radius: 9px; background: transparent;
    color: var(--secondary-text-color, #aaaeb2);
  }
  button.danger { color: var(--garage-danger, #f5a0a5); }
  ha-icon { --mdc-icon-size: 19px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

export const formStyles = [controlStyles, css`
  :host { line-height: 1.5; }
  label { display: block; font-size: .78rem; font-weight: 550; color: var(--secondary-text-color, #aaaeb2); margin: 18px 0 7px; }
  input:not([type="checkbox"]), select, textarea { width: 100%; }
  textarea { min-height: 92px; resize: vertical; }
  input[type="file"] { border-style: dashed; padding: 16px; }
  input[type="file"]::file-selector-button {
    padding: 8px 12px; margin-right: 12px; border: 1px solid var(--divider-color);
    border-radius: 7px; background: var(--garage-raised, #272b2f); color: var(--primary-text-color); cursor: pointer;
  }
  .dialog-intro { color: var(--secondary-text-color); font-size: .83rem; margin: 0 0 22px; line-height: 1.7; }
  .form-section {
    display: flex; align-items: center; gap: 8px; margin: 26px 0 6px; padding-top: 22px;
    border-top: 1px solid var(--divider-color); color: var(--primary-color);
    font-size: .7rem; letter-spacing: .09em; text-transform: uppercase; font-weight: 650;
  }
  .row, .form-row { display: flex; gap: 16px; }
  .row > *, .form-row > * { flex: 1; min-width: 0; }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; margin: 0; padding: 0; }
  .template-list { background: var(--garage-inset); }
  .template-row { margin: 0; min-height: 48px; }
  .template-row:has(input:checked) { background: color-mix(in srgb, var(--primary-color) 8%, transparent); color: var(--primary-text-color); }
  .hint { color: var(--secondary-text-color); font-size: .76rem; line-height: 1.6; margin-top: 8px; }
  @media (max-width: 600px) {
    .row, .form-row { flex-direction: column; gap: 0; }
    .actions > button { flex: 1; }
  }
`];

export const pageStyles = [controlStyles, css`
  :host { display: block; line-height: 1.5; }
  h2, h3 { letter-spacing: -.025em; }
  section { margin-bottom: 24px; }
  section h2 { font-size: .95rem; font-weight: 650; margin: 0 0 14px; gap: 12px; flex-wrap: wrap; }
  section h2 > span { display: flex; gap: 8px; flex-wrap: wrap; }
  .section-head, .header-row, .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .section-head h2, .panel-head h2 { margin: 0; font-size: 1rem; font-weight: 650; }
  .section-head p, .panel-head p { margin: 4px 0 0; color: var(--secondary-text-color); font-size: .78rem; }
  .eyebrow, .label { color: var(--secondary-text-color); font-size: .65rem; font-weight: 600; text-transform: uppercase; letter-spacing: .09em; }
  .summary-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); margin-bottom: 24px; }
  .summary-grid ha-card { padding: 20px; }
  .summary-grid .value { font-size: 1.85rem; font-weight: 650; letter-spacing: -.045em; font-variant-numeric: tabular-nums; margin: 10px 0 4px; line-height: 1.2; }
  .kpi-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .kpi-top ha-icon { color: var(--primary-color); --mdc-icon-size: 19px; }
  .kpi-foot { font-size: .72rem; color: var(--secondary-text-color); }
  .sub { color: var(--secondary-text-color); font-size: .78rem; line-height: 1.6; }
  .row { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0; border-bottom: 1px solid var(--divider-color); }
  .row:last-child { border-bottom: none; }
  .row > * { min-width: 0; flex: initial; }
  .row > :first-child { overflow-wrap: anywhere; }
  .row > :last-child { flex-shrink: 0; }
  .empty { padding: 36px 20px; text-align: center; color: var(--secondary-text-color); font-size: .85rem; line-height: 1.7; }
  .empty ha-icon { display: block; margin: 0 auto 12px; --mdc-icon-size: 32px; color: var(--primary-color); }
  .empty strong { display: block; color: var(--primary-text-color); font-size: .95rem; font-weight: 550; margin-bottom: 6px; }
  .pill, .tag { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: 1px solid var(--divider-color); border-radius: 6px; font-size: .65rem; font-weight: 600; text-transform: capitalize; color: var(--secondary-text-color); background: var(--garage-inset); white-space: nowrap; }
  .pill.good { color: var(--garage-success); border-color: #83d5ad30; background: #83d5ad0b; }
  .pill.warn, .tag.due-soon { color: var(--garage-warning); border-color: #edc27e30; background: #edc27e0b; }
  .pill.bad, .alert-tag, .tag.due { color: var(--garage-danger); border-color: #f5a0a530; background: #f5a0a50b; }
  .alert-tag { border-radius: 6px; padding: 4px 8px; font-size: .68rem; }
  a { color: var(--primary-color); text-decoration: none; font-weight: 550; overflow-wrap: anywhere; }
  a:hover { text-decoration: underline; }
  .mono { font-family: var(--garage-mono); font-variant-numeric: tabular-nums; }
  .panel { padding: 22px; }
  .icon-tile { display: inline-grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border: 1px solid #f6a45b25; border-radius: 10px; background: #f6a45b09; color: var(--primary-color); }
  .ledger-head { color: var(--secondary-text-color); font-size: .64rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--divider-color); padding: 12px 0; }
  .comparison-grid, .vehicle-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }
  .bar-row { display: grid; grid-template-columns: minmax(80px, 140px) minmax(0, 1fr) minmax(70px, 100px); gap: 14px; align-items: center; margin-bottom: 20px; font-size: .82rem; }
  .bar-label, .bar-value { width: auto; overflow-wrap: anywhere; }
  .bar-value { text-align: right; font-family: var(--garage-mono); }
  .bar-track { height: 8px; border-radius: 4px; background: var(--garage-raised); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: inherit; }
  .stat { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--divider-color); font-size: .8rem; }
  .stat:last-child { border: none; }
  .stat > :first-child { color: var(--secondary-text-color); }
  .stat > :last-child { font-family: var(--garage-mono); font-weight: 550; }
  @media (max-width: 600px) {
    .panel { padding: 16px; }
    .row { flex-wrap: wrap; }
    .row > :last-child:not(:first-child) { margin-left: auto; }
    .header-row select { flex: 1; min-width: 0; }
    section h2 > span { width: 100%; }
    section h2 > span button { flex: 1; }
    .bar-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
    .bar-track { grid-column: 1 / -1; grid-row: 2; }
  }
`];

