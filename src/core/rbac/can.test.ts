import { describe, expect, it } from "vitest";
import { can, canSomewhere, permissionMatches, type Grant } from "./can";

describe("permissionMatches", () => {
  it("matches exact, global and area wildcards", () => {
    expect(permissionMatches("users.view", "users.view")).toBe(true);
    expect(permissionMatches("*", "anything.at_all")).toBe(true);
    expect(permissionMatches("users.*", "users.manage")).toBe(true);
    expect(permissionMatches("users.*", "usersx.manage")).toBe(false);
    expect(permissionMatches("users.view", "users.manage")).toBe(false);
  });
});

describe("can", () => {
  const admin: Grant[] = [{ permissions: ["*"] }];
  const ipcLead: Grant[] = [{ permissions: ["documents.*"], chapterCode: "IPC" }];
  const nursingHead: Grant[] = [{ permissions: ["incidents.view"], departmentId: "dep-nursing" }];

  it("lets an unscoped wildcard do everything", () => {
    expect(can(admin, "users.manage")).toBe(true);
    expect(can(admin, "documents.approve", { chapterCode: "LD" })).toBe(true);
  });

  it("limits chapter-scoped grants to their chapter", () => {
    expect(can(ipcLead, "documents.approve", { chapterCode: "IPC" })).toBe(true);
    expect(can(ipcLead, "documents.approve", { chapterCode: "LD" })).toBe(false);
    expect(can(ipcLead, "documents.approve")).toBe(false);
    expect(canSomewhere(ipcLead, "documents.approve")).toBe(true);
  });

  it("limits department-scoped grants to their department", () => {
    expect(can(nursingHead, "incidents.view", { departmentId: "dep-nursing" })).toBe(true);
    expect(can(nursingHead, "incidents.view", { departmentId: "dep-lab" })).toBe(false);
  });

  it("denies when nothing matches", () => {
    expect(can([], "users.view")).toBe(false);
  });
});
