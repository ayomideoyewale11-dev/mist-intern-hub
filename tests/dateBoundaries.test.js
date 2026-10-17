const { isOverdue, isPastDate } = require("../config/taskStatus");
const { hasEnded } = require("../config/accounts");

describe("Lagos calendar date boundaries", () => {
  afterEach(() => jest.useRealTimers());

  it("keeps a task due today open through the last second of the day", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-16T22:59:59.000Z"));

    const task = { dueDate: new Date("2026-10-16T00:00:00.000Z") };
    expect(isOverdue(task)).toBe(false);
    expect(isPastDate(task.dueDate)).toBe(false);
  });

  it("marks a task overdue at midnight at the start of the next Lagos day", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-16T23:00:00.000Z"));

    const task = { dueDate: new Date("2026-10-16T00:00:00.000Z") };
    expect(isOverdue(task)).toBe(true);
    expect(isPastDate(task.dueDate)).toBe(true);
  });

  it("keeps an intern active through the final second of their end date", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-16T22:59:59.000Z"));

    expect(hasEnded(new Date("2026-10-16T00:00:00.000Z"))).toBe(false);
  });

  it("ends internship access at midnight at the start of the next Lagos day", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-16T23:00:00.000Z"));

    expect(hasEnded(new Date("2026-10-16T00:00:00.000Z"))).toBe(true);
  });
});
