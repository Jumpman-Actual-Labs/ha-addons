import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { CacheState, DashboardStats, Firearm } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { formatCurrency, formatDate, formatNumber } from "../utils/format";
import { firearmHeroImage } from "../utils/hero-image";

interface ActivityEvent {
  date: string;
  icon: string;
  title: string;
  desc: string;
  firearmId?: string;
}

/** The Dashboard - Cache's "home screen," not a grid of individual
 * database stats. SEVEN consolidated glass surfaces (Armory Overview's 4
 * KPI cards, then Collection Breakdown/Armory Status/Recent Activity/
 * Most Used/Ammunition Status/Wishlist, one panel each) instead of the
 * ~16 small cards this view used to render - one per raw `DashboardStats`
 * field. Every value here is still read straight from `DashboardStats`/
 * `CacheState` (nothing fabricated); the redesign is about grouping and
 * presentation, not new data.
 *
 * A follow-up density pass fixed forced-equal-height panels: the six
 * panels below the KPI row sit in ONE `.dashboard-grid` laid out via
 * named `grid-template-areas` (not DOM-order auto-placement) with
 * `align-items: start`, so Recent Activity and Most Used - previously
 * sharing a plain 2-column grid ROW, which stretched the shorter one
 * (Most Used, 3 items) up to match the taller one (Recent Activity, up
 * to 6 events) even though neither needed that height - size
 * independently to their own content. Most Used and Wishlist now share
 * the right column as their OWN nested `.right-stack` (a plain flex
 * column, not a grid row), so THEY don't force each other's height
 * either. Ammunition Status spans the full width at the bottom instead
 * of pairing with Wishlist. See CLAUDE.md's Dashboard section for the
 * full rationale and which fields
 * feed which panel. */
