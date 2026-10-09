// #2419/#2447/#2481: durable-state message guards, declared per plugin lane.
//
// Some hosts inject DURABLE STATE as ordinary conversation messages and gate
// re-injection on a content fingerprint: dsh ships three such carriers as
// user-role messages — dsh-tool-skill's skill catalog (\x3cavailable_skills\x3e,
// #2419; never resent while the sha256(name+description) digest is unchanged),
// @deepseek-ai/dsh-agent-instructions' workspace-instructions baseline
// (#2447: global + project AGENTS.md merged into ONE message, re-emitted only
// when baselineIdentity — projectRoot + discovery/budget config, NOT file
// contents — changes), and the agent-loop runtime-context snapshot (#2481:
// sandbox/approval policy state, self-declared "supersedes earlier
// runtime-context snapshots" — resent only when the runtime context CHANGES,
// not every turn) — plus a FOURTH carrier from the dsh PLUGIN ecosystem
// (#2446: dsh-skill-mcp-manager's \x3cmcp_catalog\x3e block, the first guard
// entry whose emitter is not dsh core). ACP compression treats every history message as consumable,
// so one fold of any carrier silently kills its guidance forever (the host
// will not resend what it believes is already present). The structured
// source.kind these hosts stamp internally never reaches the proxy wire
// (CoreMessage carries no metadata field), so the guards match stable text
// markers instead — the same criterion discipline as #2447. The kernel's
// protection surface was tool-exchange-only (protectedTools /
// isToolProtected), structurally unable to cover a plain text message — hence
// the generic Config.isMessageProtected hook (kernel 0.0.108) and this
// lane-scoped policy map. The mechanism lives in the kernel; the POLICY
// (which shapes, for which host) lives here, one entry per lane with traffic
// evidence.
//
// KDD #9 evidence-permitlist discipline applies: entries are added PER HOST
// with traffic evidence (shape + stability proof), never enabled wholesale —
// a message-shape guard applied to every lane would hard-pin arbitrary user
// prose into context for hosts whose state carriers have no such contract.

import type { CoreMessage } from "acp-kernel";

type DurableMessageGuard = (msg: CoreMessage) => boolean;

/** dsh skill-catalog guard (#2419): matches the durable catalog message
 *  injected by dsh-tool-skill (a \x3csystem-reminder\x3e carrying the
 *  \x3cavailable_skills\x3e block; source: asar dsh-tool-skill/lib/index.js,
 *  createUserMessage({ source: { kind: "skill-catalog" } })). The marker is
 *  matched on its own rather than on the wrapper so a future wrapper change
 *  cannot silently disarm the guard; a false positive is benign (a matching
 *  message simply stays visible) and the marker is DSH-specific XML. */
export function dshSkillCatalogGuard(msg: CoreMessage): boolean {
    return msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("\x3cavailable_skills\x3e");
}

/** dsh workspace-instructions guard (#2447): matches the durable AGENTS.md
 *  baseline message injected by @deepseek-ai/dsh-agent-instructions — global
 *  (~/.dsh/AGENTS.md) and project instructions merged into ONE user-role
 *  \x3csystem-reminder\x3e message whose sections are labelled
 *  `Instructions from: <path>` (source: lib/index.js sectionText +
 *  createUserMessage). The host re-emits the baseline only when
 *  baselineIdentity (projectRoot + discovery/budget config, NOT file contents)
 *  changes, so one fold of it silently kills hard constraints like "read X
 *  before any web access" forever. Same marker-over-wrapper rationale as
 *  dshSkillCatalogGuard: the per-file label is matched on its own so wrapper/
 *  intro rewording cannot silently disarm the guard; a false positive is
 *  benign (a matching message simply stays visible). The match is
 *  case-sensitive on purpose — reconciliation change messages use lowercase
 *  variants ("Updated instructions from:") that remain ordinary consumable
 *  history. At most ~one such baseline lives per session (replacements are
 *  rare identity changes), so pinning every match is bounded. */
export function dshWorkspaceInstructionsGuard(msg: CoreMessage): boolean {
    return msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("Instructions from:");
}

/** dsh mcp-catalog guard (#2446): matches the durable MCP-server catalog
 *  injected by the THIRD-PARTY plugin dsh-skill-mcp-manager (author-reported
 *  marker; the plugin also curates which skills the dsh core catalog offers).
 *  The catalog rides a user-role message whose \x3cmcp_catalog\x3e block lists
 *  every registered MCP server with tool-schema digests (~5K tokens in the
 *  report); the plugin re-emits it only when the visible MCP/skill set
 *  CHANGES, so one fold silently kills the session's MCP server inventory
 *  forever — the report's failure mode is the model hunting for servers by
 *  wrong names mid-session. First guard entry for a carrier emitted by the
 *  dsh plugin ecosystem rather than dsh core: same evidence bar (shape from
 *  the #2446 report, stability owned by the plugin author who filed it),
 *  marker-over-wrapper rationale as #2419, and re-emissions are rare set
 *  changes so pinning every match stays bounded (same argument as #2447). */
export function dshMcpCatalogGuard(msg: CoreMessage): boolean {
    return msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("\x3cmcp_catalog\x3e");
}

/** dsh runtime-context guard (#2481): matches the durable runtime-context
 *  snapshot injected by the dsh agent loop — sandbox/approval policy state
 *  carried as a user-role message containing "Current runtime context"
 *  (source: deepseek-ai/deepseek-harness MIT packages/core/agent-loop/src/
 *  runtime-context.ts; the same text family bili already recognizes as an
 *  auto-injected notification in #2286's AUTO_INJECTED_NOTIFICATION_PREFIXES).
 *  Both variants match on purpose: the populated snapshot ("Current runtime
 *  context. This snapshot supersedes earlier runtime-context snapshots. …")
 *  AND the cleared form ("Current runtime context: none. Earlier
 *  runtime-context snapshots no longer apply.") — the cleared notice must
 *  stay visible too, because it is what invalidates the older snapshots this
 *  guard pins. The host re-emits only when the runtime context CHANGES (the
 *  per-turn time-context carrier deliberately stays foldable), so one fold of
 *  the latest snapshot silently drops the session's sandbox/approval semantics
 *  forever. Each snapshot is tiny (~100–400 chars); superseded ones keep
 *  pinning harmlessly because the newest carries the supersedes clause. */
export function dshRuntimeContextGuard(msg: CoreMessage): boolean {
    return msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("Current runtime context");
}

/** Lane → guard registry. Only lanes with traffic evidence of the
 *  durable-user-message carrier belong here (KDD #9). Keyed by the value of
 *  the x-bili-plugin header / session.metadata.pluginAgent binding. */
export const durableMessageGuards: Record<string, DurableMessageGuard> = {
    dsh: (msg) =>
        dshSkillCatalogGuard(msg) || dshWorkspaceInstructionsGuard(msg) || dshRuntimeContextGuard(msg) || dshMcpCatalogGuard(msg),
};
