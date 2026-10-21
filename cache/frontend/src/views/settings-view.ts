import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState } from "../types";
import { AMMO_ALERT_RULE_MATCH_TYPE_LABELS, DIAGRAM_TYPE_LABELS } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { knownBulletTypes, knownCalibers } from "../utils/options";
import "../components/image-source-button";

interface NewRuleDraft {
  matchType: "caliber" | "bullet_type" | "speed_class";
  matchValue: string;
  threshold: string;
}

const EMPTY_NEW_RULE: NewRuleDraft = { matchType: "caliber", matchValue: "", threshold: "" };

@customElement("cache-settings-view")
export class CacheSettingsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;

  @state() private _saved = false;
  @state() private _draft: Record<string, unknown> | null = null;
  @state() private _newRule: NewRuleDraft = { ...EMPTY_NEW_RULE };
  @state() private _ruleError: string | null = null;
  @state() private _defaultImageDiagramType = "ar_platform";
  @state() private _diagramImageUploading = false;
  @state() private _diagramImageError: string | null = null;
  @state() private _reprocessingPhotos = false;
  @state() private _reprocessError: string | null = null;
  @state() private _reprocessDone = false;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.panel {
        padding: 16px;
        margin-bottom: 20px;
        max-width: 640px;
      }
      code {
        background: var(--secondary-background-color, #eee);
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 0.85em;
      }
      .rule-row {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .rule-row > div {
        flex: 1;
        min-width: 100px;
      }
      .rule-row .threshold {
        flex: 0 1 90px;
        min-width: 80px;
      }
      .rule-row .remove-rule {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
        padding: 8px 0 0;
        flex-shrink: 0;
      }
      .rule-list {
        margin: 0 0 14px;
      }
      ha-card.diagram-card {
        padding: 16px;
        margin-bottom: 20px;
        max-width: 640px;
      }
      .diagram-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .diagram-controls select {
        flex: 1;
        min-width: 160px;
      }
      .default-image-preview {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 160px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--divider-color, #3a4552);
        overflow: hidden;
      }
      .default-image-preview img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .default-image-preview .empty {
        color: var(--secondary-text-color, #7c8894);
        font-size: 0.85rem;
        font-style: italic;
      }
    `,
  ];

  private _value(key: string): unknown {
    if (this._draft && key in this._draft) return this._draft[key];
    return (this.cacheState.settings as unknown as Record<string, unknown> | null)?.[key];
  }

  private _set(key: string, value: unknown): void {
    this._draft = { ...(this._draft ?? {}), [key]: value };
    this._saved = false;
  }

  private async _save(): Promise<void> {
    if (!this._draft) return;
    const payload: Record<string, unknown> = {};
    if ("collectionName" in this._draft) payload.collection_name = this._draft.collectionName;
    if ("lowAmmoThresholdDefault" in this._draft)
      payload.low_ammo_threshold_default = Number(this._draft.lowAmmoThresholdDefault);
    if ("cleaningReminderRounds" in this._draft)
      payload.cleaning_reminder_rounds = Number(this._draft.cleaningReminderRounds);
    if ("cleaningReminderDays" in this._draft)
      payload.cleaning_reminder_days = Number(this._draft.cleaningReminderDays);
    if ("cleaningNotificationsEnabled" in this._draft)
      payload.cleaning_notifications_enabled = this._draft.cleaningNotificationsEnabled;
    if ("lowAmmoNotificationsEnabled" in this._draft)
      payload.low_ammo_notifications_enabled = this._draft.lowAmmoNotificationsEnabled;

    await cacheApi.updateSettings(this.hass, payload);
    this._draft = null;
    this._saved = true;
  }

  private async _addRule(): Promise<void> {
    this._ruleError = null;
    const { matchType, matchValue, threshold } = this._newRule;
    if (!matchValue || threshold === "") {
      this._ruleError = "Match value and threshold are required";
      return;
    }
    try {
      await cacheApi.addAmmoAlertRule(this.hass, matchType, matchValue, Number(threshold));
      this._newRule = { ...EMPTY_NEW_RULE };
    } catch (err) {
      this._ruleError = err instanceof Error ? err.message : "Failed to add rule";
    }
  }

  private async _updateRuleThreshold(ruleId: string, value: string): Promise<void> {
    if (value === "") return;
    await cacheApi.updateAmmoAlertRule(this.hass, ruleId, { threshold: Number(value) });
  }

  private async _deleteRule(ruleId: string): Promise<void> {
    await cacheApi.deleteAmmoAlertRule(this.hass, ruleId);
  }

  private _setDefaultImageDiagramType(diagramType: string): void {
    this._defaultImageDiagramType = diagramType;
    this._diagramImageError = null;
  }

  private async _onDiagramImageSelected(e: CustomEvent<{ files: File[] }>): Promise<void> {
    const file = e.detail.files[0];
    if (!file) return;
    this._diagramImageError = null;
    this._diagramImageUploading = true;
    try {
      await cacheApi.uploadDiagramImage(this.hass, this._defaultImageDiagramType, file);
    } catch (err) {
      this._diagramImageError = err instanceof Error ? err.message : "Upload failed";
    } finally {
      this._diagramImageUploading = false;
    }
  }

  private _onDiagramImageError(e: CustomEvent<{ message: string }>): void {
    this._diagramImageError = e.detail.message;
  }

  private async _clearDiagramImage(): Promise<void> {
    await cacheApi.clearDiagramReferenceImage(this.hass, this._defaultImageDiagramType);
  }

  // One-off batch action, not tied to any single firearm - re-runs every
  // already-uploaded firearm gallery photo through AI background removal
  // (new uploads already get this automatically, see photo-manager-
  // dialog.ts). Real cost (one OpenAI call per photo) and no undo (the
  // original background is gone once overwritten), so this lives behind
  // an explicit button with its own confirmation-style copy rather than
  // running silently.
  private async _reprocessFirearmPhotos(): Promise<void> {
    this._reprocessError = null;
    this._reprocessDone = false;
    this._reprocessingPhotos = true;
    try {
      await cacheApi.reprocessFirearmPhotos(this.hass);
      this._reprocessDone = true;
    } catch (err) {
      this._reprocessError = err instanceof Error ? err.message : "Reprocessing failed";
    } finally {
      this._reprocessingPhotos = false;
    }
  }

  render() {
    if (!this.cacheState.settings) {
      return html`<div class="empty">Loading...</div>`;
    }

    return html`
      <h1 style="font-size:1.4rem;font-weight:600">Settings</h1>
      ${this._saved ? html`<div class="badge success" style="margin-bottom:14px">Settings saved</div>` : ""}

      <ha-card class="panel">
        <h2 style="margin-top:0">Collection</h2>
        <label>Collection Name</label>
        <input
          .value=${String(this._value("collectionName") ?? "")}
          @input=${(e: Event) => this._set("collectionName", (e.target as HTMLInputElement).value)}
        />
      </ha-card>

      <ha-card class="panel">
        <h2 style="margin-top:0">Cleaning Reminders</h2>
        <p class="small muted">
          Cache flags a firearm as needing cleaning once it crosses either threshold below.
        </p>
        <div class="checkbox-row">
          <input
            type="checkbox"
            .checked=${!!this._value("cleaningNotificationsEnabled")}
            @change=${(e: Event) =>
              this._set("cleaningNotificationsEnabled", (e.target as HTMLInputElement).checked)}
          />
          <label style="margin:0">Enable cleaning due notifications</label>
        </div>
        <div class="field-row">
          <div>
            <label>Rounds fired since last cleaning</label>
            <input
              type="number"
              .value=${String(this._value("cleaningReminderRounds") ?? "")}
              @input=${(e: Event) =>
                this._set("cleaningReminderRounds", (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label>Days since last cleaning</label>
            <input
              type="number"
              .value=${String(this._value("cleaningReminderDays") ?? "")}
              @input=${(e: Event) => this._set("cleaningReminderDays", (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
      </ha-card>

      <ha-card class="panel">
        <h2 style="margin-top:0">Ammunition Alerts</h2>
        <p class="small muted">
          The default threshold below applies to everything. An ammo entry's own threshold
          (set on that entry directly) always wins over both the default and the rules here;
          otherwise the first matching rule below applies before falling back to the default.
        </p>
        <div class="checkbox-row">
          <input
            type="checkbox"
            .checked=${!!this._value("lowAmmoNotificationsEnabled")}
            @change=${(e: Event) =>
              this._set("lowAmmoNotificationsEnabled", (e.target as HTMLInputElement).checked)}
          />
          <label style="margin:0">Enable low ammunition notifications</label>
        </div>
        <label>Default low inventory threshold (rounds)</label>
        <input
          type="number"
          .value=${String(this._value("lowAmmoThresholdDefault") ?? "")}
          @input=${(e: Event) =>
            this._set("lowAmmoThresholdDefault", (e.target as HTMLInputElement).value)}
        />

        <label>Thresholds by caliber, bullet type, or velocity</label>
        ${this._ruleError ? html`<div class="error-banner">${this._ruleError}</div>` : ""}
        ${this.cacheState.ammoAlertRules.length === 0
          ? html`<p class="small muted">No rules yet - the default threshold applies to everything.</p>`
          : html`
              <div class="rule-list">
                ${this.cacheState.ammoAlertRules.map(
                  (r) => html`
                    <div class="rule-row">
                      <div><span class="badge">${AMMO_ALERT_RULE_MATCH_TYPE_LABELS[r.matchType] ?? r.matchType}</span></div>
                      <div>${r.matchValue}</div>
                      <div class="threshold">
                        <input
                          type="number"
                          .value=${String(r.threshold)}
                          @change=${(e: Event) => this._updateRuleThreshold(r.id, (e.target as HTMLInputElement).value)}
                        />
                      </div>
                      <button class="remove-rule" aria-label="Remove rule" @click=${() => this._deleteRule(r.id)}>
                        <ha-icon icon="mdi:close"></ha-icon>
                      </button>
                    </div>
                  `
                )}
              </div>
            `}
        <div class="rule-row">
          <div>
            <select
              .value=${this._newRule.matchType}
              @change=${(e: Event) =>
                (this._newRule = {
                  ...this._newRule,
                  matchType: (e.target as HTMLSelectElement).value as NewRuleDraft["matchType"],
                  matchValue: "",
                })}
            >
              <option value="caliber" ?selected=${this._newRule.matchType === "caliber"}>Caliber</option>
              <option value="bullet_type" ?selected=${this._newRule.matchType === "bullet_type"}>Bullet type</option>
              <option value="speed_class" ?selected=${this._newRule.matchType === "speed_class"}>Velocity</option>
            </select>
          </div>
          <div>
            ${this._newRule.matchType === "speed_class"
              ? html`
                  <select
                    .value=${this._newRule.matchValue}
                    @change=${(e: Event) =>
                      (this._newRule = { ...this._newRule, matchValue: (e.target as HTMLSelectElement).value })}
                  >
                    <option value="">Select...</option>
                    <option value="Subsonic" ?selected=${this._newRule.matchValue === "Subsonic"}>Subsonic</option>
                    <option value="Supersonic" ?selected=${this._newRule.matchValue === "Supersonic"}>Supersonic</option>
                  </select>
                `
              : html`
                  <input
                    list=${this._newRule.matchType === "caliber"
                      ? "settings-caliber-list"
                      : "settings-bullet-type-list"}
                    placeholder=${this._newRule.matchType === "caliber" ? "e.g. 9mm" : "e.g. JHP"}
                    .value=${this._newRule.matchValue}
                    @input=${(e: Event) =>
                      (this._newRule = { ...this._newRule, matchValue: (e.target as HTMLInputElement).value })}
                  />
                `}
          </div>
          <div class="threshold">
            <input
              type="number"
              placeholder="Threshold"
              .value=${this._newRule.threshold}
              @input=${(e: Event) => (this._newRule = { ...this._newRule, threshold: (e.target as HTMLInputElement).value })}
            />
          </div>
          <button class="secondary" @click=${this._addRule}>Add</button>
        </div>
        <datalist id="settings-caliber-list">
          ${knownCalibers(this.cacheState).map((c) => html`<option value=${c}></option>`)}
        </datalist>
        <datalist id="settings-bullet-type-list">
          ${knownBulletTypes(this.cacheState).map((b) => html`<option value=${b}></option>`)}
        </datalist>
      </ha-card>

      <ha-card class="diagram-card">
        <h2 style="margin-top:0">Default Firearm Photos</h2>
        <p class="small muted">
          The Dashboard's Wishlist panel and each firearm's own detail page show its own
          uploaded photo if it has one, otherwise this per-type default. Useful for giving
          every AR Platform (or any type) a reasonable picture before you've photographed
          each one individually.
        </p>
        ${this._diagramImageError ? html`<div class="error-banner">${this._diagramImageError}</div>` : ""}
        <div class="diagram-controls">
          <select
            .value=${this._defaultImageDiagramType}
            @change=${(e: Event) => this._setDefaultImageDiagramType((e.target as HTMLSelectElement).value)}
          >
            ${Object.entries(DIAGRAM_TYPE_LABELS).map(
              ([value, label]) =>
                html`<option value=${value} ?selected=${value === this._defaultImageDiagramType}>${label}</option>`
            )}
          </select>
          <cache-image-source-button
            .label=${this.cacheState.settings.diagramReferenceImages[this._defaultImageDiagramType]
              ? "Change Photo"
              : "Add Photo"}
            .busyLabel=${"Uploading..."}
            .disabled=${this._diagramImageUploading}
            @cache-image-selected=${this._onDiagramImageSelected}
            @cache-image-error=${this._onDiagramImageError}
          ></cache-image-source-button>
          ${this.cacheState.settings.diagramReferenceImages[this._defaultImageDiagramType]
            ? html`<button class="secondary" @click=${this._clearDiagramImage}>Remove Photo</button>`
            : ""}
        </div>
        <div class="default-image-preview">
          ${this.cacheState.settings.diagramReferenceImages[this._defaultImageDiagramType]
            ? html`<img
                src=${this.cacheState.settings.diagramReferenceImages[this._defaultImageDiagramType]}
                alt="${DIAGRAM_TYPE_LABELS[this._defaultImageDiagramType]} default"
              />`
            : html`<span class="empty">No default photo set for this type</span>`}
        </div>
      </ha-card>

      <ha-card class="panel">
        <h2 style="margin-top:0">Photo Background Removal</h2>
        <p class="small muted">
          When an OpenAI API key is set (Settings &gt; Add-ons &gt; Cache &gt; Configuration),
          new firearm and part photos have their background removed automatically. Without
          a key they're saved as-is. Use this to apply the cutout to firearm photos uploaded
          before a key was set - it costs one OpenAI call per photo and overwrites the stored
          file, so there's no undo once it's run.
        </p>
        ${this._reprocessError ? html`<div class="error-banner">${this._reprocessError}</div>` : ""}
        ${this._reprocessDone
          ? html`<div class="badge success" style="margin-bottom:10px">Done reprocessing</div>`
          : ""}
        <button
          class="secondary"
          ?disabled=${this._reprocessingPhotos}
          @click=${this._reprocessFirearmPhotos}
        >
          ${this._reprocessingPhotos ? "Reprocessing…" : "Reprocess All Firearm Photos"}
        </button>
      </ha-card>

      <ha-card class="panel">
        <h2 style="margin-top:0">Home Assistant Integration</h2>
        <p class="small muted">
          Cache exposes <code>sensor.cache_cleaning_due_count</code>,
          <code>binary_sensor.cache_cleaning_due</code>, <code>sensor.cache_low_ammo_count</code>,
          and <code>binary_sensor.cache_low_ammo</code> so you can build automations around
          cleaning reminders and low ammunition.
        </p>
      </ha-card>

      <div class="actions" style="justify-content:flex-start;max-width:640px">
        <button class="primary" ?disabled=${!this._draft} @click=${this._save}>Save Settings</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-settings-view": CacheSettingsView;
  }
}
