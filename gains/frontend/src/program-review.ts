import type { ProgramPrescription } from "./training-types";

/** A generated lifting session must arrive filled in, never as a manual-entry task. */
export function programNeedsExercises(program: ProgramPrescription): boolean {
  return !program.weeks?.length || program.weeks.some(week => !week.sessions?.length || week.sessions.some(session => {
    if (!["workout", "hiit", "conditioning"].includes(session.type)) return false;
    const prescription = session.prescription as { exercises?: { sets?: unknown[] }[] };
    return !prescription.exercises?.length || prescription.exercises.some(exercise => !exercise.sets?.length);
  }));
}
