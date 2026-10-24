import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { hustleApi } from "../ha-api";
import type { Bounty, BountyAcceptance, ChoreDefinition, HustleState } from "../types";
import { formatCents } from "../utils/money";
import { memberName } from "../utils/members";
import { glassCardStyle, formStyles } from "../styles";
import "../components/hustle-dialog";
import "../components/hustle-countdown";

const ACCEPT_BADGE: Record<string, string> = {
  accepted: "info",
  submitted: "warning",
  completed: "success",
  abandoned: "error",
};

const HISTORY_STATUS_BADGE: Record<string, string> = {
  closed: "success",
  cancelled: "error",
  expired: "",
};

type DialogState = { type: "submit"; bountyId: string; memberId: string } | { type: "finalize"; bountyId: string } | null;

/** Bounties are never created from scratch here - they only ever come from
 * chores-view's "Make Bounty" (an unassigned chore definition) or "Convert
 * to Bounty" (an assigned chore gone overdue or manually converted)
 * actions. This view is purely about accepting/completing/managing bounties
 * that already exist. */
@customElement("hustle-bounties-view")
export class HustleBountiesView extends LitElement {
  @property({ attribute: false }) readOnly = false;
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;
  @property({ attribute: false }) effectiveMemberId!: string;
  @property({ attribute: false }) isParent!: boolean;
  /** Children a parent manages (or every active child if unrestricted) -
   * used to scope the acceptance list a parent sees on each card. Empty for
   * a child viewer. */
  @property({ attribute: false }) visibleMemberIds!: string[];

  @state() private _dialog: DialogState = null;
  @state() private _saving = false;

  private _availabilityTimer?: ReturnType<typeof setInterval>;

  connectedCallback(): void {
    super.connectedCallback();
    // Keep the available list current even when HA sends no state updates.
    this._availabilityTimer = setInterval(() => this.requestUpdate(), 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this._availabilityTimer);
  }

