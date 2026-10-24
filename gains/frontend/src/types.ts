import type { GeoffreyAction, RunSegment } from "./training-types";
import { musclesForExercise, type ExerciseMuscles } from "./muscles";

// TS mirror of ha-gains-integration's const.py attribute names and
// sensor.py's GainsAthleteProfileSensor attribute shape - kept in sync by
// hand with ha-gains-integration (no shared schema between the two repos,
// so a backend sensor/service field rename needs a matching edit here).

export const UNITS = ["imperial", "metric"] as const;
export type Units = (typeof UNITS)[number];

export const EXPERIENCE_LEVELS = [
  "kids",
  "beginner",
  "novice",
  "intermediate",
  "advanced",
] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const ACTIVITY_LEVELS = [
  "sedentary",
  "lightly_active",
  "active",
  "very_active",
] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

// Mirrors ha-gains-integration's const.py REST_TIMER_OPTIONS -- a fixed
// choice list (not a free number) so the settings picker stays a simple
// select instead of a raw number input.
export const REST_TIMER_OPTIONS = [45, 60, 90, 120] as const;
export type RestTimerSeconds = (typeof REST_TIMER_OPTIONS)[number];

export interface AthleteProfile {
  profileId: string;
  haUserId: string;
  displayName: string;
  units: Units;
  experienceLevel: ExperienceLevel | null;
  activityLevel: ActivityLevel | null;
  preferredDurationMinutes: number | null;
  /** Default rest-period timer between sets, in seconds -- one of
   * REST_TIMER_OPTIONS. Purely a panel display preference. */
  restTimerSeconds: number;
  preferredSequencingPolicy?: "calendar" | "completion";
  isAdmin: boolean;
  onboardingComplete: boolean;
  createdAt: string;
  updatedAt: string;
  /** In `units` (lb or kg). Only used as a Strength Score input -- null
   * until the athlete sets it in Settings. */
  bodyweight: number | null;
  /** Whole years, self-reported. Only used as a Strength Score age
   * adjustment -- null until the athlete sets it in Settings. */
  age: number | null;
  /** Best estimated one-rep max seen so far, keyed by exercise_id. */
  personalRecords: Record<string, number>;
  inventoryPolicy?: import("./inventory-policy").InventoryPolicy;
  /** This athlete's persistent Ask Geoffrey thread (partial Phase 8). */
  aiConversation: AICoachMessage[];
  /** Which GainsState.gymProfiles entry this athlete has selected as their
   * gym -- gym profiles are shared instance-wide (see GymProfile), so
   * equipment is no longer tracked per-athlete. null means no gym selected
   * yet (bodyweight-only until one is picked). */
  gymProfileId: string | null;
  /** Other profiles on this same Home Assistant instance this athlete has
   * linked (e.g. a family member) -- for switching between profiles in
   * the panel, not a security boundary (HA's own entity permissions
   * govern actual visibility). */
  linkedProfiles: LinkedProfileSummary[];
  /** Every other profile on this instance not already linked -- who this
   * athlete could link to. */
  linkableProfiles: LinkedProfileSummary[];
  /** Every other profile on this instance, regardless of link status --
   * who a workout/run/program can be shared with. Sharing never requires
   * linking first. */
  shareTargets: LinkedProfileSummary[];
  jointTargets?: LinkedProfileSummary[];
  /** Pending share offers made TO this profile, newest first -- shown on
   * the Programs screen with Accept/Decline. */
  incomingShares: IncomingShare[];
}

export interface LinkedProfileSummary {
  profileId: string;
  displayName: string;
  eligibleWorkoutIds?: string[];
}

export type ShareKind = "workout" | "joint_workout" | "run" | "program";

export interface IncomingShare {
  deviceMode?: "same_device" | "different_devices";
  id: string;
  kind: ShareKind;
  name: string;
  fromProfileId: string;
  fromDisplayName: string;
  createdAt: string;
}

// A named, reusable equipment checklist shared instance-wide (e.g. "Home
// Gym", "Planet Fitness") -- any Home Assistant member on this instance can
// create one, edit any of them, and select which one is theirs via
// AthleteProfile.gymProfileId. createdByProfileId is attribution only, not
// an access boundary.
export type CableLoadType = "plate_loaded" | "weight_stack";

export interface EquipmentConfig {
  loadType?: CableLoadType;
  pulleyRatio?: number;
  stackMax?: number | null;
  stackIncrement?: number | null;
  stackMin?: number | null;
  baseWeight?: number | null;
  loadingPoints?: number | null;
}

export interface GymProfile {
  id: string;
  name: string;
  /** Same shape as the old per-athlete equipment field it replaces --
   * keyed by equipment_id, a present key means "checked," value is a list
   * of weights (one per physical unit owned, null meaning "use the
   * catalog's defaultWeight"). */
  equipment: Record<string, (number | null)[]>;
  /** Machine-specific metadata that is not a physical unit weight. Cable
   * stations use this for plate-loaded vs selectorized-stack setup. */
  equipmentConfig: Record<string, EquipmentConfig>;
  createdByProfileId: string;
  createdAt: string;
  updatedAt: string;
}

