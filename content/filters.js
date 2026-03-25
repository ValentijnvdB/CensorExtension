/**
 * filters.js – Filter rule loading and URL matching
 *
 * Reads filters.json bundled with the extension, compiles each rule into a
 * matcher function, and exposes isFiltered() for the pipeline to call.
 * Writes globalMatchers / domainMatchers in state.js.
 */

async function loadFilters() {
    try {
        const url      = browser.runtime.getURL("src/content/filters.json");
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (err) {
        console.warn("[ImageCensor] Could not load filters.json:", err);
        return { global: [], domains: {} };
    }
}

function compileRule(rule) {
    const lower = rule.toLowerCase();
    if (!lower.includes("*")) {
        return url => url.toLowerCase().includes(lower);
    }
    const pattern = lower
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
    const re = new RegExp(pattern);
    return url => re.test(url.toLowerCase());
}

function compileFilters(filters) {
    globalMatchers = (filters.global ?? []).map(compileRule);
    for (const [domain, rules] of Object.entries(filters.domains ?? {})) {
        domainMatchers[domain.toLowerCase()] = rules.map(compileRule);
    }
}

function isFiltered(imageUrl) {
    for (const match of globalMatchers) {
        if (match(imageUrl)) return true;
    }
    const pageHost = window.location.hostname.toLowerCase();
    for (const [domain, matchers] of Object.entries(domainMatchers)) {
        if (pageHost === domain || pageHost.endsWith(`.${domain}`)) {
            for (const match of matchers) {
                if (match(imageUrl)) return true;
            }
        }
    }
    return false;
}