  // finalize form state
  @state() private _allocations: Record<string, string> = {};

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.kid-job { padding:24px; display:flex; flex-direction:column; height:100%; box-sizing:border-box; }
      .kid-job-top { display:flex; justify-content:space-between; align-items:center; color:#23765c; }
      .kid-job-top ha-icon { padding:12px; border-radius:14px; background:#e7f1eb; }
      .kid-job-top span { font-size:1.5rem; font-weight:750; color:var(--primary-text-color,#153d35); }
      .kid-job h2 { font-size:1.2rem; margin:20px 0 4px; }
      .kid-job .card-actions { margin-top:auto; padding-top:20px; }
      .kid-job button.primary { width:100%; min-height:52px; font-weight:700; border-radius:12px; }

      .kid-empty {
        padding: 48px 24px;
        text-align: center;
        border: 1px dashed var(--divider-color);
        border-radius: 20px;
      }
      .kid-empty ha-icon { --mdc-icon-size: 40px; color: var(--secondary-text-color); }
      .kid-empty h2 { font-size: 1.2rem; margin: 16px 0 8px; }
      .kid-empty p { margin: 0; line-height: 1.5; }
      .kid-intro { margin-bottom: 24px; line-height: 1.5; }

      .spread {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      ha-card.bounty-card {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .bounty-card header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .wanted-poster {
        position: relative;
        background:
          radial-gradient(ellipse at 25% 15%, rgba(139, 94, 52, 0.25), transparent 55%),
          radial-gradient(ellipse at 75% 85%, rgba(101, 67, 33, 0.25), transparent 55%),
          linear-gradient(135deg, #ecdfbd 0%, #dcc899 45%, #cbae7c 100%);
        border: 3px solid #4a2f1a;
        border-radius: 6px;
        padding: 14px 12px 12px;
        text-align: center;
        box-shadow:
          inset 0 0 22px rgba(74, 47, 26, 0.35),
          0 2px 6px rgba(0, 0, 0, 0.3);
      }
      .wanted-poster::before,
      .wanted-poster::after {
        content: "";
        position: absolute;
        top: 8px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #3a2414;
        box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.2);
      }
      .wanted-poster::before {
        left: 8px;
      }
      .wanted-poster::after {
        right: 8px;
      }
      .poster-title {
        font-family: Georgia, "Times New Roman", serif;
        font-weight: 900;
        font-size: 1.4rem;
        letter-spacing: 4px;
        text-transform: uppercase;
        color: #3a2414;
        border-bottom: 2px solid #4a2f1a;
        padding-bottom: 6px;
        margin-bottom: 10px;
      }
      .poster-photo {
        width: 110px;
        height: 110px;
        margin: 0 auto 10px;
        border: 2px solid #4a2f1a;
        background: #f3e9d2;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .poster-photo img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .poster-photo ha-icon {
        --mdc-icon-size: 40px;
        color: #8a6a42;
      }
      .poster-name {
        font-family: Georgia, "Times New Roman", serif;
        font-weight: 700;
        color: #3a2414;
        margin-bottom: 8px;
      }
      .poster-reward {
        font-family: Georgia, "Times New Roman", serif;
        font-weight: 900;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: #3a2414;
        border-top: 2px solid #4a2f1a;
        padding-top: 6px;
        font-size: 1.05rem;
      }
      .poster-amount {
        display: block;
        font-size: 1.3rem;
        color: #6b3e17;
      }
      .claimed-stamp {
        position: absolute;
        top: 46%;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-16deg);
        border: 4px double #a52822;
        border-radius: 6px;
        padding: 4px 14px;
        font-family: Georgia, "Times New Roman", serif;
        font-weight: 900;
        font-size: 1.5rem;
        letter-spacing: 3px;
        text-transform: uppercase;
        color: #a52822;
        opacity: 0.85;
        pointer-events: none;
        z-index: 1;
      }
      .payout-line {
        font-size: 1.1rem;
        font-weight: 700;
        color: var(--success-color, #43a047);
      }
      .payout-line .bonus {
        font-size: 0.7em;
        font-weight: 600;
        color: var(--accent-color, #ff9800);
        margin-left: 6px;
      }
      .acceptances {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .acceptance-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.88rem;
      }
      .card-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 4px;
      }
    `,
  ];

  /** For a child, only their own row (per the "full catalog, own history
   * only" decision); for a parent, every acceptance from a child they
   * manage - they need multi-child visibility to approve completions and
   * decide splits. */
  private _visibleAcceptances(b: Bounty): BountyAcceptance[] {
    if (this.isParent) {
      return b.acceptances.filter((a) => this.visibleMemberIds.includes(a.memberId));
    }
    return b.acceptances.filter((a) => a.memberId === this.effectiveMemberId);
  }

  private async _accept(bountyId: string): Promise<void> {
    await hustleApi.acceptBounty(this.hass, bountyId);
  }

  private _openSubmitDialog(bountyId: string, memberId: string): void {
    this._dialog = { type: "submit", bountyId, memberId };
  }

  private async _saveSubmit(): Promise<void> {
    if (this._dialog?.type !== "submit") return;
    this._saving = true;
    try {
      await hustleApi.submitBountyAcceptance(this.hass, this._dialog.bountyId, this._dialog.memberId);
      this._dialog = null;
    } finally {
      this._saving = false;
    }
  }

  private async _complete(bountyId: string, memberId: string): Promise<void> {
    await hustleApi.completeBountyAcceptance(this.hass, bountyId, memberId);
  }

  private async _close(bountyId: string): Promise<void> {
    await hustleApi.closeBounty(this.hass, bountyId);
  }

  private async _cancel(bountyId: string): Promise<void> {
    if (!window.confirm("Cancel this bounty?")) return;
    await hustleApi.cancelBounty(this.hass, bountyId);
  }

  private _openFinalizeDialog(bounty: Bounty): void {
    const completed = bounty.acceptances.filter(
      (a) => a.status === "completed" && this.visibleMemberIds.includes(a.memberId)
    );
    const allocations: Record<string, string> = {};
    for (const a of completed) {
      allocations[a.memberId] = ((a.payoutCents ?? 0) / 100).toFixed(2);
    }
    this._allocations = allocations;
    this._dialog = { type: "finalize", bountyId: bounty.bountyId };
  }

  private async _saveFinalize(): Promise<void> {
    if (this._dialog?.type !== "finalize") return;
    this._saving = true;
    try {
      const allocations: Record<string, number> = {};
      for (const [memberId, value] of Object.entries(this._allocations)) {
        allocations[memberId] = Math.round(Number(value) * 100) || 0;
      }
      await hustleApi.finalizeBountySplit(this.hass, this._dialog.bountyId, allocations);
      this._dialog = null;
    } finally {
      this._saving = false;
    }
  }

  /** Same cache-busting trick as chores-view's _imageSrc - the image is
   * always saved at the same per-chore URL, so the query param has to
   * change on every edit/regeneration or the browser just serves its
   * cached copy. */
  private _imageSrc(d: ChoreDefinition): string | null {
    if (!d.imagePath) return null;
    return `${d.imagePath}?v=${encodeURIComponent(d.updatedAt)}`;
  }

  private _posterImageSrc(b: Bounty): string | null {
    if (!b.sourceChoreDefinitionId) return null;
    const chore = this.hustleState.choreDefinitions.find((d) => d.definitionId === b.sourceChoreDefinitionId);
    return chore ? this._imageSrc(chore) : null;
  }

  private _renderCard(b: Bounty) {
    // Dynamic bounty sensors exist while open, and for a while after
    // closing too (see sensor.py's _bounty_is_board_visible) so a claimed
    // bounty can stay on the board with a "claimed" stamp until its
    // deadline - so status can legitimately be "open" or "closed" here.
    const myAcceptance = b.acceptances.find((a) => a.memberId === this.effectiveMemberId);
    const isClaimed = b.acceptances.some((a) => a.status === "completed");
    const canAccept = b.status === "open" && !myAcceptance;
    const canSubmit = b.status === "open" && myAcceptance && myAcceptance.status === "accepted";
    const visibleAcceptances = this._visibleAcceptances(b);
    const hasUnresolvedSplit =
      this.isParent &&
      b.status === "open" &&
      b.splitRule === "parent_decides" &&
      visibleAcceptances.some((a) => a.status === "completed" && a.payoutCents === null);
    const isOverduePenalty = b.originalAssigneeMemberId === this.effectiveMemberId;

    const posterImageSrc = this._posterImageSrc(b);
    if (!this.isParent) return html`<ha-card class="kid-job"><div class="kid-job-top"><ha-icon icon="mdi:briefcase-outline"></ha-icon><span>${formatCents(b.payoutCents)}</span></div><h2>${b.title}</h2><p class="muted">${b.splitRule === "equal_split" ? "Reward is shared between the kids who finish." : b.splitRule === "parent_decides" ? "A parent decides each person’s share." : "Complete this extra job to earn a reward."}</p><p class="small muted">Time left: <hustle-countdown .deadline=${b.deadlineAt}></hustle-countdown></p>${isOverduePenalty && b.overduePenaltyPct !== null ? html`<p class="small">Your overdue-task payout rule applies: ${b.overduePenaltyPct}%.</p>` : ""}<div class="card-actions">${canAccept ? html`<button class="primary" ?disabled=${this.readOnly} @click=${() => this._accept(b.bountyId)}>I’ll do this!</button>` : canSubmit ? html`<button class="primary" ?disabled=${this.readOnly} @click=${() => this._openSubmitDialog(b.bountyId,this.effectiveMemberId)}>I’m done!</button>` : html`<span class="badge">${myAcceptance?.status === "submitted" ? "Waiting for approval" : myAcceptance?.status === "completed" ? "Completed" : "No longer available"}</span>`}</div></ha-card>`;
    return html`
      <ha-card class="bounty-card">
        <div class="wanted-poster">
          ${isClaimed ? html`<div class="claimed-stamp">Claimed</div>` : ""}
          <div class="poster-title">Wanted</div>
          <div class="poster-photo">
            ${posterImageSrc ? html`<img src=${posterImageSrc} alt=${b.title} />` : html`<ha-icon icon="mdi:target"></ha-icon>`}
          </div>
          <div class="poster-name">${b.title}</div>
          <div class="poster-reward">Reward<span class="poster-amount">${formatCents(b.payoutCents)}</span></div>
        </div>
        <header>
          <span class="small muted">${b.splitRule.replace(/_/g, " ")}</span>
          <span>
            ${b.isRepeatable ? html`<span class="badge info">repeatable</span>` : ""}
            <span class="badge ${b.status === "open" ? "success" : ""}">${b.status}</span>
          </span>
        </header>
        <div class="payout-line">${formatCents(b.payoutCents)}</div>
        ${isOverduePenalty && b.overduePenaltyPct !== null
          ? html`<p class="muted small">
              This was your own overdue chore - completing it yourself pays ${b.overduePenaltyPct}% instead of the
              normal bounty reward.
            </p>`
          : ""}
        <div>Deadline: <hustle-countdown .deadline=${b.deadlineAt}></hustle-countdown></div>

        <div class="acceptances">
          ${visibleAcceptances.length === 0
            ? html`<span class="small muted">No one has accepted yet.</span>`
            : visibleAcceptances.map(
                (a) => html`
                  <div class="acceptance-row">
                    <span class="grow">${memberName(this.hustleState, a.memberId)}</span>
                    <span class="badge ${ACCEPT_BADGE[a.status] ?? ""}">${a.status}</span>
                    ${a.payoutCents !== null ? html`<span class="small" style="font-weight:600">${formatCents(a.payoutCents)}</span>` : ""}
                    ${this.isParent && a.status === "submitted"
                      ? html`<button class="link" @click=${() => this._complete(b.bountyId, a.memberId)}>Complete</button>`
                      : ""}
                  </div>
                `
              )}
        </div>

        <div class="card-actions">
          ${canAccept ? html`<button class="primary" ?disabled=${this.readOnly} @click=${() => this._accept(b.bountyId)}>${this.isParent ? "Accept bounty" : "I’ll do this!"}</button>` : ""}
          ${canSubmit
            ? html`<button class="primary" ?disabled=${this.readOnly} @click=${() => this._openSubmitDialog(b.bountyId, this.effectiveMemberId)}>I’m done!</button>`
            : ""}
          ${this.isParent && b.status === "open"
            ? html`<button class="link" @click=${() => this._close(b.bountyId)}>Close</button>`
            : ""}
          ${this.isParent && b.status === "open"
            ? html`<button class="link danger" @click=${() => this._cancel(b.bountyId)}>Cancel</button>`
            : ""}
          ${hasUnresolvedSplit ? html`<button class="link" @click=${() => this._openFinalizeDialog(b)}>Finalize split</button>` : ""}
        </div>
      </ha-card>
    `;
  }

  private _renderHistoryCard() {
    const history = this.hustleState.recentBountiesHistory;
    return html`
      <ha-card>
        <h3>Bounty history</h3>
        ${history.length === 0
          ? html`<div class="empty">No closed, cancelled, or expired bounties yet.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Payout</th>
                    <th>Completed by</th>
                  </tr>
                </thead>
                <tbody>
                  ${history.map((b) => {
                    const paidOut = b.acceptances.filter(
                      (a) =>
                        a.status === "completed" &&
                        a.payoutCents !== null &&
                        (this.isParent ? this.visibleMemberIds.includes(a.memberId) : a.memberId === this.effectiveMemberId)
                    );
                    return html`
                      <tr>
                        <td>${b.title}</td>
                        <td><span class="badge ${HISTORY_STATUS_BADGE[b.status] ?? ""}">${b.status}</span></td>
                        <td>${formatCents(b.payoutCents)}</td>
                        <td>
                          ${paidOut.length === 0
                            ? html`<span class="muted small">—</span>`
                            : paidOut
                                .map((a) => `${memberName(this.hustleState, a.memberId)} (${formatCents(a.payoutCents)})`)
                                .join(", ")}
                        </td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            `}
      </ha-card>
    `;
  }

  private _renderDialogContent() {
    const dialog = this._dialog;
    if (dialog === null) return html``;

    if (dialog.type === "submit") {
      return html`
        <p class="muted small">Submitting will notify a parent for review.</p>
        <div class="actions">
          <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._saveSubmit}>Submit</button>
        </div>
      `;
    }

    // finalize
    const bounty = this.hustleState.bounties.find((b) => b.bountyId === dialog.bountyId);
    const completed = bounty?.acceptances.filter((a) => a.status === "completed" && this.visibleMemberIds.includes(a.memberId)) ?? [];
    return html`
      <p class="muted small">Total payout available: ${formatCents(bounty?.payoutCents ?? 0)}</p>
      ${completed.map(
        (a) => html`
          <label>${memberName(this.hustleState, a.memberId)}</label>
          <input
            type="number"
            step="0.01"
            min="0"
            .value=${this._allocations[a.memberId] ?? "0.00"}
            @input=${(e: InputEvent) =>
              (this._allocations = { ...this._allocations, [a.memberId]: (e.target as HTMLInputElement).value })}
          />
        `
      )}
      <div class="actions">
        <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
        <button class="primary" ?disabled=${this._saving} @click=${this._saveFinalize}>Save split</button>
      </div>
    `;
  }

  private _dialogHeading(): string {
    const dialog = this._dialog;
    if (dialog === null) return "";
    if (dialog.type === "submit") return "Submit your work";
    return "Finalize payout split";
  }

  render() {
    const s = this.hustleState;
    // Cancelled/expired bounties never have a dynamic sensor entity, and
    // closed (claimed) ones drop off once their deadline passes (see
    // sensor.py's _bounty_is_board_visible) - they show up in the bounded
    // recent-bounties-history sensor instead once they're gone from here.
    //
    // Nobody sees a bounty before its available_at, parents included - the
    // board only ever shows what's actually postable/claimable right now.
    const now = Date.now();
    const visibleBounties = s.bounties.filter((b) =>
      new Date(b.availableAt).getTime() <= now &&
      (this.isParent || (
        b.status === "open" &&
        new Date(b.deadlineAt).getTime() >= now &&
        !b.acceptances.some((a) => a.memberId === this.effectiveMemberId)
      ))
    );
    return html`
      <h1>${this.isParent ? "Bounty Board" : "Extra jobs"}</h1>

      ${!this.isParent ? html`<p class="muted kid-intro">Pick an extra job to earn more. Jobs you take appear in My tasks on Today.</p>` : ""}

      ${visibleBounties.length === 0
        ? this.isParent
          ? html`<div class="empty">No open bounties right now.</div>`
          : html`<div class="kid-empty"><ha-icon icon="mdi:briefcase-outline"></ha-icon><h2>No extra jobs available</h2><p class="muted">Check back later for more ways to earn.</p></div>`
        : html`<div class="grid">${visibleBounties.map((b) => this._renderCard(b))}</div>`}

      ${this.isParent ? this._renderHistoryCard() : ""}

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
    "hustle-bounties-view": HustleBountiesView;
  }
}