// Phase 2 (Strength MVP): mirrors ha-gains-integration's exercises.py
// EXERCISE_LIBRARY -- kept in sync by hand (no shared schema between the
// two repos). gains.create_workout validates exercise_id against the
// backend's copy of this same list.
export interface ExerciseDef {
  muscles?: ExerciseMuscles;
  id: string;
  name: string;
  category: string;
  equipment: string;
  /** YouTube URL for a how-to-perform video, embedded on the exercise's
   * detail page. Left unset for most exercises -- populate per-exercise
   * as real, verified videos are sourced; never fabricated. */
  videoUrl?: string;
  /** Mirrors ha-gains-integration's exercises.py requires_equipment_id --
   * only set on the handful of exercises named after a specific piece of
   * gear (e.g. Trap Bar Deadlift) rather than the broad `equipment`
   * category it belongs to. Not currently read by anything in this repo
   * (the Ask Geoffrey's equipment gating happens server-side); kept here so
   * the two exercise lists stay in sync by hand, per this file's header
   * comment. */
  requiresEquipmentId?: string;
  /** Mirrors ha-gains-integration's exercises.py is_timed -- an isometric
   * hold (Plank, Wall Sit, ...) whose sets are logged as seconds held
   * rather than reps. WorkoutSet.plannedReps/actualReps still carry the
   * raw number (a duration in seconds); this just tells the logging UI to
   * label/enter that number as a time instead of a rep count. */
  isTimed?: boolean;
}

// Human-readable muscle groups per exercise category, so a plan card or
// exercise detail page can show "Chest, Shoulders, Triceps" instead of the
// raw internal category id -- there's no separate "muscle group" field in
// the exercise library, category is already a reasonable proxy for it.
export const MUSCLE_GROUPS_BY_CATEGORY: Record<string, string> = {
  squat: "Quads, Glutes",
  hinge: "Hamstrings, Glutes, Back",
  push: "Chest, Shoulders, Triceps",
  pull: "Back, Biceps",
  single_leg: "Legs, Glutes",
  core: "Core",
  carry: "Full Body, Grip",
  olympic: "Full Body, Power",
  arms: "Arms",
  shoulders: "Shoulders",
  legs: "Legs",
  conditioning: "Cardio, Full Body",
  mobility: "Mobility",
};

