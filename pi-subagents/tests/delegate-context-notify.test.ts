import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeDelegateTool,
  scheduleRunNotification,
  setDelegateNotifyIfRead,
} from "../src/delegate-tool.js";

// #2320 busy-tier contract: while the host is mid-task, a finished delegate's
// notification must be committed at the NEXT MODEL CALL (the `context` event),
// not parked until the task ends. These tests drive the host lifecycle events
// deterministically through the same mock surface as
// delegate-settle-notify.test.ts, plus the `context` event that carries the
// outgoing message list.

type PiLike = Parameters<typeof makeDelegateTool>[0];

function mkRun(runId: string, status: "completed" | "failed", over: Record<string, unknown> = {}): any {
  return {
    runId,
    agent: "reviewer",
    task: "review X",
    cwd: "/tmp",
    startedAt: 0,
    finishedAt: 1000,
    status,
    result: { code: status === "completed" ? 0 : 1, file: `/tmp/${runId}.out`, body: "boom" },
    ...over,
  };
}

const assistantMsg = { role: "assistant", content: [{ type: "text", text: "working" }] } as any;
const userMsg = { role: "user", content: [{ type: "text", text: "go" }] } as any;

type SentEntry = { t: string; o?: { deliverAs?: string } };

/** Mock ExtensionAPI capturing sends WITH options and able to fire the `context`
 *  event with a chosen outgoing message list. */
function mockPi() {
  const sent: SentEntry[] = [];
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const pi = {
    sendUserMessage: (t: string, o?: { deliverAs?: string }) => void sent.push({ t, o }),
    on: (event: string, handler: (...a: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as PiLike;
  const emit = (event: string) => {
    for (const h of handlers.get(event) ?? []) h({});
  };
  // Fire the context boundary; returns the handler's ContextEventResult (if any).
  const context = (messages: unknown[]): unknown => {
    let res: unknown;
    for (const h of handlers.get("context") ?? []) {
      const r = h({ type: "context", messages });
      if (r !== undefined) res = r;
    }
    return res;
  };
  return { pi, sent, emit, context };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(5);
  }
}

// ─── busy tier: commit at the next model call, mid-task ─────────────────────

test("busy host: notification commits into the next model call's context (#2320)", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit, context } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start"); // host is mid-task
  const run = mkRun("del_busy", "completed");
  scheduleRunNotification(pi, run);
  await sleep(30);
  assert.equal(sent.length, 0, "nothing sent while the host is busy");

  // The next LLM call assembles the context — the notification must ride along.
  const base = [assistantMsg, userMsg];
  const res = context(base) as { messages: unknown[] } | undefined;
  assert.ok(res, "context handler returns modified messages");
  assert.equal(res.messages.length, base.length + 1, "exactly ONE message appended");
  const appended = res.messages[base.length]! as any;
  assert.equal(appended.role, "user");
  assert.ok(String(appended.content[0]!.text).includes("`del_busy`"), "names the run");
  assert.equal(run.injected, true, "marked committed synchronously");
  assert.equal(run.notifyQueued, false);

  // Task ends shortly after: nothing may be delivered AGAIN.
  emit("agent_settled");
  await sleep(30);
  assert.equal(sent.length, 0, "no double delivery at the settle boundary");
});

test("busy host: read-before-boundary drops the notification at commit time (#2301)", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, sent, emit, context } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_ctx_read", "completed");
  scheduleRunNotification(pi, run);
  run.readAt = run.finishedAt; // model claims the result before the boundary
  const res = context([assistantMsg, userMsg]);
  assert.equal(res, undefined, "nothing survives the re-check -> unmodified context");
  assert.equal(run.readSuppressed, true, "recorded as suppressed");
  assert.equal(run.injected, true, "suppression marks it handled so no tier can deliver it");
  emit("agent_settled");
  await sleep(30);
  assert.equal(sent.length, 0, "suppressed run never reaches the idle tier either");
});

test("busy host: failed run commits even when its output was read", async () => {
  setDelegateNotifyIfRead("skip");
  const { pi, emit, context } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_ctx_fail", "failed");
  scheduleRunNotification(pi, run);
  run.readAt = run.finishedAt;
  const res = context([assistantMsg, userMsg]) as { messages: unknown[] };
  const appended = res.messages[res.messages.length - 1] as any;
  assert.match(String(appended.content[0]!.text), /FAILED/, "failures stay loud");
  assert.equal(run.readSuppressed, undefined);
});

