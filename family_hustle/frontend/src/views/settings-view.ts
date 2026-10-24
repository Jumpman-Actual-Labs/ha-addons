import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { hustleApi } from "../ha-api";
import type { HustleState } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import "../components/hustle-dialog";

const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

@customElement("hustle-settings-view")
export class HustleSettingsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;

  @state() private _saving = false;
  @state() private _addMemberOpen = false;
  @state() private _editMemberId: string | null = null;

  // add/edit member form
  @state() private _haUserId = "";
  @state() private _haDisplayName = "";
  @state() private _role = "child";
  @state() private _permissionLevel = "admin";
  @state() private _managedChildIds: string[] = [];
  @state() private _notifyTarget = "";
  @state() private _haUsers: Array<{ id: string; name: string }> = [];

  // household form
  @state() private _householdName = "";
  @state() private _currency = "";
  @state() private _timezone = "";
  @state() private _notifyService = "";
  private _householdFormLoaded = false;

  // payroll config form
  @state() private _recurrence = "weekly";
  @state() private _dayOfWeek = "FRI";
  @state() private _dayOfMonth = "1";
  @state() private _anchorDate = new Date().toISOString().slice(0, 10);
  @state() private _requiresParentApproval = true;
  @state() private _autoGenerate = true;
  @state() private _payParentsToo = false;
  @state() private _defaultInitiativeBonusPct = "30";
  @state() private _approvalThreshold = "";
  private _payrollFormLoaded = false;

  // danger zone
  @state() private _dangerBusy = false;
  @state() private _dangerResult: string | null = null;

  /** Pre-fills the household/payroll forms from real sensor data the first
   * time it becomes available, so the forms show current values instead of
   * blanks. Only runs once per load - after that the fields are user-owned
   * so edits in progress aren't clobbered by unrelated coordinator updates. */
  protected willUpdate(): void {
    const s = this.hustleState;
    if (!this._householdFormLoaded && s.household) {
      this._householdName = s.household.name;
      this._currency = s.household.currency;
      this._timezone = s.household.timezone;
      this._notifyService = s.household.notifyService ?? "";
      this._householdFormLoaded = true;
    }
    if (!this._payrollFormLoaded && s.payrollConfig) {
      const cfg = s.payrollConfig;
      this._recurrence = cfg.recurrence;
      this._dayOfWeek = cfg.paydayRule.dayOfWeek ?? "FRI";
      this._dayOfMonth = cfg.paydayRule.dayOfMonth ? String(cfg.paydayRule.dayOfMonth) : "1";
      this._anchorDate = cfg.paydayRule.anchorDate ?? new Date().toISOString().slice(0, 10);
      this._requiresParentApproval = cfg.requiresParentApproval;
      this._autoGenerate = cfg.autoGenerate;
      this._payParentsToo = cfg.payParentsToo;
      this._defaultInitiativeBonusPct = String(cfg.defaultInitiativeBonusPct);
      this._approvalThreshold = cfg.approvalThresholdCents ? (cfg.approvalThresholdCents / 100).toFixed(2) : "";
      this._payrollFormLoaded = true;
    }
  }

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      section {
        margin-bottom: 28px;
      }
      ha-card {
        padding: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        padding: 10px 8px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .spread {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .field {
        margin-bottom: 12px;
        max-width: 420px;
      }
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .checkbox-row input {
        width: auto;
      }
      .checkbox-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 180px;
        overflow-y: auto;
        margin-bottom: 10px;
      }
      ha-card.danger-zone {
        border: 1px solid var(--error-color, #c62828);
      }
      .danger-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 8px;
      }
      .danger-result {
        margin-top: 10px;
      }
    `,
  ];

  private async _openAddMember(): Promise<void> {
    this._editMemberId = null;
    this._haUserId = "";
    this._haDisplayName = "";
    this._role = "child";
    this._permissionLevel = "admin";
    this._managedChildIds = [];
    this._notifyTarget = "";
    this._addMemberOpen = true;
    this._haUsers = await hustleApi.listHaUsers(this.hass);
  }

  private _onHaUserPicked(userId: string): void {
    this._haUserId = userId;
    const picked = this._haUsers.find((u) => u.id === userId);
    if (picked) this._haDisplayName = picked.name;
  }

  private _openEditMember(memberId: string): void {
    const member = this.hustleState.memberRoster.find((m) => m.id === memberId);
    if (!member) return;
    this._editMemberId = memberId;
    this._haUserId = member.haUserId;
    this._haDisplayName = member.haDisplayName;
    this._role = member.role;
    this._permissionLevel = member.permissionLevel ?? "admin";
    this._managedChildIds = member.managedChildIds;
    this._notifyTarget = member.notifyTarget ?? "";
    this._addMemberOpen = true;
  }

  private _toggleManagedChild(childId: string, checked: boolean): void {
    this._managedChildIds = checked
      ? [...this._managedChildIds, childId]
      : this._managedChildIds.filter((id) => id !== childId);
  }

  private async _saveAddMember(): Promise<void> {
    if (!this._haDisplayName.trim()) return;
    this._saving = true;
    try {
      if (this._editMemberId) {
        await hustleApi.updateMember(this.hass, this._editMemberId, {
          ha_display_name: this._haDisplayName.trim(),
          role: this._role,
          permission_level: this._role === "parent" ? this._permissionLevel : undefined,
          managed_child_ids: this._role === "parent" ? this._managedChildIds : [],
          notify_target: this._notifyTarget || undefined,
        });
      } else {
        if (!this._haUserId.trim()) return;
        await hustleApi.addMember(this.hass, {
          ha_user_id: this._haUserId.trim(),
          ha_display_name: this._haDisplayName.trim(),
          role: this._role,
          permission_level: this._role === "parent" ? this._permissionLevel : undefined,
          managed_child_ids: this._role === "parent" ? this._managedChildIds : [],
          notify_target: this._notifyTarget || undefined,
        });
      }
      this._addMemberOpen = false;
      this._editMemberId = null;
    } finally {
      this._saving = false;
    }
  }

  private async _deactivateMember(memberId: string): Promise<void> {
    if (!window.confirm("Deactivate this household member?")) return;
    await hustleApi.deactivateMember(this.hass, memberId);
  }

  private async _reactivateMember(memberId: string): Promise<void> {
    await hustleApi.updateMember(this.hass, memberId, { active: true });
  }

  private async _saveHousehold(): Promise<void> {
    this._saving = true;
    try {
      await hustleApi.updateHousehold(this.hass, {
        name: this._householdName || null,
        currency: this._currency || null,
        timezone: this._timezone || null,
        notify_service: this._notifyService || null,
      });
    } finally {
      this._saving = false;
    }
  }

  private async _savePayrollConfig(): Promise<void> {
    this._saving = true;
    try {
      const payday_rule: Record<string, unknown> = { type: this._recurrence };
      if (this._recurrence === "monthly") {
        payday_rule.day_of_month = Number(this._dayOfMonth);
      } else {
        payday_rule.day_of_week = this._dayOfWeek;
        if (this._recurrence === "biweekly") payday_rule.anchor_date = this._anchorDate;
      }
      await hustleApi.updatePayrollConfig(this.hass, {
        recurrence: this._recurrence,
        payday_rule,
        requires_parent_approval: this._requiresParentApproval,
        auto_generate: this._autoGenerate,
        pay_parents_too: this._payParentsToo,
        default_initiative_bonus_pct: Number(this._defaultInitiativeBonusPct) || 0,
        approval_threshold_cents: this._approvalThreshold
          ? Math.round(Number(this._approvalThreshold) * 100)
          : null,
      });
    } finally {
      this._saving = false;
    }
  }

  private async _unassignAllChores(): Promise<void> {
    if (
      !window.confirm(
        "Unassign every currently assigned or submitted chore across the whole household? Approved chores are left alone. This can't be undone."
      )
    )
      return;
    this._dangerBusy = true;
    this._dangerResult = null;
    try {
      await hustleApi.unassignAllChores(this.hass);
      this._dangerResult = "All unapproved chore assignments were cleared.";
    } finally {
      this._dangerBusy = false;
    }
  }

  private async _removeAllBounties(): Promise<void> {
    if (
      !window.confirm(
        "Cancel every open bounty on the board? Closed/expired bounties are left alone. This can't be undone."
      )
    )
      return;
    this._dangerBusy = true;
    this._dangerResult = null;
    try {
      await hustleApi.removeAllBounties(this.hass);
      this._dangerResult = "All open bounties were cancelled.";
    } finally {
      this._dangerBusy = false;
    }
  }

  private async _resetAccountEarnings(): Promise<void> {
    if (this._dangerBusy) return;
    if (!window.confirm(
      "Permanently clear EVERYONE’S earnings and ALL paycheck history? Recorded chore, bounty, grade and behavior earnings will be reset to $0 and cannot return through payroll regeneration. Profiles, Home Assistant links, chore setup and unfinished work will stay. This cannot be undone."
    )) return;
    this._dangerBusy = true;
    this._dangerResult = null;
    try {
      await hustleApi.resetAccountEarnings(this.hass);
      this._dangerResult = "Everyone’s earnings and paycheck history have been cleared. Profiles, Home Assistant links and chore setup were kept.";
    } catch (error) {
      this._dangerResult = `Reset failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this._dangerBusy = false;
    }
  }

  private async _resetPaychecks(): Promise<void> {
    if (
      !window.confirm(
        "Reset every kid's paycheck for the current pay period to $0? This discards whatever's been earned/approved this period, regardless of completed chores or bounties. This can't be undone."
      )
    )
      return;
    this._dangerBusy = true;
    this._dangerResult = null;
    try {
      await hustleApi.resetCurrentPeriodPaychecks(this.hass);
      this._dangerResult = "Every kid's current-period paycheck was reset to $0.";
    } finally {
      this._dangerBusy = false;
    }
  }

  render() {
    const s = this.hustleState;
    const roster = s.memberRoster;
    const canResetAccounts = roster.some(m => m.haUserId === this.hass.user?.id && m.active && m.role === "parent" && m.permissionLevel === "admin");
    return html`
      <h1>${s.household?.name ?? "Household"} settings</h1>

      <section>
        <div class="spread">
          <h3>Family members</h3>
          <button class="primary" @click=${this._openAddMember}>+ Add member</button>
        </div>
        <ha-card>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Permission</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${roster.length === 0
                ? html`<tr><td class="muted" colspan="5">No members yet.</td></tr>`
                : roster.map(
                    (m) => html`
                      <tr>
                        <td>${m.haDisplayName}</td>
                        <td><span class="badge ${m.role === "parent" ? "info" : ""}">${m.role}</span></td>
                        <td>${m.permissionLevel ?? "—"}</td>
                        <td>
                          <span class="badge ${m.active ? "success" : "error"}">${m.active ? "active" : "deactivated"}</span>
                        </td>
                        <td>
                          <button class="link" @click=${() => this._openEditMember(m.id)}>Edit</button>
                          ${m.active
                            ? html`<button class="link danger" @click=${() => this._deactivateMember(m.id)}>Deactivate</button>`
                            : html`<button class="link" @click=${() => this._reactivateMember(m.id)}>Reactivate</button>`}
                        </td>
                      </tr>
                    `
                  )}
            </tbody>
          </table>
        </ha-card>
      </section>

      <section>
        <h3>Household settings</h3>
        <ha-card>
          <div class="field"><label>Household name</label><input .value=${this._householdName} @input=${(e: InputEvent) => (this._householdName = (e.target as HTMLInputElement).value)} /></div>
          <div class="field"><label>Currency</label><input .value=${this._currency} @input=${(e: InputEvent) => (this._currency = (e.target as HTMLInputElement).value)} /></div>
          <div class="field"><label>Timezone</label><input .value=${this._timezone} @input=${(e: InputEvent) => (this._timezone = (e.target as HTMLInputElement).value)} /></div>
          <div class="field"><label>Notify service (optional)</label><input .value=${this._notifyService} @input=${(e: InputEvent) => (this._notifyService = (e.target as HTMLInputElement).value)} /></div>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveHousehold}>Save</button>
        </ha-card>
      </section>

      <section>
        <h3>Payroll settings</h3>
        <ha-card>
          <div class="field">
            <label>Payday recurrence</label>
            <select @change=${(e: Event) => (this._recurrence = (e.target as HTMLSelectElement).value)}>
              <option value="weekly" ?selected=${this._recurrence === "weekly"}>Weekly</option>
              <option value="biweekly" ?selected=${this._recurrence === "biweekly"}>Every two weeks</option>
              <option value="monthly" ?selected=${this._recurrence === "monthly"}>Monthly</option>
            </select>
          </div>
          ${this._recurrence === "monthly"
            ? html`<div class="field"><label>Day of month</label><input type="number" min="1" max="28" .value=${this._dayOfMonth} @input=${(e: InputEvent) => (this._dayOfMonth = (e.target as HTMLInputElement).value)} /></div>`
            : html`
                <div class="field">
                  <label>Payday</label>
                  <select @change=${(e: Event) => (this._dayOfWeek = (e.target as HTMLSelectElement).value)}>
                    ${WEEKDAYS.map((d) => html`<option value=${d} ?selected=${d === this._dayOfWeek}>${d}</option>`)}
                  </select>
                </div>
                ${this._recurrence === "biweekly"
                  ? html`<div class="field"><label>Anchor payday date</label><input type="date" .value=${this._anchorDate} @input=${(e: InputEvent) => (this._anchorDate = (e.target as HTMLInputElement).value)} /></div>`
                  : ""}
              `}
          <label class="checkbox-row">
            <input type="checkbox" .checked=${this._requiresParentApproval} @change=${(e: Event) => (this._requiresParentApproval = (e.target as HTMLInputElement).checked)} />
            Require parent approval
          </label>
          <label class="checkbox-row">
            <input type="checkbox" .checked=${this._autoGenerate} @change=${(e: Event) => (this._autoGenerate = (e.target as HTMLInputElement).checked)} />
            Auto-generate payroll on payday
          </label>
          <label class="checkbox-row">
            <input type="checkbox" .checked=${this._payParentsToo} @change=${(e: Event) => (this._payParentsToo = (e.target as HTMLInputElement).checked)} />
            Include parents in payroll
          </label>
          <div class="field"><label>Default bounty initiative bonus (%)</label><input type="number" min="0" max="200" .value=${this._defaultInitiativeBonusPct} @input=${(e: InputEvent) => (this._defaultInitiativeBonusPct = (e.target as HTMLInputElement).value)} /></div>
          <div class="field"><label>Auto-approve under ($, optional)</label><input type="number" step="0.01" min="0" .value=${this._approvalThreshold} @input=${(e: InputEvent) => (this._approvalThreshold = (e.target as HTMLInputElement).value)} /></div>
          <button class="primary" ?disabled=${this._saving} @click=${this._savePayrollConfig}>Save</button>
        </ha-card>
      </section>

      <section>
        <h3>Danger zone</h3>
        <ha-card class="danger-zone">
          <p class="muted small">
            Household-wide bulk actions. Each of these affects the whole household and can't be
            undone - you'll be asked to confirm before anything happens.
          </p>
          <div class="danger-actions">
            ${canResetAccounts ? html`<button class="secondary danger" ?disabled=${this._dangerBusy} @click=${this._resetAccountEarnings}>Reset earnings & paycheck history</button>` : ""}
            <button class="secondary danger" ?disabled=${this._dangerBusy} @click=${this._unassignAllChores}>
              Unassign all chores
            </button>
            <button class="secondary danger" ?disabled=${this._dangerBusy} @click=${this._removeAllBounties}>
              Remove all bounties
            </button>
            <button class="secondary danger" ?disabled=${this._dangerBusy} @click=${this._resetPaychecks}>
              Reset this week's paychecks
            </button>
          </div>
          ${this._dangerResult ? html`<p class="small danger-result" role="status">${this._dangerResult}</p>` : ""}
        </ha-card>
      </section>

      <hustle-dialog
        heading=${this._editMemberId ? "Edit family member" : "Add family member"}
        .open=${this._addMemberOpen}
        @hustle-dialog-closed=${() => (this._addMemberOpen = false)}
      >
        <label>Role</label>
        <select @change=${(e: Event) => (this._role = (e.target as HTMLSelectElement).value)}>
          <option value="child" ?selected=${this._role === "child"}>Child</option>
          <option value="parent" ?selected=${this._role === "parent"}>Parent</option>
        </select>
        <label>Display name</label>
        <input .value=${this._haDisplayName} @input=${(e: InputEvent) => (this._haDisplayName = (e.target as HTMLInputElement).value)} />
        ${this._editMemberId
          ? ""
          : html`
              <label>Home Assistant user</label>
              <select @change=${(e: Event) => this._onHaUserPicked((e.target as HTMLSelectElement).value)}>
                <option value="" ?selected=${!this._haUserId}>Select a person…</option>
                ${this._haUsers.map(
                  (u) => html`<option value=${u.id} ?selected=${u.id === this._haUserId}>${u.name}</option>`
                )}
              </select>
              ${this._haUsers.length === 0
                ? html`<p class="muted">No available Home Assistant users found - everyone may already be linked to a Hustle member.</p>`
                : ""}
            `}
        ${this._role === "parent"
          ? html`
              <label>Permission level</label>
              <select @change=${(e: Event) => (this._permissionLevel = (e.target as HTMLSelectElement).value)}>
                <option value="admin" ?selected=${this._permissionLevel === "admin"}>Admin</option>
                <option value="standard" ?selected=${this._permissionLevel === "standard"}>Standard</option>
              </select>
              <label>Manages these children</label>
              <div class="checkbox-list">
                ${this.hustleState.memberRoster
                  .filter((m) => m.role === "child" && m.active)
                  .map(
                    (c) => html`
                      <label class="checkbox-row">
                        <input
                          type="checkbox"
                          .checked=${this._managedChildIds.includes(c.id)}
                          @change=${(e: Event) => this._toggleManagedChild(c.id, (e.target as HTMLInputElement).checked)}
                        />
                        ${c.haDisplayName}
                      </label>
                    `
                  )}
              </div>
              <p class="muted small">Leave unchecked to manage every child in the household.</p>
            `
          : ""}
        <label>Notify target (optional)</label>
        <input
          .value=${this._notifyTarget}
          placeholder="notify.mobile_app_..."
          @input=${(e: InputEvent) => (this._notifyTarget = (e.target as HTMLInputElement).value)}
        />
        <div class="actions">
          <button class="secondary" @click=${() => (this._addMemberOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveAddMember}>
            ${this._editMemberId ? "Save" : "Add"}
          </button>
        </div>
      </hustle-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-settings-view": HustleSettingsView;
  }
}

