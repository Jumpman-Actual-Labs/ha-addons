import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { hustleApi } from "../ha-api";
import type { Bounty, BountyAcceptance, ChoreAssignment, ChoreDefinition, HustleState } from "../types";
import { formatCents } from "../utils/money";
import { formatDate, isOverdue, isWithinAvailabilityWindow, nextOccurrenceDate, today } from "../utils/time";
import { memberName } from "../utils/members";
import { glassCardStyle, formStyles } from "../styles";
import "../components/hustle-dialog";

const CHORE_CATEGORIES = [
  "Bedroom",
  "Kitchen",
  "Bathroom",
  "Living Areas",
  "Laundry",
  "Trash & Recycling",
  "Yard Work",
  "School & Homework",
  "Playroom",
  "Maintenance",
  "Errands",
  "Personal Responsibility",
  "Seasonal",
  "Special Projects",
];

const STATUS_BADGE: Record<string, string> = {
  assigned: "info",
  submitted: "warning",
  approved: "success",
  rejected: "error",
};

const BOUNTY_STATUS_BADGE: Record<string, string> = {
  accepted: "info",
  submitted: "warning",
};

const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

type DialogState =
  | { type: "create" }
  | { type: "edit"; definitionId: string }
  | { type: "assign"; definitionId: string }
  | { type: "bounty"; definitionId: string }
  | { type: "convert"; assignmentId: string }
  | null;

@customElement("hustle-chores-view")
export class HustleChoresView extends LitElement {
  @property({ attribute: false }) readOnly = false;
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;
  @property({ attribute: false }) effectiveMemberId!: string;
  @property({ attribute: false }) isParent!: boolean;
  /** The children a parent may assign chores to - their managedChildIds if
   * set, else every active child. Empty for a child viewer (children don't
   * assign chores). Computed once in hustle-panel.ts. */
  @property({ attribute: false }) assignableMemberIds!: string[];

  @state() private _tab: "definitions" | "assignments" = "assignments";
  @state() private _dialog: DialogState = null;
  @state() private _saving = false;
  @state() private _kidFilter: "todo" | "review" | "upcoming" = "todo";
  @state() private _submittingId = "";
  @state() private _taskMessage = "";

  // create/edit chore form state
  @state() private _title = "";
  @state() private _description = "";
  @state() private _category = "";
  @state() private _payout = "1.00";
  @state() private _dueTime = "";
  @state() private _availableFromTime = "";
  @state() private _availableUntilTime = "";
  @state() private _recurrenceType = "none";
  @state() private _daysOfWeek: string[] = [];
  @state() private _recurrenceAnchorDate = today();
  @state() private _recurrenceDayOfMonth = "1";
  @state() private _isBounty = false;
  @state() private _isRepeatable = false;
  @state() private _isRotating = false;
  @state() private _defaultAssigneeIds: string[] = [];
  @state() private _requiresApproval = true;
  @state() private _ageMin = "";
  @state() private _ageMax = "";
  @state() private _prerequisite = "";
  @state() private _overdueAction = "";
  @state() private _overdueDeductionCents = "1.00";
  @state() private _overdueBountyHours = "5";
  @state() private _overduePenaltyPct = "-50";

  // assign form state
  @state() private _assignMemberIds: string[] = [];
  @state() private _assignDueDate = today();

