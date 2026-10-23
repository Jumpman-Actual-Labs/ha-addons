import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HaUserSummary, HomeAssistant } from "../ha-api";
import { financeApi } from "../ha-api";
import type { FinanceState, IncomeSource, Member, PayFrequency } from "../types";
import { money, signedMoney } from "../format";
import { glassCardStyle, bankingStyle } from "../styles";
import { MONTHLY_PAY_MULTIPLIER } from "../pay-period";
import "../components/finance-dialog";

const PAY_FREQUENCIES: { value: PayFrequency; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "semi_monthly", label: "Semi-monthly (two days a month)" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "weekly", label: "Weekly" },
];

function monthlyTotal(payAmount: number, frequency: PayFrequency): number {
  return payAmount * MONTHLY_PAY_MULTIPLIER[frequency];
}

function payAmountFromMonthly(monthlyAmount: number, frequency: PayFrequency): number {
  return monthlyAmount / MONTHLY_PAY_MULTIPLIER[frequency];
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface PayCycleDraft {
  frequency: PayFrequency;
  dayA: string;
  dayB: string;
  anchorDate: string;
}

function defaultPayCycle(): PayCycleDraft {
  return { frequency: "monthly", dayA: "15", dayB: "", anchorDate: today() };
}

@customElement("finance-members-view")
export class FinanceMembersView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) financeState!: FinanceState;

  // Add member dialog
  @state() private _dialogOpen = false;
  @state() private _name = "";
  @state() private _income = "";
  @state() private _notes = "";
  @state() private _payCycle: PayCycleDraft = defaultPayCycle();
  @state() private _haUserId = "";
  @state() private _saving = false;
  @state() private _deleteError = "";

  // Edit member dialog (name/notes/pay cycle - not income, that has its own flow)
  @state() private _editOpen = false;
  @state() private _editMemberId = "";
  @state() private _editName = "";
  @state() private _editNotes = "";
  @state() private _editPayCycle: PayCycleDraft = defaultPayCycle();
  @state() private _editHaUserId = "";

  // HA users, for linking a member to an account (admin-only feature)
  @state() private _haUsers: HaUserSummary[] = [];
  private _haUsersLoaded = false;

  // Update income dialog
  @state() private _incomeDialogOpen = false;
  @state() private _incomeMemberId = "";
  @state() private _incomeMemberName = "";
  @state() private _incomeMonth = currentMonth();
  @state() private _incomeAmount = "";

  // Income sources dialog (multiple named streams per member, each with its
  // own pay cycle - informational/for its own next-payday, never used for
  // pay-period or bill-timing math, which stays driven by the member's own
  // schedule above)
  @state() private _sourcesDialogOpen = false;
  @state() private _sourcesMemberId = "";
  @state() private _sourcesMemberName = "";
  @state() private _newSourceName = "";
  @state() private _newSourcePayAmount = "";
  @state() private _newSourcePayCycle: PayCycleDraft = defaultPayCycle();
  @state() private _editingSourceId = "";
  @state() private _editSourceName = "";
  @state() private _editSourcePayAmount = "";
  @state() private _editSourcePayCycle: PayCycleDraft = defaultPayCycle();
  @state() private _sourcesError = "";

  static styles = [glassCardStyle, css`
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 16px;
    }
    button.primary {
      background: var(--primary-color, #03a9f4);
      color: var(--text-primary-color, #fff);
      border: none;
      border-radius: 8px;
      padding: 10px 16px;
      font-size: 0.95rem;
      cursor: pointer;
    }
    button.secondary {
      background: none;
      border: 1px solid var(--divider-color, #e0e0e0);
      border-radius: 8px;
      padding: 10px 16px;
      cursor: pointer;
    }
    button.link {
      background: none;
      border: none;
      color: var(--primary-color, #03a9f4);
      cursor: pointer;
      padding: 4px 0;
    }
    .error {
      color: var(--error-color, #c62828);
      font-size: 0.85rem;
      margin: 0 0 12px;
    }
    ha-card {
      padding: 16px;
      margin-bottom: 12px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
    }
    .card-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: var(--secondary-text-color, #727272);
      margin: 12px 0 4px;
    }
    input,
    select {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--divider-color, #e0e0e0);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color, #212121);
      font-size: 1rem;
    }
    .day-inputs {
      display: flex;
      gap: 8px;
    }
    .pay-total {
      font-size: 0.85rem;
      color: var(--secondary-text-color, #727272);
      margin: 4px 0 0;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    .source-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
    }
    .source-row:last-of-type {
      border-bottom: none;
    }
    .source-name {
      flex: 1;
    }
    .source-frequency {
      font-size: 0.8rem;
      color: var(--secondary-text-color, #727272);
    }
    .source-amount {
      color: var(--secondary-text-color, #727272);
    }
    .source-total {
      font-weight: 600;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--divider-color, #e0e0e0);
      display: flex;
      justify-content: space-between;
    }
    .add-source,
    .source-edit {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--divider-color, #e0e0e0);
    }
  `, bankingStyle];

  private get _isAdmin(): boolean {
    return this.hass.user?.is_admin ?? false;
  }

  private _isSelf(member: Member): boolean {
    return !!member.haUserId && member.haUserId === this.hass.user?.id;
  }

  private _canSeeIncome(member: Member): boolean {
    return this._isAdmin || this._isSelf(member);
  }

  updated(): void {
    if (this._isAdmin && !this._haUsersLoaded) {
      this._haUsersLoaded = true;
      financeApi.listHaUsers(this.hass).then((users) => (this._haUsers = users));
    }
  }

  private _haUserName(userId: string | null): string {
    if (!userId) return "Not linked";
    return this._haUsers.find((u) => u.id === userId)?.name ?? userId;
  }

  // ------------------------------------------------------------ add member

  private _openDialog(): void {
    this._name = "";
    this._income = "";
    this._notes = "";
    this._payCycle = defaultPayCycle();
    this._haUserId = "";
    this._dialogOpen = true;
  }

  private async _save(): Promise<void> {
    if (!this._name.trim()) return;
    this._saving = true;
    try {
      await financeApi.addMember(
        this.hass,
        this._name.trim(),
        monthlyTotal(Number(this._income) || 0, this._payCycle.frequency),
        this._notes,
        this._payCycleServiceFields(this._payCycle),
        this._haUserId
      );
      this._dialogOpen = false;
    } finally {
      this._saving = false;
    }
  }

  // ----------------------------------------------------------- edit member

  private _openEdit(memberId: string): void {
    const member = this.financeState.members.find((m) => m.memberId === memberId);
    if (!member) return;
    this._editMemberId = memberId;
    this._editName = member.name;
    this._editNotes = member.notes;
    this._editPayCycle = {
      frequency: member.payFrequency,
      dayA: String(member.payDays[0] ?? "15"),
      dayB: String(member.payDays[1] ?? ""),
      anchorDate: member.payAnchorDate ?? today(),
    };
    this._editHaUserId = member.haUserId ?? "";
    this._editOpen = true;
  }

  private async _saveEdit(): Promise<void> {
    if (!this._editMemberId) return;
    this._saving = true;
    try {
      await financeApi.editMember(this.hass, this._editMemberId, {
        name: this._editName.trim(),
        notes: this._editNotes,
        ...this._payCycleServiceFields(this._editPayCycle),
        ...(this._isAdmin ? { ha_user_id: this._editHaUserId } : {}),
      });
      this._editOpen = false;
    } finally {
      this._saving = false;
    }
  }

  private async _deleteMember(memberId: string): Promise<void> {
    this._deleteError = "";
    try {
      await financeApi.deleteMember(this.hass, memberId);
    } catch (e) {
      this._deleteError = (e as { message?: string })?.message || "Failed to remove member.";
    }
  }

  private _payCycleServiceFields(draft: PayCycleDraft) {
    if (draft.frequency === "monthly") {
      return { pay_frequency: draft.frequency, pay_days: [Number(draft.dayA) || 1] };
    }
    if (draft.frequency === "semi_monthly") {
      return {
        pay_frequency: draft.frequency,
        pay_days: [Number(draft.dayA) || 1, Number(draft.dayB) || 15],
      };
    }
    return { pay_frequency: draft.frequency, pay_anchor_date: draft.anchorDate };
  }

  // ---------------------------------------------------------------- income

  private _openIncomeDialog(memberId: string, memberName: string, currentIncome: number): void {
    this._incomeMemberId = memberId;
    this._incomeMemberName = memberName;
    this._incomeMonth = currentMonth();
    this._incomeAmount = String(currentIncome);
    this._incomeDialogOpen = true;
  }

  private async _saveIncome(): Promise<void> {
    if (!this._incomeMemberId || !this._incomeMonth) return;
    this._saving = true;
    try {
      await financeApi.updateIncome(
        this.hass,
        this._incomeMemberId,
        this._incomeMonth,
        Number(this._incomeAmount) || 0
      );
      this._incomeDialogOpen = false;
    } finally {
      this._saving = false;
    }
  }

  // ---------------------------------------------------------- income sources

  private _openSourcesDialog(memberId: string, memberName: string): void {
    this._sourcesMemberId = memberId;
    this._sourcesMemberName = memberName;
    this._newSourceName = "";
    this._newSourcePayAmount = "";
    this._newSourcePayCycle = defaultPayCycle();
    this._editingSourceId = "";
    this._sourcesError = "";
    this._sourcesDialogOpen = true;
  }

  private get _currentMember(): Member | undefined {
    return this.financeState.members.find((m) => m.memberId === this._sourcesMemberId);
  }

  private get _currentSources(): IncomeSource[] {
    return this._currentMember?.incomeSources ?? [];
  }

  private async _addSource(): Promise<void> {
    if (!this._newSourceName.trim()) return;
    this._sourcesError = "";
    this._saving = true;
    try {
      // The member may already have a single legacy income figure (set via
      // the old "Update Income" flow, before this member had any named
      // sources). Once a source exists, the backend sums sources instead of
      // using that legacy figure - so carry it forward as a first source
      // here, rather than silently dropping it the moment a second source
      // is added.
      const legacyIncome = this._currentMember?.income ?? 0;
      if (this._currentSources.length === 0 && legacyIncome > 0) {
        await financeApi.addIncomeSource(this.hass, this._sourcesMemberId, "Primary income", legacyIncome, {
          pay_frequency: "monthly",
        });
      }
      await financeApi.addIncomeSource(
        this.hass,
        this._sourcesMemberId,
        this._newSourceName.trim(),
        monthlyTotal(Number(this._newSourcePayAmount) || 0, this._newSourcePayCycle.frequency),
        this._payCycleServiceFields(this._newSourcePayCycle)
      );
      this._newSourceName = "";
      this._newSourcePayAmount = "";
      this._newSourcePayCycle = defaultPayCycle();
    } catch (e) {
      this._sourcesError = (e as { message?: string })?.message || "Failed to add income source.";
    } finally {
      this._saving = false;
    }
  }

  private _startEditSource(source: IncomeSource): void {
    this._editingSourceId = source.id;
    this._editSourceName = source.name;
    this._editSourcePayCycle = {
      frequency: source.payFrequency,
      dayA: String(source.payDays[0] ?? "15"),
      dayB: String(source.payDays[1] ?? ""),
      anchorDate: source.payAnchorDate ?? today(),
    };
    this._editSourcePayAmount = String(
      Math.round(payAmountFromMonthly(source.amount, source.payFrequency) * 100) / 100
    );
  }

  private async _saveEditSource(): Promise<void> {
    if (!this._editingSourceId || !this._editSourceName.trim()) return;
    this._sourcesError = "";
    this._saving = true;
    try {
      await financeApi.editIncomeSource(this.hass, this._sourcesMemberId, this._editingSourceId, {
        name: this._editSourceName.trim(),
        amount: monthlyTotal(Number(this._editSourcePayAmount) || 0, this._editSourcePayCycle.frequency),
        ...this._payCycleServiceFields(this._editSourcePayCycle),
      });
      this._editingSourceId = "";
    } catch (e) {
      this._sourcesError = (e as { message?: string })?.message || "Failed to update income source.";
    } finally {
      this._saving = false;
    }
  }

  private async _deleteSource(sourceId: string): Promise<void> {
    this._sourcesError = "";
    try {
      await financeApi.deleteIncomeSource(this.hass, this._sourcesMemberId, sourceId);
      if (this._editingSourceId === sourceId) this._editingSourceId = "";
    } catch (e) {
      this._sourcesError = (e as { message?: string })?.message || "Failed to remove income source.";
    }
  }

  // -------------------------------------------------------------- shared UI

  private _renderHaUserField(value: string, onChange: (next: string) => void) {
    return html`
      <label>Linked HA user (lets that person see their own income)</label>
      <select @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="" ?selected=${!value}>Not linked</option>
        ${this._haUsers.map(
          (u) => html`<option value=${u.id} ?selected=${u.id === value}>${u.name}</option>`
        )}
      </select>
    `;
  }

  private _renderPayCycleFields(
    draft: PayCycleDraft,
    onChange: (next: PayCycleDraft) => void
  ) {
    return html`
      <label>Pay frequency</label>
      <select
        @change=${(e: Event) =>
          onChange({ ...draft, frequency: (e.target as HTMLSelectElement).value as PayFrequency })}
      >
        ${PAY_FREQUENCIES.map(
          (f) => html`<option value=${f.value} ?selected=${f.value === draft.frequency}>${f.label}</option>`
        )}
      </select>

      ${draft.frequency === "monthly"
        ? html`
            <label>Day of month paid</label>
            <input
              type="number"
              min="1"
              max="31"
              .value=${draft.dayA}
              @input=${(e: InputEvent) => onChange({ ...draft, dayA: (e.target as HTMLInputElement).value })}
            />
          `
        : ""}
      ${draft.frequency === "semi_monthly"
        ? html`
            <label>Days of month paid</label>
            <div class="day-inputs">
              <input
                type="number"
                min="1"
                max="31"
                .value=${draft.dayA}
                @input=${(e: InputEvent) => onChange({ ...draft, dayA: (e.target as HTMLInputElement).value })}
              />
              <input
                type="number"
                min="1"
                max="31"
                .value=${draft.dayB}
                @input=${(e: InputEvent) => onChange({ ...draft, dayB: (e.target as HTMLInputElement).value })}
              />
            </div>
          `
        : ""}
      ${draft.frequency === "weekly" || draft.frequency === "biweekly"
        ? html`
            <label>A known pay date (used to calculate the schedule)</label>
            <input
              type="date"
              .value=${draft.anchorDate}
              @input=${(e: InputEvent) => onChange({ ...draft, anchorDate: (e.target as HTMLInputElement).value })}
            />
          `
        : ""}
    `;
  }

  render() {
    return html`
      <div class="toolbar">
        <button class="primary" @click=${this._openDialog}>Add Member</button>
      </div>
      ${this._deleteError ? html`<p class="error">${this._deleteError}</p>` : ""}

      ${this.financeState.members.map(
        (m) => html`
          <ha-card>
            <div class="row"><strong>${m.name}</strong></div>
            <div class="row"><span>Shared budget income split</span><span>${m.responsibilityPct.toFixed(1)}%</span></div>
            <div class="row"><span>Monthly budget responsibility</span><span>${money(m.budgetResponsibleAmount)}</span></div>
            <div class="row"><span>Bill responsibility</span><span>${money(m.responsibleAmount)}</span></div>
            <div class="row"><span>Actually paid</span><span>${money(m.actuallyPaid)}</span></div>
            <div class="row"><span>Settlement balance</span><span>${signedMoney(m.settlementBalance)}</span></div>
            <div class="row">
              <span>Pay schedule</span>
              <span>${PAY_FREQUENCIES.find((f) => f.value === m.payFrequency)?.label}</span>
            </div>
            ${m.nextPayDate
              ? html`<div class="row"><span>Next pay date</span><span>${m.nextPayDate}</span></div>`
              : ""}
            ${m.notes ? html`<div class="row"><span>Notes</span><span>${m.notes}</span></div>` : ""}
            ${this._isAdmin
              ? html`<div class="row"><span>Linked account</span><span>${this._haUserName(m.haUserId)}</span></div>`
              : ""}
            <div class="card-actions">
              <button class="secondary" @click=${() => this._openEdit(m.memberId)}>Edit</button>
              ${this._canSeeIncome(m)
                ? html`
                    <button
                      class="secondary"
                      @click=${() => this._openSourcesDialog(m.memberId, m.name)}
                    >
                      Income Sources
                    </button>
                  `
                : ""}
              ${this._canSeeIncome(m) && m.incomeSources.length === 0
                ? html`
                    <button
                      class="secondary"
                      @click=${() => this._openIncomeDialog(m.memberId, m.name, m.income)}
                    >
                      Update Income
                    </button>
                  `
                : ""}
              <button class="link" @click=${() => this._deleteMember(m.memberId)}>Remove</button>
            </div>
          </ha-card>
        `
      )}

      <finance-dialog
        heading="Add Household Member"
        .open=${this._dialogOpen}
        @finance-dialog-closed=${() => (this._dialogOpen = false)}
      >
        <label>Name</label>
        <input .value=${this._name} @input=${(e: InputEvent) => (this._name = (e.target as HTMLInputElement).value)} />
        <label>Pay</label>
        <input
          type="number"
          step="0.01"
          .value=${this._income}
          @input=${(e: InputEvent) => (this._income = (e.target as HTMLInputElement).value)}
        />
        ${this._renderPayCycleFields(this._payCycle, (next) => (this._payCycle = next))}
        <p class="pay-total">
          ${money(monthlyTotal(Number(this._income) || 0, this._payCycle.frequency))} / month
        </p>
        <label>Notes</label>
        <input .value=${this._notes} @input=${(e: InputEvent) => (this._notes = (e.target as HTMLInputElement).value)} />
        ${this._isAdmin ? this._renderHaUserField(this._haUserId, (v) => (this._haUserId = v)) : ""}
        <div class="actions">
          <button class="secondary" @click=${() => (this._dialogOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._save}>Save</button>
        </div>
      </finance-dialog>

      <finance-dialog
        heading="Edit Member"
        .open=${this._editOpen}
        @finance-dialog-closed=${() => (this._editOpen = false)}
      >
        <label>Name</label>
        <input .value=${this._editName} @input=${(e: InputEvent) => (this._editName = (e.target as HTMLInputElement).value)} />
        ${this._renderPayCycleFields(this._editPayCycle, (next) => (this._editPayCycle = next))}
        <label>Notes</label>
        <input .value=${this._editNotes} @input=${(e: InputEvent) => (this._editNotes = (e.target as HTMLInputElement).value)} />
        ${this._isAdmin
          ? this._renderHaUserField(this._editHaUserId, (v) => (this._editHaUserId = v))
          : ""}
        <div class="actions">
          <button class="secondary" @click=${() => (this._editOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveEdit}>Save</button>
        </div>
      </finance-dialog>

      <finance-dialog
        heading="Update Income - ${this._incomeMemberName}"
        .open=${this._incomeDialogOpen}
        @finance-dialog-closed=${() => (this._incomeDialogOpen = false)}
      >
        <label>Month</label>
        <input
          type="month"
          .value=${this._incomeMonth}
          @input=${(e: InputEvent) => (this._incomeMonth = (e.target as HTMLInputElement).value)}
        />
        <label>Income for that month</label>
        <input
          type="number"
          step="0.01"
          .value=${this._incomeAmount}
          @input=${(e: InputEvent) => (this._incomeAmount = (e.target as HTMLInputElement).value)}
        />
        <div class="actions">
          <button class="secondary" @click=${() => (this._incomeDialogOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveIncome}>Save</button>
        </div>
      </finance-dialog>

      <finance-dialog
        heading="Income Sources - ${this._sourcesMemberName}"
        .open=${this._sourcesDialogOpen}
        @finance-dialog-closed=${() => (this._sourcesDialogOpen = false)}
      >
        ${this._sourcesError ? html`<p class="error">${this._sourcesError}</p>` : ""}
        ${this._currentSources.length === 0
          ? html`<p class="pay-total">No income sources yet. Add one below.</p>`
          : this._currentSources.map((s) =>
              this._editingSourceId === s.id
                ? html`
                    <div class="source-edit">
                      <label>Source name</label>
                      <input
                        .value=${this._editSourceName}
                        @input=${(e: InputEvent) =>
                          (this._editSourceName = (e.target as HTMLInputElement).value)}
                      />
                      <label>Pay amount</label>
                      <input
                        type="number"
                        step="0.01"
                        .value=${this._editSourcePayAmount}
                        @input=${(e: InputEvent) =>
                          (this._editSourcePayAmount = (e.target as HTMLInputElement).value)}
                      />
                      ${this._renderPayCycleFields(
                        this._editSourcePayCycle,
                        (next) => (this._editSourcePayCycle = next)
                      )}
                      <p class="pay-total">
                        ${money(
                          monthlyTotal(
                            Number(this._editSourcePayAmount) || 0,
                            this._editSourcePayCycle.frequency
                          )
                        )} / month
                      </p>
                      <div class="actions">
                        <button class="secondary" @click=${() => (this._editingSourceId = "")}>
                          Cancel
                        </button>
                        <button
                          class="primary"
                          ?disabled=${this._saving}
                          @click=${this._saveEditSource}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  `
                : html`
                    <div class="source-row">
                      <span class="source-name"
                        >${s.name}
                        <span class="source-frequency"
                          >(${PAY_FREQUENCIES.find((f) => f.value === s.payFrequency)?.label}${s.nextPayDate
                            ? html` · next ${s.nextPayDate}`
                            : ""})</span
                        ></span
                      >
                      <span class="source-amount">${money(s.amount)} / mo</span>
                      <button class="link" @click=${() => this._startEditSource(s)}>Edit</button>
                      <button class="link" @click=${() => this._deleteSource(s.id)}>Remove</button>
                    </div>
                  `
            )}
        ${this._currentSources.length > 0
          ? html`
              <div class="source-total">
                <span>Total</span>
                <span>${money(this._currentSources.reduce((sum, s) => sum + s.amount, 0))} / mo</span>
              </div>
            `
          : ""}

        <div class="add-source">
          <label>Source name</label>
          <input
            .value=${this._newSourceName}
            @input=${(e: InputEvent) => (this._newSourceName = (e.target as HTMLInputElement).value)}
          />
          <label>Pay amount</label>
          <input
            type="number"
            step="0.01"
            .value=${this._newSourcePayAmount}
            @input=${(e: InputEvent) =>
              (this._newSourcePayAmount = (e.target as HTMLInputElement).value)}
          />
          ${this._renderPayCycleFields(
            this._newSourcePayCycle,
            (next) => (this._newSourcePayCycle = next)
          )}
          <p class="pay-total">
            ${money(
              monthlyTotal(Number(this._newSourcePayAmount) || 0, this._newSourcePayCycle.frequency)
            )} / month
          </p>
          <div class="actions">
            <button class="secondary" ?disabled=${this._saving} @click=${this._addSource}>
              Add source
            </button>
          </div>
        </div>

        <div class="actions">
          <button class="primary" @click=${() => (this._sourcesDialogOpen = false)}>Done</button>
        </div>
      </finance-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-members-view": FinanceMembersView;
  }
}