@customElement("cache-dashboard-view")
export class CacheDashboardView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;

  @state() private _breakdownTab: "type" | "caliber" | "manufacturer" = "type";

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      .overview-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
        gap: 14px;
        margin-bottom: 14px;
      }
      ha-card.kpi-card {
        padding: 16px 18px;
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .kpi-icon {
        width: 42px;
        height: 42px;
        border-radius: 10px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--primary-color, #f2f4f6) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--primary-color, #f2f4f6) 25%, transparent);
      }
      .kpi-icon ha-icon {
        --mdc-icon-size: 20px;
        color: var(--primary-color, #f2f4f6);
      }
      .kpi-body {
        min-width: 0;
      }
      .kpi-label {
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #a3adb6);
      }
      .kpi-value {
        font-size: 1.75rem;
        font-weight: 700;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kpi-secondary {
        font-size: 0.78rem;
        color: var(--secondary-text-color, #a3adb6);
      }
      .kpi-tertiary {
        color: var(--secondary-color, #e8b34c);
      }
      /* The main ~67/33 two-column home-screen grid, laid out via named
         grid-template-areas rather than DOM-order auto-placement, so
         Most Used and Wishlist can share the right column as their OWN
         nested stack (.right-stack, a plain flex column) instead of each
         claiming a full grid row the width of Recent Activity. Ammo
         Status spans both columns at the bottom.

         align-items: start is the single most important line here - CSS
         Grid's default (stretch) is exactly what was making Most Used
         balloon to Recent Activity's height (and vice versa) even though
         neither panel's own content needed it - every panel below sizes
         to its own content now, full stop. Deliberately NOT set on
         .right-stack's own flex children (default flex-column behavior
         already doesn't stretch heights, only cross-axis width, which is
         what's wanted there too). */
      .dashboard-grid {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
        grid-template-areas:
          "breakdown status"
          "activity rightstack"
          "ammo ammo";
        gap: 14px;
        align-items: start;
      }
      .panel-breakdown {
        grid-area: breakdown;
      }
      .panel-status {
        grid-area: status;
      }
      .panel-activity {
        grid-area: activity;
      }
      .right-stack {
        grid-area: rightstack;
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 0;
      }
      .panel-ammo {
        grid-area: ammo;
      }
      @media (max-width: 900px) {
        .dashboard-grid {
          grid-template-columns: 1fr;
          grid-template-areas:
            "breakdown"
            "status"
            "activity"
            "rightstack"
            "ammo";
        }
      }
      ha-card.panel {
        padding: 16px 18px;
      }
      .panel-head-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 12px;
      }
      .panel-head-row .panel-heading {
        margin: 0;
      }
      .panel-heading {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 12px;
        font-size: 0.85rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .panel-heading ha-icon {
        --mdc-icon-size: 16px;
        color: var(--primary-color, #f2f4f6);
      }
      /* Restrained status pill - a dot + label, no glow, amber for
         "something needs attention" / green for "nothing does" (the
         same --hud-good used everywhere else for status-good text). */
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 0.64rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        flex-shrink: 0;
      }
      .status-pill .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .status-pill.nominal {
        color: var(--hud-good, #7bc98f);
      }
      .status-pill.nominal .status-dot {
        background: var(--hud-good, #7bc98f);
      }
      .status-pill.attention {
        color: var(--secondary-color, #e8b34c);
      }
      .status-pill.attention .status-dot {
        background: var(--secondary-color, #e8b34c);
      }
      .panel-footer {
        margin-top: 10px;
      }
      .panel-footer a {
        display: flex;
        align-items: center;
        gap: 4px;
        justify-content: center;
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #a3adb6);
        text-decoration: none;
        cursor: pointer;
        padding-top: 8px;
      }
      .panel-footer a:hover {
        color: var(--primary-color, #f2f4f6);
      }
      .panel-footer ha-icon {
        --mdc-icon-size: 14px;
      }
      /* Bar rows - shared between Collection Breakdown and Ammunition
         Status, same visual language rather than two one-off styles. */
      .bar-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 5px 0;
      }
      .bar-row .bar-label {
        width: 128px;
        flex-shrink: 0;
        font-size: 0.85rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .bar-track {
        flex: 1;
        height: 8px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        border-radius: 4px;
        background: linear-gradient(90deg, var(--cache-olive), var(--cache-olive-light));
      }
      .bar-count {
        width: 40px;
        flex-shrink: 0;
        text-align: right;
        font-size: 0.85rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .ammo-low-badge {
        flex-shrink: 0;
      }
      /* Armory Status */
      .status-metric {
        display: flex;
        align-items: baseline;
        gap: 10px;
        width: 100%;
        background: none;
        border: none;
        padding: 5px 0;
        font: inherit;
        text-align: left;
        color: inherit;
        cursor: default;
        border-radius: 6px;
        transition: background 150ms ease;
      }
      button.status-metric.clickable {
        cursor: pointer;
      }
      button.status-metric.clickable:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      button.status-metric.clickable:hover .status-label {
        color: var(--primary-text-color, #f2f4f6);
      }
      .status-count {
        font-size: 1.1rem;
        font-weight: 700;
        min-width: 20px;
      }
      .status-label {
        font-size: 0.78rem;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #a3adb6);
      }
      .status-divider {
        height: 1px;
        background: var(--divider-color, rgba(255, 255, 255, 0.1));
        margin: 8px 0;
      }
      .status-footer-label {
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #a3adb6);
        margin-bottom: 2px;
      }
      .status-footer-value {
        font-size: 0.9rem;
        font-weight: 600;
      }
      /* Recent Activity - a compact system log, not a list of cards.
         Tightened padding/margins throughout (was 14px/6px) so ~6 events
         across a few date groups lands close to the panel's actual
         content height instead of trailing off into empty space. */
      .activity-group + .activity-group {
        margin-top: 10px;
      }
      .activity-date {
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #a3adb6);
        margin-bottom: 4px;
      }
      .activity-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 4px 6px;
        margin: 0 -6px;
        border-radius: 6px;
        transition: background 150ms ease;
      }
      .activity-item.clickable {
        cursor: pointer;
      }
      .activity-item.clickable:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      .activity-icon {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        margin-top: 1px;
      }
      .activity-icon ha-icon {
        --mdc-icon-size: 13px;
        color: var(--secondary-text-color, #a3adb6);
      }
      .activity-title {
        font-size: 0.82rem;
        font-weight: 600;
        line-height: 1.35;
      }
      .activity-desc {
        font-size: 0.76rem;
        color: var(--secondary-text-color, #a3adb6);
        line-height: 1.35;
      }
      /* Most Used ranking */
      .ranking-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 5px 0;
      }
      .ranking-rank {
        font-size: 0.8rem;
        font-weight: 700;
        color: var(--secondary-text-color, #a3adb6);
        width: 20px;
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
      }
      .ranking-body {
        flex: 1;
        min-width: 0;
      }
      .ranking-name {
        font-size: 0.85rem;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ranking-meta {
        font-size: 0.72rem;
        color: var(--secondary-text-color, #a3adb6);
        margin-bottom: 4px;
      }
      .ranking-bar-track {
        height: 6px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }
      .ranking-bar-fill {
        height: 100%;
        border-radius: 3px;
        background: linear-gradient(90deg, var(--cache-olive), var(--cache-olive-light));
      }
      /* Ammunition Status */
      .ammo-status-header {
        display: flex;
        gap: 28px;
        margin-bottom: 10px;
      }
      .ammo-total-value {
        display: block;
        font-size: 1.3rem;
        font-weight: 700;
        line-height: 1.2;
      }
      .ammo-total-label {
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #a3adb6);
      }
      /* Wishlist - compact, image kept modest so the panel (sharing the
         right column with Most Used) doesn't dominate it. object-fit:
         contain against the plain panel background, no secondary box
         drawn around the image itself. */
      .wishlist-featured {
        text-align: center;
        padding-bottom: 10px;
      }
      .wishlist-image {
        width: 100%;
        max-width: 140px;
        max-height: 110px;
        object-fit: contain;
        margin: 0 auto 8px;
        display: block;
      }
      .wishlist-image-placeholder {
        height: 90px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .wishlist-image-placeholder ha-icon {
        --mdc-icon-size: 32px;
        opacity: 0.25;
      }
      .wishlist-priority-label {
        font-size: 0.64rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #a3adb6);
      }
      .wishlist-name {
        font-size: 0.95rem;
        font-weight: 700;
        margin: 3px 0 6px;
      }
      .wishlist-totals {
        display: flex;
        justify-content: space-between;
        padding-top: 10px;
        border-top: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
        font-size: 0.78rem;
        font-weight: 600;
      }
      .panel-heading ha-icon { color: var(--cache-coyote); }
      .activity-group { border-left: 1px solid var(--cache-olive); padding-left: 12px; }
      .activity-icon { border-color: var(--cache-olive); background: var(--cache-gunmetal); }
      .kpi-icon { box-shadow: inset 0 1px rgba(255,255,255,.07), 0 3px 8px rgba(0,0,0,.25); }
      @media (max-width: 600px) {
        ha-card.panel, ha-card.kpi-card { padding: 14px 12px; }
        .bar-row { flex-wrap: wrap; gap: 6px; }
        .bar-row .bar-label { width: 88px; font-size: 12px; }
        .bar-track { min-width: 32px; }
        .bar-count { width: 32px; }
      }
    `,
  ];

  private _openFirearm(id: string): void {
    this.dispatchEvent(
      new CustomEvent("cache-open-firearm", { detail: { firearmId: id }, bubbles: true, composed: true })
    );
  }

  // Plain tab switches (no specific record) - "View Wishlist" and every
  // status/panel link on this dashboard use this, same bubbling-event
  // pattern as cache-open-firearm. The optional `wishlist` flag only
  // does anything when `tab` is "firearms" - see cache-panel.ts's
  // _handleSwitchTab.
  private _switchTab(tab: string, wishlist = false): void {
    this.dispatchEvent(
      new CustomEvent("cache-switch-tab", { detail: { tab, wishlist }, bubbles: true, composed: true })
    );
  }

  private _panelHeading(icon: string, text: string) {
    return html`<div class="panel-heading"><ha-icon icon=${icon}></ha-icon>${text}</div>`;
  }

  private _kpiCard(icon: string, label: string, value: string, secondary: string, tertiary?: string) {
    return html`
      <ha-card class="kpi-card">
        <div class="kpi-icon"><ha-icon icon=${icon}></ha-icon></div>
        <div class="kpi-body">
          <div class="kpi-label">${label}</div>
          <div class="kpi-value" title=${value}>${value}</div>
          <div class="kpi-secondary">
            ${secondary}${tertiary ? html` · <span class="kpi-tertiary">${tertiary}</span>` : ""}
          </div>
        </div>
      </ha-card>
    `;
  }

  private _bars(record: Record<string, number>, limit = 8) {
    const entries = Object.entries(record).slice(0, limit);
    if (entries.length === 0) {
      return html`<div class="empty">Nothing to show yet.</div>`;
    }
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(
      ([label, value]) => html`
        <div class="bar-row">
          <span class="bar-label" title=${label}>${label}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${(value / max) * 100}%"></div>
          </div>
          <span class="bar-count">${formatNumber(value)}</span>
        </div>
      `
    );
  }

  private _statusMetric(count: number, label: string, tab?: string) {
    const body = html`<span class="status-count">${count}</span><span class="status-label">${label}</span>`;
    return tab
      ? html`<button class="status-metric clickable" @click=${() => this._switchTab(tab)}>${body}</button>`
      : html`<div class="status-metric">${body}</div>`;
  }

  // Every entry a manufacturer/model/caliber/type card could plausibly
  // need, pulled straight from the raw collection (not the pre-
  // aggregated DashboardStats id lists, which only cover ~8 entries
  // each) so a real date-ordered feed can be built rather than a fixed
  // "recently added/fired" pair of lists. Only event types this app can
  // actually produce: a firearm being added, a range session's rounds
  // fired (per firearm, since one session can cover several), a
  // cleaning log entry, and an ammunition transaction NOT already tied
  // to a range session (range_session-tagged transactions are the same
  // real-world event as the range session itself - showing both would
  // double up one action as two log lines).
  private get _activityFeed(): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    for (const f of this.cacheState.firearms) {
      events.push({
        date: f.createdAt,
        icon: "mdi:plus-circle-outline",
        title: f.customName,
        desc: "Added to collection",
        firearmId: f.id,
      });
      for (const c of f.cleaningHistory) {
        events.push({
          date: c.cleanedDate,
          icon: "mdi:water-outline",
          title: f.customName,
          desc: c.notes ? `Cleaned · ${c.notes}` : "Cleaned",
          firearmId: f.id,
        });
      }
    }
    for (const s of this.cacheState.rangeSessions) {
      for (const entry of s.firearms) {
        if (entry.roundsFired <= 0) continue;
        events.push({
          date: s.date,
          icon: "mdi:target",
          title: entry.firearmName ?? "Unknown Firearm",
          desc: `${formatNumber(entry.roundsFired)} rounds fired${
            entry.ammunitionLabel ? ` · ${entry.ammunitionLabel}` : ""
          }`,
          firearmId: entry.firearmId,
        });
      }
    }
    for (const a of this.cacheState.ammunition) {
      const label = [a.manufacturer, a.caliber].filter(Boolean).join(" ") || a.caliber;
      for (const t of a.transactions) {
        if (t.changeType === "range_session") continue;
        const verb = t.changeType === "add" ? "added" : t.changeType === "remove" ? "removed" : "adjusted";
        events.push({
          date: t.createdAt,
          icon: t.changeType === "add" ? "mdi:tray-arrow-down" : "mdi:tray-arrow-up",
          title: label,
          desc: `${formatNumber(Math.abs(t.quantityDelta))} rounds ${verb}`,
        });
      }
    }
    events.sort((x, y) => {
      const cmp = y.date.slice(0, 10).localeCompare(x.date.slice(0, 10));
      return cmp !== 0 ? cmp : y.date.localeCompare(x.date);
    });
    return events;
  }

  private _renderActivity() {
    const all = this._activityFeed;
    if (all.length === 0) {
      return html`<div class="empty">Nothing logged yet.</div>`;
    }
    const shown = all.slice(0, 6);
    const groups: { date: string; events: ActivityEvent[] }[] = [];
    for (const ev of shown) {
      const dateKey = ev.date.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.date === dateKey) {
        last.events.push(ev);
      } else {
        groups.push({ date: dateKey, events: [ev] });
      }
    }
    return html`
      ${groups.map(
        (g) => html`
          <div class="activity-group">
            <div class="activity-date">${formatDate(g.date)}</div>
            ${g.events.map(
              (ev) => html`
                <div
                  class="activity-item ${ev.firearmId ? "clickable" : ""}"
                  @click=${ev.firearmId ? () => this._openFirearm(ev.firearmId!) : undefined}
                >
                  <div class="activity-icon"><ha-icon icon=${ev.icon}></ha-icon></div>
                  <div>
                    <div class="activity-title">${ev.title}</div>
                    <div class="activity-desc">${ev.desc}</div>
                  </div>
                </div>
              `
            )}
          </div>
        `
      )}
      ${all.length > shown.length
        ? html`<div class="panel-footer">
            <a @click=${() => this._switchTab("firearms")}>View All <ha-icon icon="mdi:arrow-right"></ha-icon></a>
          </div>`
        : ""}
    `;
  }

  // Top ~5 by lifetime round count, skipping zero-round entries unless
  // there aren't enough firearms WITH usage to fill out the list -
  // mostUsedIds is already sorted desc by DashboardStats, so no
  // re-sorting needed here, just filtering/trimming.
  private get _mostUsed(): Firearm[] {
    const stats = this.cacheState.dashboardStats;
    if (!stats) return [];
    const byId = new Map(this.cacheState.firearms.map((f) => [f.id, f]));
    const list = stats.mostUsedIds.map((id) => byId.get(id)).filter((f): f is Firearm => !!f);
    const withUsage = list.filter((f) => f.lifetimeRoundCount > 0);
    const source = withUsage.length >= 3 ? withUsage : list;
    return source.slice(0, 5);
  }

  private _renderMostUsed() {
    const top = this._mostUsed;
    if (top.length === 0) {
      return html`<div class="empty">No usage data yet.</div>`;
    }
    const max = Math.max(1, top[0].lifetimeRoundCount);
    return top.map(
      (f, i) => html`
        <div class="ranking-item" @click=${() => this._openFirearm(f.id)} style="cursor:pointer">
          <div class="ranking-rank">${String(i + 1).padStart(2, "0")}</div>
          <div class="ranking-body">
            <div class="ranking-name">${f.customName}</div>
            <div class="ranking-meta">${formatNumber(f.lifetimeRoundCount)} Rounds</div>
            <div class="ranking-bar-track">
              <div class="ranking-bar-fill" style="width:${(f.lifetimeRoundCount / max) * 100}%"></div>
            </div>
          </div>
        </div>
      `
    );
  }

  private _renderAmmoStatus(stats: DashboardStats) {
    const entries = Object.entries(stats.ammunitionByCaliber);
    if (entries.length === 0) {
      return html`<div class="empty">No ammunition logged yet.</div>`;
    }
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return html`
      <div class="ammo-status-header">
        <div>
          <span class="ammo-total-value">${formatNumber(stats.totalAmmunition)}</span>
          <span class="ammo-total-label">Total Rounds</span>
        </div>
        <div>
          <span class="ammo-total-value">${entries.length}</span>
          <span class="ammo-total-label">Caliber${entries.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      ${entries.map(([caliber, qty]) => {
        const low = this.cacheState.ammunition.some((a) => a.caliber === caliber && a.isLow);
        return html`
          <div class="bar-row">
            <span class="bar-label" title=${caliber}>${caliber}</span>
            <div class="bar-track">
              <div class="bar-fill" style="width:${(qty / max) * 100}%"></div>
            </div>
            <span class="bar-count">${formatNumber(qty)}</span>
            ${low ? html`<span class="badge warning ammo-low-badge">Low</span>` : ""}
          </div>
        `;
      })}
    `;
  }

  // Same ranking rule the backend uses for DashboardStats.topWishlistItemName
  // when any wishlist firearms exist (wishlistRank ascending - the user's
  // own drag-and-drop order, see the Wishlist reorder modal - then
  // effective value desc, then most recently added; see ha-cache-
  // integration's CLAUDE.md), computed client-side and scoped to FIREARMS
  // only rather than the backend's pooled firearms+parts ranking, since
  // this panel specifically wants a firearm to feature with a photo - a
  // part wouldn't fit the "next acquisition" presentation the same way.
  private get _topWishlistFirearm(): Firearm | null {
    const candidates = this.cacheState.firearms.filter((f) => f.isWishlist);
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sorted.sort((a, b) => {
      const rankDiff = (a.wishlistRank ?? Infinity) - (b.wishlistRank ?? Infinity);
      if (rankDiff !== 0) return rankDiff;
      return (b.effectiveEstimatedValue ?? 0) - (a.effectiveEstimatedValue ?? 0);
    });
    return sorted[0];
  }

  private _wishlistImage(f: Firearm): string | null {
    return firearmHeroImage(this.cacheState, f);
  }

  private _renderWishlist(stats: DashboardStats) {
    const top = this._topWishlistFirearm;
    const image = top ? this._wishlistImage(top) : null;
    return html`
      ${top
        ? html`
            <div class="wishlist-featured">
              ${image
                ? html`<img class="wishlist-image" src=${image} alt=${top.customName} />`
                : html`
                    <div class="wishlist-image wishlist-image-placeholder">
                      <ha-icon icon="mdi:target"></ha-icon>
                    </div>
                  `}
              <div class="wishlist-priority-label">Top Priority</div>
              <div class="wishlist-name">${top.customName}</div>
              ${top.wishlistRank !== null
                ? html`<span class="badge wishlist">Rank #${top.wishlistRank + 1}</span>`
                : ""}
            </div>
          `
        : html`<div class="empty small">No wishlist firearms yet.</div>`}
      <div class="wishlist-totals">
        <span>${stats.wishlistFirearmsCount} Firearm${stats.wishlistFirearmsCount === 1 ? "" : "s"}</span>
        <span>${formatCurrency(stats.wishlistTotalValue)} Total</span>
      </div>
      <div class="panel-footer">
        <a @click=${() => this._switchTab("firearms", true)}>View Wishlist <ha-icon icon="mdi:arrow-right"></ha-icon></a>
      </div>
    `;
  }

  render() {
    const stats = this.cacheState.dashboardStats;
    if (!stats) {
      return html`<div class="empty">Loading...</div>`;
    }

    if (stats.totalFirearms === 0 && stats.wishlistFirearmsCount === 0 && stats.wishlistItemsCount === 0) {
      return html`
        <div class="empty">
          <p>Welcome to Cache. Add your first firearm from the Firearms tab to get started.</p>
        </div>
      `;
    }

    const standardFirearms = stats.totalFirearms - stats.nfaItems;
    const caliberCount = Object.keys(stats.ammunitionByCaliber).length;
    const cleaningDue = this.cacheState.cleaningDueCount;
    const trainingDue = this.cacheState.trainingDueCount;
    const lastSessionDate = this.cacheState.rangeSessions.reduce<string | null>(
      (latest, s) => (!latest || s.date > latest ? s.date : latest),
      null
    );

    return html`
      <div class="overview-grid">
        ${this._kpiCard(
          "mdi:target",
          "Firearms",
          formatNumber(stats.totalFirearms),
          stats.nfaItems > 0 ? `${formatNumber(standardFirearms)} Standard · ${formatNumber(stats.nfaItems)} NFA` : "Standard"
        )}
        ${this._kpiCard(
          "mdi:ammunition",
          "Ammunition",
          formatNumber(stats.totalAmmunition),
          `${caliberCount} Caliber${caliberCount === 1 ? "" : "s"}`
        )}
        ${this._kpiCard(
          "mdi:currency-usd",
          "Collection Value",
          formatCurrency(stats.totalCollectionValue),
          "Total Collection Value"
        )}
        ${this._kpiCard(
          "mdi:bookmark-outline",
          "Wishlist",
          formatCurrency(stats.wishlistTotalValue),
          `${formatNumber(stats.wishlistFirearmsCount)} Firearm${stats.wishlistFirearmsCount === 1 ? "" : "s"}`,
          stats.wishlistNfaItems > 0 ? `${stats.wishlistNfaItems} NFA` : undefined
        )}
      </div>

      <div class="dashboard-grid">
        <ha-card class="panel panel-breakdown">
          <div class="panel-head-row">
            ${this._panelHeading("mdi:shape-outline", "Collection Breakdown")}
            <div class="segmented">
              <button
                class=${this._breakdownTab === "type" ? "active" : ""}
                @click=${() => (this._breakdownTab = "type")}
              >
                Type
              </button>
              <button
                class=${this._breakdownTab === "caliber" ? "active" : ""}
                @click=${() => (this._breakdownTab = "caliber")}
              >
                Caliber
              </button>
              <button
                class=${this._breakdownTab === "manufacturer" ? "active" : ""}
                @click=${() => (this._breakdownTab = "manufacturer")}
              >
                Manufacturer
              </button>
            </div>
          </div>
          ${this._bars(
            this._breakdownTab === "caliber"
              ? stats.byCaliber
              : this._breakdownTab === "manufacturer"
                ? stats.byManufacturer
                : stats.byType
          )}
        </ha-card>

        <ha-card class="panel panel-status">
          <div class="panel-head-row">
            ${this._panelHeading("mdi:shield-check-outline", "Armory Status")}
            ${cleaningDue === 0 && trainingDue === 0
              ? html`<span class="status-pill nominal"><span class="status-dot"></span>Nominal</span>`
              : html`<span class="status-pill attention"><span class="status-dot"></span>Attention</span>`}
          </div>
          ${cleaningDue > 0 ? this._statusMetric(cleaningDue, "Need Cleaning", "firearms") : ""}
          ${trainingDue > 0 ? this._statusMetric(trainingDue, "Training Due", "training-schedule") : ""}
          ${stats.nfaItems > 0 ? this._statusMetric(stats.nfaItems, "NFA Item" + (stats.nfaItems === 1 ? "" : "s"), "firearms") : ""}
          <div class="status-divider"></div>
          <div class="status-footer-label">Last Range Session</div>
          <div class="status-footer-value">${lastSessionDate ? formatDate(lastSessionDate) : "No sessions logged"}</div>
        </ha-card>

        <ha-card class="panel panel-activity">
          ${this._panelHeading("mdi:history", "Recent Activity")}
          ${this._renderActivity()}
        </ha-card>

        <div class="right-stack">
          <ha-card class="panel">
            ${this._panelHeading("mdi:chart-line", "Most Used")}
            ${this._renderMostUsed()}
          </ha-card>

          <ha-card class="panel">
            ${this._panelHeading("mdi:bookmark-outline", "Wishlist")}
            ${this._renderWishlist(stats)}
          </ha-card>
        </div>

        <ha-card class="panel panel-ammo">
          ${this._panelHeading("mdi:ammunition", "Ammunition Status")}
          ${this._renderAmmoStatus(stats)}
        </ha-card>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-dashboard-view": CacheDashboardView;
  }
}

