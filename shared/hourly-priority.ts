/**
 * Hourly-booking capsule ordering (owner decisions 21/7 + 24/7): which
 * capsule do we PREFER to sell by the hour?
 *
 * 24/7 semantics ("Add to priority"): the flag no longer defines WHAT is
 * sellable — it marks capsules to fill FIRST, but only once the other
 * criteria are met. Readiness gates the flag: an Inspected non-priority
 * capsule beats a Dirty priority capsule; among equally ready capsules the
 * priority-marked one always wins, then the one free for the rest of the day
 * (less turnover pressure). Dirty is still sellable — housekeeping gets an
 * automatic SMS on booking.
 *
 * ONE implementation shared by the admin inventory view and the server's
 * allocation ordering — a drifted copy would sell different capsules than
 * the overview shows.
 */

export function readinessRank(state: string | null | undefined): number {
  return state === "Inspected" ? 0 : state === "Clean" ? 1 : 2;
}

export function priorityScore(opts: {
  /** The capsule's priority flag (rooms.hourly_pool — kept as DB name). */
  priority: boolean;
  state: string | null | undefined;
  freeRestOfDay: boolean;
}): number {
  return readinessRank(opts.state) * 100 + (opts.priority ? 0 : 10) + (opts.freeRestOfDay ? 0 : 1);
}
