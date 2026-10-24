import "../components/coaching-permissions";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { gainsApi } from "../ha-api";
import type { ActivityLevel, ExperienceLevel, GainsState, Units } from "../types";
import { ACTIVITY_LEVELS, EXPERIENCE_LEVELS, REST_TIMER_OPTIONS, UNITS } from "../types";
import { glassCardStyle, formStyles } from "../styles";

interface Draft {
  displayName: string;
  units: Units;
  experienceLevel: ExperienceLevel | "";
  activityLevel: ActivityLevel | "";
  preferredDurationMinutes: string;
  restTimerSeconds: number;
  preferredSequencingPolicy: "calendar" | "completion";
  bodyweight: string;
  age: string;
}

/** "45s", "1:00", "1:30", "2:00" -- REST_TIMER_OPTIONS are all under two
 * minutes, so seconds-only vs. m:ss reads more naturally than always
 * padding to a clock format. */
function formatRestTimerOption(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function draftFromState(state: GainsState): Draft {
  const p = state.profile;
  return {
    displayName: p?.displayName ?? "",
    units: p?.units ?? "imperial",
    experienceLevel: p?.experienceLevel ?? "",
    activityLevel: p?.activityLevel ?? "",
    preferredDurationMinutes:
      p?.preferredDurationMinutes != null ? String(p.preferredDurationMinutes) : "",
    restTimerSeconds: p?.restTimerSeconds ?? 60,
    preferredSequencingPolicy: p?.preferredSequencingPolicy ?? "completion",
    bodyweight: p?.bodyweight != null ? String(p.bodyweight) : "",
    age: p?.age != null ? String(p.age) : "",
  };
}

@customElement("gains-settings-view")
export class GainsSettingsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;

  @state() private _draft: Draft | null = null;
  @state() private _saving = false;
  @state() private _saved = false;
  @state() private _linkBusyId: string | null = null;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.panel {
        padding: 20px;
        margin-bottom: 20px;
        max-width: 480px;
      }
      ul.link-list {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
      }
      ul.link-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      ul.link-list li:last-child {
        border-bottom: none;
      }
    `,
  ];

  /** Repopulates the form whenever the underlying profile actually
   * changes identity (first load resolving, or switching to a different
   * profile) -- without this, _draft (once set by any edit) would keep
   * showing stale values forever instead of picking up the newly loaded
   * profile's real settings. An incidental re-render of the same profile
   * (e.g. a workout list update elsewhere) leaves in-progress edits
   * alone. */
  protected willUpdate(changedProps: Map<string, unknown>): void {
    if (!changedProps.has("gainsState")) return;
    const previous = changedProps.get("gainsState") as GainsState | undefined;
    if (previous?.profile?.profileId !== this.gainsState.profile?.profileId) {
      this._draft = null;
      this._saved = false;
    }
  }

  private get _current(): Draft {
    return this._draft ?? draftFromState(this.gainsState);
  }

  private _set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    this._draft = { ...this._current, [key]: value };
    this._saved = false;
  }

  private async _linkAccount(profileId: string): Promise<void> {
    this._linkBusyId = profileId;
    try {
      await gainsApi.linkAccount(this.hass, profileId);
    } finally {
      this._linkBusyId = null;
    }
  }

  private async _unlinkAccount(profileId: string): Promise<void> {
    this._linkBusyId = profileId;
    try {
      await gainsApi.unlinkAccount(this.hass, profileId);
    } finally {
      this._linkBusyId = null;
    }
  }

  private async _save(): Promise<void> {
    const draft = this._current;
    this._saving = true;
    try {
      await gainsApi.updateProfile(this.hass, {
        display_name: draft.displayName || undefined,
        units: draft.units,
        experience_level: (draft.experienceLevel || undefined) as ExperienceLevel | undefined,
        activity_level: (draft.activityLevel || undefined) as ActivityLevel | undefined,
        preferred_duration_minutes: draft.preferredDurationMinutes
          ? Number(draft.preferredDurationMinutes)
          : undefined,
        rest_timer_seconds: draft.restTimerSeconds,
        ...(this.gainsState.profile?.preferredSequencingPolicy ? {preferred_sequencing_policy:draft.preferredSequencingPolicy} : {}),
        bodyweight: draft.bodyweight ? Number(draft.bodyweight) : undefined,
        age: draft.age ? Number(draft.age) : undefined,
      });
      this._draft = null;
      this._saved = true;
    } finally {
      this._saving = false;
    }
  }

  render() {
    if (!this.gainsState.profile) {
      return html`<ha-card class="panel"><p class="muted">Loading&hellip;</p></ha-card>`;
    }

    const draft = this._current;

    return html`
      <ha-card class="panel">
        <h2>Profile</h2>

        <label for="display-name">Display name</label>
        <input
          id="display-name"
          type="text"
          .value=${draft.displayName}
          @input=${(e: InputEvent) => this._set("displayName", (e.target as HTMLInputElement).value)}
        />

        <div class="field-row">
          <div>
            <label for="units">Units</label>
            <select
              id="units"
              @change=${(e: Event) => this._set("units", (e.target as HTMLSelectElement).value as Units)}
            >
              ${UNITS.map(
                (u) => html`<option value=${u} ?selected=${draft.units === u}>${u}</option>`
              )}
            </select>
          </div>
          <div>
            <label for="experience">Experience level</label>
            <select
              id="experience"
              @change=${(e: Event) =>
                this._set("experienceLevel", (e.target as HTMLSelectElement).value as ExperienceLevel)}
            >
              <option value="" ?selected=${draft.experienceLevel === ""}>Not set</option>
              ${EXPERIENCE_LEVELS.map(
                (level) =>
                  html`<option value=${level} ?selected=${draft.experienceLevel === level}>
                    ${level}
                  </option>`
              )}
            </select>
          </div>
        </div>

        <div class="field-row">
          <div>
            <label for="activity">Activity level</label>
            <select
              id="activity"
              @change=${(e: Event) =>
                this._set("activityLevel", (e.target as HTMLSelectElement).value as ActivityLevel)}
            >
              <option value="" ?selected=${draft.activityLevel === ""}>Not set</option>
              ${ACTIVITY_LEVELS.map(
                (level) =>
                  html`<option value=${level} ?selected=${draft.activityLevel === level}>
                    ${level}
                  </option>`
              )}
            </select>
          </div>
          <div>
            <label for="duration">Preferred workout duration (minutes)</label>
            <input
              id="duration"
              type="number"
              min="10"
              max="180"
              step="5"
              .value=${draft.preferredDurationMinutes}
              @input=${(e: InputEvent) =>
                this._set("preferredDurationMinutes", (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="field-row">
          <div>
            <label for="rest-timer">Rest timer between sets</label>
            <select
              id="rest-timer"
              @change=${(e: Event) =>
                this._set("restTimerSeconds", Number((e.target as HTMLSelectElement).value))}
            >
              ${REST_TIMER_OPTIONS.map(
                (seconds) =>
                  html`<option value=${seconds} ?selected=${draft.restTimerSeconds === seconds}>
                    ${formatRestTimerOption(seconds)}
                  </option>`
              )}
            </select>
          </div>
        </div>

        <label for="program-sequencing">Default program sequencing</label>
        <select id="program-sequencing" ?disabled=${!this.gainsState.profile.preferredSequencingPolicy}
          @change=${(e:Event) => this._set("preferredSequencingPolicy",(e.target as HTMLSelectElement).value as "calendar" | "completion")}>
          <option value="completion" ?selected=${draft.preferredSequencingPolicy === "completion"}>Sequence based · completed or skipped sessions</option>
          <option value="calendar" ?selected=${draft.preferredSequencingPolicy === "calendar"}>Calendar based · scheduled days</option>
        </select>
        <p class="muted small">Used for new programs. You can override it in the builder. Existing programs keep their own sequencing.</p>
        ${!this.gainsState.profile.preferredSequencingPolicy ? html`<p class="muted small">Update the Gains integration to enable this setting.</p>` : ""}

        <div class="field-row">
          <div>
            <label for="bodyweight">Bodyweight (${draft.units === "metric" ? "kg" : "lb"})</label>
            <input
              id="bodyweight"
              type="number"
              min="1"
              max="2000"
              step="0.1"
              .value=${draft.bodyweight}
              @input=${(e: InputEvent) => this._set("bodyweight", (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="age">Age</label>
            <input
              id="age"
              type="number"
              min="5"
              max="120"
              step="1"
              .value=${draft.age}
              @input=${(e: InputEvent) => this._set("age", (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>
        <p class="muted small">
          Bodyweight and age improve the Progress tab's Strength Score accuracy -- both optional.
        </p>

        <div class="actions">
          ${this._saved ? html`<span class="badge success">Saved</span>` : ""}
          <button class="primary" ?disabled=${this._saving} @click=${this._save}>
            ${this._saving ? "Saving…" : this._draft !== null ? "Save Change" : "Save"}
          </button>
        </div>
      </ha-card>

      <ha-card class="panel">
        <h2>Linked Accounts</h2>
        <p class="muted small">
          Link with another Home Assistant user on this instance (e.g. a
          family member) for quick profile switching. Sharing and coaching
          don't require linking -- see "Who can coach me?" below for
          coaching, and any workout or program's Share button for sending a
          copy to anyone on this instance.
        </p>

        ${this.gainsState.profile.linkedProfiles.length > 0
          ? html`
              <ul class="link-list">
                ${this.gainsState.profile.linkedProfiles.map(
                  (p) => html`
                    <li>
                      <span>${p.displayName}</span>
                      <button
                        class="secondary"
                        ?disabled=${this._linkBusyId === p.profileId}
                        @click=${() => this._unlinkAccount(p.profileId)}
                      >
                        Unlink
                      </button>
                    </li>
                  `
                )}
              </ul>
            `
          : html`<p class="muted small">No linked accounts yet.</p>`}
        ${this.gainsState.profile.linkableProfiles.length > 0
          ? html`
              <label>Link a new account</label>
              <ul class="link-list">
                ${this.gainsState.profile.linkableProfiles.map(
                  (p) => html`
                    <li>
                      <span>${p.displayName}</span>
                      <button
                        class="secondary"
                        ?disabled=${this._linkBusyId === p.profileId}
                        @click=${() => this._linkAccount(p.profileId)}
                      >
                        Link
                      </button>
                    </li>
                  `
                )}
              </ul>
            `
          : ""}
      <gains-coaching-permissions .hass=${this.hass} .gainsState=${this.gainsState}></gains-coaching-permissions>
</ha-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gains-settings-view": GainsSettingsView;
  }
}