  // bounty-from-chore / convert-to-bounty form state
  @state() private _bountyAvailableAt = new Date().toISOString().slice(0, 16);
  @state() private _bountyDeadlineAt = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16);
  @state() private _bountyRepeatable = false;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      .kid-task-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,270px),1fr)); gap:18px; }
      .kid-task { border:1px solid var(--divider-color,#e2e7e9); border-radius:22px; padding:22px; background:var(--card-background-color,#fff); display:flex; flex-direction:column; min-width:0; }
      .kid-task-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; }
      .kid-task-icon { width:58px; height:58px; border-radius:16px; overflow:hidden; background:#e7f1eb; color:#23765c; display:grid; place-items:center; }
      .kid-task-icon img { width:100%; height:100%; object-fit:cover; }
      .kid-reward { padding:7px 12px; background:#e7f1eb; color:#1c604a; border-radius:10px; font-size:1.1rem; font-weight:750; }
      .kid-task h3 { font-size:1.2rem; line-height:1.3; overflow-wrap:anywhere; }
      .kid-instructions { color:var(--secondary-text-color,#637185); line-height:1.6; font-size:.95rem; margin:10px 0 22px; white-space:pre-line; overflow-wrap:anywhere; flex:1; }
      .kid-task-meta { display:flex; gap:12px; align-items:center; justify-content:space-between; color:var(--secondary-text-color,#637185); font-size:.8rem; margin-bottom:16px; }
      button.kid-complete { width:100%; min-height:52px; display:flex; gap:8px; justify-content:center; align-items:center; font-weight:700; border-radius:12px; }
      .kid-waiting { min-height:52px; border-radius:12px; background:var(--secondary-background-color,#f0f3f2); display:flex; gap:8px; align-items:center; justify-content:center; font-size:.9rem; }
      .kid-empty { text-align:center; border:1px dashed var(--divider-color,#cbd9d0); border-radius:22px; padding:40px 24px; background:var(--card-background-color,#fff); }
      .kid-empty ha-icon { color:#368269; --mdc-icon-size:40px; }

      details.child-section { border: 1px solid var(--divider-color,#e2e7e9); border-radius: 18px; padding: 16px; background: var(--card-background-color,#fff); margin-bottom: 16px; }
      details.child-section > summary { font-size: 1rem; font-weight: 650; }
      .child-section ha-card.assign-row { --ha-card-border-width: 0; border-top: 1px solid var(--divider-color,#edf0ef); border-radius: 0; margin: 0; padding: 16px 0; }

      .more-actions { width: 100%; margin-top: 4px; }
      .more-actions summary { display: flex; align-items: center; color: var(--secondary-text-color,#657080); font-size: .85rem; }
      .more-actions summary::after { content: "＋"; margin-left: auto; }
      .more-actions[open] summary::after { content: "−"; }
      .more-options { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0; }
      .section-tabs { display: flex; flex-wrap: wrap; max-width: 100%; gap: 6px; padding: 5px; border-radius: 12px; background: var(--secondary-background-color,#edf0ef); width: fit-content; margin: 20px 0 24px; }
      .section-tabs button { border: 0; background: transparent; color: var(--secondary-text-color,#657080); padding: 8px 16px; border-radius: 9px; cursor: pointer; }
      .section-tabs button.active { background: var(--card-background-color,#fff); color: var(--primary-text-color,#21352e); box-shadow: 0 1px 4px #0000000a; font-weight: 650; }
      .spread {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      ha-card.chore-card {
        padding: 0;
        margin-bottom: 12px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .chore-card .chore-image {
        width: 100%;
        aspect-ratio: 16 / 7;
        background: var(--secondary-background-color, #f0f0f0);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .chore-card .chore-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .chore-card .chore-image ha-icon {
        --mdc-icon-size: 48px;
        color: var(--secondary-text-color, #9e9e9e);
      }
      .chore-card .chore-card-body {
        padding: 16px;
      }
      .chore-card header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .chore-card .payout {
        font-weight: 700;
        color: var(--success-color, #43a047);
      }
      .badges {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .chore-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      ha-card.assign-row {
        flex-wrap: wrap;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        margin-bottom: 10px;
      }
      .assign-thumb {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border-radius: 8px;
        overflow: hidden;
        background: var(--secondary-background-color, #f0f0f0);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .assign-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .assign-thumb ha-icon {
        --mdc-icon-size: 20px;
        color: var(--secondary-text-color, #9e9e9e);
      }
      .grow {
        min-width: 130px;
        overflow-wrap: anywhere;
        flex: 1;
      }
      .checkbox-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 180px;
        overflow-y: auto;
      }
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .checkbox-row input {
        width: auto;
      }
      .toggle-group {
        display: flex;
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 8px;
        overflow: hidden;
        width: fit-content;
      }
      .toggle-option {
        padding: 8px 20px;
        border: none;
        background: none;
        cursor: pointer;
        font-size: 0.9rem;
        color: var(--secondary-text-color, #727272);
      }
      .toggle-option.active {
        background: var(--primary-color, #03a9f4);
        color: #fff;
      }
      details.child-section summary {
        cursor: pointer;
        padding: 12px 0;
        font-size: 1.05rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
        list-style: none;
      }
      details.child-section summary::-webkit-details-marker {
        display: none;
      }
      details.child-section[open] summary {
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      details.child-section > :not(summary) {
        padding-top: 10px;
      }
      details.child-section .assign-row:last-child {
        margin-bottom: 10px;
      }
    `,
  ];

  private _openCreateDialog(): void {
    this._title = "";
    this._description = "";
    this._category = "";
    this._payout = "1.00";
    this._dueTime = "";
    this._availableFromTime = "";
    this._availableUntilTime = "";
    this._recurrenceType = "none";
    this._daysOfWeek = [];
    this._recurrenceAnchorDate = today();
    this._recurrenceDayOfMonth = "1";
    this._isBounty = false;
    this._isRepeatable = false;
    this._isRotating = false;
    this._defaultAssigneeIds = [];
    this._requiresApproval = true;
    this._ageMin = "";
    this._ageMax = "";
    this._prerequisite = "";
    this._overdueAction = "";
    this._overdueDeductionCents = "1.00";
    this._overdueBountyHours = "5";
    this._overduePenaltyPct = "-50";
    this._dialog = { type: "create" };
  }

  /** Bounty-type chores don't have an overdue setting (see the dialog's
   * "When overdue" section), so switching to Bounty resets whatever was
   * selected - matches the backend clearing it on save regardless, just
   * keeps the form from showing stale values if you flip back to Chore. */
  private _setIsBounty(value: boolean): void {
    this._isBounty = value;
    if (value) {
      this._overdueAction = "";
      this._overdueDeductionCents = "1.00";
      this._overdueBountyHours = "5";
      this._overduePenaltyPct = "-50";
    } else {
      this._isRepeatable = false;
    }
  }

  /** "One-time (repeatable)" is a synthetic option, not a real
   * RecurrenceType - it maps to recurrence_type="none" plus is_repeatable,
   * same underlying fields the old separate checkbox set. Any other
   * selection turns repeatable back off (recurring + repeatable isn't
   * exposed here, only via the API). */
  private _onRecurrenceSelected(value: string): void {
    if (value === "none-repeatable") {
      this._recurrenceType = "none";
      this._isRepeatable = true;
    } else {
      this._recurrenceType = value;
      this._isRepeatable = false;
    }
  }

  private _populateFormFrom(d: ChoreDefinition): void {
    this._title = d.title;
    this._description = d.description ?? "";
    this._category = d.category ?? "";
    this._payout = (d.payoutCents / 100).toFixed(2);
    this._dueTime = d.dueTime ?? "";
    this._availableFromTime = d.availableFromTime ?? "";
    this._availableUntilTime = d.availableUntilTime ?? "";
    this._recurrenceType = d.recurrenceType;
    this._daysOfWeek = d.recurrenceConfig.days_of_week ?? [];
    this._recurrenceAnchorDate = d.recurrenceConfig.anchor_date ?? today();
    this._recurrenceDayOfMonth = d.recurrenceConfig.day_of_month ? String(d.recurrenceConfig.day_of_month) : "1";
    this._isBounty = d.isBounty;
    this._isRepeatable = d.isRepeatable;
    this._isRotating = d.isRotating;
    this._defaultAssigneeIds = d.defaultAssigneeIds;
    this._requiresApproval = d.requiresApproval;
    this._ageMin = d.ageMin !== null ? String(d.ageMin) : "";
    this._ageMax = d.ageMax !== null ? String(d.ageMax) : "";
    this._prerequisite = d.prerequisiteIds[0] ?? "";
    this._overdueAction = d.overdueAction ?? "";
    this._overdueDeductionCents = d.overdueDeductionCents !== null ? (d.overdueDeductionCents / 100).toFixed(2) : "1.00";
    this._overdueBountyHours = d.overdueBountyHours !== null ? String(d.overdueBountyHours) : "5";
    this._overduePenaltyPct = d.overduePenaltyPct !== null ? String(d.overduePenaltyPct) : "-50";
  }

  private _openEditDialog(definitionId: string): void {
    const d = this.hustleState.choreDefinitions.find((c) => c.definitionId === definitionId);
    if (!d) return;
    this._populateFormFrom(d);
    this._dialog = { type: "edit", definitionId };
  }

  /** Prefills the create dialog from an existing chore, so a parent can
   * spin up a near-identical chore (e.g. "Sweep bedroom" -> "Sweep
   * living room") without retyping every field. */
  private _openDuplicateDialog(definitionId: string): void {
    const d = this.hustleState.choreDefinitions.find((c) => c.definitionId === definitionId);
    if (!d) return;
    this._populateFormFrom(d);
    this._dialog = { type: "create" };
  }

  private _choreFormFields(): Record<string, unknown> {
    let recurrenceConfig: Record<string, unknown> = {};
    if (this._recurrenceType === "weekly") {
      recurrenceConfig = { days_of_week: this._daysOfWeek };
    } else if (this._recurrenceType === "biweekly" || this._recurrenceType === "quarterly") {
      recurrenceConfig = { anchor_date: this._recurrenceAnchorDate };
    } else if (this._recurrenceType === "monthly") {
      recurrenceConfig = { day_of_month: Number(this._recurrenceDayOfMonth) || 1 };
    }
    return {
      title: this._title.trim(),
      description: this._description || null,
      category: this._category || null,
      payout_cents: Math.round(Number(this._payout) * 100) || 0,
      due_time: this._dueTime || null,
      available_from_time: this._availableFromTime || null,
      available_until_time: this._availableUntilTime || null,
      recurrence_type: this._recurrenceType,
      recurrence_config: recurrenceConfig,
      is_bounty: this._isBounty,
      is_repeatable: this._isRepeatable,
      is_rotating: this._isRotating,
      default_assignee_ids: this._isBounty || this._isRotating ? [] : this._defaultAssigneeIds,
      requires_approval: this._requiresApproval,
      age_min: this._ageMin ? Number(this._ageMin) : null,
      age_max: this._ageMax ? Number(this._ageMax) : null,
      prerequisite_ids: this._prerequisite ? [this._prerequisite] : [],
      overdue_action: this._overdueAction || null,
      overdue_deduction_cents:
        this._overdueAction === "deduct" ? Math.round(Number(this._overdueDeductionCents) * 100) || 0 : null,
      overdue_bounty_hours:
        this._overdueAction === "convert_to_bounty" ? Number(this._overdueBountyHours) || 5 : null,
      overdue_penalty_pct:
        this._overdueAction === "convert_to_bounty" ? Number(this._overduePenaltyPct) || -50 : null,
    };
  }

  private async _saveChoreForm(): Promise<void> {
    if ((this._dialog?.type !== "create" && this._dialog?.type !== "edit") || !this._title.trim()) return;
    this._saving = true;
    try {
      if (this._dialog.type === "edit") {
        await hustleApi.updateChoreDefinition(this.hass, this._dialog.definitionId, this._choreFormFields());
      } else {
        await hustleApi.addChoreDefinition(this.hass, this._choreFormFields());
      }
      this._dialog = null;
    } finally {
      this._saving = false;
    }
  }

  private _openAssignDialog(definitionId: string): void {
    const d = this.hustleState.choreDefinitions.find((c) => c.definitionId === definitionId);
    this._assignMemberIds = [];
    this._assignDueDate = d ? nextOccurrenceDate(d.recurrenceType, d.recurrenceConfig) : today();
    this._dialog = { type: "assign", definitionId };
  }

  private async _saveAssign(): Promise<void> {
    if (this._dialog?.type !== "assign" || this._assignMemberIds.length === 0) return;
    this._saving = true;
    try {
      await hustleApi.assignChore(this.hass, this._dialog.definitionId, this._assignMemberIds, this._assignDueDate);
      this._dialog = null;
      this._tab = "assignments";
    } finally {
      this._saving = false;
    }
  }

  private async _submit(assignmentId: string): Promise<void> {
    if (this.readOnly || this._submittingId) return;
    this._submittingId = assignmentId;
    this._taskMessage = "";
    try {
      await hustleApi.submitChore(this.hass, assignmentId);
      this._taskMessage = "Nice work! Your task was sent for review.";
    } catch (error) {
      this._taskMessage = `Could not send this task. ${error instanceof Error ? error.message : "Please try again."}`;
    } finally { this._submittingId = ""; }
  }

  private async _submitBounty(bountyId: string, memberId: string): Promise<void> {
    await hustleApi.submitBountyAcceptance(this.hass, bountyId, memberId);
  }

  private _openBountyDialog(definitionId: string): void {
    const now = new Date();
    this._bountyAvailableAt = now.toISOString().slice(0, 16);
    this._bountyDeadlineAt = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 16);
    this._bountyRepeatable = false;
    this._dialog = { type: "bounty", definitionId };
  }

  private async _saveBounty(): Promise<void> {
    if (this._dialog?.type !== "bounty") return;
    this._saving = true;
    try {
      await hustleApi.addBountyFromChore(this.hass, {
        chore_definition_id: this._dialog.definitionId,
        available_at: new Date(this._bountyAvailableAt).toISOString(),
        deadline_at: new Date(this._bountyDeadlineAt).toISOString(),
        is_repeatable: this._bountyRepeatable,
      });
      this._dialog = null;
    } finally {
      this._saving = false;
    }
  }

  private _openConvertDialog(assignmentId: string): void {
    const now = new Date();
    this._bountyAvailableAt = now.toISOString().slice(0, 16);
    this._bountyDeadlineAt = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 16);
    this._dialog = { type: "convert", assignmentId };
  }

  private async _saveConvert(): Promise<void> {
    if (this._dialog?.type !== "convert") return;
    this._saving = true;
    try {
      await hustleApi.convertAssignmentToBounty(this.hass, this._dialog.assignmentId, {
        available_at: new Date(this._bountyAvailableAt).toISOString(),
        deadline_at: new Date(this._bountyDeadlineAt).toISOString(),
      });
      this._dialog = null;
    } finally {
      this._saving = false;
    }
  }

  private async _approve(assignmentId: string): Promise<void> {
    await hustleApi.approveChore(this.hass, assignmentId);
  }

  private async _reject(assignmentId: string): Promise<void> {
    const reason = window.prompt("Reason for rejecting?") || "Needs improvement";
    await hustleApi.rejectChore(this.hass, assignmentId, reason);
  }

  private async _generateOccurrences(): Promise<void> {
    await hustleApi.generateDueChoreOccurrences(this.hass);
  }

  private async _regenerateImage(definitionId: string): Promise<void> {
    await hustleApi.regenerateChoreImage(this.hass, definitionId);
  }

  /** Chore images are always saved at the same URL (per chore id), so the
   * browser cache never sees a regenerated image as "new" unless we bust it
   * with something that actually changes - updatedAt does, on every edit or
   * regeneration. */
  private _imageSrc(d: ChoreDefinition): string | null {
    if (!d.imagePath) return null;
    return `${d.imagePath}?v=${encodeURIComponent(d.updatedAt)}`;
  }

  private _toggleAssignMember(memberId: string, checked: boolean): void {
    this._assignMemberIds = checked
      ? [...this._assignMemberIds, memberId]
      : this._assignMemberIds.filter((id) => id !== memberId);
  }

  private _toggleDefaultAssignee(memberId: string, checked: boolean): void {
    this._defaultAssigneeIds = checked
      ? [...this._defaultAssigneeIds, memberId]
      : this._defaultAssigneeIds.filter((id) => id !== memberId);
  }

  private _toggleDayOfWeek(day: string, checked: boolean): void {
    this._daysOfWeek = checked ? [...this._daysOfWeek, day] : this._daysOfWeek.filter((d) => d !== day);
  }

  private _renderDefinitionCard(d: ChoreDefinition) {
    return html`
      <ha-card class="chore-card">
        <div class="chore-image">
          ${this._imageSrc(d)
            ? html`<img src=${this._imageSrc(d)!} alt=${d.title} />`
            : html`<ha-icon icon="mdi:broom"></ha-icon>`}
        </div>
        <div class="chore-card-body">
          <header>
            <h3>${d.title}</h3>
            <span class="payout">${formatCents(d.payoutCents)}</span>
          </header>
          ${d.category ? html`<span class="small muted">${d.category}</span>` : ""}
          <div class="badges">
            ${d.isBounty ? html`<span class="badge info">bounty</span>` : ""}
            ${d.recurrenceType !== "none"
              ? html`<span class="badge info">${d.recurrenceType}</span>`
              : html`<span class="badge">one-time</span>`}
            ${d.isRotating ? html`<span class="badge">rotating</span>` : ""}
            ${d.requiresApproval ? html`<span class="badge">needs approval</span>` : ""}
            ${d.dueTime ? html`<span class="badge">due ${d.dueTime}</span>` : ""}
            ${d.overdueAction
              ? html`<span class="badge warning">overdue: ${d.overdueAction.replace(/_/g, " ")}</span>`
              : ""}
          </div>
          ${this.isParent
            ? html`
                <div class="chore-actions">
                  ${d.isBounty
                    ? ""
                    : html`<button class="link" @click=${() => this._openAssignDialog(d.definitionId)}>Assign</button>`}
                  <button class="link" @click=${() => this._openEditDialog(d.definitionId)}>Edit</button>
                  <details class="more-actions"><summary>More options</summary><div class="more-options">
                  <button class="link" @click=${() => this._openDuplicateDialog(d.definitionId)}>Duplicate</button>
                  <button class="link" @click=${() => this._openBountyDialog(d.definitionId)}>Make Bounty</button>
                  <button class="link" @click=${() => this._regenerateImage(d.definitionId)}>Regenerate image</button>
                  </div></details>
                </div>
              `
            : ""}
        </div>
      </ha-card>
    `;
  }

  private _renderAssignmentRow(a: ChoreAssignment) {
    const definition = this.hustleState.choreDefinitions.find((d) => d.definitionId === a.choreDefinitionId);
    const upcoming = !this.isParent && a.dueDate > today();
    const pending = a.status === "assigned" || a.status === "rejected";
    const withinHours = isWithinAvailabilityWindow(a.dueDate, a.availableFromTime, a.availableUntilTime);
    const canSubmit = !upcoming && pending && (this.isParent || withinHours);
    const canReview = this.isParent && a.status === "submitted";
    const canConvert = this.isParent && (a.status === "assigned" || a.status === "submitted");
    const imageSrc = definition ? this._imageSrc(definition) : null;
    if (!this.isParent) return html`
      <article class="kid-task">
        <div class="kid-task-top"><div class="kid-task-icon">${imageSrc ? html`<img src=${imageSrc} alt="" />` : html`<ha-icon icon="mdi:broom"></ha-icon>`}</div><span class="kid-reward">${formatCents(a.payoutCents)}</span></div>
        <h3>${definition?.title ?? "Your task"}</h3>
        <p class="kid-instructions">${definition?.description || "Finish this task, then send it to a parent to check."}</p>
        <div class="kid-task-meta"><span>${a.dueDate === today() ? "Today" : formatDate(a.dueDate)}${a.dueTime ? ` · ${a.dueTime}` : ""}</span>${a.status === "rejected" ? html`<span class="badge warning">Try again</span>` : pending && isOverdue(a.dueDate, a.dueTime) ? html`<span class="badge warning">Overdue</span>` : ""}</div>
        ${canSubmit ? html`<button class="primary kid-complete" ?disabled=${this.readOnly || Boolean(this._submittingId)} @click=${() => this._submit(a.assignmentId)}><ha-icon icon="mdi:check"></ha-icon>${this._submittingId === a.assignmentId ? "Sending…" : "I’m done!"}</button>` : html`<div class="kid-waiting"><ha-icon icon="mdi:clock-outline"></ha-icon>${upcoming ? `Available ${formatDate(a.dueDate)}` : pending && !withinHours ? "Outside task hours — ask a parent" : a.status === "approved" ? "Approved. Great work!" : "Sent to a parent"}</div>`}
      </article>`;
    return html`
      <ha-card class="assign-row">
        <div class="assign-thumb">
          ${imageSrc ? html`<img src=${imageSrc} alt=${definition?.title ?? ""} />` : html`<ha-icon icon="mdi:broom"></ha-icon>`}
        </div>
        <div class="grow col">
          <span>${definition?.title ?? a.choreDefinitionId}</span>
          <span class="small muted">due ${formatDate(a.dueDate)}${a.dueTime ? ` ${a.dueTime}` : ""}</span>
        </div>
        <span class="payout">${formatCents(a.payoutCents)}</span>
        <span class="badge ${STATUS_BADGE[a.status] ?? ""}">${a.status === "submitted" ? "Waiting for approval" : a.status === "rejected" ? "Try again" : a.status === "assigned" ? "To do" : "Done"}</span>
        ${canSubmit ? html`<button class="secondary" ?disabled=${this.readOnly} @click=${() => this._submit(a.assignmentId)}>I’m done!</button>` : ""}
        ${canReview
          ? html`
              <button class="secondary" @click=${() => this._approve(a.assignmentId)}>Approve</button>
              <button class="link danger" @click=${() => this._reject(a.assignmentId)}>Reject</button>
            `
          : ""}
        ${canConvert
          ? html`<button class="link" @click=${() => this._openConvertDialog(a.assignmentId)}>Convert to Bounty</button>`
          : ""}
      </ha-card>
    `;
  }

  /** Accepted/submitted bounties show up in the same "Currently Assigned
   * Chores" list as regular chore assignments, so a child sees everything
   * they're currently on the hook for in one place. */
  private _renderBountyAcceptanceRow(bounty: Bounty, acceptance: BountyAcceptance) {
    const sourceChore = bounty.sourceChoreDefinitionId
      ? this.hustleState.choreDefinitions.find((d) => d.definitionId === bounty.sourceChoreDefinitionId)
      : undefined;
    const imageSrc = sourceChore ? this._imageSrc(sourceChore) : null;
    return html`
      <ha-card class="assign-row">
        <div class="assign-thumb">
          ${imageSrc ? html`<img src=${imageSrc} alt=${bounty.title} />` : html`<ha-icon icon="mdi:target"></ha-icon>`}
        </div>
        <div class="grow col">
          <span>${bounty.title} <span class="badge info">bounty</span></span>
          <span class="small muted">deadline ${formatDate(bounty.deadlineAt)}</span>
        </div>
        <span class="payout">${formatCents(bounty.payoutCents)}</span>
        <span class="badge ${BOUNTY_STATUS_BADGE[acceptance.status] ?? ""}">${acceptance.status}</span>
        ${acceptance.status === "accepted"
          ? html`<button class="secondary" ?disabled=${this.readOnly} @click=${() => this._submitBounty(bounty.bountyId, acceptance.memberId)}>I’m done!</button>`
          : ""}
      </ha-card>
    `;
  }

  /** One collapsible section per managed child, each holding just that
   * child's currently assigned chores and accepted/submitted bounties -
   * replaces per-row name tags now that everything's already grouped. */
  private _renderChildSection(
    memberId: string,
    assignments: ChoreAssignment[],
    bounties: Array<{ bounty: Bounty; acceptance: BountyAcceptance }>
  ) {
    const count = assignments.length + bounties.length;
    return html`
      <details class="child-section" open>
        <summary>${memberName(this.hustleState, memberId)} <span class="badge">${count}</span></summary>
        ${count === 0
          ? html`<div class="empty">Nothing currently assigned.</div>`
          : html`
              ${assignments.map((a) => this._renderAssignmentRow(a))}
              ${bounties.map(({ bounty, acceptance }) => this._renderBountyAcceptanceRow(bounty, acceptance))}
            `}
      </details>
    `;
  }

  private _renderDialogContent() {
    const dialog = this._dialog;
    if (dialog === null) return html``;

    if (dialog.type === "create" || dialog.type === "edit") {
      const editingId = dialog.type === "edit" ? dialog.definitionId : null;
      return html`
        <label>Title</label>
        <input .value=${this._title} @input=${(e: InputEvent) => (this._title = (e.target as HTMLInputElement).value)} />
        <label>Type</label>
        <div class="toggle-group">
          <button
            type="button"
            class="toggle-option ${!this._isBounty ? "active" : ""}"
            @click=${() => this._setIsBounty(false)}
          >
            Chore
          </button>
          <button
            type="button"
            class="toggle-option ${this._isBounty ? "active" : ""}"
            @click=${() => this._setIsBounty(true)}
          >
            Bounty
          </button>
        </div>
        ${this._isBounty
          ? html`<p class="muted small">
              Every occurrence posts as an open bounty any kid can accept, instead of being
              assigned to one child.
            </p>`
          : ""}
        <label>Description</label>
        <textarea rows="2" .value=${this._description} @input=${(e: InputEvent) => (this._description = (e.target as HTMLTextAreaElement).value)}></textarea>
        <label>Category</label>
        <select @change=${(e: Event) => (this._category = (e.target as HTMLSelectElement).value)}>
          <option value="" ?selected=${this._category === ""}>None</option>
          ${CHORE_CATEGORIES.map(
            (c) => html`<option value=${c} ?selected=${c === this._category}>${c}</option>`
          )}
        </select>
        <div class="row">
          <div class="field grow"><label>Payout ($)</label><input type="number" step="0.01" min="0" .value=${this._payout} @input=${(e: InputEvent) => (this._payout = (e.target as HTMLInputElement).value)} /></div>
          <div class="field grow"><label>Due time (optional)</label><input type="time" .value=${this._dueTime} @input=${(e: InputEvent) => (this._dueTime = (e.target as HTMLInputElement).value)} /></div>
        </div>
        <div class="row">
          <div class="field grow">
            <label>Available from (optional)</label>
            <input type="time" .value=${this._availableFromTime} @input=${(e: InputEvent) => (this._availableFromTime = (e.target as HTMLInputElement).value)} />
          </div>
          <div class="field grow">
            <label>Available until (optional)</label>
            <input type="time" .value=${this._availableUntilTime} @input=${(e: InputEvent) => (this._availableUntilTime = (e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <p class="muted small">
          ${this._isBounty
            ? html`Controls when each day's bounty opens and closes - e.g. only postable
              and claimable between 6:00 AM and 9:00 AM. Leave either blank for no
              restriction on that side (defaults to midnight / due time).`
            : html`Restricts the chore to a time-of-day window each day it's due - e.g. a
              morning chore only submittable between 6:00 AM and 9:00 AM. Leave either
              blank for no restriction on that side.`}
        </p>
        <label>Recurrence</label>
        <select @change=${(e: Event) => this._onRecurrenceSelected((e.target as HTMLSelectElement).value)}>
          <option value="none" ?selected=${this._recurrenceType === "none" && !this._isRepeatable}>One-time</option>
          ${this._isBounty
            ? html`<option value="none-repeatable" ?selected=${this._recurrenceType === "none" && this._isRepeatable}>
                One-time (repeatable)
              </option>`
            : ""}
          <option value="daily" ?selected=${this._recurrenceType === "daily"}>Daily</option>
          <option value="weekly" ?selected=${this._recurrenceType === "weekly"}>Weekly</option>
          <option value="biweekly" ?selected=${this._recurrenceType === "biweekly"}>Every two weeks</option>
          <option value="monthly" ?selected=${this._recurrenceType === "monthly"}>Monthly</option>
          <option value="quarterly" ?selected=${this._recurrenceType === "quarterly"}>Every three months</option>
        </select>
        ${this._isBounty && this._recurrenceType === "none" && this._isRepeatable
          ? html`<p class="muted small">
              Keeps reappearing after it's completed instead of closing for good - e.g. "Read a
              book," completable once per book. Posts a single open-ended bounty right away;
              cancel it from the Bounty Board whenever you're done with it.
            </p>`
          : ""}
        ${this._recurrenceType === "weekly"
          ? html`
              <label>Days of week</label>
              <div class="checkbox-list">
                ${WEEKDAYS.map(
                  (d) => html`
                    <label class="checkbox-row">
                      <input
                        type="checkbox"
                        .checked=${this._daysOfWeek.includes(d)}
                        @change=${(e: Event) => this._toggleDayOfWeek(d, (e.target as HTMLInputElement).checked)}
                      />
                      ${d}
                    </label>
                  `
                )}
              </div>
            `
          : ""}
        ${this._recurrenceType === "biweekly" || this._recurrenceType === "quarterly"
          ? html`
              <label>Anchor date (first occurrence)</label>
              <input type="date" .value=${this._recurrenceAnchorDate} @input=${(e: InputEvent) => (this._recurrenceAnchorDate = (e.target as HTMLInputElement).value)} />
            `
          : ""}
        ${this._recurrenceType === "monthly"
          ? html`
              <label>Day of month</label>
              <input type="number" min="1" max="28" .value=${this._recurrenceDayOfMonth} @input=${(e: InputEvent) => (this._recurrenceDayOfMonth = (e.target as HTMLInputElement).value)} />
            `
          : ""}
        <div class="row">
          <div class="field grow"><label>Min age (optional)</label><input type="number" min="0" .value=${this._ageMin} @input=${(e: InputEvent) => (this._ageMin = (e.target as HTMLInputElement).value)} /></div>
          <div class="field grow"><label>Max age (optional)</label><input type="number" min="0" .value=${this._ageMax} @input=${(e: InputEvent) => (this._ageMax = (e.target as HTMLInputElement).value)} /></div>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" .checked=${this._requiresApproval} @change=${(e: Event) => (this._requiresApproval = (e.target as HTMLInputElement).checked)} />
          Requires approval
        </label>
        ${this._isBounty
          ? ""
          : html`
              <label class="checkbox-row">
                <input type="checkbox" .checked=${this._isRotating} @change=${(e: Event) => (this._isRotating = (e.target as HTMLInputElement).checked)} />
                Rotates between kids
              </label>
            `}
        ${!this._isBounty && !this._isRotating && this._recurrenceType !== "none"
          ? html`
              <label>Default assignees</label>
              <p class="muted small">
                Who each new occurrence gets automatically assigned to as it recurs. Leave
                empty and this chore will never auto-assign itself - it'll only exist when
                assigned by hand.
              </p>
              <div class="checkbox-list">
                ${this.hustleState.memberRoster
                  .filter((m) => m.active && this.assignableMemberIds.includes(m.id))
                  .map(
                    (m) => html`
                      <label class="checkbox-row">
                        <input
                          type="checkbox"
                          .checked=${this._defaultAssigneeIds.includes(m.id)}
                          @change=${(e: Event) => this._toggleDefaultAssignee(m.id, (e.target as HTMLInputElement).checked)}
                        />
                        ${m.haDisplayName}
                      </label>
                    `
                  )}
              </div>
            `
          : ""}
        <label>Prerequisite chore (optional)</label>
        <select @change=${(e: Event) => (this._prerequisite = (e.target as HTMLSelectElement).value)}>
          <option value="">None</option>
          ${this.hustleState.choreDefinitions
            .filter((d) => d.definitionId !== editingId)
            .map(
              (d) => html`<option value=${d.definitionId} ?selected=${d.definitionId === this._prerequisite}>${d.title}</option>`
            )}
        </select>

        ${this._isBounty
          ? html`<p class="muted small">
              Bounty-type chores don't have an overdue setting - a missed occurrence just
              doesn't get claimed, and the next one posts on its own schedule regardless.
            </p>`
          : html`
              <label>When overdue</label>
              <select @change=${(e: Event) => (this._overdueAction = (e.target as HTMLSelectElement).value)}>
                <option value="" ?selected=${this._overdueAction === ""}>Nothing (leave it assigned)</option>
                <option value="remove" ?selected=${this._overdueAction === "remove"}>Remove the assignment</option>
                <option value="convert_to_bounty" ?selected=${this._overdueAction === "convert_to_bounty"}>Turn into a bounty</option>
                <option value="deduct" ?selected=${this._overdueAction === "deduct"}>Create a deduction</option>
              </select>
              ${this._overdueAction === "deduct"
                ? html`
                    <label>Deduction amount ($)</label>
                    <input type="number" step="0.01" min="0" .value=${this._overdueDeductionCents} @input=${(e: InputEvent) => (this._overdueDeductionCents = (e.target as HTMLInputElement).value)} />
                  `
                : ""}
              ${this._overdueAction === "convert_to_bounty"
                ? html`
                    <div class="row">
                      <div class="field grow">
                        <label>Bounty open for (hours after due)</label>
                        <input type="number" min="1" .value=${this._overdueBountyHours} @input=${(e: InputEvent) => (this._overdueBountyHours = (e.target as HTMLInputElement).value)} />
                      </div>
                      <div class="field grow">
                        <label>Penalty % if the original assignee does it</label>
                        <input type="number" max="0" .value=${this._overduePenaltyPct} @input=${(e: InputEvent) => (this._overduePenaltyPct = (e.target as HTMLInputElement).value)} />
                      </div>
                    </div>
                    <p class="muted small">
                      A negative percent of the chore's normal payout - e.g. -50 on a $1 chore
                      means the original assignee gets -$0.50 (a deduction) if it's them who
                      completes it late. Anyone else gets the full bounty reward as usual.
                    </p>
                  `
                : ""}
            `}

        <div class="actions">
          <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveChoreForm}>
            ${editingId ? "Save changes" : "Create chore"}
          </button>
        </div>
      `;
    }

    if (dialog.type === "assign") {
      return html`
        <label>Assign to</label>
        <div class="checkbox-list">
          ${this.hustleState.memberRoster
            .filter((m) => m.active && this.assignableMemberIds.includes(m.id))
            .map(
              (m) => html`
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    .checked=${this._assignMemberIds.includes(m.id)}
                    @change=${(e: Event) => this._toggleAssignMember(m.id, (e.target as HTMLInputElement).checked)}
                  />
                  ${m.haDisplayName}
                </label>
              `
            )}
        </div>
        <div class="actions">
          <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveAssign}>Assign</button>
        </div>
      `;
    }

    if (dialog.type === "convert") {
      return html`
        <p class="muted small">Removes the current assignment and posts it as an open bounty instead.</p>
        <div class="row">
          <div class="field grow"><label>Available from</label><input type="datetime-local" .value=${this._bountyAvailableAt} @input=${(e: InputEvent) => (this._bountyAvailableAt = (e.target as HTMLInputElement).value)} /></div>
          <div class="field grow"><label>Deadline</label><input type="datetime-local" .value=${this._bountyDeadlineAt} @input=${(e: InputEvent) => (this._bountyDeadlineAt = (e.target as HTMLInputElement).value)} /></div>
        </div>
        <div class="actions">
          <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveConvert}>Convert to Bounty</button>
        </div>
      `;
    }

    // bounty (make an unassigned chore definition into a bounty)
    return html`
      <div class="row">
        <div class="field grow"><label>Available from</label><input type="datetime-local" .value=${this._bountyAvailableAt} @input=${(e: InputEvent) => (this._bountyAvailableAt = (e.target as HTMLInputElement).value)} /></div>
        <div class="field grow"><label>Deadline</label><input type="datetime-local" .value=${this._bountyDeadlineAt} @input=${(e: InputEvent) => (this._bountyDeadlineAt = (e.target as HTMLInputElement).value)} /></div>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" .checked=${this._bountyRepeatable} @change=${(e: Event) => (this._bountyRepeatable = (e.target as HTMLInputElement).checked)} />
        Repeatable
      </label>
      <p class="muted small">
        Keeps reappearing after it's completed - the same or a different kid can complete it
        again, right up until the deadline. E.g. "Read a book," completable once per book.
      </p>
      <div class="actions">
        <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
        <button class="primary" ?disabled=${this._saving} @click=${this._saveBounty}>Post bounty</button>
      </div>
    `;
  }

  private _dialogHeading(): string {
    const dialog = this._dialog;
    if (dialog === null) return "";
    if (dialog.type === "create") return "New chore";
    if (dialog.type === "edit") return "Edit chore";
    if (dialog.type === "assign") return "Assign chore";
    if (dialog.type === "convert") return "Convert to bounty";
    return "Turn into a bounty";
  }

  render() {
    const s = this.hustleState;
    // Assignment visibility is separate from whether it can be submitted now.
    // Keep overdue and time-restricted work visible; future work has its own tab.
    const todayStr = today();
    const visibleAssignments = s.choreAssignments.filter(a =>
      (this.isParent ? this.assignableMemberIds.includes(a.memberId) : a.memberId === this.effectiveMemberId)
      && (this.isParent || a.dueDate <= todayStr)
    );
    const visibleBounties: Array<{ bounty: Bounty; acceptance: BountyAcceptance }> = [];
    for (const bounty of s.bounties) {
      const relevant = this.isParent
        ? bounty.acceptances.filter((a) => this.assignableMemberIds.includes(a.memberId))
        : bounty.acceptances.filter((a) => a.memberId === this.effectiveMemberId);
      for (const acceptance of relevant) {
        if (acceptance.status === "accepted" || acceptance.status === "submitted") {
          visibleBounties.push({ bounty, acceptance });
        }
      }
    }
    const hasCurrentWork = visibleAssignments.length > 0 || visibleBounties.length > 0;

    if (!this.isParent) {
      const upcomingTasks = s.choreAssignments
        .filter(a => a.memberId === this.effectiveMemberId && a.dueDate > todayStr && (a.status === "assigned" || a.status === "rejected"))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.dueTime ?? "").localeCompare(b.dueTime ?? ""));
      const tasks = this._kidFilter === "upcoming" ? upcomingTasks : visibleAssignments.filter(a => this._kidFilter === "review" ? a.status === "submitted" : a.status === "assigned" || a.status === "rejected");
      const extras = this._kidFilter === "upcoming" ? [] : visibleBounties.filter(({acceptance}) => this._kidFilter === "review" ? acceptance.status === "submitted" : acceptance.status === "accepted");
      const todoCount = visibleAssignments.filter(a => a.status === "assigned" || a.status === "rejected").length + visibleBounties.filter(b => b.acceptance.status === "accepted").length;
      const reviewCount = visibleAssignments.filter(a => a.status === "submitted").length + visibleBounties.filter(b => b.acceptance.status === "submitted").length;
      return html`<div class="spread"><div><h1>My tasks</h1><p class="muted small">${todoCount ? `${todoCount} ${todoCount === 1 ? "task" : "tasks"} assigned to you` : "Nothing left to do right now"}</p></div></div>
        <div class="section-tabs" aria-label="Task status"><button class=${this._kidFilter === "todo" ? "active" : ""} aria-pressed=${this._kidFilter === "todo"} @click=${() => this._kidFilter = "todo"}>To do · ${todoCount}</button><button class=${this._kidFilter === "review" ? "active" : ""} aria-pressed=${this._kidFilter === "review"} @click=${() => this._kidFilter = "review"}>In review · ${reviewCount}</button><button class=${this._kidFilter === "upcoming" ? "active" : ""} aria-pressed=${this._kidFilter === "upcoming"} @click=${() => this._kidFilter = "upcoming"}>Upcoming · ${upcomingTasks.length}</button></div>
        ${this._taskMessage ? html`<p role="status">${this._taskMessage}</p>` : ""}
        ${tasks.length || extras.length ? html`<div class="kid-task-grid">${tasks.map(a => this._renderAssignmentRow(a))}</div>${extras.map(({bounty,acceptance}) => this._renderBountyAcceptanceRow(bounty,acceptance))}` : html`<div class="kid-empty"><ha-icon icon=${this._kidFilter === "todo" ? "mdi:check-circle-outline" : "mdi:clock-outline"}></ha-icon><h2>${this._kidFilter === "upcoming" ? "No upcoming tasks yet" : this._kidFilter === "todo" ? "You’re all caught up" : "Nothing waiting for review"}</h2><p class="muted">${this._kidFilter === "upcoming" ? "Future assigned tasks will appear here when they are scheduled." : this._kidFilter === "todo" ? "Check Extra jobs if you’d like to earn more." : "Tasks you send to a parent will appear here."}</p></div>`}`;
    }
    return html`
      <div class="spread">
        <div><h1>Chores</h1><p class="muted small" style="margin:0">A little work today. A little more earned.</p></div>
        ${this.isParent ? html`<button class="primary" @click=${this._openCreateDialog}>+ New chore</button>` : ""}
      </div>

      ${this.isParent ? html`<div class="section-tabs" aria-label="Chore views">
        <button class=${this._tab === "assignments" ? "active" : ""} aria-pressed=${this._tab === "assignments"} @click=${() => (this._tab = "assignments")}>Assigned</button>
        <button class=${this._tab === "definitions" ? "active" : ""} aria-pressed=${this._tab === "definitions"} @click=${() => (this._tab = "definitions")}>Chore library</button>
      </div>` : ""}
      ${!this.isParent || this._tab === "assignments"
        ? html`
            <div class="toolbar">
              ${this.isParent ? html`<button class="link" @click=${this._generateOccurrences}>Generate upcoming</button>` : ""}
            </div>
            ${this.isParent
              ? this.assignableMemberIds.map((memberId) =>
                  this._renderChildSection(
                    memberId,
                    visibleAssignments.filter((a) => a.memberId === memberId),
                    visibleBounties.filter(({ acceptance }) => acceptance.memberId === memberId)
                  )
                )
              : !hasCurrentWork
                ? html`<div class="empty">All caught up! Check Extra jobs if you want to earn more.</div>`
                : html`
                    ${visibleAssignments.map((a) => this._renderAssignmentRow(a))}
                    ${visibleBounties.map(({ bounty, acceptance }) => this._renderBountyAcceptanceRow(bounty, acceptance))}
                  `}
          `
        : html`
            ${s.choreDefinitions.length === 0
              ? html`<div class="empty">No chores yet. Create your first one!</div>`
              : html`<div class="grid">${s.choreDefinitions.map((d) => this._renderDefinitionCard(d))}</div>`}
          `}

      <hustle-dialog
        heading=${this._dialogHeading()}
        .open=${this._dialog !== null}
        @hustle-dialog-closed=${() => (this._dialog = null)}
      >
        ${this._renderDialogContent()}
      </hustle-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-chores-view": HustleChoresView;
  }
}

