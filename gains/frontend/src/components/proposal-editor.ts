import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { EXERCISE_LIBRARY, RUN_TYPES } from "../types";
import { formStyles } from "../styles";
import { programNeedsExercises } from "../program-review";
import { trainingApi, type HomeAssistant } from "../ha-api";
import type {
  BuildType,
  TrainingPayload,
  WorkoutPrescription,
  RunPrescription,
  ProgramPrescription,
} from "../training-types";
import "./muscle-map";
const days = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
@customElement("gains-proposal-editor")
export class GainsProposalEditor extends LitElement {
  @property({ attribute: false }) payload!: TrainingPayload;
  @property() kind: BuildType = "workout";
  @property({ type: Boolean }) automaticProgram = false;
  @property({ attribute: false }) hass!: HomeAssistant;
  @property() target?: string;
  @property() units = "lb";
  @state() private busy = false;
  @state() private error = "";
  static styles = [
    formStyles,
    css`
      :host {
        display: block;
      }
      details {
        border: 1px solid var(--divider-color);
        border-radius: 12px;
        padding: 12px;
        margin: 12px 0;
      }
      summary {
        cursor: pointer;
        min-height: 44px;
        font-weight: 600;
      }
      .auto-session { padding: 16px; margin: 12px 0; border: 1px solid var(--divider-color); border-radius: 16px; }
      .auto-session h3 { margin: 0 0 12px; font-size: 17px; }
      .auto-session ul { list-style: none; padding: 0; margin: 0; }
      .auto-session li { padding: 10px 0; border-bottom: 1px solid var(--divider-color); }
      .auto-session li:last-child { border-bottom: 0; }
      .auto-session li strong { display: block; font-size: 14px; }
      .auto-session small { display: block; margin-top: 4px; }
      .set {
        display: grid;
        grid-template-columns: 1fr 1fr 44px;
        gap: 8px;
        align-items: end;
      }
      button {
        min-height: 44px;
      }
      .row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .row > * {
        flex: 1;
      }
      small {
        color: var(--secondary-text-color);
      }
      .error {
        color: var(--error-color, #c33);
      }
      input,
      select {
        min-width: 0;
      }
      gains-muscle-map {
        float: right;
        width: 45px;
        --gains-compact-muscle-height: 62px;
        --gains-compact-muscle-width: 40px;
      }
    `,
  ];
  private change() {
    this.dispatchEvent(
      new CustomEvent("proposal-change", {
        detail: structuredClone(this.payload),
      }),
    );
    this.requestUpdate();
  }
  private numeric(e: Event) {
    return Number((e.target as HTMLInputElement).value);
  }
  private async regenerate(
    kind: BuildType,
    payload: TrainingPayload,
    apply: (p: TrainingPayload) => void,
    extra: Record<string, unknown> = {},
  ) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const p = await trainingApi.build(
        this.hass,
        {
          type: kind,
          source: "wizard",
          answers: {
            existing: payload,
            instructions:
              "Regenerate only this item. Preserve its purpose and fit the athlete's current workload.",
            ...extra,
          },
        },
        this.target,
      );
      apply(p.payload);
      this.change();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }
  private workout(p: WorkoutPrescription) {
    return html`${p.planning?.estimated_duration_minutes ? html`<p><small>Generated estimate: ${p.planning.estimated_duration_minutes} minutes including warmup, rests and transitions. Your edits may change timing.</small></p>` : ""}
      ${p.planning?.warnings?.includes("inventory_not_configured") ? html`<p><small>No gym inventory is configured. Review the estimated loads before accepting.</small></p>` : ""}
      ${p.planning?.warnings?.includes("recovery_conflict") ? html`<p><small>Recent logged work suggests lower recovery. This plan keeps your split and reduces the number of sets.</small></p>` : ""}
      ${p.exercises.map(
        (ex, i) =>
          html`<details>
            <summary>
              <gains-muscle-map
                compact
                .exerciseIds=${[ex.exercise_id]}
              ></gains-muscle-map
              >${EXERCISE_LIBRARY.find((e) => e.id === ex.exercise_id)?.name ?? ex.exercise_id}<br /><small
                >${ex.sets.length} sets · Tap to edit</small
              >
            </summary>
            <label
              >Exercise<select
                .value=${ex.exercise_id}
                @change=${(e: Event) => {
                  ex.exercise_id = (e.target as HTMLSelectElement).value;
                  this.change();
                }}
              >
                ${EXERCISE_LIBRARY.map((e) => html`<option value=${e.id} ?selected=${e.id===ex.exercise_id}>${e.name}</option>`)}
              </select></label
            >${ex.sets.map(
              (set, si) =>
                html`<div class="set">
                  <label
                    >Reps<input
                      type="number"
                      min="1"
                      .value=${String(set.reps)}
                      @input=${(e: Event) => {
                        set.reps = this.numeric(e);
                        this.change();
                      }} /></label
                  ><label
                    >Weight · ${this.units}<input
                      type="number"
                      min="0"
                      step="any"
                      .value=${String(set.weight)}
                      @input=${(e: Event) => {
                        set.weight = this.numeric(e);
                        this.change();
                      }} /></label
                  ><button
                    class="secondary"
                    aria-label=${`Remove set ${si + 1}`}
                    @click=${() => {
                      ex.sets.splice(si, 1);
                      this.change();
                    }}
                  >
                    −
                  </button>
                </div>`,
            )}
            <div class="actions">
              <button
                class="secondary"
                @click=${() => {
                  ex.sets.push({ reps: 8, weight: 0 });
                  this.change();
                }}
              >
                Add set</button
              ><button
                class="secondary"
                ?disabled=${i === 0}
                @click=${() => {
                  [p.exercises[i - 1], p.exercises[i]] = [
                    ex,
                    p.exercises[i - 1],
                  ];
                  this.change();
                }}
              >
                Move up</button
              ><button
                class="secondary"
                ?disabled=${i === p.exercises.length - 1}
                @click=${() => {
                  [p.exercises[i + 1], p.exercises[i]] = [
                    ex,
                    p.exercises[i + 1],
                  ];
                  this.change();
                }}
              >
                Move down</button
              ><button
                class="secondary"
                @click=${() => {
                  p.exercises.splice(i, 1);
                  this.change();
                }}
              >
                Remove exercise
              </button>
            </div>
          </details>`,
      )}<button
        class="secondary"
        @click=${() => {
          p.exercises.push({
            exercise_id: "push_up",
            sets: [{ reps: 8, weight: 0 }],
          });
          this.change();
        }}
      >
        Add exercise
      </button>`;
  }
  private run(p: RunPrescription) {
    return html`<label
        >Run type<select
          .value=${p.run_type}
          @change=${(e: Event) => {
            p.run_type = (e.target as HTMLSelectElement).value;
            this.change();
          }}
        >
          ${RUN_TYPES.map((t) => html`<option ?selected=${t===p.run_type}>${t}</option>`)}
        </select></label
      >
      <div class="row">
        <label
          >Total distance · ${this.units === "kg" ? "km" : "mi"}<input
            type="number"
            min="0"
            step="any"
            .value=${String(p.target_distance ?? "")}
            @input=${(e: Event) => {
              p.target_distance = this.numeric(e);
              this.change();
            }} /></label
        ><label
          >Total minutes<input
            type="number"
            min="1"
            .value=${String(p.target_duration_minutes ?? "")}
            @input=${(e: Event) => {
              p.target_duration_minutes = this.numeric(e);
              this.change();
            }}
        /></label>
      </div>
      ${(p.segments ?? []).map(
        (seg, i) =>
          html`<details>
            <summary>
              ${seg.phase} · ${seg.label}<br /><small
                >${seg.repetitions} ×
                ${seg.distance_m ? `${seg.distance_m} m` : `${(seg.duration_seconds ?? 0) / 60} min`}${seg.recovery_seconds ? ` · ${seg.recovery_seconds}s recovery` : ""}</small
              >
            </summary>
            <label
              >Phase<select
                .value=${seg.phase}
                @change=${(e: Event) => {
                  seg.phase = (e.target as HTMLSelectElement)
                    .value as typeof seg.phase;
                  this.change();
                }}
              >
                ${["warmup", "main", "cooldown"].map((v) => html`<option ?selected=${v===seg.phase}>${v}</option>`)}
              </select></label
            ><label
              >Description<input
                .value=${seg.label}
                @input=${(e: Event) => {
                  seg.label = (e.target as HTMLInputElement).value;
                  this.change();
                }} /></label
            >${(
              [
                ["repetitions", "Repeats"],
                ["distance_m", "Distance (meters)"],
                ["duration_seconds", "Duration (seconds)"],
                ["recovery_seconds", "Recovery (seconds)"],
                ["pace_min_seconds_per_km", "Fast pace (seconds/km)"],
                ["pace_max_seconds_per_km", "Slow pace (seconds/km)"],
                ["rpe", "Effort (1–10)"],
              ] as const
            ).map(
              ([key, label]) =>
                html`<label
                  >${label}<input
                    type="number"
                    .value=${String(seg[key] ?? "")}
                    @input=${(e: Event) => {
                      if (key === "repetitions")
                        seg.repetitions = this.numeric(e);
                      else
                        seg[key] =
                          (e.target as HTMLInputElement).value === ""
                            ? undefined
                            : this.numeric(e);
                      this.change();
                    }}
                /></label>`,
            )}<button
              class="secondary"
              @click=${() => {
                p.segments.splice(i, 1);
                this.change();
              }}
            >
              Remove segment
            </button>
          </details>`,
      )}<button
        class="secondary"
        @click=${() => {
          p.segments ??= [];
          p.segments.push({
            phase: "main",
            label: "Easy",
            repetitions: 1,
            duration_seconds: 600,
          });
          this.change();
        }}
      >
        Add segment</button
      ><label
        >Notes<textarea
          .value=${p.notes ?? ""}
          @input=${(e: Event) => {
            p.notes = (e.target as HTMLTextAreaElement).value;
            this.change();
          }}
        ></textarea>
      </label>`;
  }
  private program(p: ProgramPrescription) {
    return html`<label
        >Start date<input
          type="date"
          .value=${p.start_date}
          @input=${(e: Event) => {
            p.start_date = (e.target as HTMLInputElement).value;
            this.change();
          }} /></label
      >${p.weeks.map(
        (week, wi) =>
          html`<details>
            <summary>Week ${wi + 1} · ${week.focus}</summary>
            <button
              class="secondary"
              ?disabled=${this.busy}
              @click=${() =>
                this.regenerate(
                  "program",
                  { ...p, weeks: [week] },
                  (result) => {
                    p.weeks[wi] = (result as ProgramPrescription).weeks[0];
                  },
                  { weeks: 1 },
                )}
            >
              Regenerate this week</button
            >${week.sessions.map(
              (session) =>
                html`<details>
                  <summary>${days[session.day]} · ${session.name}</summary>
                  ${
                    session.actual_id
                      ? html`<p>
                          This session is already linked to an actual
                          workout/run. Edit it in the workout or run screen.
                        </p>`
                      : html`<label
                            >Training day<select
                              .value=${String(session.day)}
                              @change=${(e: Event) => {
                                session.day = this.numeric(e);
                                this.change();
                              }}
                            >
                              ${days.map((day, i) => html`<option value=${i} ?selected=${i===session.day}>${day}</option>`)}
                            </select></label
                          >${
                            !["rest", "recovery"].includes(session.type)
                              ? html`<gains-proposal-editor
                                  .hass=${this.hass}
                                  .target=${this.target}
                                  .units=${this.units}
                                  .kind=${session.type === "run" ? "run" : "workout"}
                                  .payload=${session.prescription}
                                  @proposal-change=${(
                                    e: CustomEvent<TrainingPayload>,
                                  ) => {
                                    e.stopPropagation();
                                    session.prescription = e.detail as
                                      WorkoutPrescription | RunPrescription;
                                    this.change();
                                  }}
                                ></gains-proposal-editor>`
                              : html`<p>
                                  ${("notes" in session.prescription ? session.prescription.notes : "") || "Recovery"}
                                </p>`
                          }`
                  }
                </details>`,
            )}
          </details>`,
      )}`;
  }
  private automaticReview(p: ProgramPrescription) {
    return html`<h2>${p.name}</h2><p class="muted">Starts ${p.start_date}</p>
      ${programNeedsExercises(p) ? html`<p class="error" role="alert">A workout did not receive exercises and sets. Go back to your answers and generate again; no manual exercise entry is needed.</p>` : ""}
      ${p.weeks.map(week => html`<section aria-label=${`Generated week ${week.week_number}`}><h3>Week ${week.week_number} · ${week.focus}</h3>
        ${week.sessions.map(session => html`<article class="auto-session"><h3>${days[session.day]} · ${session.name}</h3>
          ${["workout","hiit","conditioning"].includes(session.type) ? html`
            <ul>${((session.prescription as WorkoutPrescription).exercises ?? []).map(ex => {
              const def = EXERCISE_LIBRARY.find(e => e.id===ex.exercise_id);
              const timed = def?.isTimed;
              const sets = ex.sets ?? [];
              const target = (set: {reps:number;weight:number}) => `${set.reps}${timed ? "s" : " reps"}${set.weight ? ` · ${set.weight} ${this.units}` : timed ? "" : " · bodyweight"}`;
              const same = sets.length && sets.every(s => s.reps===sets[0].reps && s.weight===sets[0].weight);
              return html`<li><strong>${def?.name ?? ex.exercise_id}</strong><small>${sets.length} sets · ${same ? target(sets[0]) : sets.map(target).join(" / ")}</small></li>`;
            })}</ul>
            ${(session.prescription as WorkoutPrescription).planning?.warnings?.includes("inventory_not_configured") ? html`<p><small>No gym inventory is configured. Review the estimated loads before accepting.</small></p>` : ""}
            ${(session.prescription as WorkoutPrescription).planning?.warnings?.includes("recovery_conflict") ? html`<p><small>Recent logged work suggests lower recovery. This plan keeps your split and reduces the number of sets.</small></p>` : ""}
            ${(session.prescription as WorkoutPrescription).planning?.estimated_duration_minutes ? html`<p><small>Estimated duration: ${(session.prescription as WorkoutPrescription).planning?.estimated_duration_minutes} minutes.</small></p>` : ""}
          ` : session.type === "run" ? html`<p>Run · ${(session.prescription as RunPrescription).run_type}</p><p>${(session.prescription as RunPrescription).target_duration_minutes ? `${(session.prescription as RunPrescription).target_duration_minutes} minutes` : ""} ${(session.prescription as RunPrescription).target_distance ? `· ${(session.prescription as RunPrescription).target_distance} ${this.units === "kg" ? "km" : "mi"}` : ""}</p>` : html`<p>${("notes" in session.prescription ? session.prescription.notes : "") || "Recovery"}</p>`}
        </article>`)}
      </section>`)}<p class="muted">No exercise selection is required here. Open a workout to change an exercise before starting or while training.</p>`;
  }
  render() {
    if (!this.payload) return html``;
    if (this.automaticProgram && this.kind === "program") return this.automaticReview(this.payload as ProgramPrescription);
    return html`<label
        >Name<input
          .value=${this.payload.name}
          @input=${(e: Event) => {
            this.payload.name = (e.target as HTMLInputElement).value;
            this.change();
          }} /></label
      >${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}${this.kind === "workout" ? this.workout(this.payload as WorkoutPrescription) : this.kind === "run" ? this.run(this.payload as RunPrescription) : this.program(this.payload as ProgramPrescription)}
      <div class="actions">
        <button
          class="secondary"
          ?disabled=${this.busy}
          @click=${() =>
            this.regenerate(this.kind, this.payload, (p) => {
              this.payload = p;
            })}
        >
          ${this.busy ? "Geoffrey is rebuilding…" : `Regenerate this ${this.kind}`}
        </button>
      </div>`;
  }
}
