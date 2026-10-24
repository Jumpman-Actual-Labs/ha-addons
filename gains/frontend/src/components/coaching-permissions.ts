import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { trainingApi, trainingService, type HomeAssistant } from "../ha-api";
import type { GainsState } from "../types";
import type { TrainingSnapshot, Permission } from "../training-types";
import { formStyles } from "../styles";
@customElement("gains-coaching-permissions")
export class GainsCoachingPermissions extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;
  @state() private snapshot: TrainingSnapshot | null = null;
  @state() private error = "";
  @state() private busy = false;
  private loaded = "";
  static styles = [
    formStyles,
    css`
      :host {
        display: block;
      }
      details {
        border: 1px solid var(--divider-color);
        padding: 14px;
        border-radius: 12px;
        margin: 12px 0;
      }
      summary {
        min-height: 44px;
      }
      label {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
      }
      input[type="checkbox"] {
        width: 24px;
        height: 24px;
      }
      .error {
        color: var(--error-color, #c33);
      }
    `,
  ];
  protected updated() {
    const id = this.gainsState?.profile?.profileId;
    if (id && id !== this.loaded) {
      this.loaded = id;
      void this.load();
    }
  }
  private async load() {
    try {
      this.snapshot = await trainingApi.state(this.hass);
    } catch (e) {
      this.error = String(e);
    }
  }
  private async save(id: string, permission: Permission, value: boolean) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const permissions = {
        view_workouts: false,
        coach_workouts: false,
        view_progress: false,
        manage_programs: false,
        ...this.snapshot?.grants[id]?.permissions,
        [permission]: value,
      };
      if (permission === "view_workouts" && !value)
        permissions.coach_workouts = false;
      await trainingService(this.hass, "set_coach_permissions", {
        id,
        fields: { permissions, role: "coach" },
      });
      await this.load();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }
  render() {
    return html`<h2>Who can coach me?</h2>
      <p class="muted">
        These grants let anyone on this Home Assistant instance access your
        training -- no linking needed first. (A "kids" profile doesn't need
        to grant anything here: every non-kids profile can already coach a
        kid automatically.)
      </p>
      ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}${this.gainsState?.profile?.shareTargets.map(
        (p) =>
          html`<details>
            <summary>${p.displayName}</summary>
            ${(
              [
                ["view_workouts", "View current workouts and runs"],
                ["coach_workouts", "Log and edit my workouts and runs"],
                ["view_progress", "View my training history and progress"],
                ["manage_programs", "Manage my programs"],
              ] as const
            ).map(
              ([key, label]) =>
                html`<label
                  ><input
                    type="checkbox"
                    ?checked=${this.snapshot?.grants[p.profileId]?.permissions[key] ?? false}
                    ?disabled=${this.busy}
                    @change=${(e: Event) => this.save(p.profileId, key, (e.target as HTMLInputElement).checked)}
                  />${label}</label
                >`,
            )}
          </details>`,
      )}`;
  }
}