export const EXERCISE_LIBRARY: ExerciseDef[] = [
  // -- squat --
  { id: "barbell_back_squat", name: "Barbell Back Squat", category: "squat", equipment: "barbell" },
  { id: "barbell_front_squat", name: "Barbell Front Squat", category: "squat", equipment: "barbell" },
  { id: "goblet_squat", name: "Goblet Squat", category: "squat", equipment: "dumbbell" },
  { id: "bodyweight_squat", name: "Bodyweight Squat", category: "squat", equipment: "bodyweight" },
  { id: "box_squat", name: "Box Squat", category: "squat", equipment: "barbell" },
  { id: "safety_bar_squat", name: "Safety Bar Squat", category: "squat", equipment: "barbell", requiresEquipmentId: "safety_squat_bar" },
  { id: "zercher_squat", name: "Zercher Squat", category: "squat", equipment: "barbell" },
  { id: "overhead_squat", name: "Overhead Squat", category: "squat", equipment: "barbell" },
  { id: "hack_squat", name: "Hack Squat (Machine)", category: "squat", equipment: "machine" },
  { id: "leg_press", name: "Leg Press", category: "squat", equipment: "machine" },
  { id: "smith_machine_squat", name: "Smith Machine Squat", category: "squat", equipment: "machine" },
  { id: "sumo_squat", name: "Sumo Squat", category: "squat", equipment: "barbell" },
  { id: "landmine_squat", name: "Landmine Squat", category: "squat", equipment: "barbell", requiresEquipmentId: "landmine" },
  { id: "jump_squat", name: "Jump Squat", category: "squat", equipment: "bodyweight" },
  { id: "wall_sit", name: "Wall Sit", category: "squat", equipment: "bodyweight", isTimed: true },
  { id: "spanish_squat", name: "Spanish Squat", category: "squat", equipment: "bands" },
  { id: "pin_squat", name: "Pin Squat", category: "squat", equipment: "barbell" },
  // -- hinge --
  { id: "barbell_deadlift", name: "Barbell Deadlift", category: "hinge", equipment: "barbell" },
  { id: "romanian_deadlift", name: "Romanian Deadlift", category: "hinge", equipment: "barbell" },
  { id: "sumo_deadlift", name: "Sumo Deadlift", category: "hinge", equipment: "barbell" },
  { id: "deficit_deadlift", name: "Deficit Deadlift", category: "hinge", equipment: "barbell" },
  { id: "stiff_leg_deadlift", name: "Stiff-Leg Deadlift", category: "hinge", equipment: "barbell" },
  { id: "trap_bar_deadlift", name: "Trap Bar Deadlift", category: "hinge", equipment: "barbell", requiresEquipmentId: "trap_bar" },
  { id: "single_leg_rdl", name: "Single-Leg Romanian Deadlift", category: "hinge", equipment: "dumbbell" },
  { id: "good_morning", name: "Good Morning", category: "hinge", equipment: "barbell" },
  { id: "kettlebell_swing", name: "Kettlebell Swing", category: "hinge", equipment: "kettlebell" },
  { id: "hip_thrust", name: "Barbell Hip Thrust", category: "hinge", equipment: "barbell" },
  { id: "glute_bridge", name: "Glute Bridge", category: "hinge", equipment: "bodyweight" },
  { id: "back_extension", name: "Back Extension", category: "hinge", equipment: "machine" },
  { id: "cable_pull_through", name: "Cable Pull-Through", category: "hinge", equipment: "cable" },
  { id: "snatch_grip_deadlift", name: "Snatch-Grip Deadlift", category: "hinge", equipment: "barbell" },
  { id: "rack_pull", name: "Rack Pull", category: "hinge", equipment: "barbell" },
  // -- push --
  { id: "barbell_bench_press", name: "Barbell Bench Press", category: "push", equipment: "barbell" },
  { id: "dumbbell_bench_press", name: "Dumbbell Bench Press", category: "push", equipment: "dumbbell" },
  { id: "incline_barbell_bench_press", name: "Incline Barbell Bench Press", category: "push", equipment: "barbell" },
  { id: "incline_dumbbell_bench_press", name: "Incline Dumbbell Bench Press", category: "push", equipment: "dumbbell" },
  { id: "decline_bench_press", name: "Decline Bench Press", category: "push", equipment: "barbell" },
  { id: "close_grip_bench_press", name: "Close-Grip Bench Press", category: "push", equipment: "barbell" },
  { id: "floor_press", name: "Floor Press", category: "push", equipment: "barbell" },
  { id: "push_up", name: "Push-Up", category: "push", equipment: "bodyweight" },
  { id: "incline_push_up", name: "Incline Push-Up", category: "push", equipment: "bodyweight" },
  { id: "decline_push_up", name: "Decline Push-Up", category: "push", equipment: "bodyweight" },
  { id: "diamond_push_up", name: "Diamond Push-Up", category: "push", equipment: "bodyweight" },
  { id: "wide_push_up", name: "Wide Push-Up", category: "push", equipment: "bodyweight" },
  { id: "archer_push_up", name: "Archer Push-Up", category: "push", equipment: "bodyweight" },
  { id: "plyo_push_up", name: "Plyo Push-Up", category: "push", equipment: "bodyweight" },
  { id: "dumbbell_fly", name: "Dumbbell Fly", category: "push", equipment: "dumbbell" },
  { id: "cable_fly", name: "Cable Fly", category: "push", equipment: "cable" },
  { id: "pec_deck", name: "Pec Deck", category: "push", equipment: "machine" },
  { id: "overhead_press", name: "Barbell Overhead Press", category: "push", equipment: "barbell" },
  { id: "dumbbell_shoulder_press", name: "Dumbbell Shoulder Press", category: "push", equipment: "dumbbell" },
  { id: "push_press", name: "Push Press", category: "push", equipment: "barbell" },
  { id: "arnold_press", name: "Arnold Press", category: "push", equipment: "dumbbell" },
  { id: "landmine_press", name: "Landmine Press", category: "push", equipment: "barbell", requiresEquipmentId: "landmine" },
  { id: "pike_push_up", name: "Pike Push-Up", category: "push", equipment: "bodyweight" },
  { id: "handstand_push_up", name: "Handstand Push-Up", category: "push", equipment: "bodyweight" },
  { id: "seated_dumbbell_press", name: "Seated Dumbbell Press", category: "push", equipment: "dumbbell" },
  // -- pull --
  { id: "barbell_row", name: "Barbell Row", category: "pull", equipment: "barbell" },
  { id: "pendlay_row", name: "Pendlay Row", category: "pull", equipment: "barbell" },
  { id: "dumbbell_row", name: "Dumbbell Row", category: "pull", equipment: "dumbbell" },
  { id: "cable_row", name: "Seated Cable Row", category: "pull", equipment: "cable" },
  { id: "chest_supported_row", name: "Chest-Supported Row", category: "pull", equipment: "dumbbell" },
  { id: "t_bar_row", name: "T-Bar Row", category: "pull", equipment: "machine" },
  { id: "meadows_row", name: "Meadows Row", category: "pull", equipment: "barbell" },
  { id: "inverted_row", name: "Inverted Row", category: "pull", equipment: "bodyweight" },
  { id: "pull_up", name: "Pull-Up", category: "pull", equipment: "bodyweight" },
  { id: "chin_up", name: "Chin-Up", category: "pull", equipment: "bodyweight" },
  { id: "weighted_pull_up", name: "Weighted Pull-Up", category: "pull", equipment: "bodyweight" },
  { id: "neutral_grip_pull_up", name: "Neutral-Grip Pull-Up", category: "pull", equipment: "bodyweight" },
  { id: "assisted_pull_up", name: "Assisted Pull-Up", category: "pull", equipment: "machine" },
  { id: "lat_pulldown", name: "Lat Pulldown", category: "pull", equipment: "cable" },
  { id: "close_grip_lat_pulldown", name: "Close-Grip Lat Pulldown", category: "pull", equipment: "cable" },
  { id: "straight_arm_pulldown", name: "Straight-Arm Pulldown", category: "pull", equipment: "cable" },
  { id: "face_pull", name: "Face Pull", category: "pull", equipment: "cable" },
  // -- single_leg --
  { id: "walking_lunge", name: "Walking Lunge", category: "single_leg", equipment: "dumbbell" },
  { id: "reverse_lunge", name: "Reverse Lunge", category: "single_leg", equipment: "dumbbell" },
  { id: "forward_lunge", name: "Forward Lunge", category: "single_leg", equipment: "dumbbell" },
  { id: "lateral_lunge", name: "Lateral Lunge", category: "single_leg", equipment: "dumbbell" },
  { id: "curtsy_lunge", name: "Curtsy Lunge", category: "single_leg", equipment: "dumbbell" },
  { id: "bulgarian_split_squat", name: "Bulgarian Split Squat", category: "single_leg", equipment: "dumbbell" },
  { id: "step_up", name: "Step-Up", category: "single_leg", equipment: "dumbbell" },
  { id: "pistol_squat", name: "Pistol Squat", category: "single_leg", equipment: "bodyweight" },
  { id: "skater_squat", name: "Skater Squat", category: "single_leg", equipment: "bodyweight" },
  { id: "single_leg_press", name: "Single-Leg Press", category: "single_leg", equipment: "machine" },
  // -- core --
  { id: "plank", name: "Plank", category: "core", equipment: "bodyweight", isTimed: true },
  { id: "side_plank", name: "Side Plank", category: "core", equipment: "bodyweight", isTimed: true },
  { id: "hanging_leg_raise", name: "Hanging Leg Raise", category: "core", equipment: "bodyweight" },
  { id: "hanging_knee_raise", name: "Hanging Knee Raise", category: "core", equipment: "bodyweight" },
  { id: "ab_wheel_rollout", name: "Ab Wheel Rollout", category: "core", equipment: "other" },
  { id: "cable_crunch", name: "Cable Crunch", category: "core", equipment: "cable" },
  { id: "sit_up", name: "Sit-Up", category: "core", equipment: "bodyweight" },
  { id: "weighted_situp", name: "Weighted Sit-Up", category: "core", equipment: "dumbbell" },
  { id: "russian_twist", name: "Russian Twist", category: "core", equipment: "bodyweight" },
  {
    id: "hollow_hold",
    name: "Hollow Hold",
    category: "core",
    equipment: "bodyweight",
    isTimed: true,
  },
  { id: "dead_bug", name: "Dead Bug", category: "core", equipment: "bodyweight" },
  { id: "bird_dog", name: "Bird Dog", category: "core", equipment: "bodyweight" },
  { id: "mountain_climber", name: "Mountain Climber", category: "core", equipment: "bodyweight" },
  { id: "v_up", name: "V-Up", category: "core", equipment: "bodyweight" },
  { id: "dragon_flag", name: "Dragon Flag", category: "core", equipment: "bodyweight" },
  { id: "pallof_press", name: "Pallof Press", category: "core", equipment: "cable" },
  // -- carry --
  { id: "farmers_carry", name: "Farmer's Carry", category: "carry", equipment: "dumbbell" },
  { id: "suitcase_carry", name: "Suitcase Carry", category: "carry", equipment: "dumbbell" },
  { id: "overhead_carry", name: "Overhead Carry", category: "carry", equipment: "dumbbell" },
  { id: "front_rack_carry", name: "Front-Rack Carry", category: "carry", equipment: "kettlebell" },
  { id: "yoke_walk", name: "Yoke Walk", category: "carry", equipment: "other" },
  // -- olympic --
  { id: "power_clean", name: "Power Clean", category: "olympic", equipment: "barbell" },
  { id: "hang_clean", name: "Hang Clean", category: "olympic", equipment: "barbell" },
  { id: "clean", name: "Clean", category: "olympic", equipment: "barbell" },
  { id: "power_snatch", name: "Power Snatch", category: "olympic", equipment: "barbell" },
  { id: "hang_snatch", name: "Hang Snatch", category: "olympic", equipment: "barbell" },
  { id: "snatch", name: "Snatch", category: "olympic", equipment: "barbell" },
  { id: "clean_and_jerk", name: "Clean and Jerk", category: "olympic", equipment: "barbell" },
  { id: "high_pull", name: "High Pull", category: "olympic", equipment: "barbell" },
  // -- arms --
  { id: "barbell_curl", name: "Barbell Curl", category: "arms", equipment: "barbell" },
  { id: "dumbbell_curl", name: "Dumbbell Curl", category: "arms", equipment: "dumbbell" },
  { id: "hammer_curl", name: "Hammer Curl", category: "arms", equipment: "dumbbell" },
  { id: "preacher_curl", name: "Preacher Curl", category: "arms", equipment: "barbell" },
  { id: "concentration_curl", name: "Concentration Curl", category: "arms", equipment: "dumbbell" },
  { id: "cable_curl", name: "Cable Curl", category: "arms", equipment: "cable" },
  { id: "overhead_tricep_extension", name: "Overhead Tricep Extension", category: "arms", equipment: "dumbbell" },
  { id: "skull_crusher", name: "Skull Crusher", category: "arms", equipment: "barbell" },
  { id: "tricep_pushdown", name: "Tricep Pushdown", category: "arms", equipment: "cable" },
  { id: "tricep_kickback", name: "Tricep Kickback", category: "arms", equipment: "dumbbell" },
  { id: "close_grip_pushup", name: "Close-Grip Push-Up", category: "arms", equipment: "bodyweight" },
  { id: "dip", name: "Dip (Triceps)", category: "arms", equipment: "bodyweight" },
  // -- shoulders --
  { id: "lateral_raise", name: "Lateral Raise", category: "shoulders", equipment: "dumbbell" },
  { id: "front_raise", name: "Front Raise", category: "shoulders", equipment: "dumbbell" },
  { id: "rear_delt_fly", name: "Rear Delt Fly", category: "shoulders", equipment: "dumbbell" },
  { id: "upright_row", name: "Upright Row", category: "shoulders", equipment: "barbell" },
  { id: "barbell_shrug", name: "Barbell Shrug", category: "shoulders", equipment: "barbell" },
  { id: "dumbbell_shrug", name: "Dumbbell Shrug", category: "shoulders", equipment: "dumbbell" },
  { id: "cable_lateral_raise", name: "Cable Lateral Raise", category: "shoulders", equipment: "cable" },
  // -- legs (isolation) --
  { id: "leg_extension", name: "Leg Extension", category: "legs", equipment: "machine" },
  { id: "seated_leg_curl", name: "Seated Leg Curl", category: "legs", equipment: "machine" },
  { id: "lying_leg_curl", name: "Lying Leg Curl", category: "legs", equipment: "machine" },
  { id: "standing_calf_raise", name: "Standing Calf Raise", category: "legs", equipment: "machine" },
  { id: "seated_calf_raise", name: "Seated Calf Raise", category: "legs", equipment: "machine" },
  { id: "hip_abduction_machine", name: "Hip Abduction Machine", category: "legs", equipment: "machine" },
  { id: "hip_adduction_machine", name: "Hip Adduction Machine", category: "legs", equipment: "machine" },
  { id: "glute_kickback", name: "Glute Kickback", category: "legs", equipment: "cable" },
  // -- conditioning --
  { id: "burpee", name: "Burpee", category: "conditioning", equipment: "bodyweight" },
  { id: "box_jump", name: "Box Jump", category: "conditioning", equipment: "box" },
  { id: "battle_ropes", name: "Battle Ropes", category: "conditioning", equipment: "other" },
  { id: "sled_push", name: "Sled Push", category: "conditioning", equipment: "other" },
  { id: "sled_pull", name: "Sled Pull", category: "conditioning", equipment: "other" },
  { id: "assault_bike", name: "Assault Bike", category: "conditioning", equipment: "machine" },
  { id: "jump_rope", name: "Jump Rope", category: "conditioning", equipment: "other" },
  { id: "rowing_machine", name: "Rowing Machine (Erg)", category: "conditioning", equipment: "machine" },
  // -- mobility --
  { id: "cat_cow", name: "Cat-Cow", category: "mobility", equipment: "bodyweight" },
  { id: "worlds_greatest_stretch", name: "World's Greatest Stretch", category: "mobility", equipment: "bodyweight" },
  { id: "hip_circles", name: "Hip Circles", category: "mobility", equipment: "bodyweight" },
  { id: "arm_circles", name: "Arm Circles", category: "mobility", equipment: "bodyweight" },
  { id: "band_pull_apart", name: "Band Pull-Apart", category: "mobility", equipment: "bands" },
  { id: "thoracic_rotation", name: "Thoracic Rotation", category: "mobility", equipment: "bodyweight" },
  { id: "couch_stretch", name: "Couch Stretch", category: "mobility", equipment: "bodyweight" },
  // -- extended curated library --
  { id: "smith_machine_incline_press", name: "Smith Machine Incline Press", category: "push", equipment: "machine" , requiresEquipmentId: "smith_machine" },
  { id: "smith_machine_flat_press", name: "Smith Machine Bench Press", category: "push", equipment: "machine" , requiresEquipmentId: "smith_machine" },
  { id: "incline_machine_chest_press", name: "Incline Chest Press Machine", category: "push", equipment: "machine" , requiresEquipmentId: "incline_chest_press_machine" },
  { id: "decline_machine_chest_press", name: "Decline Chest Press Machine", category: "push", equipment: "machine" , requiresEquipmentId: "decline_chest_press_machine" },
  { id: "single_arm_cable_chest_press", name: "Single-Arm Cable Chest Press", category: "push", equipment: "cable" },
  { id: "standing_cable_chest_press", name: "Standing Cable Chest Press", category: "push", equipment: "cable" },
  { id: "low_to_high_cable_fly", name: "Low-to-High Cable Fly", category: "push", equipment: "cable" },
  { id: "high_to_low_cable_fly", name: "High-to-Low Cable Fly", category: "push", equipment: "cable" },
  { id: "dumbbell_squeeze_press", name: "Dumbbell Squeeze Press", category: "push", equipment: "dumbbell" },
  { id: "single_arm_dumbbell_floor_press", name: "Single-Arm Dumbbell Floor Press", category: "push", equipment: "dumbbell" },
  { id: "kneeling_single_arm_lat_pulldown", name: "Kneeling Single-Arm Lat Pulldown", category: "pull", equipment: "cable" },
  { id: "neutral_grip_lat_pulldown", name: "Neutral-Grip Lat Pulldown", category: "pull", equipment: "cable" },
  { id: "underhand_lat_pulldown", name: "Underhand Lat Pulldown", category: "pull", equipment: "cable" },
  { id: "wide_grip_cable_row", name: "Wide-Grip Seated Cable Row", category: "pull", equipment: "cable" },
  { id: "single_arm_cable_row", name: "Single-Arm Cable Row", category: "pull", equipment: "cable" },
  { id: "chest_supported_t_bar_row", name: "Chest-Supported T-Bar Row", category: "pull", equipment: "machine" , requiresEquipmentId: "plate_loaded_chest_supported_t_bar" },
  { id: "iso_lateral_machine_row", name: "Iso-Lateral Machine Row", category: "pull", equipment: "machine" },
  { id: "dumbbell_meadows_row", name: "Meadows-Style Dumbbell Row", category: "pull", equipment: "dumbbell" },
  { id: "reverse_grip_barbell_row", name: "Reverse-Grip Barbell Row", category: "pull", equipment: "barbell" },
  { id: "incline_dumbbell_row", name: "Incline Bench Dumbbell Row", category: "pull", equipment: "dumbbell" },
  { id: "smith_machine_split_squat", name: "Smith Machine Split Squat", category: "single_leg", equipment: "machine" , requiresEquipmentId: "smith_machine" },
  { id: "rear_foot_elevated_split_squat", name: "Rear-Foot-Elevated Split Squat", category: "single_leg", equipment: "dumbbell" },
  { id: "dumbbell_step_down", name: "Dumbbell Step-Down", category: "single_leg", equipment: "dumbbell" },
  { id: "lateral_lunge_dumbbell", name: "Dumbbell Lateral Lunge", category: "single_leg", equipment: "dumbbell" },
  { id: "walking_barbell_lunge", name: "Barbell Walking Lunge", category: "single_leg", equipment: "barbell" },
  { id: "reverse_hack_squat", name: "Reverse Hack Squat", category: "squat", equipment: "machine" , requiresEquipmentId: "hack_squat_machine" },
  { id: "heel_elevated_goblet_squat", name: "Heel-Elevated Goblet Squat", category: "squat", equipment: "dumbbell" },
  { id: "cyclist_squat", name: "Cyclist Squat", category: "squat", equipment: "bodyweight" },
  { id: "dumbbell_sumo_squat", name: "Dumbbell Sumo Squat", category: "squat", equipment: "dumbbell" },
  { id: "single_leg_leg_press", name: "Single-Leg Leg Press", category: "legs", equipment: "machine" , requiresEquipmentId: "leg_press_machine" },
  { id: "single_leg_leg_extension", name: "Single-Leg Leg Extension", category: "legs", equipment: "machine" , requiresEquipmentId: "leg_extension_machine" },
  { id: "single_leg_seated_leg_curl", name: "Single-Leg Seated Leg Curl", category: "legs", equipment: "machine" , requiresEquipmentId: "leg_curl_machine" },
  { id: "single_leg_lying_leg_curl", name: "Single-Leg Lying Leg Curl", category: "legs", equipment: "machine" , requiresEquipmentId: "leg_curl_machine" },
  { id: "dumbbell_staggered_stance_rdl", name: "Staggered-Stance Dumbbell RDL", category: "hinge", equipment: "dumbbell" },
  { id: "single_leg_dumbbell_rdl", name: "Single-Leg Dumbbell Romanian Deadlift", category: "hinge", equipment: "dumbbell" },
  { id: "smith_machine_romanian_deadlift", name: "Smith Machine Romanian Deadlift", category: "hinge", equipment: "machine" , requiresEquipmentId: "smith_machine" },
  { id: "barbell_good_morning_seated", name: "Seated Barbell Good Morning", category: "hinge", equipment: "barbell" },
  { id: "machine_lateral_raise", name: "Lateral Raise Machine", category: "shoulders", equipment: "machine" },
  { id: "leaning_cable_lateral_raise", name: "Leaning Cable Lateral Raise", category: "shoulders", equipment: "cable" },
  { id: "single_arm_cable_rear_delt_fly", name: "Single-Arm Cable Rear Delt Fly", category: "shoulders", equipment: "cable" },
  { id: "incline_dumbbell_rear_delt_raise", name: "Incline Dumbbell Rear Delt Raise", category: "shoulders", equipment: "dumbbell" },
  { id: "single_arm_landmine_press", name: "Single-Arm Landmine Press", category: "shoulders", equipment: "barbell" },
  { id: "bayesian_cable_curl", name: "Bayesian Cable Curl", category: "arms", equipment: "cable" },
  { id: "cross_body_hammer_curl", name: "Cross-Body Hammer Curl", category: "arms", equipment: "dumbbell" },
  { id: "machine_preacher_curl", name: "Machine Preacher Curl", category: "arms", equipment: "machine" , requiresEquipmentId: "preacher_curl_machine" },
  { id: "single_arm_cable_triceps_extension", name: "Single-Arm Cable Triceps Extension", category: "arms", equipment: "cable" },
  { id: "cross_body_cable_triceps_extension", name: "Cross-Body Cable Triceps Extension", category: "arms", equipment: "cable" },
  { id: "dumbbell_tate_press", name: "Dumbbell Tate Press", category: "arms", equipment: "dumbbell" },
  { id: "weighted_dead_bug", name: "Weighted Dead Bug", category: "core", equipment: "dumbbell" },
  { id: "cable_pallof_press", name: "Cable Pallof Press", category: "core", equipment: "cable" },
  { id: "kneeling_cable_crunch", name: "Kneeling Cable Crunch", category: "core", equipment: "cable" },
  { id: "hollow_body_rock", name: "Hollow-Body Rock", category: "core", equipment: "bodyweight" },
  { id: "dumbbell_suitcase_carry", name: "Dumbbell Suitcase Carry", category: "carry", equipment: "dumbbell" },
  { id: "single_arm_overhead_carry", name: "Single-Arm Dumbbell Overhead Carry", category: "carry", equipment: "dumbbell" },
];

