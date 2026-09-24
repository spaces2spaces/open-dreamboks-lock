// Topics for the "Vejledning" staff guide. Lives outside ManualPage so the
// sidebar (DashboardLayout) can render the sub-menu without pulling the whole
// guide content into the shared bundle.
export const MANUAL_TOPICS = [
  { slug: "overnatning", label: "Overnatning & dørkoder", hourlyOnly: false },
  { slug: "tidsbooking", label: "Time-booking", hourlyOnly: true },
  { slug: "early-late", label: "Early & Late check-out", hourlyOnly: false },
  { slug: "mersalg", label: "Mersalgs-SMS", hourlyOnly: false },
  { slug: "regler", label: "Gyldne regler & alarmer", hourlyOnly: false },
] as const;
