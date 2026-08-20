// One channel-neutral source of customer outcome language. Capability-specific
// delivery channels are named only after a real communication grant exists.
export const CUSTOMER_OUTCOME = {
  needsTeam: "Tell the caller the team will confirm and contact them shortly.",
  bookingPending: "Tell the caller the team is confirming the appointment and will contact them shortly. Do not say it is booked yet.",
  bookingConfirmed: "Tell the caller the appointment is booked and repeat the date, time, and public price.",
  bookingAlreadyConfirmed: "Tell the caller the appointment is already confirmed.",
  scheduleUnreadable: "Tell the caller you cannot confirm the schedule right now, take their preferred time and contact, and say the team will confirm.",
  noSlots: "Tell the caller nothing is open in the next few days and offer to have the team contact them with options.",
} as const;
