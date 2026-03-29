/* ACB Review UI — vanilla JS, no build step. */

(function () {
  "use strict";

  let state = { acb: null, review: null };

  // ── Bootstrap ──────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    try {
      const resp = await fetch("/api/review");
      if (!resp.ok) throw new Error(await resp.text());
      state = await resp.json();
      render();
    } catch (err) {
      document.getElementById("loading").textContent =
        "Failed to load review: " + err.message;
    }
  }

  // ── Render ─────────────────────────────────────────────────────────

  function render() {
    document.getElementById("loading").classList.add("hidden");

    renderHeader();
    renderGroups();
    renderUncovered();
    renderQuestions();
    renderNegativeSpace();
    setupDiffModal();
  }

  function renderHeader() {
    const acb = state.acb;
    const review = state.review;

    const branchInfo = document.getElementById("branch-info");
    const ref = acb.change_set_ref || {};
    branchInfo.textContent = (ref.head_ref || "").substring(0, 8) + " vs " + (ref.base_ref || "").substring(0, 8);

    updateProgress();
  }

  function updateProgress() {
    const review = state.review;
    const verdicts = review.group_verdicts || [];
    const total = verdicts.length;
    const reviewed = verdicts.filter(function (v) { return v.verdict !== "pending"; }).length;
    const accepted = verdicts.filter(function (v) { return v.verdict === "accepted"; }).length;

    var pct = total > 0 ? (reviewed / total) * 100 : 0;
    document.getElementById("progress-fill").style.width = pct + "%";
    document.getElementById("progress-text").textContent = reviewed + "/" + total + " reviewed";

    var overallBadge = document.getElementById("overall-verdict");
    var overall = review.overall_verdict || "pending";
    overallBadge.textContent = overall.replace("_", " ");
    overallBadge.className = "verdict-badge " + overall;

    // Color the progress bar based on state.
    var fill = document.getElementById("progress-fill");
    if (verdicts.some(function (v) { return v.verdict === "rejected"; })) {
      fill.style.background = "var(--red)";
    } else if (accepted === total && total > 0) {
      fill.style.background = "var(--green)";
    } else {
      fill.style.background = "var(--accent)";
    }
  }

  // ── Intent Groups ──────────────────────────────────────────────────

  function renderGroups() {
    var container = document.getElementById("groups-container");
    container.innerHTML = "";
    container.classList.remove("hidden");

    var groups = state.acb.intent_groups || [];
    var verdictMap = buildVerdictMap();

    groups.forEach(function (group) {
      var verdict = verdictMap[group.id] || { verdict: "pending", comment: "" };
      container.appendChild(createGroupCard(group, verdict));
    });
  }

  function buildVerdictMap() {
    var map = {};
    (state.review.group_verdicts || []).forEach(function (v) {
      map[v.group_id] = v;
    });
    return map;
  }

  function createGroupCard(group, verdict) {
    var card = document.createElement("div");
    card.className = "group-card " + verdict.verdict;
    card.dataset.groupId = group.id;

    // Header
    var header = document.createElement("div");
    header.className = "group-header";
    header.onclick = function () { card.classList.toggle("expanded"); };

    var titleRow = document.createElement("div");
    titleRow.className = "group-title-row";

    var title = document.createElement("span");
    title.className = "group-title";
    title.textContent = group.title;

    var id = document.createElement("span");
    id.className = "group-id";
    id.textContent = group.id;

    var cls = document.createElement("span");
    cls.className = "classification-badge " + group.classification;
    cls.textContent = group.classification;

    var arrow = document.createElement("span");
    arrow.className = "expand-indicator";
    arrow.textContent = "\u25B6";

    titleRow.appendChild(title);
    titleRow.appendChild(id);
    titleRow.appendChild(cls);
    header.appendChild(titleRow);
    header.appendChild(arrow);
    card.appendChild(header);

    // Body
    var body = document.createElement("div");
    body.className = "group-body";

    // Ambiguity tags
    var tags = group.ambiguity_tags || [];
    if (tags.length > 0) {
      var tagsDiv = document.createElement("div");
      tagsDiv.className = "ambiguity-tags";
      tags.forEach(function (tag) {
        var tagEl = document.createElement("span");
        tagEl.className = "ambiguity-tag";
        tagEl.textContent = tag;
        tagsDiv.appendChild(tagEl);
      });
      body.appendChild(tagsDiv);
    }

    // Task grounding
    if (group.task_grounding) {
      var grounding = document.createElement("div");
      grounding.className = "task-grounding";
      grounding.textContent = group.task_grounding;
      body.appendChild(grounding);
    }

    // File refs
    var fileRefs = group.file_refs || [];
    if (fileRefs.length > 0) {
      var refsDiv = document.createElement("div");
      refsDiv.className = "file-refs";
      var refsH4 = document.createElement("h4");
      refsH4.textContent = "Files";
      refsDiv.appendChild(refsH4);

      fileRefs.forEach(function (ref) {
        var refEl = document.createElement("div");
        refEl.className = "file-ref";
        refEl.textContent = ref.path;
        refEl.onclick = function (e) {
          e.stopPropagation();
          showDiff(ref.path);
        };

        var ranges = (ref.ranges || []).join(", ");
        if (ranges) {
          var rangeSpan = document.createElement("span");
          rangeSpan.className = "ranges";
          rangeSpan.textContent = "L" + ranges;
          refEl.appendChild(rangeSpan);
        }
        refsDiv.appendChild(refEl);
      });
      body.appendChild(refsDiv);
    }

    // Annotations
    var annotations = group.annotations || [];
    if (annotations.length > 0) {
      var annDiv = document.createElement("div");
      annDiv.className = "annotations";
      var annH4 = document.createElement("h4");
      annH4.textContent = "Annotations";
      annDiv.appendChild(annH4);

      annotations.forEach(function (ann) {
        var annEl = document.createElement("div");
        annEl.className = "annotation " + (ann.type || "note");

        var typeEl = document.createElement("div");
        typeEl.className = "annotation-type";
        typeEl.textContent = (ann.type || "note").replace("_", " ");

        var bodyEl = document.createElement("div");
        bodyEl.className = "annotation-body";
        bodyEl.textContent = ann.body || "";

        annEl.appendChild(typeEl);
        annEl.appendChild(bodyEl);
        annDiv.appendChild(annEl);
      });
      body.appendChild(annDiv);
    }

    // Verdict controls
    var controls = document.createElement("div");
    controls.className = "verdict-controls";

    ["accept", "reject", "discuss"].forEach(function (action) {
      var verdictValue =
        action === "accept" ? "accepted" :
        action === "reject" ? "rejected" : "needs_discussion";

      var btn = document.createElement("button");
      btn.className = "verdict-btn " + action;
      if (verdict.verdict === verdictValue) btn.classList.add("active");
      btn.textContent = action.charAt(0).toUpperCase() + action.slice(1);
      btn.onclick = function (e) {
        e.stopPropagation();
        submitVerdict(group.id, verdictValue, card);
      };
      controls.appendChild(btn);
    });

    var commentInput = document.createElement("textarea");
    commentInput.className = "comment-input";
    commentInput.placeholder = "Comment (optional)";
    commentInput.rows = 1;
    commentInput.value = verdict.comment || "";
    commentInput.onclick = function (e) { e.stopPropagation(); };
    commentInput.onblur = function () {
      submitComment(group.id, commentInput.value);
    };
    controls.appendChild(commentInput);

    body.appendChild(controls);
    card.appendChild(body);

    return card;
  }

  // ── API Calls ──────────────────────────────────────────────────────

  async function submitVerdict(groupId, verdict, card) {
    var commentEl = card.querySelector(".comment-input");
    var comment = commentEl ? commentEl.value : "";

    var resp = await fetch("/api/verdict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId, verdict: verdict, comment: comment }),
    });

    if (resp.ok) {
      var data = await resp.json();
      // Update local state.
      (state.review.group_verdicts || []).forEach(function (v) {
        if (v.group_id === groupId) {
          v.verdict = verdict;
          v.comment = comment;
        }
      });
      state.review.overall_verdict = data.overall_verdict;

      // Update card.
      card.className = "group-card expanded " + verdict;
      card.querySelectorAll(".verdict-btn").forEach(function (btn) {
        var val =
          btn.classList.contains("accept") ? "accepted" :
          btn.classList.contains("reject") ? "rejected" : "needs_discussion";
        btn.classList.toggle("active", val === verdict);
      });
      updateProgress();
    }
  }

  async function submitComment(groupId, comment) {
    await fetch("/api/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId, comment: comment }),
    });
    // Update local state.
    (state.review.group_verdicts || []).forEach(function (v) {
      if (v.group_id === groupId) v.comment = comment;
    });
  }

  // ── Diff Modal ─────────────────────────────────────────────────────

  function setupDiffModal() {
    document.getElementById("diff-close").onclick = closeDiff;
    document.getElementById("diff-modal").onclick = function (e) {
      if (e.target === this) closeDiff();
    };
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDiff();
    });
  }

  async function showDiff(filePath) {
    var modal = document.getElementById("diff-modal");
    var title = document.getElementById("diff-title");
    var content = document.getElementById("diff-content");

    title.textContent = filePath;
    content.innerHTML = "<span class='diff-meta'>Loading diff...</span>";
    modal.classList.remove("hidden");

    try {
      var resp = await fetch("/api/diff?path=" + encodeURIComponent(filePath));
      if (!resp.ok) throw new Error(await resp.text());
      var data = await resp.json();
      content.innerHTML = renderDiff(data.diff);
    } catch (err) {
      content.innerHTML = "<span class='diff-meta'>Error: " + escapeHtml(err.message) + "</span>";
    }
  }

  function closeDiff() {
    document.getElementById("diff-modal").classList.add("hidden");
  }

  function renderDiff(raw) {
    if (!raw) return "<span class='diff-meta'>No diff available</span>";

    return raw.split("\n").map(function (line) {
      var escaped = escapeHtml(line);
      if (line.startsWith("+++") || line.startsWith("---")) {
        return "<span class='diff-meta'>" + escaped + "</span>";
      } else if (line.startsWith("@@")) {
        return "<span class='diff-hunk'>" + escaped + "</span>";
      } else if (line.startsWith("+")) {
        return "<span class='diff-add'>" + escaped + "</span>";
      } else if (line.startsWith("-")) {
        return "<span class='diff-del'>" + escaped + "</span>";
      } else if (line.startsWith("diff ") || line.startsWith("index ")) {
        return "<span class='diff-meta'>" + escaped + "</span>";
      }
      return escaped;
    }).join("\n");
  }

  // ── Uncovered, Questions, Negative Space ───────────────────────────

  function renderUncovered() {
    var files = state.acb.uncovered_files || [];
    if (files.length === 0) return;

    var section = document.getElementById("uncovered-section");
    section.classList.remove("hidden");

    var list = document.getElementById("uncovered-list");
    files.forEach(function (f) {
      var li = document.createElement("li");
      li.textContent = f;
      li.style.cursor = "pointer";
      li.onclick = function () { showDiff(f); };
      list.appendChild(li);
    });
  }

  function renderQuestions() {
    var questions = state.acb.open_questions || [];
    if (questions.length === 0) return;

    var section = document.getElementById("questions-section");
    section.classList.remove("hidden");

    var container = document.getElementById("questions-list");
    questions.forEach(function (q) {
      var card = document.createElement("div");
      card.className = "question-card";

      var text = document.createElement("div");
      text.className = "question-text";
      text.textContent = q.question;
      card.appendChild(text);

      if (q.context) {
        var ctx = document.createElement("div");
        ctx.className = "question-context";
        ctx.textContent = q.context;
        card.appendChild(ctx);
      }

      if (q.default_behavior) {
        var def = document.createElement("div");
        def.className = "question-default";
        def.textContent = "Default: " + q.default_behavior;
        card.appendChild(def);
      }

      container.appendChild(card);
    });
  }

  function renderNegativeSpace() {
    var entries = state.acb.negative_space || [];
    if (entries.length === 0) return;

    var section = document.getElementById("negative-space-section");
    section.classList.remove("hidden");

    var list = document.getElementById("negative-space-list");
    entries.forEach(function (entry) {
      var li = document.createElement("li");
      li.textContent = entry.path;

      if (entry.reason) {
        var reason = document.createElement("span");
        reason.className = "ns-reason";
        reason.textContent = entry.reason.replace(/_/g, " ");
        li.appendChild(reason);
      }
      list.appendChild(li);
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