for (const exercise of EXERCISE_LIBRARY) {
  exercise.muscles = musclesForExercise(exercise.id);
}

export const EFFORT_LEVELS = ["easy", "moderate", "hard", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const WORKOUT_STATUSES = ["planned", "active", "completed", "skipped"] as const;
export type WorkoutStatus = (typeof WORKOUT_STATUSES)[number];

export interface WorkoutSet {
  manualWeight?: boolean;
  recordedByProfileId?: string | null;
  plannedReps: number | null;
  plannedWeight: number | null;
  actualReps: number | null;
  actualWeight: number | null;
  completed: boolean;
  /** Rep-aware strength PR metadata from the backend (estimated 1RM). */
  isPersonalRecord?: boolean;
  personalRecordValue?: number | null;
  previousPersonalRecord?: number | null;
}

export interface WorkoutExercise {
  restSeconds?: number | null;
  exerciseId: string;
  sets: WorkoutSet[];
  notes: string;
  /** Asked once, after every set in the exercise is logged, rather than
   * per set -- see ha-gains-integration's WorkoutExercise docstring. */
  effort: Effort | null;
  /** Physical bar selected for this barbell exercise. Set weight remains
   * total lifted weight including the bar. */
  selectedBarEquipmentId?: string | null;
  selectedBarWeight?: number | null;
}

export interface Workout {
  jointSession?: import("./joint-session").JointSession;
  currentExerciseIndex?: number;
  currentSetIndex?: number;
  revision?: number;
  id: string;
  profileId: string;
  name: string;
  status: WorkoutStatus;
  exercises: WorkoutExercise[];
  notes: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export const RUN_STATUSES = ["planned", "completed", "skipped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TYPES = ["easy", "tempo", "interval", "long"] as const;
export type RunType = (typeof RUN_TYPES)[number];

// Run (Strength MVP's running counterpart): logged as a whole after the
// fact (distance + duration), not set-by-set like a Workout -- there's no
// "active" status, just planned -> completed/skipped.
export interface Run {
  segments?: RunSegment[];
  id: string;
  profileId: string;
  name: string;
  runType: RunType;
  status: RunStatus;
  targetDistance: number | null;
  targetDurationMinutes: number | null;
  actualDistance: number | null;
  actualDurationMinutes: number | null;
  notes: string;
  createdAt: string;
  completedAt: string | null;
}

// Ask Geoffrey (partial Phase 8): the AI only ever proposes -- it never calls
// create_workout/create_run itself. A single reply can propose several
// workouts and/or runs at once (a multi-day plan), each validated
// independently by the backend (logic.validate_proposed_workouts against
// the exercise library, logic.validate_proposed_runs against RUN_TYPES) so
// any single accepted entry can be handed straight to
// gainsApi.createWorkout/createRun.
export interface ProposedWorkoutSet {
  reps: number | null;
  weight: number | null;
}

export interface ProposedWorkoutExercise {
  exerciseId: string;
  sets: ProposedWorkoutSet[];
}

export interface ProposedWorkout {
  name: string;
  exercises: ProposedWorkoutExercise[];
}

export interface ProposedRun {
  segments?: RunSegment[];
  name: string;
  runType: RunType;
  targetDistance: number | null;
  targetDurationMinutes: number | null;
}

export interface AICoachMessage {
  actions?: GeoffreyAction[];
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  proposedWorkouts: ProposedWorkout[];
  proposedRuns: ProposedRun[];
}

export interface GainsState {
  muscleRecovery?: import("./recovery").MuscleRecovery;
  /** The current viewer's own profile, or null if gains.ensure_profile
   * hasn't resolved yet (first render, before the ensure round-trip). */
  profile: AthleteProfile | null;
  profileCount: number;
  /** The current viewer's own workouts, newest last (creation order). */
  workouts: Workout[];
  /** The current viewer's own runs, newest last (creation order). */
  runs: Run[];
  /** Every gym profile on this instance -- shared, not scoped to the
   * viewer, so any member can select or edit any of them. */
  gymProfiles: GymProfile[];
}

// Equipment (checked per GymProfile, see above): mirrors
// ha-gains-integration's equipment.py EQUIPMENT_CATALOG -- kept in sync by
// hand (no shared schema between the two repos). gains.create_gym_profile /
// gains.update_gym_profile validate equipment_id against the backend's copy
// of this same list. equipmentCategory maps back to
// ExerciseDef's broad `equipment` tag so the Ask Geoffrey (and eventually the
// exercise picker) can tell which broad categories of exercise this
// athlete's checked equipment actually unlocks.
export interface EquipmentItem {
  id: string;
  name: string;
  category: string;
  equipmentCategory: string;
  defaultWeight: number | null;
}

export const EQUIPMENT_CATALOG: EquipmentItem[] = [
  // -- machines --
  { id: "ab_crunch_machine", name: "Ab Crunch Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "abductor_machine", name: "Abductor Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "adductor_machine", name: "Adductor Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "assisted_weight_machine", name: "Assisted Weight Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "bench_press_machine", name: "Bench Press Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "bicep_curl_machine", name: "Bicep Curl Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "calf_raise_machine", name: "Calf Raise Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "fly_machine", name: "Fly Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "leg_curl_machine", name: "Leg Curl Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "leg_extension_machine", name: "Leg Extension Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "leg_press_machine", name: "Leg Press Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "incline_chest_press_machine", name: "Incline Chest Press Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "decline_chest_press_machine", name: "Decline Chest Press Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "hack_squat_machine", name: "Hack Squat Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "glute_machine", name: "Glute Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "hip_thrust_machine", name: "Hip Thrust Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "pec_deck_machine", name: "Pec Deck Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "preacher_curl_machine", name: "Preacher Curl Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "rear_delt_machine", name: "Rear Delt Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "torso_rotation_machine", name: "Torso Rotation Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 10 },
  { id: "smith_machine", name: "Smith Machine", category: "machines", equipmentCategory: "machine", defaultWeight: 15 },

  // -- cable machines --
  { id: "crossover_cable", name: "Crossover Cable", category: "cable_machines", equipmentCategory: "cable", defaultWeight: null },
  { id: "hi_lo_pull_cable", name: "Hi Lo Pull Cable", category: "cable_machines", equipmentCategory: "cable", defaultWeight: null },
  { id: "lat_pulldown_cable", name: "Lat Pulldown Cable", category: "cable_machines", equipmentCategory: "cable", defaultWeight: null },
  { id: "row_cable", name: "Row Cable", category: "cable_machines", equipmentCategory: "cable", defaultWeight: null },
  { id: "cable_tower", name: "Cable Tower", category: "cable_machines", equipmentCategory: "cable", defaultWeight: null },

  // -- plate-loaded machines --
  { id: "plate_loaded_t_bar", name: "Plate-Loaded T Bar Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 22 },
  { id: "plate_loaded_lat_pulldown", name: "Plate-Loaded Lat Pulldown Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 22 },
  { id: "plate_loaded_chest_press", name: "Plate-Loaded Chest Press Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 12 },
  { id: "plate_loaded_preacher", name: "Plate-Loaded Preacher Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 11 },
  { id: "plate_loaded_seated_calf", name: "Plate-Loaded Seated Calf Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 11 },
  { id: "plate_loaded_glute", name: "Plate-Loaded Glute Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 22 },
  { id: "plate_loaded_hip_thrust", name: "Plate-Loaded Hip Thrust Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 22 },
  { id: "plate_loaded_chest_supported_t_bar", name: "Plate-Loaded Chest Supported T Bar", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 22 },
  { id: "plate_loaded_ab_crunch", name: "Plate-Loaded Ab Crunch Machine", category: "plate_loaded_machines", equipmentCategory: "machine", defaultWeight: 11 },

  // -- bars and plates --
  { id: "olympic_barbell", name: "Olympic Barbell", category: "bars_and_plates", equipmentCategory: "barbell", defaultWeight: 45 },
  { id: "ez_bar", name: "EZ Bar", category: "bars_and_plates", equipmentCategory: "barbell", defaultWeight: 22 },
  { id: "trap_bar", name: "Trap Bar", category: "bars_and_plates", equipmentCategory: "barbell", defaultWeight: 55 },
  { id: "short_bar", name: "Short Bar", category: "bars_and_plates", equipmentCategory: "barbell", defaultWeight: 20 },
  { id: "safety_squat_bar", name: "Safety Squat Bar", category: "bars_and_plates", equipmentCategory: "barbell", defaultWeight: 60 },
  { id: "landmine", name: "Landmine", category: "bars_and_plates", equipmentCategory: "barbell", defaultWeight: null },
  { id: "plates", name: "Plates", category: "bars_and_plates", equipmentCategory: "barbell", defaultWeight: null },

  // -- small weights --
  { id: "dumbbells", name: "Dumbbells", category: "small_weights", equipmentCategory: "dumbbell", defaultWeight: null },
  { id: "kettlebells", name: "Kettlebells", category: "small_weights", equipmentCategory: "kettlebell", defaultWeight: null },
  { id: "wrist_ankle_weights", name: "Wrist/Ankle Weights", category: "small_weights", equipmentCategory: "other", defaultWeight: null },

  // -- racks and benches --
  { id: "squat_rack", name: "Squat Rack", category: "racks_and_benches", equipmentCategory: "barbell", defaultWeight: null },
  { id: "power_rack", name: "Power Rack", category: "racks_and_benches", equipmentCategory: "barbell", defaultWeight: null },
  { id: "flat_bench", name: "Flat Bench", category: "racks_and_benches", equipmentCategory: "other", defaultWeight: null },
  { id: "incline_bench", name: "Incline Bench", category: "racks_and_benches", equipmentCategory: "other", defaultWeight: null },
  { id: "decline_bench", name: "Decline Bench", category: "racks_and_benches", equipmentCategory: "other", defaultWeight: null },
  { id: "vertical_bench", name: "Vertical Bench", category: "racks_and_benches", equipmentCategory: "other", defaultWeight: null },
  { id: "dip_station", name: "Dip Station", category: "racks_and_benches", equipmentCategory: "bodyweight", defaultWeight: null },
  { id: "pull_up_bar", name: "Pull-Up Bar", category: "racks_and_benches", equipmentCategory: "bodyweight", defaultWeight: null },

  // -- balls and accessories --
  { id: "ab_wheel", name: "Ab Wheel", category: "balls_and_accessories", equipmentCategory: "other", defaultWeight: null },
  { id: "box", name: "Box", category: "balls_and_accessories", equipmentCategory: "box", defaultWeight: null },
  { id: "medicine_ball", name: "Medicine Ball", category: "balls_and_accessories", equipmentCategory: "other", defaultWeight: null },
  { id: "stability_ball", name: "Stability Ball", category: "balls_and_accessories", equipmentCategory: "other", defaultWeight: null },
  { id: "tire", name: "Tire", category: "balls_and_accessories", equipmentCategory: "other", defaultWeight: null },
  { id: "trx", name: "TRX", category: "balls_and_accessories", equipmentCategory: "bodyweight", defaultWeight: null },
  { id: "foam_roller", name: "Foam Roller", category: "balls_and_accessories", equipmentCategory: "other", defaultWeight: null },
  { id: "resistance_bands", name: "Resistance Bands", category: "balls_and_accessories", equipmentCategory: "bands", defaultWeight: null },

  // -- rope --
  { id: "battle_ropes", name: "Battle Ropes", category: "rope", equipmentCategory: "other", defaultWeight: null },
  { id: "skipping_rope", name: "Skipping Rope", category: "rope", equipmentCategory: "bodyweight", defaultWeight: null },

  // -- cardio --
  { id: "treadmill", name: "Treadmill", category: "cardio", equipmentCategory: "other", defaultWeight: null },
  { id: "stationary_bike", name: "Stationary Bike", category: "cardio", equipmentCategory: "other", defaultWeight: null },
  { id: "rowing_machine", name: "Rowing Machine", category: "cardio", equipmentCategory: "other", defaultWeight: null },
  { id: "elliptical", name: "Elliptical", category: "cardio", equipmentCategory: "other", defaultWeight: null },
  { id: "stair_climber", name: "Stair Climber", category: "cardio", equipmentCategory: "other", defaultWeight: null },
  { id: "assault_bike", name: "Assault Bike", category: "cardio", equipmentCategory: "other", defaultWeight: null },
  ...Object.entries({
    ankle_cable_strap: "Ankle Cable Strap",
    lat_bar: "Lat Pulldown Bar", close_grip_handle: "Close Grip Cable Handle",
    straight_cable_bar: "Straight Cable Bar", rope_attachment: "Cable Rope Attachment",
    cable_handle: "Single Cable Handle", dip_belt: "Dip Belt",
    neutral_grip_pull_up_bar: "Neutral Grip Pull-Up Bar", preacher_bench: "Preacher Bench",
    back_extension_bench: "Back Extension Bench", lifting_platform: "Deficit Lifting Platform",
    yoke: "Yoke", lateral_raise_machine: "Lateral Raise Machine",
  }).map(([id, name]) => ({ id, name, category: "balls_and_accessories", equipmentCategory: "other", defaultWeight: null })),
];

export const EQUIPMENT_CATEGORY_LABELS: Record<string, string> = {
  machines: "Machines",
  cable_machines: "Cable Machines",
  plate_loaded_machines: "Plate-Loaded Machines",
  bars_and_plates: "Bars and Plates",
  small_weights: "Small Weights",
  racks_and_benches: "Racks and Benches",
  balls_and_accessories: "Balls and Accessories",
  rope: "Rope",
  cardio: "Cardio",
};


