import { describe, expect, test } from "bun:test";

type Outcome = "ended" | "startup_error" | "killed_deadline" | "killed_budget" | "error";
type Reservation = {
  id: string; callId: string; day: string; reserved: number; status: "active" | "settled";
  actual: number; outcome?: Outcome; ledgerKinds: string[];
};

/** Deterministic contract fixture for the SQL transaction; it is not a Postgres substitute. */
class BudgetSqlFixture {
  private reservations = new Map<string, Reservation>();
  private lock: Promise<void> = Promise.resolve();
  constructor(private readonly cap: number, private readonly timezone: string) {}

  private day(at: Date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.timezone }).format(at);
  }

  async reserve(callId: string, estimate: number, at: Date) {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const existing = this.reservations.get(callId);
      if (existing) return existing;
      const day = this.day(at);
      const committed = [...this.reservations.values()]
        .filter((reservation) => reservation.day === day)
        .reduce((sum, reservation) => sum + (reservation.status === "active" ? reservation.reserved : reservation.actual), 0);
      if (committed + estimate > this.cap) throw new Error("budget_exceeded");
      const reservation: Reservation = {
        id: `reservation-${this.reservations.size + 1}`, callId, day, reserved: estimate,
        status: "active", actual: 0, ledgerKinds: ["reservation"],
      };
      this.reservations.set(callId, reservation);
      return reservation;
    } finally {
      release();
    }
  }

  async settle(callId: string, actual: number, outcome: Outcome) {
    const reservation = this.reservations.get(callId);
    if (!reservation) throw new Error("reservation_not_found");
    if (reservation.status === "settled") return reservation;
    reservation.status = "settled";
    reservation.actual = actual;
    reservation.outcome = outcome;
    reservation.ledgerKinds.push("adjustment", "usage");
    return reservation;
  }
}

describe("budget SQL transaction fixture", () => {
  test("serializes concurrent reservations so only one can cross the cap", async () => {
    const fixture = new BudgetSqlFixture(10, "America/Los_Angeles");
    const at = new Date("2026-08-20T17:00:00Z");

    const results = await Promise.allSettled([
      fixture.reserve("call-a", 6, at),
      fixture.reserve("call-b", 6, at),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("uses the tenant-local date instead of the UTC date", async () => {
    const fixture = new BudgetSqlFixture(10, "America/Los_Angeles");
    const beforeMidnight = await fixture.reserve("call-a", 6, new Date("2026-08-21T06:30:00Z"));
    const afterMidnight = await fixture.reserve("call-b", 6, new Date("2026-08-21T07:30:00Z"));

    expect(beforeMidnight.day).toBe("2026-08-20");
    expect(afterMidnight.day).toBe("2026-08-21");
  });

  test("settlement releases the estimate, charges actual cost, and is idempotent", async () => {
    const fixture = new BudgetSqlFixture(10, "America/Los_Angeles");
    const at = new Date("2026-08-20T17:00:00Z");
    await fixture.reserve("call-a", 6, at);

    const first = await fixture.settle("call-a", 1, "ended");
    const repeated = await fixture.settle("call-a", 9, "error");
    const next = await fixture.reserve("call-b", 9, at);

    expect(repeated).toBe(first);
    expect(repeated.actual).toBe(1);
    expect(repeated.outcome).toBe("ended");
    expect(repeated.ledgerKinds).toEqual(["reservation", "adjustment", "usage"]);
    expect(next.status).toBe("active");
  });
});
