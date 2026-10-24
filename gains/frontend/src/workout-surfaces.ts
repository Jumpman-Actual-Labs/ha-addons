import { css } from "lit";

export const workoutSurfaceStyles = css`
  .library-header { align-items: center; gap: 16px; }
  .library-header h1 { margin: 0; letter-spacing: -1px; }
  .segments { border-radius: 999px; background: var(--secondary-background-color); padding: 4px; gap: 4px; }
  .segments button { border: 0; border-radius: 999px; min-height: 44px; background: transparent; }
  .segments button[aria-pressed="true"] { background: var(--card-background-color); color: var(--primary-text-color); }
  .library-grid { gap: 16px; margin-top: 22px; }
  .workout-tile { border-radius: 22px; padding: 24px; min-height: 190px; }
  .workout-tile:hover { border-color: var(--primary-color); }
  .workout-tile h2 { font-size: 24px; line-height: 1.15; letter-spacing: -.5px; }
  .workout-tile .small:last-child { color: var(--primary-color); font-weight: 700; margin-top: 18px; }
  .workout-tile gains-muscle-map { --gains-compact-muscle-width: 70px; --gains-compact-muscle-height: 100px; }
  .compact-workout-overview { max-width: 820px; }
  .workout-overview-title h1 { font-size: clamp(30px, 4vw, 42px); line-height: 1.1; }
  .compact-summary { padding: 18px 22px; border: 1px solid var(--divider-color); border-radius: 18px; background: var(--card-background-color); justify-content: space-between; gap: 12px; }
  .compact-summary strong { font-size: 24px; }
  .target-muscle-card { background: transparent; border: 0; border-radius: 0; padding: 8px 0; }
  .target-muscle-strip { border-bottom: 1px solid var(--divider-color); padding-bottom: 16px; }
  .exercise-overview-list { gap: 10px; margin-top: 16px; }
  .exercise-list-row { border: 1px solid var(--divider-color); border-radius: 18px; background: var(--card-background-color); padding: 8px; }
  .exercise-list-row .exercise-card-header { padding: 4px; }
  .exercise-card-name { font-size: 16px; }
  .exercise-card-summary { margin-top: 4px; }
  .exercise-menu-trigger { background: transparent; min-width: 44px; height: 44px; }
  .workout-overview-actions .primary { min-height: 54px; }
  .exercise-focus { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 22px; background: var(--primary-background-color); border-radius: 18px; margin: 18px 0; }
  .exercise-focus p { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 1.4px; color: var(--secondary-text-color); }
  .exercise-focus strong { font-size: 16px; line-height: 1.4; }
  .exercise-focus gains-muscle-map { flex: 0 0 110px; --gains-compact-muscle-width: 48px; --gains-compact-muscle-height: 104px; }
  .exercise-page-header { align-items: center; }
  .exercise-page-title h2 { font-size: clamp(24px, 3vw, 30px); margin-top: 0; }
  .set-grid-header { margin-top: 26px; letter-spacing: .08em; }
  .set-row.gravl-set-row { padding: 6px; background: var(--card-background-color); border-radius: 14px; }
  .set-row.gravl-set-row.active { background: var(--card-background-color); border-color: var(--gains-active-outline); }
  .set-swipe-shell:not(.swiping):not(.armed):not(.deleting) .set-swipe-delete-lane { visibility: hidden; }
  .set-number-box, .set-field input, .set-readonly-value, .set-loading-button { background: var(--secondary-background-color); border-color: transparent; border-radius: 10px; }
  .set-row.active .set-field input { border-color: var(--gains-active-outline); }
  .set-row.done .set-readonly-value { color: var(--gains-success); }
  .log-set-button { border-radius: 999px; min-height: 54px; font-size: 16px; }
  .rest-timer-banner { border-color: var(--divider-color); }
  .rest-timer-countdown { color: var(--primary-color); }
  @media (max-width: 520px) {
    .library-header { flex-wrap: wrap; }
    .library-header .primary { font-size: 12px; padding: 10px 16px; }
    .library-grid { grid-template-columns: 1fr; }
    .workout-tile { min-height: 170px; }
    .compact-summary { margin: 18px 0 24px; padding: 16px; }
    .compact-summary strong { font-size: 21px; }
    .exercise-list-row { padding: 6px; }
    .exercise-focus { padding: 16px; }
    .exercise-focus gains-muscle-map { --gains-compact-muscle-height: 70px; }
    .exercise-page-title h2 { font-size: 24px; }
  }
`;
