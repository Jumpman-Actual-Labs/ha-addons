# Muscle maps

The geometry in `src/components/muscle-map.ts` was authored for this redesign from simple vector paths. No diagram from Strong, Muscle & Motion, Wikipedia, or another asset library was copied or embedded. It is a stylized group-level illustration, not a medical atlas. The repository has no declared license; these additions do not grant a separate CC0 or open-source license. Choose a repository license before distributing source as open source. Any future replacement artwork must have an explicit license permitting modification and redistribution, with required attribution retained.

`src/data/muscles.json` is mirrored exactly in `ha-gains-integration/custom_components/gains/muscles.json`. Update both files and bump `catalogVersion` when mappings change. Exercise IDs remain stable. Each exercise has optional `muscles: { primary: MuscleId[], secondary: MuscleId[] }`; muscle IDs map to display labels and anatomical descriptions. Group aliases (forearms, gluteals, calves) intentionally cover multiple anatomical muscles. Category remains a movement-pattern tag, independent of anatomy.

Mappings describe typical technique, not measured activation, recovery, fatigue, or personalized coaching. They need trainer/anatomy review before being treated as authoritative. Mobility-only movements are left unmapped instead of misrepresenting stretching as strength involvement. Unknown exercises display an unavailable state; partially mapped workouts disclose the mapped count.

Workout coverage takes the union of primary and secondary roles, with primary winning if a muscle occurs in both. Completed summaries include only exercises with at least one logged set. Planned and active overviews show the full plan. This is not volume weighting.

The full component offers front/back views, a text legend, named targets, and patterned secondary regions. Compact list illustrations are decorative; open the workout for the complete legend and back view. Body geometry is shared by all athletes and does not infer sex, body composition, or age.

# Scope and verification

This change implements Today, a separate Workouts library, the workout overview and logging flow, bottom navigation with a desktop rail, solid light/dark surfaces, and the muscle component. Runs, Coach, gym management and account settings retain their existing functions with shared visual tokens. Account linking still copies planned workouts; it does not switch the logged-in Home Assistant actor. Session drafts and rest deadlines are stored per profile in sessionStorage (this browser tab only), with an in-memory fallback when storage is unavailable.

Validation: production build, TypeScript, ESLint, and a browser fixture exercising failed/successful set saves, navigation, reload persistence, and front/back rendering. The fixture substitutes Home Assistant services and elements; verify actual dialogs, shell sizing, and service latency on a Home Assistant test instance before merging. This branch does not deploy automatically; main does.