test("busy host: close-together finishes merge into ONE appended message", async () => {
  const { pi, emit, context } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const a = mkRun("del_m1", "completed");
  const b = mkRun("del_m2", "failed");
  scheduleRunNotification(pi, a);
  scheduleRunNotification(pi, b);
  const base = [assistantMsg, userMsg];
  const res = context(base) as { messages: unknown[] };
  assert.equal(res.messages.length, base.length + 1, "one merged message, not two");
  const text = String((res.messages[base.length] as any).content[0]!.text);
  assert.ok(text.includes("`del_m1`") && text.includes("`del_m2`"), "both runs named");
  assert.ok(text.includes("2 delegates finished"), "batch header");
  assert.equal(a.injected, true);
  assert.equal(b.injected, true);
});

test("busy host: non-turn contexts (no assistant yet) defer the commit", async () => {
  const { pi, emit, context } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const run = mkRun("del_gate", "completed");
  scheduleRunNotification(pi, run);
  const res = context([userMsg]); // e.g. an auxiliary/first-turn context
  assert.equal(res, undefined, "gate refuses a context with no assistant turn");
  assert.equal(run.notifyQueued, true, "still pending for the next boundary");
  const res2 = context([assistantMsg, userMsg]) as { messages: unknown[] };
  assert.ok(res2, "the real turn's context picks it up");
  assert.equal(run.injected, true);
});

test("busy host: waiter-owned runs are excluded from the boundary commit", async () => {
  const { pi, emit, context } = mockPi();
  makeDelegateTool(pi);
  emit("agent_start");
  const parked = mkRun("del_parked", "completed", { waiter: {} });
  const free = mkRun("del_free", "completed");
  scheduleRunNotification(pi, parked);
  scheduleRunNotification(pi, free);
  const res = context([assistantMsg, userMsg]) as { messages: unknown[] };
  const text = String((res.messages[res.messages.length - 1] as any).content[0]!.text);
  assert.ok(text.includes("`del_free`"));
  assert.ok(!text.includes("`del_parked`"), "wait-owned result stays with the wait path");
  assert.ok(!parked.injected, "waiter run untouched — the wait path owns its delivery");
});

// ─── per-host isolation: sessions never leak notifications across hosts ─────

test("two hosts: each boundary commits only its own queued runs", async () => {
  const A = mockPi();
  const B = mockPi();
  makeDelegateTool(A.pi);
  makeDelegateTool(B.pi);
  A.emit("agent_start");
  B.emit("agent_start");
  const ra = mkRun("del_hostA", "completed");
  const rb = mkRun("del_hostB", "completed");
  scheduleRunNotification(A.pi, ra);
  scheduleRunNotification(B.pi, rb);
  await sleep(30);
  assert.equal(A.sent.length, 0);
  assert.equal(B.sent.length, 0);

  const resA = A.context([assistantMsg, userMsg]) as { messages: unknown[] };
  const textA = String((resA.messages[resA.messages.length - 1] as any).content[0]!.text);
  assert.ok(textA.includes("`del_hostA`"));
  assert.ok(!textA.includes("`del_hostB`"), "host A's context never sees host B's run");
  assert.equal(rb.notifyQueued, true, "host B's run still pending");

  const resB = B.context([assistantMsg, userMsg]) as { messages: unknown[] };
  const textB = String((resB.messages[resB.messages.length - 1] as any).content[0]!.text);
  assert.ok(textB.includes("`del_hostB`"));
  assert.ok(!textB.includes("`del_hostA`"));
});

// ─── idle tier: ONE merged steering message starts the follow-up turn ───────

test("idle host: single finish wakes with ONE steering message (#2320)", async () => {
  const { pi, sent } = mockPi();
  makeDelegateTool(pi);
  const run = mkRun("del_idle_steer", "completed");
  scheduleRunNotification(pi, run);
  await waitFor(() => sent.length === 1, "idle wake");
  assert.ok(sent[0]!.t.includes("`del_idle_steer`"));
  assert.deepEqual(sent[0]!.o, { deliverAs: "steer" }, "steering, not follow-up");
});

test("idle host: multiple finishes coalesce into ONE steering message", async () => {
  const { pi, sent } = mockPi();
  makeDelegateTool(pi);
  const a = mkRun("del_ib1", "completed");
  const b = mkRun("del_ib2", "failed");
  scheduleRunNotification(pi, a);
  scheduleRunNotification(pi, b);
  await waitFor(() => sent.length === 1, "coalesced idle wake");
  assert.ok(sent[0]!.t.includes("`del_ib1`") && sent[0]!.t.includes("`del_ib2`"));
  assert.deepEqual(sent[0]!.o, { deliverAs: "steer" });
});
