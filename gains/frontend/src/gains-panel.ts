import { LitElement, css, html } from "lit";
import { gainsTheme } from "./theme";
import { keyed } from "lit/directives/keyed.js";
import type {
  TrainingSnapshot,
  BuildType,
  BuilderAnswers,
  GainsViewContext,
  TrainingPayload,
} from "./training-types";
import type { GainsTrainingView } from "./views/training-view";
import "./views/training-view";
import "./views/progress-view";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "./ha-api";
import {
  gainsApi,
  parseGainsState,
  serviceErrorMessage,
  trainingApi,
  trainingService,
  parseTrainingState,
  scopedTrainingHass,
} from "./ha-api";
import "./views/today-view";
import "./views/workouts-view";
import type { GainsWorkoutsView } from "./views/workouts-view";
import "./views/runs-view";
import "./views/coach-view";
import "./views/equipment-view";
import "./views/settings-view";
import { RUNS_ENABLED } from "./features";

type Tab =
  | "training"
  | "today"
  | "workouts"
  | "runs"
  | "coaching"
  | "progress"
  | "coach"
  | "equipment"
  | "settings";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "mdi:home-outline" },
  { id: "workouts", label: "Workouts", icon: "mdi:dumbbell" },
  { id: "coaching", label: "Coach", icon: "mdi:account-supervisor-outline" },
  { id: "progress", label: "Progress", icon: "mdi:chart-line" },
  { id: "coach", label: "Ask Geoffrey", icon: "mdi:message-text-outline" },
];
@customElement("gains-panel")
export class GainsPanel extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;
  @state() private _tab: Tab = "today";
  @state() private _activity: "strength" | "runs" = "strength";
  @state() private _accountOpen = false;
  @state() private _error = "";
  private _ensuredUser: string | null = null;
  private _ensuring = false;
  @state() private _snapshot: TrainingSnapshot | null = null;
  @state() private _target: string | undefined;
  private _refreshing = false;
  private _poll: number | undefined;
  private _contextUser: string | undefined;
  private _layoutObserver?: ResizeObserver;
  private _fitViewport = (): void => {
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const height = Math.max(0, bottom - this.getBoundingClientRect().top);
    this.style.setProperty("--gains-panel-height", `${height}px`);
  };
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this._fitViewport);
    window.visualViewport?.addEventListener("resize", this._fitViewport);
    this._layoutObserver = new ResizeObserver(this._fitViewport);
    if (this.parentElement) this._layoutObserver.observe(this.parentElement);
    void this.updateComplete.then(() => { if (this.isConnected) this._fitViewport(); });
    this._poll = window.setInterval(() => void this._refreshTraining(), 2000);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("resize", this._fitViewport);
    window.visualViewport?.removeEventListener("resize", this._fitViewport);
    this._layoutObserver?.disconnect();
    window.clearInterval(this._poll);
  }
  private async _refreshTraining(): Promise<void> {
    if (!this.hass?.user || this._refreshing) return;
    const user = this.hass.user.id,
      target = this._target;
    this._refreshing = true;
    try {
      const snapshot = await trainingApi.state(this.hass, target);
      if (user === this.hass.user?.id && target === this._target) {
        this._snapshot = snapshot;
        this._error = "";
      }
    } catch (e) {
      if (target === this._target) {
        if (!this._snapshot) this._error = serviceErrorMessage(e);
        if (target) {
          this._target = undefined;
          this._snapshot = null;
        }
      }
    } finally {
      this._refreshing = false;
    }
  }
  private async _selectAthlete(id?: string): Promise<void> {
    this._target = id;
    this._snapshot = null;
    this._error = "";
    this._tab = "today";
    await this._refreshTraining();
  }
  private async _openBuilder(
    e: CustomEvent<{ kind: BuildType; prefill?: BuilderAnswers }>,
  ): Promise<void> {
    this._tab = "training";
    await this.updateComplete;
    (
      this.shadowRoot?.querySelector("gains-training-view") as GainsTrainingView
    )?.openBuilder(
      e.detail.kind,
      e.detail.prefill ?? {},
      e.detail.prefill ? "geoffrey" : "wizard",
    );
  }

  static styles = [css`
    :host {
      display: block;
      height: var(--gains-panel-height, 100dvh);
      min-width: 0;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      /* HA theme variables inherit through the panel and nested shadow roots. */
      --gains-tint: color-mix(in srgb, var(--primary-color) 12%, var(--card-background-color));
      --gains-muscle: var(--primary-color);
      --gains-muscle-secondary: color-mix(in srgb, var(--primary-color) 40%, var(--card-background-color));
      --gains-muscle-neutral: var(--divider-color);
      --gains-success: var(--success-color, var(--primary-color));
      --gains-success-bg: color-mix(in srgb, var(--gains-success) 12%, var(--card-background-color));
      color: var(--primary-text-color);
      background: var(--primary-background-color);
    }
    :host([data-dark]) {
      color-scheme: dark;
    }
    .activity-tabs { display: flex; gap: 8px; margin-bottom: 20px; }
    .activity-tabs button, .coach-athlete {
      min-height: 48px; border: 1px solid var(--divider-color);
      border-radius: 12px; padding: 12px 18px;
      background: var(--card-background-color); color: var(--primary-text-color);
    }
    .activity-tabs button[aria-pressed="true"] { background: var(--gains-tint); color: var(--primary-color); font-weight: 700; }
    .coach-list { max-width: 760px; }
    .coach-tiles {
      display: grid; gap: 12px;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    }
    .coach-tile {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 20px 12px 16px; border: 1px solid var(--divider-color); border-radius: 16px;
      background: var(--card-background-color); color: var(--primary-text-color);
      font: inherit; cursor: pointer; text-align: center; min-width: 0;
      transition: border-color 0.15s, transform 0.15s;
    }
    .coach-tile:hover { border-color: var(--primary-color); transform: translateY(-1px); }
    .coach-tile:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    .coach-tile[aria-pressed="true"] { border-color: var(--primary-color); background: var(--gains-tint); }
    .avatar {
      position: relative; width: 72px; height: 72px; border-radius: 50%; overflow: hidden;
      display: grid; place-items: center; flex-shrink: 0;
      background: var(--gains-tint); color: var(--primary-color);
      font-size: 1.75rem; font-weight: 700; text-transform: uppercase;
    }
    .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .coach-tile .name {
      font-weight: 700; max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .coach-tile .status { font-size: 0.8rem; color: var(--secondary-text-color); }
    .coach-tile[aria-pressed="true"] .status { color: var(--primary-color); font-weight: 600; }
    .coach-exit { margin-top: 16px; }
    * {
      box-sizing: border-box;
    }
    [hidden] {
      display: none !important;
    }
    .shell {
      height: 100%;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      justify-content: space-between;
      padding: 14px 22px;
      border-bottom: 1px solid var(--divider-color);
      background: var(--card-background-color);
      transition:
        background 180ms ease,
        border-color 180ms ease,
        box-shadow 180ms ease;
    }
    header.coach-mode {
      background: color-mix(
        in srgb,
        var(--primary-color) 30%,
        var(--card-background-color)
      );
      border-bottom-color: color-mix(
        in srgb,
        var(--primary-color) 62%,
        var(--divider-color)
      );
      box-shadow: inset 0 -1px 0 color-mix(
        in srgb,
        var(--primary-color) 24%,
        transparent
      );
    }
    header.coach-mode .account {
      border-color: color-mix(
        in srgb,
        var(--primary-color) 55%,
        var(--divider-color)
      );
      background: color-mix(
        in srgb,
        var(--primary-color) 12%,
        var(--card-background-color)
      );
    }
    .brand {
      font-size: 23px;
      font-weight: 800;
      letter-spacing: -1px;
    }
    .brand span {
      color: var(--primary-color);
    }
    button {
      font: inherit;
      cursor: pointer;
      color: inherit;
    }
    .account {
      min-height: 44px;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      border-radius: 24px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 70%;
    }
    .account span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .account-menu {
      flex-shrink: 0;
      padding: 12px 22px;
      background: var(--card-background-color);
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .account-menu button {
      min-height: 44px;
      background: var(--gains-tint);
      border: 0;
      border-radius: 10px;
      padding: 8px 15px;
    }
    main {
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 22px 20px 36px;
    }
    .content {
      width: 100%;
      min-width: 0;
      max-width: 1000px;
      margin: 0 auto;
    }
    nav {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 3px;
      background: var(--card-background-color);
      border-top: 1px solid var(--divider-color);
      padding: 8px 10px max(10px, env(safe-area-inset-bottom));
      flex-shrink: 0;
    }
    nav button {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      min-height: 54px;
      padding: 6px;
      border: 0;
      background: none;
      color: var(--secondary-text-color);
      font-size: 11px;
      border-radius: 12px;
      min-width: 0;
    }
    nav button span {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    nav button[aria-current="page"] {
      color: var(--primary-color);
      background: var(--gains-tint);
      font-weight: 600;
    }
    ha-icon {
      --mdc-icon-size: 22px;
    }
    .error {
      padding: 12px;
      color: var(--error-color, #b91c1c);
    }
    @media (min-width: 850px) {
      .shell {
        display: grid;
        grid-template-columns: 105px minmax(0, 1fr);
        grid-template-rows: auto auto minmax(0, 1fr);
      }
      header,
      .account-menu {
        grid-column: 1/-1;
      }
      nav {
        grid-column: 1;
        grid-row: 3;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        border-top: 0;
        border-right: 1px solid var(--divider-color);
        padding-top: 18px;
      }
      main {
        grid-column: 2;
        grid-row: 3;
      }
      nav button {
        padding: 15px 5px;
      }
    }

    header { background: var(--primary-background-color); padding: 16px 24px; }
    .brand { font-size: 27px; letter-spacing: -1.5px; }
    .account { background: var(--secondary-background-color); border-color: transparent; font-size: 13px; }
    main { padding: 30px 24px 40px; }
    nav { background: var(--primary-background-color); }
    nav button { font-weight: 600; }
    nav button[aria-current="page"] { background: transparent; }
    nav button[aria-current="page"] ha-icon { background: var(--gains-tint); border-radius: 14px; padding: 6px 16px; box-sizing: content-box; }
    .activity-tabs { background: var(--secondary-background-color); padding: 4px; border-radius: 999px; width: fit-content; max-width: 100%; }
    .activity-tabs button { border: 0; border-radius: 999px; background: transparent; min-height: 44px; padding: 8px 18px; }
    .activity-tabs button[aria-pressed="true"] { background: var(--card-background-color); color: var(--primary-text-color); }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
    @media (max-width: 520px) {
      header { padding: 12px 18px; }
      main { padding: 22px 18px 28px; }
      nav { padding-top: 5px; }
      nav button { min-height: 60px; gap: 3px; }
      .activity-tabs { width: 100%; }
      .activity-tabs button { flex: 1; padding: 8px 10px; }
    }
  `, gainsTheme];
  protected willUpdate(changed: Map<string, unknown>): void {
    if (this.hass?.user?.id !== this._contextUser) {
      this._contextUser = this.hass?.user?.id;
      this._target = undefined;
      this._snapshot = null;
    }
    this.toggleAttribute("data-coach", !!this._target);
    const dark =
      this.hass?.themes?.darkMode ??
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    this.toggleAttribute("data-dark", dark);
    // HA pushes new state objects after coordinator saves. Refresh the scoped
    // service snapshot on those updates; polling is only a reconnect fallback.
    const previousHass = changed.get("hass") as HomeAssistant | undefined;
    if (
      changed.has("hass") &&
      this._snapshot &&
      previousHass?.states !== this.hass.states
    ) {
      void this._refreshTraining();
    }
    if (
      this.hass?.user?.id &&
      this._ensuredUser !== this.hass.user.id &&
      !this._ensuring &&
      !this._error
    )
      void this._ensureProfile();
  }
  private async _ensureProfile(): Promise<void> {
    this._ensuring = true;
    const user = this.hass.user?.id ?? null;
    try {
      await gainsApi.ensureProfile(this.hass, this.hass.user?.name);
      this._ensuredUser = user;
      this._error = "";
      void this._refreshTraining();
    } catch {
      this._error =
        "Unable to load your profile. Check the connection and retry.";
    } finally {
      this._ensuring = false;
    }
  }
  private _navigate(e: CustomEvent<{ tab: Tab; workoutId?: string }>): void {
    this._tab = e.detail.tab === "runs" ? "workouts" : e.detail.tab;
    if (e.detail.tab === "runs" && RUNS_ENABLED) this._activity = "runs";
    if (e.detail.tab === "runs" && !RUNS_ENABLED) this._activity = "strength";
    if (e.detail.tab === "workouts") this._activity = "strength";
    if (e.detail.workoutId)
      (
        this.shadowRoot?.querySelector(
          "gains-workouts-view",
        ) as GainsWorkoutsView | null
      )?.openWorkout(e.detail.workoutId);
    this._accountOpen = false;
    this.shadowRoot?.querySelector("main")?.scrollTo(0, 0);
  }
  private async _regenerateProgramSession(e: CustomEvent<{
    programId: string; sessionId: string;
    resolve: () => void; reject: (error: unknown) => void;
  }>): Promise<void> {
    const target = this._target;
    const viewer = this.hass.user?.id;
    try {
      await trainingService(this.hass, "program_action", {
        id: e.detail.programId, action: "regenerate_session",
        fields: { session_id: e.detail.sessionId },
        ...(target ? { target_profile_id: target } : {}),
      });
      const snapshot = await trainingApi.state(this.hass, target);
      if (target === this._target && viewer === this.hass.user?.id) this._snapshot = snapshot;
      e.detail.resolve();
    } catch (error) { e.detail.reject(error); }
  }
  private async _openProgramSession(e: CustomEvent<{
    programId: string; sessionId: string; startNow: boolean;
    resolve: () => void; reject: (error: unknown) => void;
  }>): Promise<void> {
    const target = this._target;
    const viewer = this.hass.user?.id;
    try {
      const result = await trainingService<{ id: string; type: string }>(this.hass, "program_action", {
        id: e.detail.programId, action: "open_session",
        fields: { session_id: e.detail.sessionId, start_now: e.detail.startNow },
        ...(target ? { target_profile_id: target } : {}),
      });
      // Fetch after creation, rather than navigating against the previous poll's data.
      const snapshot = await trainingApi.state(this.hass, target);
      if (target !== this._target || viewer !== this.hass.user?.id) { e.detail.resolve(); return; }
      const loaded = parseTrainingState(snapshot);
      const items = result.type === "run" ? loaded.runs : loaded.workouts;
      if (!result.id || !items.some(item => item.id === result.id)) {
        throw new Error("The program's linked session could not be loaded. Reopen Gains after the integration update and try again.");
      }
      this._snapshot = snapshot;
      await this.updateComplete;
      const workouts = this.shadowRoot?.querySelector("gains-workouts-view") as GainsWorkoutsView | null;
      if (workouts) await workouts.updateComplete;
      this._navigate(new CustomEvent("gains-switch-tab", { detail: {
        tab: result.type === "run" ? "runs" : "workouts",
        workoutId: result.type === "run" ? undefined : result.id,
      } }));
      e.detail.resolve();
    } catch (error) { e.detail.reject(error); }
  }
  render() {
    if (!this.hass) return html``;
    const ownState = parseGainsState(this.hass);
    const state = this._snapshot
      ? parseTrainingState(this._snapshot)
      : this._target
        ? { ...ownState, profile: null, workouts: [], runs: [] }
        : ownState;
    const context: GainsViewContext = {
      viewerProfileId:
        this._snapshot?.viewer_profile_id ?? ownState.profile?.profileId ?? "",
      activeProfileId: state.profile?.profileId ?? "",
      mode: this._target ? "coach" : "self",
    };
    const scoped = this._snapshot
      ? scopedTrainingHass(this.hass, this._snapshot, () =>
          this._refreshTraining(),
        )
      : this.hass;
    return html`<div class="shell">
      <header class=${this._target ? "coach-mode" : ""}>
        <div class="brand">gains<span>.</span></div>
        <button
          class="account"
          aria-expanded=${this._accountOpen}
          @click=${() => (this._accountOpen = !this._accountOpen)}
        >
          <ha-icon icon="mdi:account-circle-outline"></ha-icon
          ><span>${state.profile?.displayName ?? "Loading athlete…"}</span
          ><ha-icon icon="mdi:chevron-down"></ha-icon>
        </button>
      </header>
      <div class="account-menu" ?hidden=${!this._accountOpen}>
        <button
          @click=${() => {
            if (this._target) {
              void this._selectAthlete();
            } else {
              this._tab = "coaching";
            }
            this._accountOpen = false;
          }}
        >
          ${this._target ? "Exit Coach Mode" : "Coach Mode"}</button
        ><button
          @click=${() => {
            this._tab = "training";
            this._accountOpen = false;
          }}
        >
          Programs & builders</button
        ><button
          ?hidden=${!!this._target}
          @click=${() => {
            this._tab = "equipment";
            this._accountOpen = false;
          }}
        >
          Shared gyms</button
        ><button
          ?hidden=${!!this._target}
          @click=${() => {
            this._tab = "settings";
            this._accountOpen = false;
          }}
        >
          Account & preferences
        </button>
      </div>
      <main
        @gains-page-change=${() => this.shadowRoot?.querySelector("main")?.scrollTo(0, 0)}
        @open-program-session=${this._openProgramSession}
        @regenerate-program-session=${this._regenerateProgramSession}
        @gains-switch-tab=${this._navigate}
        @open-builder=${this._openBuilder}
        @review-proposal=${async (
          e: CustomEvent<{ kind: BuildType; payload: TrainingPayload }>,
        ) => {
          this._tab = "training";
          await this.updateComplete;
          void (
            this.shadowRoot?.querySelector(
              "gains-training-view",
            ) as GainsTrainingView
          )?.review(e.detail.kind, e.detail.payload);
        }}
        @training-refresh=${() => void this._refreshTraining()}
        @enter-coach-mode=${() => (this._tab = "coaching")}
      >
        <div class="content">
          ${this._error ? html`<p class="error" role="alert">${this._error}<button @click=${() => void this._ensureProfile()}>Retry</button></p>` : ""}
          ${keyed(
            context.viewerProfileId + ":" + context.activeProfileId,
            html`
              <section ?hidden=${this._tab !== "today"}>
                <gains-today-view
                  .hass=${scoped}
                  .gainsState=${state}
                  .snapshot=${this._snapshot ?? undefined}
                ></gains-today-view>
              </section>
              <section ?hidden=${this._tab !== "workouts"}>
                <div class="activity-tabs" role="group" aria-label="Workout type">
                  <button aria-pressed=${this._activity === "strength"} @click=${() => (this._activity = "strength")}>Strength</button>
                  ${RUNS_ENABLED ? html`<button aria-pressed=${this._activity === "runs"} @click=${() => (this._activity = "runs")}>Runs</button>` : ""}
                  <button aria-pressed="false" @click=${() => (this._tab = "training")}>Programs</button>
                </div>
                <div ?hidden=${this._activity !== "strength"}>
                <gains-workouts-view
                  .viewContext=${context}
                  .hass=${scoped}
                  .gainsState=${state}
                ></gains-workouts-view>
                </div>
                ${RUNS_ENABLED ? html`<div ?hidden=${this._activity !== "runs"}>
                <gains-runs-view
                  .hass=${scoped}
                  .gainsState=${state}
                ></gains-runs-view>
                </div>` : ""}
              </section>
              <section ?hidden=${this._tab !== "coaching"}>
                <h1>Coach</h1>
                <p>Select an athlete to view and log their training with them.</p>
                <div class="coach-list">
                  ${!this._snapshot ? html`<p>Loading athletes…</p>` : this._snapshot.coachable_profiles.length ? html`<div class="coach-tiles">${this._snapshot.coachable_profiles.map(p => html`
                    <button class="coach-tile" aria-pressed=${this._target === p.profile_id} @click=${() => void this._selectAthlete(p.profile_id)}>
                      <span class="avatar" aria-hidden="true">${(p.display_name.trim()[0] ?? "?")}${p.picture ? html`<img src=${p.picture} alt="" loading="lazy" @error=${(e: Event) => ((e.target as HTMLElement).hidden = true)} />` : ""}</span>
                      <span class="name">${p.display_name}</span>
                      <span class="status">${this._target === p.profile_id ? "Coaching" : "Coach athlete"}</span>
                    </button>`)}</div>` : html`<p>No athletes have granted you coaching access yet. They can enable coaching permissions for your linked profile in Account & preferences.</p>`}
                  ${this._target ? html`<button class="coach-athlete coach-exit" @click=${() => void this._selectAthlete()}>Exit Coach Mode · Return to my training</button>` : ""}
                </div>
              </section>
              <section ?hidden=${this._tab !== "progress"}>
                <gains-progress-view
                  .hass=${this.hass}
                  .gainsState=${state}
                  .target=${this._target}
                ></gains-progress-view>
              </section>
              <section ?hidden=${this._tab !== "coach"}>
                <gains-coach-view
                  .programs=${this._snapshot?.programs ?? []}
                  .hass=${scoped}
                  .gainsState=${state}
                ></gains-coach-view>
              </section>
              <section ?hidden=${this._tab !== "equipment" || !!this._target}>
                <gains-equipment-view
                  .hass=${scoped}
                  .gainsState=${state}
                ></gains-equipment-view>
              </section>
              <section ?hidden=${this._tab !== "settings" || !!this._target}>
                <gains-settings-view
                  .hass=${scoped}
                  .gainsState=${state}
                ></gains-settings-view>
              </section>
              <section ?hidden=${this._tab !== "training"}>
                <gains-training-view
                  .hass=${this.hass}
                  .gainsState=${state}
                  .snapshot=${this._snapshot}
                  .target=${this._target}
                ></gains-training-view>
              </section>
            `,
          )}
        </div>
      </main>
      <nav aria-label="Gains navigation">
        ${TABS.map(
          (tab) =>
            html`<button
              aria-current=${this._tab === tab.id ? "page" : "false"}
              @click=${() => {
                this._tab = tab.id;
                this._accountOpen = false;
              }}
            >
              <ha-icon icon=${tab.icon}></ha-icon><span>${tab.label}</span>
            </button>`,
        )}
      </nav>
    </div>`;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "gains-panel": GainsPanel;
  }
}

