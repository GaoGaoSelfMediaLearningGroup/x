(function () {
    if (window.__GJSiteSearch) {
        return;
    }

    const scriptEl = document.currentScript || Array.from(document.scripts).find((script) => {
        return /assets\/search\.js(?:\?|$)/.test(script.src);
    });

    if (!scriptEl || !scriptEl.src) {
        return;
    }

    const assetBaseUrl = new URL(".", scriptEl.src);
    const siteRootUrl = new URL("../", assetBaseUrl);
    const indexUrl = new URL("search-index.json", siteRootUrl).href;
    const isHistoryPage = /historical_page_summary\.html(?:\?|#|$)/.test(window.location.pathname);
    const INITIAL_BATCH_SIZE = 3;
    const FOLLOWUP_BATCH_SIZE = 3;
    const MIN_RESULTS_TARGET = 8;
    const SEARCH_RESULTS_PER_PAGE = 5;

    const state = {
        manifest: null,
        manifestPromise: null,
        shardPromises: new Map(),
        shardsLoaded: new Set(),
        docMap: new Map(),
        docs: [],
        lastQuery: "",
        lastFilters: { year: "", month: "" },
        searchVersion: 0,
    };

    const ICON_FALLBACK_STYLE_ID = "gj-inline-icon-style";
    const ICON_SVG_CLASS = "gj-inline-icon";

    function createIconSvg(paths, options) {
        const attrs = options || {};
        const viewBox = attrs.viewBox || "0 0 24 24";
        const fill = attrs.fill || "none";
        const stroke = attrs.stroke || "currentColor";
        const strokeWidth = attrs.strokeWidth || "2";
        const extraAttrs = attrs.extra || "";
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ${extraAttrs}>${paths}</svg>`;
    }

    const ICON_SVGS = {
        "fa-arrow-up": createIconSvg('<path d="m6 11 6-6 6 6"/><path d="M12 5v14"/>'),
        "fa-book-open": createIconSvg('<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H11v16H5.5A2.5 2.5 0 0 0 3 22z"/><path d="M21 6.5A2.5 2.5 0 0 0 18.5 4H13v16h5.5A2.5 2.5 0 0 1 21 22z"/>'),
        "fa-calendar": createIconSvg('<path d="M7 2v4"/><path d="M17 2v4"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>'),
        "fa-calendar-alt": createIconSvg('<path d="M7 2v4"/><path d="M17 2v4"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>'),
        "fa-calendar-day": createIconSvg('<path d="M7 2v4"/><path d="M17 2v4"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><circle cx="12" cy="15" r="2.5"/>'),
        "fa-calendar-days": createIconSvg('<path d="M7 2v4"/><path d="M17 2v4"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>'),
        "fa-calendar-times": createIconSvg('<path d="M7 2v4"/><path d="M17 2v4"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="m10 14 4 4"/><path d="m14 14-4 4"/>'),
        "fa-chart-bar": createIconSvg('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20v-11"/>'),
        "fa-chart-line": createIconSvg('<path d="M3 17 9 11l4 4 8-8"/><path d="M21 7v6h-6"/>'),
        "fa-check": createIconSvg('<path d="m5 13 4 4L19 7"/>'),
        "fa-chevron-down": createIconSvg('<path d="m6 9 6 6 6-6"/>'),
        "fa-chevron-left": createIconSvg('<path d="m15 18-6-6 6-6"/>'),
        "fa-chevron-right": createIconSvg('<path d="m9 18 6-6-6-6"/>'),
        "fa-clock": createIconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>'),
        "fa-cloud": createIconSvg('<path d="M7 18a4 4 0 1 1 .9-7.9A5.5 5.5 0 1 1 19 11.5 3.5 3.5 0 1 1 18.5 18z"/>'),
        "fa-copy": createIconSvg('<rect x="9" y="9" width="10" height="12" rx="2"/><path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/>'),
        "fa-crown": createIconSvg('<path d="m3 8 4.5 5L12 5l4.5 8L21 8l-2 11H5L3 8z"/>'),
        "fa-database": createIconSvg('<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
        "fa-exclamation-triangle": createIconSvg('<path d="M12 3 2.6 19.5A1.2 1.2 0 0 0 3.64 21h16.72a1.2 1.2 0 0 0 1.04-1.5z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
        "fa-expand-alt": createIconSvg('<path d="M9 3H3v6"/><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 21h-6v-6"/><path d="M3 9 9 3"/><path d="m15 3 6 6"/><path d="m3 15 6 6"/><path d="m15 21 6-6"/>'),
        "fa-external-link-alt": createIconSvg('<path d="M14 5h5v5"/><path d="M10 14 19 5"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>'),
        "fa-file-alt": createIconSvg('<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/><path d="M9 9h2"/>'),
        "fa-fire": createIconSvg('<path d="M12 3s2.5 2.2 2.5 5.2c0 1.3-.7 2.2-1.5 3.1-.8-1-1.4-2-1.4-3.5C11.6 5.5 12 3 12 3z"/><path d="M8.5 12.5A5 5 0 1 0 17 16.2c0-1.6-.8-3.1-2.1-4.5-.4 1.5-1.4 2.7-2.9 3.3-.2-1.2-.9-2-1.5-2.5-.9 1-2 2.4-2 4z"/>'),
        "fa-folder-open": createIconSvg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 10h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
        "fa-globe": createIconSvg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>'),
        "fa-history": createIconSvg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v5l3 2"/>'),
        "fa-info-circle": createIconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
        "fa-lightbulb": createIconSvg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 14c-1.2-1-2-2.8-2-4.5a6 6 0 1 1 12 0c0 1.7-.8 3.5-2 4.5-.8.7-1.2 1.7-1.5 2.5h-5c-.3-.8-.7-1.8-1.5-2.5z"/>'),
        "fa-link": createIconSvg('<path d="M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 0 1 7 7L17 13"/><path d="M14 11a5 5 0 0 1 0 7L12.5 19.5a5 5 0 0 1-7-7L7 11"/>'),
        "fa-list": createIconSvg('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
        "fa-medal": createIconSvg('<path d="M8 3h8l-2 6h-4L8 3z"/><circle cx="12" cy="16" r="5"/><path d="m12 13 1 2 2 .3-1.5 1.4.4 2.3-1.9-1-1.9 1 .4-2.3L9 15.3l2-.3z"/>'),
        "fa-moon": createIconSvg('<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'),
        "fa-pie-chart": createIconSvg('<path d="M12 3v9h9"/><path d="M21 12a9 9 0 1 1-9-9"/>'),
        "fa-print": createIconSvg('<path d="M7 8V4h10v4"/><rect x="5" y="12" width="14" height="8" rx="2"/><path d="M7 16h10"/><path d="M7 20h10"/>'),
        "fa-question-circle": createIconSvg('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 1 1 5.4 1.8c-.8 1-1.8 1.5-1.8 3.2"/><path d="M12 17h.01"/>'),
        "fa-quote-left": createIconSvg('<path d="M10 8H6a2 2 0 0 0-2 2v4h4v4H4"/><path d="M20 8h-4a2 2 0 0 0-2 2v4h4v4h-4"/>'),
        "fa-robot": createIconSvg('<rect x="5" y="8" width="14" height="10" rx="2"/><path d="M12 4v4"/><path d="M8 3h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 18v2"/><path d="M15 18v2"/><path d="M5 12H3"/><path d="M21 12h-2"/>'),
        "fa-search": createIconSvg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
        "fa-share-alt": createIconSvg('<circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 12 8-6"/><path d="m8 12 8 6"/>'),
        "fa-star": createIconSvg('<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9z"/>'),
        "fa-sun": createIconSvg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2.2"/><path d="M12 19.8V22"/><path d="m4.93 4.93 1.56 1.56"/><path d="m17.51 17.51 1.56 1.56"/><path d="M2 12h2.2"/><path d="M19.8 12H22"/><path d="m4.93 19.07 1.56-1.56"/><path d="m17.51 6.49 1.56-1.56"/>'),
        "fa-times": createIconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        "fa-trophy": createIconSvg('<path d="M8 4h8v4a4 4 0 0 1-8 0z"/><path d="M10 16h4"/><path d="M9 20h6"/><path d="M6 6H4a2 2 0 0 0 0 4h2"/><path d="M18 6h2a2 2 0 0 1 0 4h-2"/>'),
        "fa-users": createIconSvg('<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="8" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 4.1a4 4 0 0 1 0 7.8"/>'),
    };

    const ICON_NAMES = Object.keys(ICON_SVGS);

    function ensureInlineIconStyles() {
        if (document.getElementById(ICON_FALLBACK_STYLE_ID)) {
            return;
        }
        const style = document.createElement("style");
        style.id = ICON_FALLBACK_STYLE_ID;
        style.textContent = `
            i.${ICON_SVG_CLASS} {
                display: inline-block;
                width: 1em;
                height: 1em;
                line-height: 1;
                vertical-align: -0.125em;
                font-style: normal;
                flex: 0 0 auto;
            }
            i.${ICON_SVG_CLASS}::before {
                content: none !important;
            }
            i.${ICON_SVG_CLASS} > svg {
                display: block;
                width: 100%;
                height: 100%;
                overflow: visible;
            }
        `;
        document.head.appendChild(style);
    }

    function getSupportedIconName(element) {
        for (const iconName of ICON_NAMES) {
            if (element.classList.contains(iconName)) {
                return iconName;
            }
        }
        return "";
    }

    function applyInlineIcon(element) {
        if (!(element instanceof HTMLElement) || element.tagName !== "I") {
            return;
        }
        const iconName = getSupportedIconName(element);
        if (!iconName) {
            return;
        }
        if (element.dataset.gjInlineIcon === iconName) {
            return;
        }
        element.classList.add(ICON_SVG_CLASS);
        element.innerHTML = ICON_SVGS[iconName];
        element.dataset.gjInlineIcon = iconName;
        element.setAttribute("aria-hidden", "true");
    }

    function applyInlineIcons(root) {
        if (!root) {
            return;
        }
        if (root instanceof HTMLElement && root.tagName === "I") {
            applyInlineIcon(root);
        }
        if (root.querySelectorAll) {
            root.querySelectorAll("i").forEach(applyInlineIcon);
        }
    }

    function observeInlineIcons() {
        if (document.body && document.body.__gjInlineIconObserver) {
            return;
        }
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === "attributes") {
                    applyInlineIcon(mutation.target);
                    return;
                }
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLElement) {
                        applyInlineIcons(node);
                    }
                });
            });
        });
        observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"],
        });
        document.body.__gjInlineIconObserver = observer;
    }

    function initInlineIcons() {
        ensureInlineIconStyles();
        applyInlineIcons(document);
        if (document.body) {
            observeInlineIcons();
        }
    }

    function normalizeText(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
    }

    function normalizeSearchText(text) {
        return normalizeText(String(text || "").replace(/[/_]+/g, "-"));
    }

    function escapeHtml(text) {
        return String(text || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function escapeRegExp(text) {
        return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function debounce(fn, wait) {
        let timer = null;
        return function (...args) {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => fn.apply(this, args), wait);
        };
    }

    function formatDateLabel(date) {
        const matched = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!matched) {
            return date || "";
        }
        return `${matched[1]}年${matched[2]}月${matched[3]}日`;
    }

    function normalizeMonth(month) {
        return month ? String(month).padStart(2, "0") : "";
    }

    function getSelectedFilters(target) {
        const yearSelect = target.querySelector("[data-gj-filter-year]");
        const monthSelect = target.querySelector("[data-gj-filter-month]");
        return {
            year: yearSelect ? yearSelect.value : "",
            month: monthSelect ? normalizeMonth(monthSelect.value) : "",
        };
    }

    function getFilterScopeLabel(filters) {
        if (filters.year && filters.month) {
            return `${filters.year}年${filters.month}月`;
        }
        if (filters.year) {
            return `${filters.year}年`;
        }
        return "全站";
    }

    function parseQuery(rawQuery) {
        const normalized = normalizeSearchText(rawQuery);
        if (!normalized) {
            return { normalized: "", exactPhrase: "", terms: [], dateTerms: [] };
        }

        const baseTerms = normalized.split(/\s+/).filter(Boolean);
        const uniqueTerms = Array.from(new Set(baseTerms));
        const dateTerms = uniqueTerms.filter((term) => /^\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?$/.test(term));
        return {
            normalized,
            exactPhrase: normalized,
            terms: uniqueTerms,
            dateTerms,
        };
    }

    function decorateDoc(doc) {
        const summary = doc.summary || doc.description || "";
        return {
            ...doc,
            summary,
            _title: normalizeSearchText(doc.title),
            _summary: normalizeSearchText(summary),
            _keywords: normalizeSearchText((doc.keywords || []).join(" ")),
            _content: normalizeSearchText(doc.content),
            _date: normalizeSearchText(doc.date),
        };
    }

    function ingestDocs(docs) {
        docs.forEach((doc) => {
            const decorated = decorateDoc(doc);
            state.docMap.set(decorated.id, decorated);
        });
        state.docs = Array.from(state.docMap.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
        return state.docs;
    }

    async function loadManifest() {
        if (state.manifest) {
            return state.manifest;
        }
        if (state.manifestPromise) {
            return state.manifestPromise;
        }

        state.manifestPromise = fetch(indexUrl, { cache: "no-store" })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`搜索索引加载失败: ${response.status}`);
                }
                return response.json();
            })
            .then((payload) => {
                state.manifest = payload;
                return payload;
            })
            .catch((error) => {
                console.error(error);
                throw error;
            });

        return state.manifestPromise;
    }

    async function ensureLegacyDocs(manifest) {
        if (!Array.isArray(manifest.docs) || state.shardsLoaded.has("legacy")) {
            return state.docs;
        }
        state.shardsLoaded.add("legacy");
        return ingestDocs(manifest.docs);
    }

    async function loadShard(shard) {
        if (!shard || state.shardsLoaded.has(shard.id)) {
            return state.docs;
        }
        if (state.shardPromises.has(shard.id)) {
            return state.shardPromises.get(shard.id);
        }

        const shardUrl = new URL(shard.path, siteRootUrl).href;
        const promise = fetch(shardUrl, { cache: "no-store" })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`分片索引加载失败: ${response.status}`);
                }
                return response.json();
            })
            .then((payload) => {
                state.shardsLoaded.add(shard.id);
                return ingestDocs(Array.isArray(payload.docs) ? payload.docs : []);
            })
            .finally(() => {
                state.shardPromises.delete(shard.id);
            });

        state.shardPromises.set(shard.id, promise);
        return promise;
    }

    async function loadShardBatch(shards) {
        if (!shards.length) {
            return state.docs;
        }
        await Promise.all(shards.map((shard) => loadShard(shard)));
        return state.docs;
    }

    function getAvailableYears(manifest) {
        const shards = Array.isArray(manifest && manifest.shards) ? manifest.shards : [];
        return Array.from(new Set(shards.map((shard) => shard.year))).sort((a, b) => String(b).localeCompare(String(a)));
    }

    function getMonthsForYear(manifest, year) {
        const shards = Array.isArray(manifest && manifest.shards) ? manifest.shards : [];
        return shards
            .filter((shard) => !year || shard.year === year)
            .map((shard) => normalizeMonth(shard.month))
            .filter((month, index, list) => list.indexOf(month) === index)
            .sort((a, b) => String(b).localeCompare(String(a)));
    }

    function setSelectOptions(select, options, placeholder, formatter) {
        if (!select) {
            return;
        }
        const currentValue = select.value;
        const optionHtml = [`<option value="">${placeholder}</option>`]
            .concat(
                options.map((value) => {
                    const label = formatter ? formatter(value) : value;
                    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
                })
            )
            .join("");
        select.innerHTML = optionHtml;
        if (options.includes(currentValue)) {
            select.value = currentValue;
        }
    }

    function applyTargetFilters(target, filters) {
        const yearSelect = target.querySelector("[data-gj-filter-year]");
        const monthSelect = target.querySelector("[data-gj-filter-month]");
        const manifest = state.manifest;
        if (!yearSelect || !monthSelect || !manifest) {
            return;
        }

        const years = getAvailableYears(manifest);
        setSelectOptions(yearSelect, years, "全部年份", (year) => `${year}年`);
        yearSelect.value = filters.year && years.includes(filters.year) ? filters.year : "";

        const months = getMonthsForYear(manifest, yearSelect.value);
        setSelectOptions(monthSelect, months, yearSelect.value ? "全部月份" : "先选年份", (month) => `${month}月`);
        monthSelect.disabled = !yearSelect.value;
        monthSelect.value = filters.month && months.includes(filters.month) ? filters.month : "";
    }

    async function initFilterControls(target, input) {
        const yearSelect = target.querySelector("[data-gj-filter-year]");
        const monthSelect = target.querySelector("[data-gj-filter-month]");
        if (!yearSelect || !monthSelect) {
            return;
        }

        const manifest = await loadManifest();
        applyTargetFilters(target, state.lastFilters);

        const triggerSearch = () => {
            const filters = getSelectedFilters(target);
            state.lastFilters = filters;
            const query = input ? input.value.trim() : "";
            if (query) {
                state.lastQuery = query;
                handleSearch(query, target);
            } else {
                renderResults("", parseQuery(""), [], target, {
                    loaded: state.shardsLoaded.size,
                    total: Array.isArray(manifest.shards) ? manifest.shards.length : 0,
                    loadingMore: false,
                    filters,
                });
            }
        };

        yearSelect.addEventListener("change", () => {
            const filters = getSelectedFilters(target);
            state.lastFilters = { year: filters.year, month: "" };
            applyTargetFilters(target, state.lastFilters);
            triggerSearch();
        });

        monthSelect.addEventListener("change", () => {
            triggerSearch();
        });
    }

    function matchesFilters(doc, filters) {
        const date = String(doc && doc.date ? doc.date : "");
        if (!date) {
            return false;
        }
        if (filters && filters.year && date.slice(0, 4) !== String(filters.year)) {
            return false;
        }
        if (filters && filters.month && date.slice(5, 7) !== normalizeMonth(filters.month)) {
            return false;
        }
        return true;
    }

    function countOccurrences(text, term) {
        if (!text || !term) {
            return 0;
        }
        let count = 0;
        let startIndex = 0;
        while (true) {
            const index = text.indexOf(term, startIndex);
            if (index === -1) {
                break;
            }
            count += 1;
            startIndex = index + term.length;
        }
        return count;
    }

    function highlightText(text, terms) {
        let highlighted = escapeHtml(text);
        terms
            .filter(Boolean)
            .sort((a, b) => b.length - a.length)
            .forEach((term) => {
                highlighted = highlighted.replace(
                    new RegExp(escapeRegExp(escapeHtml(term)), "gi"),
                    "<mark>$&</mark>"
                );
            });
        return highlighted;
    }

    function buildSnippet(doc, queryInfo) {
        const candidateSources = [
            { text: doc.summary || "", label: "摘要" },
            { text: doc.content || "", label: "正文" },
        ];

        let bestSnippet = "";
        let bestScore = -1;

        candidateSources.forEach((source) => {
            const lowered = normalizeSearchText(source.text);
            if (!lowered) {
                return;
            }

            queryInfo.terms.forEach((term) => {
                const index = lowered.indexOf(term);
                if (index === -1) {
                    return;
                }

                const start = Math.max(0, index - 36);
                const end = Math.min(source.text.length, index + 110);
                const snippet = source.text.slice(start, end);
                const snippetNorm = normalizeSearchText(snippet);

                let score = 0;
                queryInfo.terms.forEach((snippetTerm) => {
                    if (snippetNorm.includes(snippetTerm)) {
                        score += 3;
                    }
                });
                if (snippetNorm.includes(queryInfo.exactPhrase)) {
                    score += 5;
                }
                if (source.label === "摘要") {
                    score += 2;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestSnippet = snippet;
                }
            });
        });

        if (!bestSnippet) {
            bestSnippet = (doc.summary || doc.content || "").slice(0, 160);
        }

        let output = bestSnippet.trim();
        const sourceText = doc.content || doc.summary || "";
        if (sourceText.length > output.length && !output.endsWith("...")) {
            output = `${output}...`;
        }
        if (doc.content && !doc.content.startsWith(output.replace(/^\.{3}/, "")) && !output.startsWith("...")) {
            output = `...${output}`;
        }
        return highlightText(output, queryInfo.terms);
    }

    function scoreDoc(doc, queryInfo) {
        let score = 0;
        let matchedTerms = 0;

        queryInfo.terms.forEach((term) => {
            const titleCount = countOccurrences(doc._title, term);
            const keywordCount = countOccurrences(doc._keywords, term);
            const summaryCount = countOccurrences(doc._summary, term);
            const contentCount = countOccurrences(doc._content, term);
            const dateHit = doc._date.includes(term);

            if (titleCount || keywordCount || summaryCount || contentCount || dateHit) {
                matchedTerms += 1;
            }

            score += Math.min(titleCount, 3) * 120;
            score += Math.min(keywordCount, 3) * 70;
            score += Math.min(summaryCount, 4) * 45;
            score += Math.min(contentCount, 8) * 14;
            if (dateHit) {
                score += 150;
            }
            if (doc._title.startsWith(term)) {
                score += 40;
            }
        });

        if (queryInfo.exactPhrase) {
            if (doc._title.includes(queryInfo.exactPhrase)) {
                score += 260;
            }
            if (doc._keywords.includes(queryInfo.exactPhrase)) {
                score += 160;
            }
            if (doc._summary.includes(queryInfo.exactPhrase)) {
                score += 110;
            }
            if (doc._content.includes(queryInfo.exactPhrase)) {
                score += 65;
            }
        }

        if (queryInfo.dateTerms.length && queryInfo.dateTerms.some((term) => doc._date.includes(term))) {
            score += 120;
        }

        score += Number(String(doc.date || "").replace(/-/g, "").slice(2)) / 1000000;
        return { score, matchedTerms };
    }

    function searchDocs(queryInfo, filters) {
        if (!queryInfo.normalized) {
            return [];
        }

        return state.docs
            .filter((doc) => matchesFilters(doc, filters))
            .map((doc) => {
                const { score, matchedTerms } = scoreDoc(doc, queryInfo);
                return {
                    doc,
                    score,
                    matchedTerms,
                    titleHtml: highlightText(doc.title, queryInfo.terms),
                    snippet: buildSnippet(doc, queryInfo),
                };
            })
            .filter((item) => item.score > 0 && item.matchedTerms === queryInfo.terms.length)
            .sort((a, b) => {
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                return String(b.doc.date).localeCompare(String(a.doc.date));
            });
    }

    function shardMatchesDateTerm(shard, term) {
        if (!term) {
            return false;
        }
        if (term === shard.id || term === shard.year) {
            return true;
        }
        if (/^\d{4}-\d{1,2}$/.test(term)) {
            const month = term.split("-")[1].padStart(2, "0");
            return shard.id === `${term.slice(0, 4)}-${month}`;
        }
        if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(term)) {
            const parts = term.split("-");
            return shard.id === `${parts[0]}-${parts[1].padStart(2, "0")}`;
        }
        return shard.id.startsWith(term);
    }

    function uniqueShards(shards) {
        const seen = new Set();
        return shards.filter((shard) => {
            if (!shard || seen.has(shard.id)) {
                return false;
            }
            seen.add(shard.id);
            return true;
        });
    }

    function getLoadedCountForShards(shards) {
        return shards.filter((shard) => state.shardsLoaded.has(shard.id)).length;
    }

    function getShardPlan(manifest, queryInfo, filters) {
        const manifestShards = Array.isArray(manifest.shards) ? manifest.shards.slice() : [];
        const allShards = manifestShards.filter((shard) => {
            if (filters.year && shard.year !== filters.year) {
                return false;
            }
            if (filters.month && normalizeMonth(shard.month) !== normalizeMonth(filters.month)) {
                return false;
            }
            return true;
        });
        if (!allShards.length) {
            return { initial: [], remaining: [], total: 0 };
        }

        if (filters.year && filters.month) {
            return { initial: allShards.slice(0, 1), remaining: [], total: allShards.length };
        }

        const matchedByDate = queryInfo.dateTerms.length
            ? allShards.filter((shard) => queryInfo.dateTerms.some((term) => shardMatchesDateTerm(shard, term)))
            : [];
        const recentShards = allShards.slice(0, INITIAL_BATCH_SIZE);
        const initial = uniqueShards(
            matchedByDate.length
                ? matchedByDate.slice(0, INITIAL_BATCH_SIZE).concat(recentShards)
                : recentShards
        ).slice(0, Math.max(INITIAL_BATCH_SIZE, matchedByDate.length || 0));
        const remaining = allShards.filter((shard) => !initial.some((item) => item.id === shard.id));
        return { initial, remaining, total: allShards.length };
    }

    function createResultHtml(item, queryInfo) {
        const docUrl = new URL(item.doc.url, siteRootUrl).href;
        const keywordHtml = (item.doc.keywords || []).slice(0, 4).map((keyword) => {
            return `<span>${highlightText(keyword, queryInfo.terms)}</span>`;
        }).join("");

        return `
            <article class="gj-search-result">
                <a class="gj-search-result-title" href="${docUrl}" target="_blank" rel="noopener noreferrer">
                    <i class="fas fa-file-alt"></i>
                    <span>${item.titleHtml}</span>
                </a>
                <div class="gj-search-result-date">
                    <i class="fas fa-calendar-alt"></i>
                    <span>${escapeHtml(formatDateLabel(item.doc.date))}</span>
                </div>
                <div class="gj-search-result-snippet">${item.snippet}</div>
                ${keywordHtml ? `<div class="gj-search-keywords">${keywordHtml}</div>` : ""}
            </article>
        `;
    }

    function createEmptyHtml(text) {
        return `<div class="gj-search-empty">${escapeHtml(text)}</div>`;
    }

    function getSearchStateKey(query, filters) {
        const activeFilters = filters || { year: "", month: "" };
        return JSON.stringify({
            query: String(query || ""),
            year: String(activeFilters.year || ""),
            month: String(activeFilters.month || ""),
        });
    }

    function createPaginationHtml(currentPage, totalPages, totalResults) {
        if (totalResults <= SEARCH_RESULTS_PER_PAGE || totalPages <= 1) {
            return "";
        }
        return `
            <div class="gj-search-pagination-inner">
                <button class="gj-search-page-btn" type="button" data-gj-page-action="prev" ${currentPage <= 1 ? "disabled" : ""}>上一页</button>
                <div class="gj-search-page-info">第 ${currentPage} / ${totalPages} 页，共 ${totalResults} 条结果</div>
                <button class="gj-search-page-btn" type="button" data-gj-page-action="next" ${currentPage >= totalPages ? "disabled" : ""}>下一页</button>
            </div>
        `;
    }

    function updatePagination(target, query, queryInfo, results, stats) {
        const pagination = target.querySelector("[data-gj-search-pagination]");
        if (!pagination) {
            return results;
        }

        if (!query || !results.length) {
            pagination.innerHTML = "";
            pagination.hidden = true;
            return results;
        }

        const searchStateKey = getSearchStateKey(query, stats.filters);
        if (target.__gjSearchStateKey !== searchStateKey) {
            target.__gjSearchStateKey = searchStateKey;
            target.__gjSearchPage = 1;
        }

        const totalPages = Math.max(1, Math.ceil(results.length / SEARCH_RESULTS_PER_PAGE));
        const currentPage = Math.min(Math.max(target.__gjSearchPage || 1, 1), totalPages);
        const start = (currentPage - 1) * SEARCH_RESULTS_PER_PAGE;
        const pagedResults = results.slice(start, start + SEARCH_RESULTS_PER_PAGE);

        target.__gjSearchPage = currentPage;
        pagination.hidden = totalPages <= 1;
        pagination.innerHTML = createPaginationHtml(currentPage, totalPages, results.length);

        const prevButton = pagination.querySelector('[data-gj-page-action="prev"]');
        const nextButton = pagination.querySelector('[data-gj-page-action="next"]');
        const rerenderPage = (page) => {
            target.__gjSearchPage = page;
            renderResults(query, queryInfo, results, target, stats);
        };

        if (prevButton) {
            prevButton.addEventListener("click", () => {
                rerenderPage(Math.max(1, currentPage - 1));
            });
        }
        if (nextButton) {
            nextButton.addEventListener("click", () => {
                rerenderPage(Math.min(totalPages, currentPage + 1));
            });
        }

        return pagedResults;
    }

    function replaceHistoryHash(query, filters) {
        if (!isHistoryPage) {
            return;
        }
        const hashParams = new URLSearchParams();
        if (query) {
            hashParams.set("q", query);
        }
        if (filters && filters.year) {
            hashParams.set("y", filters.year);
        }
        if (filters && filters.month) {
            hashParams.set("m", normalizeMonth(filters.month));
        }
        const nextUrl = hashParams.toString() ? `#${hashParams.toString()}` : window.location.pathname;
        window.history.replaceState(null, "", nextUrl);
    }

    function formatSearchMeta(query, results, stats) {
        const scopeLabel = getFilterScopeLabel(stats.filters || { year: "", month: "" });
        if (!query) {
            return scopeLabel === "全站" ? "输入关键词后点击搜索，即可检索全部历史日报" : `已限定在 ${scopeLabel} 内搜索`;
        }
        if (!results.length && stats.loaded === stats.total) {
            return `没有找到与“${query}”相关的日报，已完成 ${scopeLabel} 搜索`;
        }
        if (!results.length) {
            return `还没找到命中结果，正在扩展 ${scopeLabel} 内更早月份（已加载 ${stats.loaded}/${stats.total} 个月）...`;
        }
        if (stats.loadingMore) {
            return `先找到 ${results.length} 条高相关结果，正在扩展 ${scopeLabel} 内更早月份（已加载 ${stats.loaded}/${stats.total} 个月）...`;
        }
        if (stats.loaded < stats.total) {
            return `找到 ${results.length} 条结果，当前优先搜索 ${scopeLabel} 中较新的月份（已加载 ${stats.loaded}/${stats.total} 个月）`;
        }
        return `找到 ${results.length} 条结果，已完成 ${scopeLabel} 搜索（${stats.total} 个月索引）`;
    }

    function shouldOfferLoadAll(query, stats) {
        return Boolean(query && stats && !stats.loadingMore && stats.loaded < stats.total);
    }

    function updateLoadAllButton(target, query, stats, loading) {
        const loadAllButton = target.querySelector("[data-gj-search-load-all]");
        if (!loadAllButton) {
            return;
        }
        const visible = loading || shouldOfferLoadAll(query, stats);
        loadAllButton.hidden = !visible;
        loadAllButton.disabled = Boolean(loading);
        loadAllButton.textContent = loading ? "正在全量检索..." : "继续全量检索";
    }

    function renderResults(query, queryInfo, results, target, stats) {
        const meta = target.querySelector("[data-gj-search-meta]");
        const metaText = target.querySelector("[data-gj-search-meta-text]");
        const resultsContainer = target.querySelector("[data-gj-search-results]");
        const pagination = target.querySelector("[data-gj-search-pagination]");
        if (!resultsContainer || !meta || !metaText) {
            return;
        }

        if (!query) {
            metaText.textContent = formatSearchMeta("", [], stats);
            updateLoadAllButton(target, "", stats, false);
            if (pagination) {
                pagination.innerHTML = "";
                pagination.hidden = true;
            }
            resultsContainer.innerHTML = createEmptyHtml("支持全文检索，例如：提示词、豆包、知识库、封面设计。输入后点击搜索即可。");
            replaceHistoryHash("", stats.filters);
            return;
        }

        metaText.textContent = formatSearchMeta(query, results, stats);
        updateLoadAllButton(target, query, stats, false);
        if (!results.length) {
            if (pagination) {
                pagination.innerHTML = "";
                pagination.hidden = true;
            }
            resultsContainer.innerHTML = createEmptyHtml("换个关键词试试，或等待搜索自动扩展到更早历史。");
        } else {
            const pagedResults = updatePagination(target, query, queryInfo, results, stats);
            resultsContainer.innerHTML = pagedResults.map((item) => createResultHtml(item, queryInfo)).join("");
        }
        replaceHistoryHash(query, stats.filters);
    }

    function isCurrentSearch(version) {
        return version === state.searchVersion;
    }

    async function handleLoadAllSearch(query, target) {
        const version = ++state.searchVersion;
        const queryInfo = parseQuery(query);
        const metaText = target.querySelector("[data-gj-search-meta-text]");
        const resultsContainer = target.querySelector("[data-gj-search-results]");
        const filters = getSelectedFilters(target);
        state.lastQuery = query;
        state.lastFilters = filters;

        if (!queryInfo.normalized) {
            return;
        }

        if (metaText) {
            metaText.textContent = "正在加载剩余月份索引...";
        }
        updateLoadAllButton(target, query, {
            loaded: 0,
            total: 1,
            loadingMore: false,
            filters,
        }, true);

        try {
            const manifest = await loadManifest();
            if (!isCurrentSearch(version)) {
                return;
            }

            if (Array.isArray(manifest.docs)) {
                await ensureLegacyDocs(manifest);
                if (!isCurrentSearch(version)) {
                    return;
                }
                renderResults(query, queryInfo, searchDocs(queryInfo, filters), target, {
                    loaded: 1,
                    total: 1,
                    loadingMore: false,
                    filters,
                });
                return;
            }

            const plan = getShardPlan(manifest, queryInfo, filters);
            const allPlanShards = plan.initial.concat(plan.remaining);
            const pendingShards = allPlanShards.filter((shard) => !state.shardsLoaded.has(shard.id));

            if (resultsContainer && !resultsContainer.innerHTML.trim()) {
                resultsContainer.innerHTML = createEmptyHtml("正在补齐更早月份索引，请稍候...");
            }

            await loadShardBatch(pendingShards);
            if (!isCurrentSearch(version)) {
                return;
            }

            renderResults(query, queryInfo, searchDocs(queryInfo, filters), target, {
                loaded: plan.total,
                total: plan.total,
                loadingMore: false,
                filters,
            });
        } catch (error) {
            console.error(error);
            if (metaText) {
                metaText.textContent = "剩余月份索引加载失败";
            }
            updateLoadAllButton(target, query, {
                loaded: 0,
                total: 1,
                loadingMore: false,
                filters,
            }, false);
            if (resultsContainer) {
                resultsContainer.innerHTML = createEmptyHtml("补齐全量索引失败，请稍后刷新页面重试。");
            }
        }
    }

    async function handleSearch(query, target) {
        const version = ++state.searchVersion;
        const queryInfo = parseQuery(query);
        const metaText = target.querySelector("[data-gj-search-meta-text]");
        const filters = getSelectedFilters(target);
        state.lastFilters = filters;
        const manifest = state.manifest;

        if (!queryInfo.normalized) {
            renderResults("", queryInfo, [], target, {
                loaded: 0,
                total: Array.isArray(manifest && manifest.shards)
                    ? getShardPlan(manifest, parseQuery(""), filters).total
                    : state.shardsLoaded.size || 0,
                loadingMore: false,
                filters,
            });
            return;
        }

        if (metaText) {
            metaText.textContent = "正在加载搜索索引...";
        }
        updateLoadAllButton(target, query, {
            loaded: 0,
            total: 1,
            loadingMore: false,
            filters,
        }, false);

        try {
            const manifest = await loadManifest();
            if (!isCurrentSearch(version)) {
                return;
            }

            if (Array.isArray(manifest.docs)) {
                await ensureLegacyDocs(manifest);
                if (!isCurrentSearch(version)) {
                    return;
                }
                renderResults(query, queryInfo, searchDocs(queryInfo, filters), target, {
                    loaded: 1,
                    total: 1,
                    loadingMore: false,
                    filters,
                });
                return;
            }

            const plan = getShardPlan(manifest, queryInfo, filters);
            const pendingInitial = plan.initial.filter((shard) => !state.shardsLoaded.has(shard.id));
            await loadShardBatch(pendingInitial);
            if (!isCurrentSearch(version)) {
                return;
            }

            let results = searchDocs(queryInfo, filters);
            let remainingPlan = plan.remaining.filter((shard) => !state.shardsLoaded.has(shard.id));

            while (remainingPlan.length && results.length < MIN_RESULTS_TARGET) {
                renderResults(query, queryInfo, results, target, {
                    loaded: getLoadedCountForShards(plan.initial.concat(remainingPlan)),
                    total: plan.total,
                    loadingMore: true,
                    filters,
                });
                const nextBatch = remainingPlan.splice(0, FOLLOWUP_BATCH_SIZE);
                await loadShardBatch(nextBatch);
                if (!isCurrentSearch(version)) {
                    return;
                }
                results = searchDocs(queryInfo, filters);
            }

            renderResults(query, queryInfo, results, target, {
                loaded: getLoadedCountForShards(plan.initial.concat(remainingPlan)),
                total: plan.total,
                loadingMore: false,
                filters,
            });
        } catch (error) {
            console.error(error);
            const resultsContainer = target.querySelector("[data-gj-search-results]");
            if (metaText) {
                metaText.textContent = "搜索索引加载失败";
            }
            updateLoadAllButton(target, query, {
                loaded: 0,
                total: 1,
                loadingMore: false,
                filters,
            }, false);
            if (resultsContainer) {
                resultsContainer.innerHTML = createEmptyHtml("索引暂时不可用，请稍后刷新页面重试。");
            }
        }
    }

    function attachSearchBehavior(target, input) {
        const executeSearch = () => {
            const query = input.value.trim();
            state.lastQuery = query;
            handleSearch(query, target);
        };

        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                executeSearch();
            }
        });

        const searchButton = target.querySelector("[data-gj-search-submit]");
        if (searchButton) {
            searchButton.addEventListener("click", executeSearch);
        }

        const clearButton = target.querySelector("[data-gj-search-clear]");
        if (clearButton) {
            clearButton.addEventListener("click", () => {
                state.searchVersion += 1;
                input.value = "";
                state.lastQuery = "";
                renderResults("", parseQuery(""), [], target, {
                    loaded: 0,
                    total: Array.isArray(state.manifest && state.manifest.shards)
                        ? getShardPlan(state.manifest, parseQuery(""), getSelectedFilters(target)).total
                        : state.shardsLoaded.size || 0,
                    loadingMore: false,
                    filters: getSelectedFilters(target),
                });
                input.focus();
            });
        }

        const loadAllButton = target.querySelector("[data-gj-search-load-all]");
        if (loadAllButton) {
            loadAllButton.addEventListener("click", () => {
                const query = input.value.trim();
                state.lastQuery = query;
                handleLoadAllSearch(query, target);
            });
        }

        renderResults("", parseQuery(""), [], target, {
            loaded: 0,
            total: 0,
            loadingMore: false,
            filters: getSelectedFilters(target),
        });
    }

    function buildInlineCard() {
        const section = document.createElement("section");
        section.className = "w-full mb-6";
        section.id = "history-search-section";
        section.innerHTML = `
            <div class="gj-search-card">
                <div class="gj-search-header">
                    <div class="gj-search-title">
                        <i class="fas fa-search"></i>
                        <span>搜索历史内容</span>
                    </div>
                </div>
                <div class="gj-search-bar">
                    <div class="gj-search-input-wrap">
                        <i class="fas fa-search gj-search-input-icon"></i>
                        <input class="gj-search-input" type="search" placeholder="输入关键词，例如：提示词、封面、豆包、知识库" aria-label="搜索全部日报">
                    </div>
                    <button class="gj-search-submit" type="button" data-gj-search-submit="true">
                        <i class="fas fa-search"></i>
                        <span>搜索</span>
                    </button>
                    <button class="gj-search-clear" type="button" data-gj-search-clear="true">清空</button>
                </div>
                <div class="gj-search-filters">
                    <div class="gj-search-filter-group">
                        <span class="gj-search-filter-label">搜索年份</span>
                        <select class="gj-search-select" data-gj-filter-year="true" aria-label="按年份筛选"></select>
                    </div>
                    <div class="gj-search-filter-group">
                        <span class="gj-search-filter-label">搜索月份</span>
                        <select class="gj-search-select" data-gj-filter-month="true" aria-label="按月份筛选"></select>
                    </div>
                </div>
                <div class="gj-search-meta" data-gj-search-meta="true">
                    <span data-gj-search-meta-text="true"></span>
                    <div class="gj-search-meta-actions">
                        <button class="gj-search-open-history gj-search-load-all" type="button" data-gj-search-load-all="true" hidden>继续全量检索</button>
                    </div>
                </div>
                <div class="gj-search-results" data-gj-search-results="true"></div>
                <div class="gj-search-pagination" data-gj-search-pagination="true" hidden></div>
            </div>
        `;
        return section;
    }

    function initHistorySearch() {
        const errorMessage = document.getElementById("error-message");
        if (!errorMessage || document.getElementById("gj-inline-search")) {
            return;
        }

        const card = buildInlineCard();
        card.id = "gj-inline-search";
        errorMessage.insertAdjacentElement("afterend", card);

        const input = card.querySelector(".gj-search-input");
        attachSearchBehavior(card, input);
        card.__filterInitPromise = initFilterControls(card, input).then(() => {
            if (state.lastQuery) {
                input.value = state.lastQuery;
                handleSearch(state.lastQuery, card);
            }
        });
    }

    function buildModal() {
        const overlay = document.createElement("div");
        overlay.className = "gj-search-overlay";
        overlay.id = "gj-search-overlay";
        overlay.innerHTML = `
            <div class="gj-search-modal" role="dialog" aria-modal="true" aria-labelledby="gj-search-modal-title">
                <div class="gj-search-header">
                    <div>
                        <div class="gj-search-title" id="gj-search-modal-title">
                            <i class="fas fa-search"></i>
                            <span>搜索全部日报</span>
                        </div>
                        <div class="gj-search-hint">输入关键词后点击搜索，先搜最近月份，再补充更早历史。</div>
                    </div>
                    <div class="gj-search-modal-actions">
                        <span class="gj-search-shortcut">快捷键 Ctrl/Cmd + K</span>
                        <button class="gj-search-close" type="button" data-gj-search-close="true">关闭</button>
                    </div>
                </div>
                <div class="gj-search-bar">
                    <div class="gj-search-input-wrap">
                        <i class="fas fa-search gj-search-input-icon"></i>
                        <input class="gj-search-input" type="search" placeholder="输入全文关键词" aria-label="搜索全部日报">
                    </div>
                    <button class="gj-search-submit" type="button" data-gj-search-submit="true">
                        <i class="fas fa-search"></i>
                        <span>搜索</span>
                    </button>
                    <button class="gj-search-clear" type="button" data-gj-search-clear="true">清空</button>
                    <button class="gj-search-open-history" type="button" data-gj-open-history="true">历史页</button>
                </div>
                <div class="gj-search-filters">
                    <div class="gj-search-filter-group">
                        <span class="gj-search-filter-label">年份</span>
                        <select class="gj-search-select" data-gj-filter-year="true" aria-label="按年份筛选"></select>
                    </div>
                    <div class="gj-search-filter-group">
                        <span class="gj-search-filter-label">月份</span>
                        <select class="gj-search-select" data-gj-filter-month="true" aria-label="按月份筛选"></select>
                    </div>
                </div>
                <div class="gj-search-meta" data-gj-search-meta="true">
                    <span data-gj-search-meta-text="true"></span>
                    <div class="gj-search-meta-actions">
                        <button class="gj-search-open-history gj-search-load-all" type="button" data-gj-search-load-all="true" hidden>继续全量检索</button>
                    </div>
                </div>
                <div class="gj-search-modal-body">
                    <div class="gj-search-results" data-gj-search-results="true"></div>
                    <div class="gj-search-pagination" data-gj-search-pagination="true" hidden></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeModal();
            }
        });

        const input = overlay.querySelector(".gj-search-input");
        attachSearchBehavior(overlay, input);
        overlay.__filterInitPromise = initFilterControls(overlay, input);

        overlay.querySelector("[data-gj-search-close]").addEventListener("click", closeModal);
        overlay.querySelector("[data-gj-open-history]").addEventListener("click", () => {
            const historyUrl = new URL("historical_page_summary.html", siteRootUrl).href;
            const query = input.value.trim();
            const filters = getSelectedFilters(overlay);
            const hashParams = new URLSearchParams();
            if (query) {
                hashParams.set("q", query);
            }
            if (filters.year) {
                hashParams.set("y", filters.year);
            }
            if (filters.month) {
                hashParams.set("m", normalizeMonth(filters.month));
            }
            window.open(hashParams.toString() ? `${historyUrl}#${hashParams.toString()}` : historyUrl, "_blank", "noopener,noreferrer");
        });

        return overlay;
    }

    async function openModal() {
        const overlay = document.getElementById("gj-search-overlay") || buildModal();
        overlay.classList.add("active");
        if (overlay.__filterInitPromise) {
            await overlay.__filterInitPromise;
        }
        applyTargetFilters(overlay, state.lastFilters);
        const input = overlay.querySelector(".gj-search-input");
        input.value = state.lastQuery || "";
        input.focus();
        handleSearch(input.value.trim(), overlay);
    }

    function closeModal() {
        const overlay = document.getElementById("gj-search-overlay");
        if (overlay) {
            overlay.classList.remove("active");
        }
    }

    function initDailySearch() {
        const stack = document.querySelector(".floating-action-stack");
        if (!stack || document.getElementById("gj-search-trigger")) {
            return;
        }

        const button = document.createElement("button");
        button.id = "gj-search-trigger";
        button.className = "toc-floating-button";
        button.type = "button";
        button.title = "搜索全部日报";
        button.setAttribute("aria-label", "搜索全部日报");
        button.innerHTML = '<i class="fas fa-search"></i>';
        button.addEventListener("click", openModal);
        stack.insertBefore(button, stack.firstChild);

        document.addEventListener("keydown", (event) => {
            const isShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
            if (isShortcut) {
                event.preventDefault();
                openModal();
            } else if (event.key === "Escape") {
                closeModal();
            }
        });
    }

    function parseHashSearchState() {
        const hash = window.location.hash || "";
        if (!hash.startsWith("#")) {
            return;
        }
        const params = new URLSearchParams(hash.slice(1));
        state.lastQuery = params.get("q") || "";
        state.lastFilters = {
            year: params.get("y") || "",
            month: normalizeMonth(params.get("m") || ""),
        };
    }

    function init() {
        initInlineIcons();
        parseHashSearchState();
        if (isHistoryPage) {
            initHistorySearch();
        } else {
            initDailySearch();
        }
    }

    window.__GJSiteSearch = {
        open: openModal,
        close: closeModal,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
