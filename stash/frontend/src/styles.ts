import { css } from "lit";

/** Theme-aware surfaces and controls, scoped to each view's shadow root. */
export const glassCardStyle = css`
  :host { display: block; min-width: 0; }
  * { box-sizing: border-box; }
  ha-card {
    --ha-card-background: var(--card-background-color, #fff);
    --ha-card-border-radius: 18px;
    --ha-card-border-width: 1px;
    --ha-card-border-color: color-mix(in srgb, var(--divider-color, #dce3e8) 70%, transparent);
    --ha-card-box-shadow: var(--stash-card-shadow);
  }
  button, input, select { font: inherit; }
  button { color: inherit; min-height: 40px; transition: background 150ms ease; }
  button:not(:disabled):hover { filter: brightness(0.96); }
  button:disabled { opacity: 0.55; cursor: wait; }
  button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
    outline: 3px solid var(--primary-color, #16856b); outline-offset: 3px;
  }
  h2 { letter-spacing: -0.02em; }
  .value, .amount, .legend-amount { font-variant-numeric: tabular-nums; letter-spacing: -0.025em; }
  .empty { line-height: 1.6; }
  @media (max-width: 600px) {
    .actions, .toolbar { flex-wrap: wrap; }
    input, select { min-height: 44px; }
  }
`;

/** Last in each view's style list, so controls stay consistent across sections. */
export const bankingStyle = css`
  ha-card {
    --ha-card-border-radius: 12px;
    --ha-card-box-shadow: var(--stash-card-shadow);
    --ha-card-border-color: var(--stash-card-border, var(--divider-color, #e3e9ed));
  }
  button.primary, button.secondary, button.option {
    font-size: 0.82rem; font-weight: 600; border-radius: 8px; min-height: 42px;
    padding: 10px 16px; line-height: 1.4;
  }
  button.primary { background: var(--primary-color, #4757bd); color: var(--text-primary-color, #fff); border: 1px solid var(--primary-color, #4757bd); cursor: pointer; }
  button.secondary { border: 1px solid var(--divider-color, #d8dfe9); cursor: pointer; color: var(--primary-text-color, #263b42); background: var(--card-background-color, #fff); }
  button.option { color: var(--primary-text-color, #263b42); }
  label { font-size: 0.78rem; font-weight: 500; }
  input, select { border-radius: 8px; min-height: 42px; font-size: 0.9rem; }
  section h2 { font-size: 0.96rem; font-weight: 650; margin: 24px 0 12px; }
  .label, .bill-meta { font-size: 0.78rem; line-height: 1.5; }
  .value { font-weight: 650; letter-spacing: -0.04em; }
  .toolbar { gap: 8px; flex-wrap: wrap; }
  .actions { flex-wrap: wrap; }
  .status, .tag { border-radius: 5px; font-size: 0.68rem; font-weight: 600; padding: 4px 7px; }
  .status.paid, .tag.paid { background: var(--stash-success-bg); color: var(--stash-success); }
  .status.overdue, .tag.overdue { background: var(--stash-danger-bg); color: var(--stash-danger); }
  .status.unpaid, .tag.upcoming { background: var(--stash-muted-bg); color: var(--secondary-text-color); }
  .status.deferred { background: var(--stash-deferred-bg); color: var(--stash-deferred); }
  .status.partially_paid, .tag.due { background: var(--stash-warning-bg); color: var(--stash-warning); }
  .empty { font-size: 0.82rem; padding: 18px 0; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
