import { afterAll, describe, expect, it } from "vitest";
import "@/core/events/subscribers";
import { db } from "@/core/db";
import { publish } from "@/core/events/bus";
import { dispatchBatch } from "@/core/events/dispatcher";
import { subscribe } from "@/core/events/registry";
import { notify } from "@/core/notifications/notify";
import { resolveAudience } from "@/core/notifications/audience";
import { sendPendingEmails } from "@/core/notifications/deliver";
import { runDueJobs, defineJob } from "@/core/jobs/scheduler";
import { makeUser } from "./helpers";

afterAll(() => db.$disconnect());

describe("event bus", () => {
  it("delivers a published event to the welcome subscriber exactly once", async () => {
    const user = await makeUser({ locale: "ar" });
    await db.$transaction((tx) => publish(tx, "user.created", { userId: user.id }));
    await dispatchBatch();
    await dispatchBatch(); // nothing left

    const notes = await db.notification.findMany({ where: { userId: user.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("مرحباً بك في نظام إدارة الجودة"); // user's language
    const event = await db.domainEvent.findFirstOrThrow({ where: { type: "user.created", payload: { equals: { userId: user.id } } } });
    expect(event.status).toBe("PROCESSED");
  });

  it("does not save the event when the transaction rolls back", async () => {
    const user = await makeUser();
    await expect(
      db.$transaction(async (tx) => {
        await publish(tx, "user.deactivated", { userId: user.id });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.domainEvent.count({ where: { type: "user.deactivated" } })).toBe(0);
  });

  it("retries a failing handler with backoff, then marks the event FAILED", async () => {
    subscribe("test.always_fails", "test.fail", async () => {
      throw new Error("boom");
    });
    const e = await db.domainEvent.create({ data: { type: "test.always_fails", payload: {} } });
    await dispatchBatch();
    let after = await db.domainEvent.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain("boom");
    expect(after.availableAt.getTime()).toBeGreaterThan(Date.now());

    await db.domainEvent.update({ where: { id: e.id }, data: { attempts: 8, availableAt: new Date(0) } });
    await dispatchBatch();
    after = await db.domainEvent.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.status).toBe("FAILED");
  });

  it("raises an alert from an external event's alert envelope", async () => {
    const director = await makeUser({ roleKey: "QUALITY_DIRECTOR" });
    await db.domainEvent.create({
      data: {
        type: "external.fms.work_order.overdue",
        source: "fms",
        externalId: "WO-1",
        chapterCode: "FMS",
        payload: { alert: { severity: "CRITICAL", title: { ar: "عطل", en: "Breakdown" } } },
      },
    });
    await dispatchBatch();
    const note = await db.notification.findFirstOrThrow({ where: { userId: director.id, type: "integration.alert" } });
    expect(note).toMatchObject({ title: "Breakdown", severity: "CRITICAL", chapterCode: "FMS" });
  });
});

describe("notifications", () => {
  it("resolves audiences by role, department and department head", async () => {
    const dep = await db.department.create({ data: { code: `D${Date.now()}`, nameEn: "D", nameAr: "د" } });
    const member = await makeUser({ departmentId: dep.id });
    const head = await makeUser();
    await db.department.update({ where: { id: dep.id }, data: { headId: head.id } });
    const coordinator = await makeUser({ roleKey: "QUALITY_COORDINATOR" });

    expect(await resolveAudience(db, { departmentIds: [dep.id] })).toEqual([member.id]);
    expect(await resolveAudience(db, { departmentHeadsOf: [dep.id] })).toEqual([head.id]);
    expect(await resolveAudience(db, { roleKeys: ["QUALITY_COORDINATOR"] })).toContain(coordinator.id);
  });

  it("is idempotent per event and respects e-mail preferences", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await db.notificationPreference.create({ data: { userId: b.id, type: "system.welcome", inApp: true, email: false } });
    const input = {
      type: "system.welcome",
      audience: { userIds: [a.id, b.id] },
      title: { ar: "أ", en: "A" },
      eventId: `evt-${Date.now()}`,
    };
    expect(await notify(db, input)).toBe(2);
    expect(await notify(db, input)).toBe(0); // same event again → no duplicates

    const deliveries = await db.notificationDelivery.findMany({ where: { notification: { userId: { in: [a.id, b.id] } } }, include: { notification: true } });
    expect(deliveries.map((d) => d.notification.userId)).toEqual([a.id]);
  });

  it("marks e-mails SKIPPED when SMTP is not configured", async () => {
    const u = await makeUser();
    await notify(db, { type: "system.welcome", audience: { userIds: [u.id] }, title: { ar: "أ", en: "A" } });
    await sendPendingEmails();
    const d = await db.notificationDelivery.findFirstOrThrow({ where: { notification: { userId: u.id } } });
    expect(d.status).toBe("SKIPPED");
  });
});

describe("scheduler", () => {
  it("runs a job once per interval", async () => {
    let runs = 0;
    const job = defineJob({ name: `test.job.${Date.now()}`, everyMinutes: 60, run: async () => void runs++ });
    const now = new Date();
    await runDueJobs([job], now);
    await runDueJobs([job], new Date(now.getTime() + 30 * 60_000));
    expect(runs).toBe(1);
    await runDueJobs([job], new Date(now.getTime() + 61 * 60_000));
    expect(runs).toBe(2);
  });
});
