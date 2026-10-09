import { test } from "node:test";
import assert from "node:assert/strict";
import { createTagEchoFilter, createMarkerLineFilter, createBiliArtifactFilter, createIdentityStreamFilter, composeStreamFilters, stripAcpTags } from "../src/loop/tag-echo-filter.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";

// #2405(c): strip coverage must be ACCEPTABLE FROM THE LOG ALONE. Three
// properties pinned here:
//   1. every filter reports HOW MANY times it stripped (stats().dropCount),
//      not just whether (dropped boolean);
//   2. each response settles with ONE total line when n>1 (n==1 is already
//      fully described by its one-shot detail line);
//   3. the family prefix is unambiguous: "[tag-echo] stripped" appears ONLY
//      for actual strip events, no detection line contains "stripped", and
//      no event is double-written (one logger line per event).
const LT = "\x3c";
const GT = "\x3e";
const TAG = (ref: string) => `${LT}acp tokens="2" type="text"${GT}${ref}${LT}/acp${GT}`;

function makeSession(id: string, protocol: string): Session {
    return {
        id,
        protocol,
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function sse(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
}

test("filters count every drop event, composition sums, identity stays zero (#2405c)", () => {
    const tag = createTagEchoFilter();
    tag.push(`a ${TAG("m00001")} b ${TAG("m00002")} c ${TAG("m00003")} d`);
    tag.flush();
    const ts = tag.stats();
    assert.equal(ts.dropped, true);
    assert.equal(ts.dropCount, 3, `three tags in one push = three artifacts, got ${ts.dropCount}`);

    const marker = createMarkerLineFilter();
    marker.push(`line\n📦 [ACP] Compressed m00120–m0300 → 1 block(s), ~12K tokens saved.\nnext`);
    marker.flush();
    assert.equal(marker.stats().dropCount, 1, "one marker line = one drop event");

    const artifact = createBiliArtifactFilter();
    artifact.push("keep\n[Compressed conversation section]\nrest of the field is swallowed");
    artifact.flush();
    assert.equal(artifact.stats().dropCount, 1, "forged summary header block counted once");

    const identity = createIdentityStreamFilter();
    identity.push(`${TAG("m00009")} untouched`);
    identity.flush();
    assert.equal(identity.stats().dropCount, 0, "identity filter never drops");

    const composed = composeStreamFilters(createTagEchoFilter(), createMarkerLineFilter());
    composed.push(`a ${TAG("m00010")} b\n📦 [ACP] Compressed m00120–m0300 → 1 block(s), ~12K tokens saved.\n`);
    composed.flush();
    const cs = composed.stats();
    assert.equal(cs.dropCount, 2, `composition must SUM family counts, got ${cs.dropCount}`);

    // whole-text stripper parity: the same input loses every tag
    const whole = stripAcpTags(`a ${TAG("m00001")} b ${TAG("m00002")} c`);
    assert.ok(!whole.includes(LT + "acp "), `whole-text strip removes pairs: ${whole}`);
});

test("plugin chat pipe settles with one total line and no double-write (#2405c)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const reqLogs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ content: `see ${TAG("m00001")} then ${TAG("m00002")} and ${TAG("m00003")} ok` }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-strip", "openai"), (msg) => reqLogs.push(msg));
    } finally {
        setLogCapture(null);
    }
    const family = logs.filter((l) => l.includes("[tag-echo]"));
    const details = family.filter((l) => l.includes("stripped model-emitted render tag"));
    const totals = family.filter((l) => l.includes("occurrence(s) total in this response"));
    assert.equal(details.length, 1, `one-shot detail line expected, got: ${logs.join(" | ")}`);
    assert.equal(totals.length, 1, `exactly one per-response total expected, got: ${logs.join(" | ")}`);
    assert.ok(totals[0].includes("stripped 3 occurrence(s)"), totals[0]);
    assert.ok(totals[0].includes("[sess-strip]"), totals[0]);
    // the request-logger twin write is gone: no family line may arrive there
    assert.ok(!reqLogs.some((m) => m.includes("[tag-echo]")), `double-write detected: ${reqLogs.join(" | ")}`);
});

