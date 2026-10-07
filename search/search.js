// Search page: loads search-index.json (built by build_search_index.py) and
// searches it in the browser with MiniSearch. No server involved.
(function () {
    var MAX_EPISODES = 20;
    var MAX_PASSAGES = 3;
    var SNIPPET_CHARS = 240;

    var input = document.getElementById("q");
    var status = document.getElementById("status");
    var results = document.getElementById("results");
    var data = null;
    var mini = null;
    var timer = null;

    function esc(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // "2025-01-03" -> "Jan 3, 2025". The date is the feed's UTC date, so format it
    // in UTC; local time would show the day before for some readers.
    function fmtDate(iso) {
        var d = new Date(iso + "T00:00:00Z");
        return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    }

    function escRe(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // MiniSearch's default tokenizer treats "#" as punctuation, so "C#" was
    // indexed and searched as just "c". Keep a "#" that is glued to a word
    // ("C#", "F#") as part of that word. Used for both the index and the query.
    var HASH = "\uE000";
    var defaultTokenize = MiniSearch.getDefault("tokenize");
    function tokenize(text, fieldName) {
        return defaultTokenize(text.replace(/([\p{L}\p{N}])#/gu, "$1" + HASH), fieldName).map(function (t) {
            return t.split(HASH).join("#");
        });
    }

    // Matches a search term only as a whole word: not inside a longer word
    // ("c" in "because") and not as the front of a longer token ("c" in "C#").
    // Written without lookbehind, which older iPhones don't support, so the
    // character before the term is captured as group 1.
    function termRegex(terms) {
        if (!terms.length) { return null; }
        var alternation = terms.slice().sort(function (a, b) { return b.length - a.length; }).map(escRe).join("|");
        return new RegExp("(^|[^\\p{L}\\p{N}])(" + alternation + ")(?![\\p{L}\\p{N}#+])", "giu");
    }

    // Text with each whole-word match wrapped in <mark>; everything is escaped
    // piece by piece, so the term can never match inside an HTML entity.
    function highlight(text, re) {
        var out = "";
        var last = 0;
        var m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            var at = m.index + m[1].length;
            out += esc(text.slice(last, at)) + "<mark>" + esc(m[2]) + "</mark>";
            last = at + m[2].length;
        }
        return out + esc(text.slice(last));
    }

    // Passage text with the matched words highlighted, trimmed to a window
    // around the first match.
    function snippet(text, terms) {
        var re = termRegex(terms);
        var start = 0;
        if (re) {
            var m = re.exec(text);
            var first = m ? m.index + m[1].length : -1;
            if (first > SNIPPET_CHARS / 2) {
                start = text.lastIndexOf(" ", first - SNIPPET_CHARS / 3) + 1;
            }
        }
        var end = start + SNIPPET_CHARS;
        if (end < text.length) {
            var space = text.indexOf(" ", end);
            end = space === -1 ? text.length : space;
        } else {
            end = text.length;
        }
        var piece = text.slice(start, end);
        return (start > 0 ? "&hellip; " : "") + (re ? highlight(piece, re) : esc(piece)) + (end < text.length ? " &hellip;" : "");
    }

    function build(json) {
        data = json;
        mini = new MiniSearch({
            fields: ["title", "summary", "themes", "references", "text"],
            idField: "id",
            tokenize: tokenize,
            searchOptions: {
                boost: { title: 3, themes: 2, summary: 1.5, references: 1.5 },
                prefix: function (term) { return term.length > 2; },
                fuzzy: function (term) { return term.length > 4 ? 0.2 : false; },
                combineWith: "AND"
            }
        });
        var docs = [];
        data.episodes.forEach(function (ep, i) {
            docs.push({
                id: "e" + i,
                title: ep.title,
                summary: ep.summary,
                themes: ep.themes.join(" "),
                references: ep.references.join(" ")
            });
        });
        data.passages.forEach(function (p, j) {
            docs.push({ id: "p" + j, text: p[3] });
        });
        // Synchronous on purpose: addAllAsync paces itself with timers, which
        // browsers throttle to about one a second in a background tab.
        mini.addAll(docs);
    }

    function run() {
        var q = input.value.trim();
        try {
            history.replaceState(null, "", q ? "?q=" + encodeURIComponent(q) : location.pathname);
        } catch (e) { /* the URL is a convenience only */ }
        if (!mini) { return; }
        if (!q) {
            results.innerHTML = "";
            status.textContent = data.episodes.length + " episodes, " + data.passages.length + " passages indexed.";
            return;
        }

        var found = mini.search(q);
        var byEpisode = {};
        var order = [];
        found.forEach(function (hit) {
            var isEpisode = hit.id.charAt(0) === "e";
            var n = parseInt(hit.id.slice(1), 10);
            var epIndex = isEpisode ? n : data.passages[n][0];
            var group = byEpisode[epIndex];
            if (!group) {
                group = byEpisode[epIndex] = { index: epIndex, score: 0, fields: {}, passages: [], passageCount: 0 };
                order.push(group);
            }
            if (isEpisode) {
                group.score += hit.score * 2;
                Object.keys(hit.match).forEach(function (term) {
                    hit.match[term].forEach(function (f) { group.fields[f] = true; });
                });
                group.terms = (group.terms || []).concat(hit.terms);
            } else {
                group.score += hit.score;
                group.passageCount += 1;
                if (group.passages.length < MAX_PASSAGES) { group.passages.push({ row: data.passages[n], terms: hit.terms }); }
            }
        });
        order.sort(function (a, b) { return b.score - a.score; });

        var html = order.slice(0, MAX_EPISODES).map(function (g) {
            var ep = data.episodes[g.index];
            var where = Object.keys(g.fields).map(function (f) { return f === "text" ? "transcript" : f; });
            var out = '<div class="hit"><h2><a href="/episodes/' + esc(ep.slug) + '.html">Episode ' + ep.n + " - " + esc(ep.title) + "</a></h2>";
            if (ep.date) { out += '<div class="where">published ' + esc(fmtDate(ep.date)) + "</div>"; }
            if (where.length) { out += '<div class="where">matches the ' + where.join(", ") + "</div>"; }
            g.passages.forEach(function (p) {
                out += "<blockquote><span class=\"ts\">[" + esc(p.row[1]) + "]</span> <strong>" + esc(p.row[2]) + ":</strong> " + snippet(p.row[3], p.terms) + "</blockquote>";
            });
            if (g.passageCount > g.passages.length) {
                out += '<div class="where">and ' + (g.passageCount - g.passages.length) + " more passage" + (g.passageCount - g.passages.length === 1 ? "" : "s") + " in this episode</div>";
            }
            return out + "</div>";
        }).join("");
        results.innerHTML = html;

        if (!order.length) {
            status.textContent = "No matches for \"" + q + "\".";
        } else {
            status.textContent = order.length + " episode" + (order.length === 1 ? "" : "s") + " match" + (order.length === 1 ? "es" : "") +
                (order.length > MAX_EPISODES ? " (showing the best " + MAX_EPISODES + ")" : "") + ".";
        }
    }

    input.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(run, 150);
    });

    var started = Date.now();
    fetch("search-index.json")
        .then(function (r) {
            if (!r.ok) { throw new Error(r.status); }
            return r.json();
        })
        .then(build)
        .then(function () {
            input.value = new URLSearchParams(location.search).get("q") || "";
            run();
            if (window.console) { console.log("search index ready in " + (Date.now() - started) + " ms"); }
        })
        .catch(function () {
            status.textContent = "The search index couldn't be loaded. Try reloading the page.";
        });
})();
