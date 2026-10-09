// #2462: known high-cost third-party plugin detection (dsh auto-review) + the
// web notice that surfaces it. Distinct from the compression-conflict ledger —
// these plugins are not compressors; they burn prefix-cache hits host-side and
// bili already isolates them into a sub-session.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";

import { detectCostAdvisories, _clearCostAdvisoryCache } from "../src/plugin-advisory.js";
import { WEB_CLIENT } from "../src/web/client.ts";

const PLUGIN = "@deepseek-ai/dsh-experimental-auto-review";
const ISSUE_URL = "https://github.com/ranxianglei/billion-context/issues/2462";

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function hermeticEnv(root: string): NodeJS.ProcessEnv {
    return { HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), DSH_HOME: path.join(root, "dsh") };
}
function assertTestOwned(file: string, root: string): void {
    const rel = path.relative(root, file);
    assert.ok(!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`),
        `refusing to write outside test-owned root ${root}: ${file}`);
}
function writeProfilePkg(root: string, pkg: Record<string, unknown>): void {
    const file = path.join(root, "dsh", "profiles", "main", "package.json");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pkg));
}

test("#2462: dsh profile carrying auto-review yields exactly one cost advisory", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-hit-");
    writeProfilePkg(root, { dependencies: { [PLUGIN]: "0.2.0-rc.2", "billion-context": "^0.1.0" } });
    const res = detectCostAdvisories(hermeticEnv(root));
    assert.equal(res.length, 1);
    assert.equal(res[0]?.id, PLUGIN);
    assert.equal(res[0]?.client, "dsh");
    assert.equal(res[0]?.issueUrl, ISSUE_URL);
});

test("#2462: profile without the plugin yields no advisory (bili-self skipped)", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-miss-");
    writeProfilePkg(root, { dependencies: { "billion-context": "^0.1.0", "@deepseek-ai/dsh-compaction-basic": "0.2.0-rc.2" } });
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#2462: missing profiles root yields empty without throwing", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-empty-");
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#2462: devDependencies are scanned too", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-dev-");
    writeProfilePkg(root, { dependencies: {}, devDependencies: { [PLUGIN]: "*" } });
    const res = detectCostAdvisories(hermeticEnv(root));
    assert.equal(res.length, 1);
    assert.equal(res[0]?.id, PLUGIN);
});

test("#2462: result cached within TTL, invalidated by _clearCostAdvisoryCache", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-cache-");
    writeProfilePkg(root, { dependencies: { [PLUGIN]: "x" } });
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
    fs.rmSync(path.join(root, "dsh", "profiles", "main", "package.json"));
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1, "cached result returned before TTL expires");
    _clearCostAdvisoryCache();
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), [], "after clearing the cache the re-scan sees the removal");
});

type Adv = { id?: string; name?: string; client?: string; issueUrl?: string };
type Strs = { on: string; desc: string; hint: string };
function bannerHtml(): (advs: Adv[], s: Strs) => string {
    const src = WEB_CLIENT;
    const s = src.indexOf("function escapeHtml");
    const e = src.indexOf("window.bili_pluginAdvisoryBanner = bili_pluginAdvisoryBanner;");
    assert.ok(s >= 0 && e > s, "plugin-advisory banner helpers missing from WEB_CLIENT");
    (globalThis as { window?: Record<string, unknown> }).window = {};
    const fn = new Function(src.slice(s, e) + "\nreturn bili_pluginAdvisoryBanner;");
    return fn() as (advs: Adv[], s: Strs) => string;
}

test("#2462: banner names the plugin, links the issue, shows title/desc/hint", () => {
    const f = bannerHtml();
    const out = f([{ name: PLUGIN, issueUrl: ISSUE_URL }], { on: "High-cost plugin detected", desc: "desc text", hint: "hint text" });
    assert.ok(out.includes('<div class="banner-title">High-cost plugin detected</div>'));
    assert.ok(out.includes("<strong>" + PLUGIN + "</strong>"));
    assert.ok(out.includes('href="' + ISSUE_URL + '" target="_blank" rel="noopener"'));
    assert.ok(out.includes("desc text"));
    assert.ok(out.includes("hint text"));
});

test("#2462: banner escapes HTML in plugin name and url", () => {
    const f = bannerHtml();
    const out = f([{ name: "a<b&c", issueUrl: "https://e.com/?a=1&b=2" }], { on: "T", desc: "D", hint: "H" });
    assert.ok(out.includes("&lt;b&amp;c"), "name escaped");
    assert.ok(out.includes("https://e.com/?a=1&amp;b=2"), "url escaped in href");
    assert.ok(!out.includes("<b&c"), "raw < never leaks unescaped");
});

test("#2462: wiring drift guards (seam export, banner branch, i18n refs, payload field)", () => {
    assert.ok(WEB_CLIENT.includes("window.bili_pluginAdvisoryBanner = bili_pluginAdvisoryBanner;"), "seam export present");
    assert.ok(WEB_CLIENT.includes('$("plugin-advisory-banner")'), "renderBanners reads the banner slot");
    for (const k of ['t("pluginadv.on")', 't("pluginadv.desc")', 't("pluginadv.hint")']) {
        assert.ok(WEB_CLIENT.includes(k), `i18n key ${k} referenced literally (dead-key lint)`);
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const adminSrc = fs.readFileSync(join(here, "..", "src", "server", "admin.ts"), "utf8");
    assert.ok(adminSrc.includes("pluginAdvisories: detectCostAdvisories(process.env)"), "overview/status payload carries the field");
});
