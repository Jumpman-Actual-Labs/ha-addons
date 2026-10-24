import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { hustleApi } from "../ha-api";
import type { HustleState } from "../types";
import { formatCents } from "../utils/money";
import { formatDate } from "../utils/time";
import { memberName } from "../utils/members";
import { glassCardStyle, formStyles } from "../styles";
import "../components/hustle-dialog";

@customElement("hustle-grades-view")
export class HustleGradesView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;

  @state() private _dialogOpen = false;
  @state() private _saving = false;
  @state() private _newSubjectName = "";

  // record-grade form state
  @state() private _memberId = "";
  @state() private _subjectId = "";
  @state() private _gradeLetter = "";
  @state() private _periodLabel = "";
  @state() private _note = "";

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      .spread {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      ha-card {
        padding: 16px;
        margin-bottom: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        font-size: 0.92rem;
      }
    `,
  ];

  private _openDialog(): void {
    const subjects = this.hustleState.subjects.filter((sub) => sub.active);
    const letters = this.hustleState.gradeScale;
    this._memberId = this.hustleState.members[0]?.memberId ?? "";
    this._subjectId = subjects[0]?.id ?? "";
    this._gradeLetter = letters[0]?.letter ?? "";
    this._periodLabel = "";
    this._note = "";
    this._dialogOpen = true;
  }

  private async _saveGrade(): Promise<void> {
    if (!this._memberId || !this._subjectId || !this._gradeLetter || !this._periodLabel.trim()) return;
    this._saving = true;
    try {
      await hustleApi.recordGrade(this.hass, {
        subject_id: this._subjectId,
        member_id: this._memberId,
        grade_letter: this._gradeLetter,
        period_label: this._periodLabel.trim(),
        note: this._note || null,
      });
      this._dialogOpen = false;
    } finally {
      this._saving = false;
    }
  }

  private async _addSubject(): Promise<void> {
    if (!this._newSubjectName.trim()) return;
    this._saving = true;
    try {
      await hustleApi.addSubject(this.hass, this._newSubjectName.trim());
      this._newSubjectName = "";
    } finally {
      this._saving = false;
    }
  }

  render() {
    const s = this.hustleState;
    const subjects = s.subjects.filter((sub) => sub.active);
    const letters = s.gradeScale;
    const allEntries = s.grades
      .flatMap((g) => g.recentGrades.map((e) => ({ ...e, memberId: g.memberId })))
      .sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));

    return html`
      <div class="spread">
        <h1>Grades</h1>
        <button class="primary" @click=${this._openDialog}>+ Record grade</button>
      </div>

      <ha-card>
        <h3>Subjects</h3>
        <div class="wrap">
          ${s.subjects.length === 0
            ? html`<span class="muted small">No subjects yet - add one below.</span>`
            : s.subjects.map(
                (sub) => html`<span class="badge ${sub.active ? "" : "muted"}">${sub.name}</span>`
              )}
        </div>
        <div class="row">
          <input
            .value=${this._newSubjectName}
            placeholder="New subject name"
            @input=${(e: InputEvent) => (this._newSubjectName = (e.target as HTMLInputElement).value)}
          />
          <button class="secondary" ?disabled=${this._saving} @click=${this._addSubject}>Add</button>
        </div>
      </ha-card>

      <ha-card>
        <h3>Grade scale</h3>
        <div class="wrap">
          ${letters.length === 0
            ? html`<span class="muted small">No grade scale configured yet.</span>`
            : letters.map((g) => html`<span class="badge info">${g.letter} = ${formatCents(g.valueCents)}</span>`)}
        </div>
      </ha-card>

      <ha-card>
        <h3>Grade history</h3>
        ${allEntries.length === 0
          ? html`<div class="empty">No grades recorded yet.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Student</th>
                    <th>Grade</th>
                    <th>Value</th>
                    <th>Period</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  ${allEntries.map(
                    (e) => html`
                      <tr>
                        <td>${e.subjectName}</td>
                        <td>${memberName(this.hustleState,e.memberId)}</td>
                        <td><span class="badge info">${e.gradeLetter}</span></td>
                        <td>${formatCents(e.gradeValueCents)}</td>
                        <td>${e.periodLabel}</td>
                        <td>${formatDate(e.enteredAt)}</td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
            `}
      </ha-card>

      <hustle-dialog heading="Record a grade" .open=${this._dialogOpen} @hustle-dialog-closed=${() => (this._dialogOpen = false)}>
        <label>Student</label>
        <select @change=${(e: Event) => (this._memberId = (e.target as HTMLSelectElement).value)}>
          ${s.members.map(
            (m) => html`<option value=${m.memberId} ?selected=${m.memberId === this._memberId}>${memberName(this.hustleState,m.memberId)}</option>`
          )}
        </select>
        <label>Subject</label>
        <select @change=${(e: Event) => (this._subjectId = (e.target as HTMLSelectElement).value)}>
          ${subjects.length === 0
            ? html`<option value="">No subjects yet - add one first</option>`
            : subjects.map((sub) => html`<option value=${sub.id} ?selected=${sub.id === this._subjectId}>${sub.name}</option>`)}
        </select>
        <label>Grade</label>
        <select @change=${(e: Event) => (this._gradeLetter = (e.target as HTMLSelectElement).value)}>
          ${letters.length === 0
            ? html`<option value="">No grades recorded yet</option>`
            : letters.map((g) => html`<option value=${g.letter} ?selected=${g.letter === this._gradeLetter}>${g.letter} (${formatCents(g.valueCents)})</option>`)}
        </select>
        <label>Period</label>
        <input placeholder="e.g. Q1 2026" .value=${this._periodLabel} @input=${(e: InputEvent) => (this._periodLabel = (e.target as HTMLInputElement).value)} />
        <label>Note (optional)</label>
        <input .value=${this._note} @input=${(e: InputEvent) => (this._note = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._dialogOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveGrade}>Save grade</button>
        </div>
      </hustle-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-grades-view": HustleGradesView;
  }
}
