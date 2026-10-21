import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState, RangeSession } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { formatDate, formatNumber } from "../utils/format";
import "../components/cache-dialog";
import "../components/log-range-session-dialog";

@customElement("cache-range-sessions-view")
export class CacheRangeSessionsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;

  @state() private _logOpen = false;
  @state() private _editingSession: RangeSession | null = null;
  @state() private _deleteTarget: RangeSession | null = null;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.session {
        padding: 16px;
        margin-bottom: 12px;
      }
      .session-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .session-title {
        font-weight: 600;
      }
      .chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      .chips .badge {
        cursor: pointer;
      }
      .session-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .delete-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
      }
    `,
  ];

  private _openFirearm(id: string): void {
    this.dispatchEvent(
      new CustomEvent("cache-open-firearm", { detail: { firearmId: id }, bubbles: true, composed: true })
    );
  }

  private _openEdit(session: RangeSession): void {
    this._editingSession = session;
    this._logOpen = true;
  }

  private _closeLog(): void {
    this._logOpen = false;
    this._editingSession = null;
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;
    await cacheApi.deleteRangeSession(this.hass, this._deleteTarget.id);
    this._deleteTarget = null;
  }

  render() {
    const sessions = this.cacheState.rangeSessions;
    return html`
      <div class="toolbar">
        <h1 style="margin:0;font-size:1.4rem;font-weight:600">Range Sessions</h1>
        <button class="primary" @click=${() => { this._editingSession = null; this._logOpen = true; }}>+ Log Range Session</button>
      </div>

      ${sessions.length === 0
        ? html`<div class="empty">
            No range sessions yet. Log a session to automatically update round counts, last-fired
            dates, and ammunition inventory.
          </div>`
        : sessions.map(
            (s) => html`
              <ha-card class="session">
                <div class="session-header">
                  <div>
                    <div class="session-title">${formatDate(s.date)}${s.location ? ` · ${s.location}` : ""}</div>
                    <div class="small muted">
                      ${formatNumber(s.totalRounds)} total rounds${s.notes ? ` · ${s.notes}` : ""}
                    </div>
                  </div>
                  <div class="session-actions">
                    <button class="delete-btn" @click=${() => this._openEdit(s)} aria-label="Edit">
                      <ha-icon icon="mdi:pencil"></ha-icon>
                    </button>
                    <button class="delete-btn" @click=${() => (this._deleteTarget = s)} aria-label="Delete">
                      <ha-icon icon="mdi:delete"></ha-icon>
                    </button>
                  </div>
                </div>
                <div class="chips">
                  ${s.firearms.map(
                    (f) => html`
                      <span class="badge" @click=${() => this._openFirearm(f.firearmId)}>
                        ${f.firearmName ?? "Firearm"} · ${formatNumber(f.roundsFired)} rds${f.ammunitionLabel ? ` (${f.ammunitionLabel})` : ""}
                      </span>
                    `
                  )}
                </div>
              </ha-card>
            `
          )}

      <log-range-session-dialog
        .hass=${this.hass}
        .cacheState=${this.cacheState}
        .open=${this._logOpen}
        .editingSession=${this._editingSession}
        @cache-dialog-closed=${this._closeLog}
      ></log-range-session-dialog>

      <cache-dialog
        .open=${!!this._deleteTarget}
        heading="Delete Range Session"
        width="380px"
        @cache-dialog-closed=${() => (this._deleteTarget = null)}
      >
        <p>Delete this session? Round counts and ammunition it deducted will be restored.</p>
        <div class="actions">
          <button class="secondary" @click=${() => (this._deleteTarget = null)}>Cancel</button>
          <button class="secondary danger" @click=${this._confirmDelete}>Delete</button>
        </div>
      </cache-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-range-sessions-view": CacheRangeSessionsView;
  }
}
