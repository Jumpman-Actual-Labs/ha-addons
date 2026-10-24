import { css } from "lit";

/** Panel surfaces with accents inherited from the current user's HA theme. */
export const gainsTheme = css`
  :host {
    color-scheme: light;
    --primary-background-color: #f5f6f8;
    --secondary-background-color: #e9edf1;
    --card-background-color: #fff;
    --primary-text-color: #17212b;
    --secondary-text-color: #566373;
    --divider-color: #d9e0e6;
    --error-color: #b83540;
    --warning-color: #956007;
    --gains-muscle-neutral: #d8e0e6;
    --gains-active-outline: #856009;
  }
  :host([data-dark]) {
    color-scheme: dark;
    --primary-background-color: #0a1117;
    --secondary-background-color: #15212b;
    --card-background-color: #101b23;
    --primary-text-color: #f3f6f7;
    --secondary-text-color: #a0afb9;
    --divider-color: #25333d;
    --error-color: #ff939e;
    --warning-color: #efc061;
    --gains-muscle-neutral: #30404c;
    --gains-active-outline: #efc061;
  }
  :host {
    --gains-success: var(--primary-color);
    --gains-tint: color-mix(in srgb, var(--primary-color) 10%, var(--card-background-color));
    --gains-muscle: var(--primary-color);
    --gains-muscle-secondary: color-mix(in srgb, var(--primary-color) 35%, var(--card-background-color));
    --gains-success-bg: color-mix(in srgb, var(--gains-success) 10%, var(--card-background-color));
    --ha-card-header-color: var(--primary-text-color);
    --mdc-theme-primary: var(--primary-color);
    --mdc-theme-surface: var(--card-background-color);
    --mdc-theme-on-surface: var(--primary-text-color);
    --mdc-theme-on-primary: var(--text-primary-color);
    -webkit-font-smoothing: antialiased;
  }
`;
