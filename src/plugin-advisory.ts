// #2462: known third-party plugins that are NOT compressors but measurably
// degrade the upstream prefix cache — each fires a full-conversation re-send
// under a separate system prompt before every tool call. bili isolates them
// into a sub-session so they no longer pollute the main session, but the token
// cost is host-side and invisible to the compression-conflict ledger (#1206),
// which tracks double-compression only. This module detects such plugins from
// the client registry (best-effort, read-only, cached) so the web UI surfaces a
// notice pointing at the owning issue instead of silently burning cache. Every
// fs access is guarded — detection must NEVER fail a request or a page load.

import fs from "node:fs";
import path from "node:path";
import { dshProfileDirs } from "./dsh-channel.js";

export interface CostAdvisory {
    id: string;
    name: string;
    client: string;
    issueUrl: string;
}

const DSH_AUTO_REVIEW_ISSUE = "https://github.com/ranxianglei/billion-context/issues/2462";

// One entry per known cost-affecting plugin. `client` scopes which registry to
// scan, `id` is the exact package name (grep-able by the user), `issueUrl` is
// the owning issue the web banner links to.
const KNOWN_COST_PLUGINS: ReadonlyArray<{ client: string; id: string; name: string; issueUrl: string }> = [
    { client: "dsh", id: "@deepseek-ai/dsh-experimental-auto-review", name: "@deepseek-ai/dsh-experimental-auto-review", issueUrl: DSH_AUTO_REVIEW_ISSUE },
];

const SCAN_TTL_MS = 5 * 60 * 1000;
let cache: { key: string; at: number; result: CostAdvisory[] } | undefined;

function dshDependencyNames(env: NodeJS.ProcessEnv): Set<string> {
    const names = new Set<string>();
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return names;
    }
    for (const dir of dirs) {
        const file = path.join(dir, "package.json");
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        } catch {
            continue;
        }
        for (const key of ["dependencies", "devDependencies"]) {
            const deps = obj[key];
            if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
            for (const dep of Object.keys(deps as Record<string, unknown>)) names.add(dep);
        }
    }
    return names;
}

export function detectCostAdvisories(env: NodeJS.ProcessEnv = process.env): CostAdvisory[] {
    const key = `${env.DSH_HOME ?? ""}|${env.HOME ?? ""}|${env.USERPROFILE ?? ""}`;
    if (cache && cache.key === key && Date.now() - cache.at < SCAN_TTL_MS) return cache.result;
    const found: CostAdvisory[] = [];
    const dshDeps = KNOWN_COST_PLUGINS.some((p) => p.client === "dsh") ? dshDependencyNames(env) : undefined;
    for (const p of KNOWN_COST_PLUGINS) {
        if (p.client !== "dsh") continue;
        if (!dshDeps?.has(p.id)) continue;
        found.push({ id: p.id, name: p.name, client: p.client, issueUrl: p.issueUrl });
    }
    cache = { key, at: Date.now(), result: found };
    return found;
}

export function _clearCostAdvisoryCache(): void {
    cache = undefined;
}
