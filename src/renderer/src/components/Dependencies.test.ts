import { describe, expect, it } from "vitest";
import type { Task } from "@shared/tasks";
import { candidatesFor } from "./Dependencies";

const task = (id: string, seq: number, over: Partial<Task> = {}): Task =>
  ({ id, seq, title: id, status: "ready", dependsOn: [], ...over }) as Task;

describe("candidatesFor", () => {
  it("offers only tasks an edge could still wait on, in the order given", () => {
    const all = [
      task("run", 5, { status: "running" }),
      task("done", 4, { status: "completed" }),
      task("failed", 3, { status: "failed" }),
      task("cancelled", 2, { status: "cancelled" }),
      task("waiting", 1, { status: "awaiting_human" }),
    ];
    expect(candidatesFor(all, null, []).map((t) => t.id)).toEqual([
      "run",
      "waiting",
    ]);
  });

  it("drops the task itself, chosen edges and anything that already waits on it", () => {
    const all = [
      task("a", 3, { dependsOn: ["b"] }),
      task("b", 2, { dependsOn: ["self"] }),
      task("self", 1),
      task("c", 0),
    ];
    expect(candidatesFor(all, "self", ["c"]).map((t) => t.id)).toEqual([]);
  });
});
