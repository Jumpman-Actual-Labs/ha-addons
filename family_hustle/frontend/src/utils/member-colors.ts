import type { MemberRosterEntry } from "../types";

/* Skylight-style soft pastels, one per family member (in roster order)
 * unless a parent picked an avatar color for them in Settings. */
const PASTELS = [
  "#7fc8c0", // teal
  "#f19a9a", // coral
  "#b39ddb", // lavender
  "#f6b26b", // apricot
  "#9ccc65", // leaf
  "#81b4e6", // sky
  "#f48fb1", // pink
  "#d7b98e", // sand
];

export const UNTAGGED_COLOR = "#a8b3c2";

export function memberColor(roster: MemberRosterEntry[], memberId: string | null | undefined): string {
  if (!memberId) return UNTAGGED_COLOR;
  const active = roster.filter((m) => m.active);
  const index = active.findIndex((m) => m.id === memberId);
  const member = active[index] ?? roster.find((m) => m.id === memberId);
  if (member?.avatarColor) return member.avatarColor;
  return index >= 0 ? PASTELS[index % PASTELS.length] : UNTAGGED_COLOR;
}

export function initials(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}