test("a pair split across pushes counts once, not per drop call (#2405c review)", () => {
    // SSE deltas split tags arbitrarily: an opening completing in one push and
    // its close in the next is ONE artifact even though the state machine
    // drops the opening and the completion as two separate calls.
    const tag = createTagEchoFilter();
    const text = `x ${TAG("m00001")} y`;
    const cut = text.indexOf(`${GT}m00001`) + 1;
    tag.push(text.slice(0, cut));
    tag.push(text.slice(cut));
    tag.flush();
    assert.equal(tag.stats().dropCount, 1, `split pair must count once, got ${tag.stats().dropCount}`);

    const many = createTagEchoFilter();
    const two = `before ${TAG("m00002")} mid ${TAG("m00003")} after`;
    for (let i = 0; i < two.length; i += 9) many.push(two.slice(i, i + 9));
    many.flush();
    assert.equal(many.stats().dropCount, 2, `two fragmented tags = two artifacts, got ${many.stats().dropCount}`);
});

test("single-strip response: detail line only, no total line (n==1 boundary, #2405c)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ content: `see ${TAG("m00007")} ok` }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-one", "openai"));
    } finally {
        setLogCapture(null);
    }
    const details = logs.filter((l) => l.includes("stripped model-emitted render tag"));
    assert.equal(details.length, 1, `one-shot detail line expected, got: ${logs.join(" | ")}`);
    // n==1 is fully described by the detail line — the total must stay silent
    assert.ok(!logs.some((l) => l.includes("occurrence(s) total")), logs.join(" | "));
});

test("plugin responses pipe settles with one total line (#2405c)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const events = [
            sse({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } }),
            sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `${TAG("m00001")}` }),
            sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: ` mid ${TAG("m00002")} tail ${TAG("m00003")}` }),
            sse({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 5 } } }),
        ];
        await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession("sess-rstrip", "responses"));
    } finally {
        setLogCapture(null);
    }
    const totals = logs.filter((l) => l.includes("occurrence(s) total in this response"));
    assert.equal(totals.length, 1, `exactly one total expected, got: ${logs.join(" | ")}`);
    assert.ok(totals[0].includes("stripped 3 occurrence(s)"), totals[0]);
});

test("detection lines never say 'stripped' and single-drop responses stay silent on totals (#2405c)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const frag = `${LT}invoke name="compress"${GT}call it${LT}/invoke${GT}`;
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ content: `draft ${frag} end` }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-detect", "openai"));
    } finally {
        setLogCapture(null);
    }
    const detects = logs.filter((l) => l.includes("tool-call XML fragment"));
    assert.equal(detects.length, 1, `detection warn expected once, got: ${logs.join(" | ")}`);
    assert.ok(detects[0].includes("left untouched"), detects[0]);
    assert.ok(!detects[0].includes("not stripped"), detects[0]);
    // no tag was actually stripped -> no detail line, no total line
    assert.ok(!logs.some((l) => l.includes("stripped model-emitted")), logs.join(" | "));
    assert.ok(!logs.some((l) => l.includes("occurrence(s) total")), logs.join(" | "));
    assert.ok(!logs.some((l) => l.includes("not stripped")), logs.join(" | "));
});

test("proxy-mode adapter settles exactly one strip-total line (anthropic, #2405c)", async () => {
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const text = `before ${TAG("m00020")} mid ${TAG("m00021")} after`;
        const parts: string[] = [];
        for (let i = 0; i < text.length; i += 9) parts.push(text.slice(i, i + 9));
        const sseParts = [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 100 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            ...parts.map((p) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })}\n\n`),
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ];
        const adapter = createAnthropicAdapter({ model: "test" });
        let clientBytes = "";
        for await (const ev of adapter.parseStream(streamOf(sseParts), 1)) {
            if (ev.kind === "meta") clientBytes += ev.chunk.toString("utf8");
        }
        assert.ok(!clientBytes.includes(LT + "acp "), `stripped tags must not leak to the client: ${clientBytes}`);
        const totals = logs.filter((l) => l.includes("occurrence(s) total in this response"));
        assert.equal(totals.length, 1, `exactly one total line expected, got: ${logs.join(" | ")}`);
        assert.ok(totals[0].includes("stripped 2 occurrence(s)"), totals[0]);
    } finally {
        setLogCapture(null);
    }
});
