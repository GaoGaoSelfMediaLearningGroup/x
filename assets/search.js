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
            if (input && input.value.trim()) {
                handleSearch(input.value.trim(), target);
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

    function searchDocs(queryInfo) {
        if (!queryInfo.normalized) {
            return [];
        }

        return state.docs
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
            })
            .slice(0, 50);
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
            return scopeLabel === "全站" ? "输入关键词后即可检索全部历史日报" : `已限定在 ${scopeLabel} 内搜索`;
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

    function renderResults(query, queryInfo, results, target, stats) {
        const meta = target.querySelector("[data-gj-search-meta]");
        const resultsContainer = target.querySelector("[data-gj-search-results]");
        if (!resultsContainer || !meta) {
            return;
        }

        if (!query) {
            meta.textContent = formatSearchMeta("", [], stats);
            resultsContainer.innerHTML = createEmptyHtml("支持全文检索，例如：提示词、豆包、知识库、封面设计");
            replaceHistoryHash("", stats.filters);
            return;
        }

        meta.textContent = formatSearchMeta(query, results, stats);
        if (!results.length) {
            resultsContainer.innerHTML = createEmptyHtml("换个关键词试试，或等待搜索自动扩展到更早历史。");
        } else {
            resultsContainer.innerHTML = results.map((item) => createResultHtml(item, queryInfo)).join("");
        }
        replaceHistoryHash(query, stats.filters);
    }

    function isCurrentSearch(version) {
        return version === state.searchVersion;
    }

    async function handleSearch(query, target) {
        const version = ++state.searchVersion;
        const queryInfo = parseQuery(query);
        const meta = target.querySelector("[data-gj-search-meta]");
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

        if (meta) {
            meta.textContent = "正在加载搜索索引...";
        }

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
                renderResults(query, queryInfo, searchDocs(queryInfo), target, {
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

            let results = searchDocs(queryInfo);
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
                results = searchDocs(queryInfo);
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
            if (meta) {
                meta.textContent = "搜索索引加载失败";
            }
            if (resultsContainer) {
                resultsContainer.innerHTML = createEmptyHtml("索引暂时不可用，请稍后刷新页面重试。");
            }
        }
    }

    function attachSearchBehavior(target, input) {
        const runSearch = debounce(() => {
            const query = input.value.trim();
            state.lastQuery = query;
            handleSearch(query, target);
        }, 120);

        input.addEventListener("input", runSearch);
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                const query = input.value.trim();
                state.lastQuery = query;
                handleSearch(query, target);
            }
        });

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
        section.innerHTML = `
            <div class="gj-search-card">
                <div class="gj-search-header">
                    <div>
                        <div class="gj-search-title">
                            <i class="fas fa-search"></i>
                            <span>全站全文检索</span>
                        </div>
                        <div class="gj-search-hint">优先搜索最近月份，并自动扩展到更早历史。</div>
                    </div>
                </div>
                <div class="gj-search-bar">
                    <div class="gj-search-input-wrap">
                        <i class="fas fa-search gj-search-input-icon"></i>
                        <input class="gj-search-input" type="search" placeholder="输入关键词，例如：提示词、封面、豆包、知识库" aria-label="搜索全部日报">
                    </div>
                    <button class="gj-search-clear" type="button" data-gj-search-clear="true">清空</button>
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
                <div class="gj-search-meta" data-gj-search-meta="true"></div>
                <div class="gj-search-results" data-gj-search-results="true"></div>
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
                        <div class="gj-search-hint">先搜最近月份，再自动补充更早历史。</div>
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
                <div class="gj-search-meta" data-gj-search-meta="true"></div>
                <div class="gj-search-modal-body">
                    <div class="gj-search-results" data-gj-search-results="true"></div>
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
        button.title = "搜索历史日报";
        button.setAttribute("aria-label", "搜索历史日报");
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
