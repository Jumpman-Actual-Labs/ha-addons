import type { HustleState } from "../types";

/** Resolves a member_id to its Home Assistant display name via the member
 * roster sensor. Falls back to the raw id only if the roster hasn't loaded
 * yet or the member was somehow deleted - member ids should never be shown
 * to users otherwise, they're an internal linking key to HA accounts. */
export function memberName(state: HustleState, memberId: string | null | undefined): string {
  if (!memberId) return "";
  return state.memberRoster.find((m) => m.id === memberId)?.haDisplayName ?? memberId;
}
