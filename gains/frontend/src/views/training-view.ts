import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  gainsApi,
  serviceErrorMessage,
  trainingApi,
  trainingService,
  type HomeAssistant,
} from "../ha-api";
import type { GainsState } from "../types";
import type {
  BuildType,
  BuilderAnswers,
  TrainingProposal,
  TrainingSnapshot,
  TrainingPayload,
  TrainingProgram,
} from "../training-types";
import { programNeedsExercises } from "../program-review";
import type { ProgramPrescription } from "../training-types";
import { builderQuestions, effectiveAnswers } from "../builder-questions";
import { formStyles, glassCardStyle } from "../styles";
import "../components/builder-question";
import "../components/program-builder";
import { programDefaults, prepareProgramAnswers } from "../program-builder";
import "../components/proposal-editor";
import "../components/muscle-map";
import { BUILD_KINDS, showSession } from "../features";
@customElement("gains-training-view")
export class GainsTrainingView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;
  @property({ attribute: false }) snapshot!: TrainingSnapshot;
  @property() target?: string;
  @state() private kind: BuildType | null = null;
  @state() private answers: BuilderAnswers = {};
  @state() private step = 0;
  @state() private known: string[] = [];
  @state() private source: "wizard" | "geoffrey" = "wizard";
  @state() private proposal: TrainingProposal | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private editing: TrainingProgram | null = null;
  @state() private sharingProgram: TrainingProgram | null = null;
  @state() private shareBusy = false;
  @state() private respondBusy: string | null = null;
  private actorKey = "";
  static styles = [
    glassCardStyle,
    formStyles,
    css`
      :host {
        display: block;
        max-width: 680px;
      }
      ha-card {
        display: block;
        padding: 20px;
        margin: 16px 0;
      }
      .program-authoring > .builder-close { float: right; min-height: 38px; padding: 6px 12px; font-size: 12px; }
      .program-authoring > h1 { font-size: 28px; margin: 4px 0 14px; padding-right: 100px; }
      .quick {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .quick button {
        min-height: 64px;
      }
      progress {
        width: 100%;
        accent-color: var(--primary-color);
      }
      .session {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        border-bottom: 1px solid var(--divider-color);
        padding: 12px 0;
      }
      .upcoming {
        display: flex;
        gap: 12px;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        scrollbar-width: none;
        margin: 14px -20px 18px 0;
        padding: 2px 28px 8px 0;
      }
      .upcoming::-webkit-scrollbar {
        display: none;
      }
      .upcoming-card {
        flex: 0 0 min(78vw, 330px);
        scroll-snap-align: start;
        border: 1px solid var(--divider-color);
        border-radius: 18px;
        background: var(--secondary-background-color);
        padding: 16px;
        min-height: 245px;
        display: flex;
        flex-direction: column;
      }
      .upcoming-card h3 {
        margin: 7px 0;
        font-size: 22px;
      }
      .upcoming-card .start {
        margin-top: auto;
        width: 100%;
        min-height: 48px;
      }
      .upcoming-visual {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        min-height: 106px;
      }
      .upcoming-visual gains-muscle-map {
        width: 88px;
        flex: 0 0 88px;
      }
      .upcoming-visual ha-icon {
        --mdc-icon-size: 64px;
        color: var(--primary-color);
        margin: 22px 14px;
      }
      .eyebrow {
        color: var(--primary-color);
        font-size: 12px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .swipe-hint {
        color: var(--secondary-text-color);
        font-size: 12px;
      }
      details {
        margin: 14px 0;
      }
      summary {
        min-height: 44px;
        font-weight: 600;
      }
      .error {
        color: var(--error-color, #c33);
      }
      .muted {
        font-size: 13px;
      }
      ul.share-list {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
      }
      ul.share-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color);
      }
      ul.share-list li:last-child {
        border-bottom: none;
      }
    `,
  ];
  private key() {
    return `gains-builder:${this.snapshot?.viewer_profile_id}:${this.snapshot?.active_profile_id}`;
  }
  protected willUpdate() {
    const k = this.key();
    if (k !== this.actorKey) {
      this.actorKey = k;
      this.kind = null;
      this.proposal = null;
      this.editing = null;
      this.error = "";
      try {
        const saved = JSON.parse(sessionStorage.getItem(k) || "null");
        if (saved && BUILD_KINDS.includes(saved.kind)) {
          this.kind = saved.kind;
          this.answers = saved.answers ?? {};
          this.known = saved.known ?? [];
          this.step = saved.step ?? 0;
          this.source = saved.source ?? "wizard";
          this.proposal = saved.proposal ?? null;
        }
      } catch {
        /* Private browsing may disable storage. */
      }
    }
  }
  private persist() {
    try {
      sessionStorage.setItem(
        this.key(),
        JSON.stringify({
          kind: this.kind,
          answers: this.answers,
          known: this.known,
          step: this.step,
          source: this.source,
          proposal: this.proposal,
        }),
      );
    } catch {
      /* In-memory editing remains available. */
    }
  }
  public openBuilder(
    kind: BuildType,
    prefill: BuilderAnswers = {},
    source: "wizard" | "geoffrey" = "wizard",
  ) {
    this.kind = kind;
    this.source = source;
    this.error = "";
    this.proposal = null;
    this.step = 0;
    this.answers = {
      ...(this.gainsState.profile?.preferredDurationMinutes
        ? { duration: this.gainsState.profile.preferredDurationMinutes }
        : {}),
      ...prefill,
    };
    if (kind === "program") this.answers = programDefaults(this.answers, this.gainsState.profile?.preferredDurationMinutes ?? 45, this.gainsState.profile?.preferredSequencingPolicy ?? "completion");
    this.known = Object.keys(this.answers);
    this.persist();
  }
  public async review(kind: BuildType, payload: TrainingPayload) {
    this.kind = kind;
    this.error = "";
    try {
      this.proposal = await trainingService<TrainingProposal>(
        this.hass,
        "review_training",
        {
          request: { type: kind, source: "geoffrey", answers: {} },
          fields: payload,
          ...(this.target ? { target_profile_id: this.target } : {}),
        },
      );
      this.persist();
    } catch (e) {
      this.error = serviceErrorMessage(e);
    }
  }
  private refresh() {
    this.dispatchEvent(
      new CustomEvent("training-refresh", { bubbles: true, composed: true }),
    );
  }
  private scheduledLabel(value?: string): string {
    if (!value) return "Upcoming";
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(`${value}T12:00:00`));
  }
  private exerciseIds(
    session: import("../training-types").ProgramSession,
  ): string[] {
    const prescription = session.prescription as {
      exercises?: { exercise_id: string }[];
    };
    return (
      prescription.exercises?.map((exercise) => exercise.exercise_id) ?? []
    );
  }
  private async generate() {
    if (!this.kind || this.busy) return;
    const key = this.key();
    this.busy = true;
    this.error = "";
    try {
      const p = await trainingApi.build(
        this.hass,
        {
          type: this.kind,
          source: this.source,
          answers: effectiveAnswers(this.kind, this.kind === "program" ? prepareProgramAnswers(programDefaults(this.answers, this.gainsState.profile?.preferredDurationMinutes ?? 45, this.gainsState.profile?.preferredSequencingPolicy ?? "completion")) : this.answers),
        },
        this.target,
      );
      if (key === this.key()) {
        if (p.type === "program") {
          if (programNeedsExercises(p.payload as ProgramPrescription)) {
            throw new Error("A workout did not receive exercises and sets. Try creating your program again.");
          }
          await trainingApi.accept(this.hass, p.id, p.payload, this.target);
          if (key !== this.key()) return;
          this.proposal = null;
          this.kind = null;
          this.persist();
          await this.updateComplete;
          if (key === this.key()) this.dispatchEvent(new CustomEvent("gains-page-change", { bubbles: true, composed: true }));
          return;
        }
        this.proposal = p;
        this.persist();
        await this.updateComplete;
        if (key === this.key()) this.dispatchEvent(new CustomEvent("gains-page-change", { bubbles: true, composed: true }));
      }
    } catch (e) {
      this.error = serviceErrorMessage(e);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }
  private async accept() {
    if (!this.proposal || this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await trainingApi.accept(
        this.hass,
        this.proposal.id,
        this.proposal.payload,
        this.target,
      );
      this.proposal = null;
      this.kind = null;
      this.persist();
      this.refresh();
    } catch (e) {
      this.error = serviceErrorMessage(e);
    } finally {
      this.busy = false;
    }
  }
  private async programAction(
    p: TrainingProgram,
    action: string,
    fields: Record<string, unknown>,
  ) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const result = await trainingService<{ id?: string; type?: string }>(
        this.hass,
        "program_action",
        {
          id: p.id,
          action,
          fields,
          ...(this.target ? { target_profile_id: this.target } : {}),
        },
      );
      this.editing = null;
      this.refresh();
      if (action === "open_session" && result.id && result.type) {
        this.dispatchEvent(
          new CustomEvent("gains-switch-tab", {
            detail: {
              tab: result.type === "run" ? "runs" : "workouts",
              workoutId: result.type === "workout" ? result.id : undefined,
            },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } catch (e) {
      this.error = serviceErrorMessage(e);
    } finally {
      this.busy = false;
    }
  }
  private async shareProgram(targetProfileId: string) {
    const program = this.sharingProgram;
    if (!program) return;
    this.shareBusy = true;
    try {
      await gainsApi.shareProgram(this.hass, program.id, targetProfileId, this.target);
      this.sharingProgram = null;
    } catch (e) {
      this.error = serviceErrorMessage(e);
    } finally {
      this.shareBusy = false;
    }
  }
  private async respondShare(shareId: string, accept: boolean) {
    if (this.respondBusy) return;
    this.respondBusy = shareId;
    this.error = "";
    try {
      await gainsApi.respondShare(this.hass, shareId, accept, this.target);
      this.refresh();
    } catch (e) {
      this.error = serviceErrorMessage(e);
    } finally {
      this.respondBusy = null;
    }
  }
  private renderShareDialog() {
    const program = this.sharingProgram;
    const shareTargets = this.gainsState.profile?.shareTargets ?? [];
    return html`
      <ha-dialog
        .open=${program !== null}
        hideActions
        @closed=${() => (this.sharingProgram = null)}
      >
        ${program
          ? html`
              <h2>Share Program</h2>
              <p class="muted small">"${program.name}" &middot; they'll need to accept it first.</p>
              ${shareTargets.length === 0
                ? html`<p class="muted">No other Home Assistant members on this instance yet.</p>`
                : html`
                    <ul class="share-list">
                      ${shareTargets.map(
                        (p) => html`
                          <li>
                            <span>${p.displayName}</span>
                            <button
                              class="secondary"
                              ?disabled=${this.shareBusy}
                              @click=${() => this.shareProgram(p.profileId)}
                            >
                              Share
                            </button>
                          </li>
                        `
                      )}
                    </ul>
                  `}
            `
          : ""}
      </ha-dialog>
    `;
  }
  render() {
    if (!this.snapshot) return html`<p>Loading training tools…</p>`;
    const questions = this.kind
      ? builderQuestions(this.kind, this.answers).filter(
          (q) => !this.known.includes(q.id),
        )
      : [];
    const q = questions[this.step];
    return html`${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}${
      this.kind
        ? html`<ha-card class=${this.kind === "program" ? "program-authoring" : ""}
            ><button
              class="secondary builder-close"
              ?disabled=${this.busy}
              @click=${() => {
                this.kind = null;
                this.persist();
              }}
            >
              Close builder
            </button>
            <h1>${this.kind === "program" ? "Build your program" : `Build ${this.kind}`}</h1>
            ${
              this.proposal
                ? html`<p>${this.kind === "program" ? "Your workouts are ready. Review the schedule and add your program." : `Review and edit before adding this ${this.kind}.`}</p>
                    <p class="muted">${this.kind === "program" ? "Exercises, sets and weights are selected automatically. You can swap exercises on each workout before or during the session." : "Your edits are saved as explicit overrides."}</p>
                    <gains-proposal-editor
                      .hass=${this.hass}
                      .target=${this.target}
                      .units=${this.gainsState.profile?.units === "metric" ? "kg" : "lb"}
                      .automaticProgram=${this.kind === "program"}
                      .kind=${this.proposal.type}
                      .payload=${this.proposal.payload}
                      @proposal-change=${(e: CustomEvent<TrainingPayload>) => {
                        this.proposal = {
                          ...this.proposal!,
                          payload: e.detail,
                        };
                        this.persist();
                      }}
                    ></gains-proposal-editor>
                    <div class="actions">
                      <button
                        class="secondary"
                        @click=${() => {
                          this.proposal = null;
                          this.persist();
                        }}
                      >
                        Back to answers</button
                      ><button
                        class="primary"
                        ?disabled=${this.busy || (this.proposal.type === "program" && programNeedsExercises(this.proposal.payload as ProgramPrescription))}
                        @click=${this.accept}
                      >
                        ${this.busy ? "Saving…" : "Accept and add"}
                      </button>
                    </div>`
                : this.kind === "program"
                  ? html`<gains-program-builder .sequencingPolicy=${this.gainsState.profile?.preferredSequencingPolicy ?? "completion"} .answers=${this.answers} .stage=${this.step} .busy=${this.busy}
                      .athlete=${this.gainsState.profile?.displayName ?? ""}
                      .gym=${this.gainsState.gymProfiles.find(g => g.id === this.gainsState.profile?.gymProfileId)?.name ?? "No gym selected"}
                      @program-answers=${(e:CustomEvent<BuilderAnswers>) => {this.answers=e.detail;this.persist();}}
                      @program-stage=${(e:CustomEvent<number>) => {this.step=e.detail;this.persist();this.dispatchEvent(new CustomEvent("gains-page-change",{bubbles:true,composed:true}));}}
                      @generate-program=${this.generate}></gains-program-builder>`
                  : html`<p class="muted">
                      ${this.step + 1} of ${questions.length + 1} ·
                      ${this.gainsState.profile?.displayName}
                    </p>
                    <progress
                      max=${questions.length + 1}
                      value=${this.step + 1}
                    ></progress
                    >${
                      q
                        ? html`<gains-builder-question
                            .question=${q}
                            .value=${this.answers[q.id]}
                            .other=${String(this.answers[q.id + "_other"] ?? "")}
                            @answer=${(
                              e: CustomEvent<{ id: string; value: unknown }>,
                            ) => {
                              this.answers = {
                                ...this.answers,
                                [e.detail.id]: e.detail.value,
                              };
                              this.persist();
                            }}
                          ></gains-builder-question>`
                        : html`<h2>Ready for Geoffrey</h2>
                            ${Object.entries(
                              effectiveAnswers(this.kind, this.answers),
                            )
                              .filter(([k]) => k !== "existing")
                              .map(
                                ([k, v]) =>
                                  html`<p>
                                    <strong>${k.replaceAll("_", " ")}</strong> ·
                                    ${String(v)}
                                  </p>`,
                              )}
                            <p class="muted">
                              Your history and selected gym will be included
                              automatically.
                            </p>`
                    }
                    <div class="actions">
                      <button
                        class="secondary"
                        ?disabled=${this.step === 0 || this.busy}
                        @click=${() => {
                          this.step--;
                          this.persist();
                        }}
                      >
                        Back</button
                      >${
                        q
                          ? html`<button
                              class="primary"
                              ?disabled=${this.answers[q.id] === undefined || this.answers[q.id] === "" || (Array.isArray(this.answers[q.id]) && !(this.answers[q.id] as unknown[]).length) || (this.answers[q.id] === "Other" && !this.answers[q.id + "_other"])}
                              @click=${() => {
                                this.step++;
                                this.persist();
                              }}
                            >
                              Continue
                            </button>`
                          : html`<button
                              class="primary"
                              ?disabled=${this.busy}
                              @click=${this.generate}
                            >
                              ${this.busy ? "Geoffrey is building…" : "Generate proposal"}
                            </button>`
                      }
                    </div>`
            }</ha-card
          >`
        : html`<h1>Training</h1>
            <div class="quick">
              ${BUILD_KINDS.map((k) => html`<button class="primary" @click=${() => this.openBuilder(k)}>Build ${k}</button>`)}<button
                class="secondary"
                @click=${() => this.dispatchEvent(new CustomEvent("gains-switch-tab", { detail: { tab: "coach" }, bubbles: true, composed: true }))}
              >
                Ask Geoffrey
              </button>
            </div>
            ${(this.gainsState.profile?.incomingShares.filter(s=>s.kind!=="joint_workout").length ?? 0) > 0
              ? html`<h2>Shared with you</h2>
                  <ul class="share-list">
                    ${this.gainsState.profile!.incomingShares.filter(s=>s.kind!=="joint_workout").map(
                      (s) => html`<li>
                        <span
                          >${s.name}
                          <span class="muted small"
                            >&middot; ${s.kind} from ${s.fromDisplayName}</span
                          ></span
                        >
                        <span>
                          <button
                            class="secondary"
                            ?disabled=${this.respondBusy === s.id}
                            @click=${() => this.respondShare(s.id, true)}
                          >
                            Accept
                          </button>
                          <button
                            class="secondary"
                            ?disabled=${this.respondBusy === s.id}
                            @click=${() => this.respondShare(s.id, false)}
                          >
                            Decline
                          </button>
                        </span>
                      </li>`,
                    )}
                  </ul>`
              : ""}
            ${this.snapshot.proposals
              .filter((p) => !p.accepted_id)
              .slice(-3)
              .map(
                (p) =>
                  html`<p>
                    <button
                      class="secondary"
                      @click=${() => {
                        this.kind = p.type;
                        this.proposal = structuredClone(p);
                      }}
                    >
                      Review ${p.payload.name}
                    </button>
                  </p>`,
              )}
            <h2>Your programs</h2>
            ${
              this.snapshot.programs.length
                ? this.snapshot.programs.map(
                    (p) =>
                      html`<ha-card
                        ><h2>${p.name}</h2>
                        <p>${p.goal} · ${p.status}</p>
                        <p>
                          Week ${p.current_week ?? 1} · Ongoing ·
                          ${p.completed_sessions ?? 0} sessions completed
                        </p>
                        <h3>Upcoming training</h3>
                        <p class="swipe-hint">
                          Swipe to see the next sessions. Start any one whenever
                          you're ready.
                        </p>
                        <div
                          class="upcoming"
                          aria-label="Upcoming program sessions"
                        >
                          ${(p.upcoming_sessions ?? []).filter(showSession).map(
                            (s, index) =>
                              html` <article class="upcoming-card">
                                <span class="eyebrow"
                                  >${index === 0 ? "Next workout" : this.scheduledLabel(s.scheduled_date)}</span
                                >
                                <div class="upcoming-visual">
                                  <div>
                                    <h3>${s.name}</h3>
                                    <p>
                                      ${this.scheduledLabel(s.scheduled_date)} ·
                                      Week ${s.week_number}
                                    </p>
                                    <p class="muted">
                                      ${s.type === "run" ? "Run" : `${this.exerciseIds(s).length} exercises`}
                                    </p>
                                  </div>
                                  ${
                                  s.type === "run"
                                    ? html`<ha-icon icon="mdi:run"></ha-icon>`
                                    : html`<gains-muscle-map
                                        compact
                                        .exerciseIds=${this.exerciseIds(s)}
                                      ></gains-muscle-map>`
                                }
                                </div>
                                <button
                                  class="primary start"
                                  ?disabled=${this.busy || p.status !== "active"}
                                  @click=${() => this.programAction(p, "open_session", { session_id: s.id, start_now: true })}
                                >
                                  ${s.actual_id ? (s.actual_status === "active" ? "Resume" : "Open") : "Start now"}
                                </button>
                              </article>`,
                          )}
                        </div>
                        <div class="actions">
                          <button
                            class="secondary"
                            ?disabled=${this.busy}
                            @click=${() => (this.editing = structuredClone(p))}
                          >
                            Edit program</button
                          ><button
                            class="secondary"
                            ?disabled=${this.busy}
                            @click=${() => this.programAction(p, "status", { status: p.status === "active" ? "paused" : "active" })}
                          >
                            ${p.status === "active" ? "Pause" : "Activate"}</button
                          ><button
                            class="secondary"
                            ?disabled=${this.busy}
                            @click=${() => (this.sharingProgram = p)}
                          >
                            Share Program</button
                          ><button
                            class="secondary"
                            ?disabled=${this.busy}
                            @click=${() => {
                              if (
                                window.confirm(
                                  `Remove ${p.name}? Completed workouts and runs will remain in history.`,
                                )
                              )
                                void this.programAction(p, "delete", {});
                            }}
                          >
                            Remove program
                          </button>
                        </div>
                        <div class="actions">
                          <button
                            class="secondary"
                            ?disabled=${this.busy || p.status !== "active" || !!p.generated_weeks?.[String((p.current_week ?? 1) + 1)]}
                            @click=${() =>
                              void this.programAction(p, "generate_week", {
                                week_number: (p.current_week ?? 1) + 1,
                              })}
                          >
                            ${p.generated_weeks?.[String((p.current_week ?? 1) + 1)] ? "Next week generated" : "Generate next week with Geoffrey"}
                          </button>
                        </div>
                        ${[p.current_schedule ?? p.weeks[0]]
                          .filter(Boolean)
                          .map(
                            (w) =>
                              html`<details>
                                <summary>This week · ${w.focus}</summary>
                                ${w.sessions.map((s) => html`<div class="session"><span>${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][s.day]} · ${s.name}${s.completed_at ? " ✓" : ""}</span><button class="secondary" ?disabled=${this.busy || p.status !== "active"} @click=${() => this.programAction(p, "open_session", { session_id: s.id })}>${s.actual_id ? "Open" : ["rest", "recovery"].includes(s.type) ? "Done" : "Start"}</button></div>`)}
                              </details>`,
                          )}</ha-card
                      >`,
                  )
                : html`<p class="muted">
                    Build a program to organize your training across weeks.
                  </p>`
            }`
    }${
      this.editing
        ? html`<ha-card
            ><h2>Edit ${this.editing.name}</h2>
            <gains-proposal-editor
              .hass=${this.hass}
              .target=${this.target}
              kind="program"
              .payload=${this.editing}
              @proposal-change=${(e: CustomEvent<TrainingPayload>) => (this.editing = { ...this.editing!, ...e.detail })}
            ></gains-proposal-editor>
            <div class="actions">
              <button class="secondary" @click=${() => (this.editing = null)}>
                Cancel</button
              ><button
                class="primary"
                ?disabled=${this.busy}
                @click=${() => this.programAction(this.editing!, "update", { revision: this.editing!.revision, payload: this.editing })}
              >
                Save program
              </button>
            </div></ha-card
          >`
        : ""
    }${this.renderShareDialog()}`;
  }
}
