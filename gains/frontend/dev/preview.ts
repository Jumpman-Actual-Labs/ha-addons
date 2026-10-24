/** Development-only synthetic HA host. No network calls, credentials or personal data. */
import { LitElement, css, html, svg } from "lit";
import "../src/gains-panel";
import { programDefaults, prepareProgramAnswers, preferenceSlots } from "../src/program-builder";
import { effectiveAnswers } from "../src/builder-questions";

class PreviewCard extends LitElement {
  static styles = css`:host{display:block;background:var(--ha-card-background,var(--card-background-color));border:var(--ha-card-border-width,1px) solid var(--ha-card-border-color,var(--divider-color));border-radius:var(--ha-card-border-radius,18px);box-shadow:var(--ha-card-box-shadow,none)}`;
  render() { return html`<slot></slot>`; }
}
class PreviewIcon extends LitElement {
  static properties = { icon: {} };
  icon = "";
  static styles = css`:host{display:inline-flex;width:var(--mdc-icon-size,24px);height:var(--mdc-icon-size,24px);flex-shrink:0}svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}`;
  render() {
    const paths = this.icon.includes("dumbbell") ? svg`<path d="M7 8v8m10-8v8M4 10v4m16-4v4M7 12h10"/>` : this.icon.includes("chevron-down") ? svg`<path d="m7 10 5 5 5-5"/>` : this.icon.includes("chevron-right") ? svg`<path d="m10 6 6 6-6 6"/>` : this.icon.includes("arrow-left") ? svg`<path d="m12 5-7 7 7 7M5 12h15"/>` : this.icon.includes("home") ? svg`<path d="m3 10 9-7 9 7v10H3ZM9 20v-7h6v7"/>` : this.icon.includes("account") ? svg`<circle cx="12" cy="8" r="4"/><path d="M4 21v-3a8 6 0 0 1 16 0v3"/>` : this.icon.includes("chart") ? svg`<path d="M4 3v17h17M7 15l4-5 4 3 5-8"/>` : this.icon.includes("message") ? svg`<path d="M3 4h18v13H9l-6 4ZM7 8h10M7 12h7"/>` : this.icon.includes("map-marker") ? svg`<path d="M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 0 1 14 0Z"/><circle cx="12" cy="9" r="2"/>` : svg`<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>`;
    return html`<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  }
}
class PreviewDialog extends LitElement {
  static properties = { open: { type: Boolean, reflect: true }, heading: {} };
  open = false;
  heading = "";
  static styles = css`:host{position:fixed;inset:12% 12px auto;max-height:75vh;overflow:auto;z-index:100;background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:20px;padding:20px}:host(:not([open])){display:none}`;
  render() { return html`<div role="dialog" aria-label=${this.heading}><h2>${this.heading}</h2><slot></slot><slot name="primaryAction"></slot><slot name="secondaryAction"></slot></div>`; }
}
customElements.define("ha-dialog", PreviewDialog);
customElements.define("ha-card", PreviewCard);
customElements.define("ha-icon", PreviewIcon);
const stamp = new Date().toISOString();
const sets = (weight: number) => Array.from({ length: 3 }, () => ({planned_reps: 8, planned_weight: weight, completed: false}));
const exercises = ["barbell_bench_press", "barbell_row", "dumbbell_shoulder_press", "lat_pulldown", "dumbbell_curl"].map((exercise_id, i) => ({ exercise_id, sets: sets([60,45,16,40,10][i]), rest_seconds: 90, notes: "" }));
const workout = {id:"preview-workout",profile_id:"preview",name:"Upper body strength",status:"planned",revision:1,exercises,notes:"",created_at:stamp};
const completed = [1, 2].map(daysAgo => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return {...structuredClone(workout), id: `preview-history-${daysAgo}`, status: "completed", completed_at: date.toISOString(), exercises: exercises.map(e => ({...e, sets: e.sets.map(s => ({...s, completed: true, actual_reps: 8, actual_weight: s.planned_weight}))}))};
});
const attributes = {profile_id:"preview",ha_user_id:"preview-user",display_name:"Alex",units:"metric",experience_level:"intermediate",onboarding_complete:true,rest_timer_seconds:90,preferred_sequencing_policy:"completion",gym_profile_id:"home",gym_profiles:[{id:"home",name:"Home gym",equipment:{},equipment_config:{}}],workouts:[workout,...completed],runs:[],muscle_recovery:{model_version:1,calculated_at:stamp,half_life_hours:24,muscles:{pectoralis_major:{recovery_percent:72},quadriceps:{recovery_percent:96},latissimus_dorsi:{recovery_percent:83},biceps_brachii:{recovery_percent:88},triceps_brachii:{recovery_percent:78}}}};
const sessions = ["Upper body strength","Lower body strength","Upper body volume"].map((name,i) => ({id:`week-1:s${i}`,day:i+1,type:"workout",name,prescription:{name,exercises},scheduled_date:stamp.slice(0,10),week_number:1}));
const snapshot = {attributes,viewer_profile_id:"preview",active_profile_id:"preview",mode:"self",permissions:{},coachable_profiles:[],grants:{},programs:[{id:"program",profile_id:"preview",name:"Your strength plan",goal:"Build strength",start_date:stamp.slice(0,10),weeks:[{week_number:1,focus:"Strength",sessions}],current_week:1,upcoming_sessions:sessions,status:"active",revision:1}],proposals:[]};
const panel = document.querySelector("gains-panel")!;
let dark = true;
let empty = false;
let draft: Record<string, any> | undefined;
function render() {
  panel.hass = {
    user:{id:"preview-user",name:"Alex",is_admin:false},themes:{darkMode:dark},states:{},
    callService:async (_domain, service, data) => { if (service === "update_profile") Object.assign(attributes,data); },
    callWS:async (message) => {
      const data = message.service_data as Record<string, any>;
      if (message.service === "build_training") {
        const answers = effectiveAnswers("program", prepareProgramAnswers(programDefaults(data.request.answers)));
        const names = preferenceSlots(answers);
        const days = (answers.days as string[]).map(day => ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].indexOf(day));
        // A visual proposal fixture, not an implementation of the production planner.
        const prescription = {name:"Preview program",goal:answers.goal,start_date:answers.start_date || stamp.slice(0,10),weeks:[{week_number:1,focus:"Synthetic preview",sessions:Array.from({length:Number(answers.lifting_days)},(_,i) => ({id:`preview-${i}`,day:days[i],type:"workout",name:names[i%names.length],prescription:{name:names[i%names.length],exercises:exercises.slice(0,2).map(e=>({exercise_id:e.exercise_id,sets:e.sets.map(s=>({reps:s.planned_reps,weight:s.planned_weight}))}))}}))}]};
        draft = {id:"preview-proposal",type:"program",request:{...data.request,answers},payload:prescription};
        return {response:structuredClone(draft)};
      }
      if (message.service === "accept_training" && draft) {
        snapshot.programs.push({...data.fields,id:"preview-created",profile_id:"preview",status:"draft",revision:1});
        return {response:{id:"preview-created",type:"program"}};
      }
      if (message.service === "progress_state") return {response:{strength_score:{overall_score:null,groups:[]},streak_days:0,this_month:{year:2026,month:10,workouts_completed:0,duration_minutes:0,volume:0,sets:0,most_improved:[],muscle_breakdown:[]}}};
      if (message.service === "program_action") { workout.status = data.fields.start_now ? "active" : "planned"; workout.revision++; return {response:{id:workout.id,type:"workout"}}; }
      if (message.service === "session_action") {
        if (data.action === "start_workout") workout.status = "active";
        if (data.action === "log_set") { const set = workout.exercises[data.fields.exercise_index].sets[data.fields.set_index]; Object.assign(set,{completed:true,actual_reps:data.fields.reps,actual_weight:data.fields.weight}); }
        workout.revision++;
        return {response:{id:workout.id}};
      }
      return {response:structuredClone(empty ? {...snapshot,attributes:{...attributes,workouts:[],muscle_recovery:undefined},programs:[]} : snapshot)};
    }
  };
}
document.querySelector("#theme")!.addEventListener("click", () => { dark = !dark; render(); });
const accents = ["#03a9f4", "#9c67df", "#e17c24"];
let accent = 0;
document.querySelector("#accent")!.addEventListener("click", () => {
  accent = (accent + 1) % accents.length;
  document.body.style.setProperty("--primary-color", accents[accent]);
});
document.querySelector("#empty")!.addEventListener("click", () => { empty = !empty; render(); });
render();
