// #2419: durable-state message guards, declared per plugin lane.
//
// Some hosts inject DURABLE STATE as ordinary conversation messages and gate
// re-injection on a content fingerprint: dsh-tool-skill ships its skill
// catalog (\x3cavailable_skills\x3e) as a user-role system-reminder once per
// session and never resends it while the sha256(name+description) digest is
// unchanged. ACP compression treats every history message as consumable, so
// one fold of the catalog silently kills skill triggering forever (the host
// will not resend what it believes is already present). The kernel's
// protection surface was tool-exchange-only (protectedTools / isToolProtected),
// structurally unable to cover a plain text message — hence the generic
// Config.isMessageProtected hook (kernel 0.0.108) and this lane-scoped policy
// map. The mechanism lives in the kernel; the POLICY (which shapes, for which
// host) lives here, one entry per lane with traffic evidence.
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

/** Lane → guard registry. Only lanes with traffic evidence of the
 *  durable-user-message carrier belong here (KDD #9). Keyed by the value of
 *  the x-bili-plugin header / session.metadata.pluginAgent binding. */
export const durableMessageGuards: Record<string, DurableMessageGuard> = {
    dsh: dshSkillCatalogGuard,
};
