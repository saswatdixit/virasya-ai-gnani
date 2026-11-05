import { useState, useMemo, type FormEvent } from "react";
import { usePreserve } from "../context/PreserveContext";
import type { VocabularyEntry } from "../types";
import { STORY_LANGUAGES } from "../types";
import { saveVocabularyToBackend } from "../api";
import { combineOptionalAndTranscribedText } from "../utils";

export default function Page4Vocabulary() {
  const {
    state,
    goToStep,
    addVocabEntry,
    updateVocabEntry,
    removeVocabEntry,
  } = usePreserve();

  const fallbackWorking = combineOptionalAndTranscribedText(
    state.form.story,
    state.tx.gnani?.text || state.tx.vaani?.text
  );
  const workingText = state.ed.text || fallbackWorking;
  const vocab = state.vocab;

  // Active form state
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTerm, setFormTerm] = useState({
    preferred: "",
    heard: "",
    meaning: "",
    language: "Odia",
    context: "",
    kind: "Cultural Term",
    pronunciation: "",
  });

  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [isSavingVocab, setIsSavingVocab] = useState(false);

  const cleanWord = (t: string) =>
    t.replace(/^[।,.;:?!"“”‘’'()\s-]+|[।,.;:?!"“”‘’'()\s-]+$/g, "");

  const savedTermsSet = useMemo(() => {
    return new Set(vocab.map((v) => cleanWord(v.heard || v.preferred)));
  }, [vocab]);

  const openNewTermForm = (word: string = "") => {
    const cleaned = cleanWord(word);
    setEditingId(null);
    setFormTerm({
      preferred: cleaned,
      heard: cleaned,
      meaning: "",
      language: state.form.language || "Odia",
      context: "",
      kind: "Cultural Term",
      pronunciation: "",
    });
    setFormOpen(true);
  };

  const openEditTermForm = (entry: VocabularyEntry) => {
    setEditingId(entry.id);
    setFormTerm({
      preferred: entry.preferred,
      heard: entry.heard || entry.preferred,
      meaning: entry.meaning || "",
      language: entry.language || state.form.language || "Odia",
      context: entry.context || "",
      kind: entry.kind || "Cultural Term",
      pronunciation: entry.pronunciation || "",
    });
    setFormOpen(true);
  };

  const handleSaveTerm = (e: FormEvent) => {
    e.preventDefault();
    if (!formTerm.preferred.trim()) return;

    if (editingId) {
      updateVocabEntry(editingId, {
        preferred: formTerm.preferred.trim(),
        heard: formTerm.heard.trim() || formTerm.preferred.trim(),
        meaning: formTerm.meaning.trim(),
        language: formTerm.language,
        context: formTerm.context.trim(),
        kind: formTerm.kind,
        pronunciation: formTerm.pronunciation.trim() || undefined,
      });
    } else {
      addVocabEntry({
        preferred: formTerm.preferred.trim(),
        heard: formTerm.heard.trim() || formTerm.preferred.trim(),
        meaning: formTerm.meaning.trim(),
        language: formTerm.language,
        context: formTerm.context.trim(),
        kind: formTerm.kind,
        pronunciation: formTerm.pronunciation.trim() || undefined,
      });
    }

    setFormOpen(false);
    setEditingId(null);
  };

  const handleProceed = async () => {
    // Persist vocabulary to backend
    if (vocab.length > 0) {
      setIsSavingVocab(true);
      try {
        await saveVocabularyToBackend(
          vocab.map((v) => ({
            preferred: v.preferred,
            heard: v.heard,
            meaning: v.meaning,
            context: v.context,
            language: v.language,
            kind: v.kind,
          }))
        );
      } catch (e) {
        console.warn("Backend vocabulary persistence error (will continue):", e);
      } finally {
        setIsSavingVocab(false);
      }
    }
    goToStep(5);
  };

  return (
    <div className="p-compact-step">
      {/* Editorial Header */}
      <header className="p-compact-header">
        <div className="p-wrap">
          <div className="p-header-flex">
            <div>
              <div className="p-eyebrow">04 / CULTURAL VOCABULARY & GLOSSARY</div>
              <h1 className="p-compact-title" id="page-heading">
                Anchoring our words in memory.
              </h1>
              <p className="p-compact-lede">
                Curate dialect words, culinary terms, and idioms that standard dictionaries overlook. Click any word in your story to add it.
              </p>
            </div>
            <div className="p-header-meta">
              <span className="p-status-pill done">
                {vocab.length} {vocab.length === 1 ? "TERM PRESERVED" : "TERMS PRESERVED"}
              </span>
              <button
                type="button"
                className="p-btn p-btn-brass p-btn-sm"
                onClick={() => openNewTermForm("")}
              >
                + Add New Term
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 2-Column Workspace */}
      <div className="p-wrap p-form-workspace">
        <div className="p-grid-two">
          {/* Column 1: Interactive Story Text with Clickable Words */}
          <div className="p-card-panel">
            <div className="p-panel-header" style={{ marginBottom: 12 }}>
              <span className="p-panel-num">1</span>
              <div>
                <h2 className="p-panel-title">Clickable Story Text</h2>
                <p className="p-panel-sub">Tap any highlighted or unknown word to preserve its cultural definition</p>
              </div>
            </div>

            <div className="p-interactive-story-box" lang="or">
              {workingText ? (
                <p className="p-odia-text p-interactive-tokens" lang="or">
                  {workingText.split(/(\s+)/).map((tok, i) => {
                    if (/^\s+$/.test(tok)) return tok;
                    const clean = cleanWord(tok);
                    const isSaved = clean && savedTermsSet.has(clean);
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`p-word-token ${isSaved ? "is-saved" : ""}`}
                        onClick={() => openNewTermForm(clean)}
                        title={isSaved ? `"${clean}" is preserved in glossary` : `Click to add "${clean}" to glossary`}
                      >
                        {tok}
                      </button>
                    );
                  })}
                </p>
              ) : (
                <p className="p-small" style={{ color: "var(--v-muted)" }}>
                  No story text loaded. Please return to Step 1 or Step 3 to add your story.
                </p>
              )}
            </div>

            <div className="p-token-legend">
              <span className="p-legend-item">
                <span className="p-legend-badge is-saved" /> Preserved in glossary
              </span>
              <span className="p-legend-item">
                <span className="p-legend-badge" /> Click any word to add
              </span>
            </div>
          </div>

          {/* Column 2: Curated Glossary & Add/Edit Form */}
          <div className="p-card-panel">
            <div className="p-panel-header" style={{ marginBottom: 12 }}>
              <span className="p-panel-num">2</span>
              <div style={{ flex: 1, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div>
                  <h2 className="p-panel-title">Cultural Glossary</h2>
                  <p className="p-panel-sub">Defined terms carried forward in this story</p>
                </div>
                {!formOpen && (
                  <button
                    type="button"
                    className="p-btn-text p-btn-sm"
                    onClick={() => openNewTermForm("")}
                  >
                    + Add manual term
                  </button>
                )}
              </div>
            </div>

            {/* Quick Add / Edit Term Form */}
            {formOpen ? (
              <form onSubmit={handleSaveTerm} className="p-vocab-form">
                <div className="p-vocab-form-top">
                  <strong>{editingId ? "Edit Preserved Term" : "Preserve Cultural Term"}</strong>
                  <button
                    type="button"
                    className="p-btn-text p-btn-sm"
                    onClick={() => {
                      setFormOpen(false);
                      setEditingId(null);
                    }}
                  >
                    ✕ Cancel
                  </button>
                </div>

                <div className="p-split-fields">
                  <div className="p-field-compact">
                    <label className="p-lab-compact" htmlFor="vt-pref">
                      Standard / Preferred Script <span className="p-req">*</span>
                    </label>
                    <input
                      id="vt-pref"
                      className="p-input-compact"
                      lang="or"
                      value={formTerm.preferred}
                      onChange={(e) => setFormTerm({ ...formTerm, preferred: e.target.value })}
                      placeholder="e.g., କାନିକା"
                      required
                      autoFocus
                    />
                  </div>

                  <div className="p-field-compact">
                    <label className="p-lab-compact" htmlFor="vt-heard">
                      Heard in Spoken Audio
                    </label>
                    <input
                      id="vt-heard"
                      className="p-input-compact"
                      lang="or"
                      value={formTerm.heard}
                      onChange={(e) => setFormTerm({ ...formTerm, heard: e.target.value })}
                      placeholder="e.g., କାନ୍ନିକା"
                    />
                  </div>
                </div>

                <div className="p-field-compact">
                  <label className="p-lab-compact" htmlFor="vt-meaning">
                    Meaning / Traditional Significance
                  </label>
                  <input
                    id="vt-meaning"
                    className="p-input-compact"
                    value={formTerm.meaning}
                    onChange={(e) => setFormTerm({ ...formTerm, meaning: e.target.value })}
                    placeholder="e.g., Traditional sweet fragrant rice cooked with ghee and cloves"
                  />
                </div>

                <div className="p-split-fields">
                  <div className="p-field-compact">
                    <label className="p-lab-compact" htmlFor="vt-lang">
                      Language / Dialect
                    </label>
                    <select
                      id="vt-lang"
                      className="p-select-compact"
                      value={formTerm.language}
                      onChange={(e) => setFormTerm({ ...formTerm, language: e.target.value })}
                    >
                      {STORY_LANGUAGES.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="p-field-compact">
                    <label className="p-lab-compact" htmlFor="vt-pron">
                      Pronunciation Hint <span className="p-opt">· opt</span>
                    </label>
                    <input
                      id="vt-pron"
                      className="p-input-compact"
                      value={formTerm.pronunciation}
                      onChange={(e) => setFormTerm({ ...formTerm, pronunciation: e.target.value })}
                      placeholder="e.g., kaa-nee-kaa"
                    />
                  </div>
                </div>

                <div className="p-field-compact">
                  <label className="p-lab-compact" htmlFor="vt-context">
                    Cultural Usage / Context
                  </label>
                  <input
                    id="vt-context"
                    className="p-input-compact"
                    value={formTerm.context}
                    onChange={(e) => setFormTerm({ ...formTerm, context: e.target.value })}
                    placeholder="e.g., Prepared as part of Chhappan Bhog in Puri Jagannath temple"
                  />
                </div>

                <div className="p-vocab-form-actions">
                  <button type="submit" className="p-btn p-btn-brass p-btn-sm">
                    {editingId ? "Update Term" : "Save to Glossary"}
                  </button>
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => {
                      setFormOpen(false);
                      setEditingId(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="p-glossary-list-box">
                {vocab.length === 0 ? (
                  <div className="p-glossary-empty">
                    <p>No regional vocabulary items added yet.</p>
                    <p className="p-small" style={{ color: "var(--v-muted)", margin: "6px 0 14px" }}>
                      Preserving unique Odia words, culinary terms, and idioms enriches the cultural archive for future generations.
                    </p>
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => openNewTermForm("")}
                    >
                      + Add your first term
                    </button>
                  </div>
                ) : (
                  <div className="p-glossary-cards">
                    {vocab.map((v) => (
                      <div key={v.id} className="p-glossary-item">
                        <div className="p-glossary-item-top">
                          <strong className="p-odia-text p-glossary-word" lang="or">
                            {v.preferred}
                          </strong>
                          <span className="p-glossary-badge">{v.language || "Odia"}</span>
                        </div>

                        {v.heard && v.heard !== v.preferred && (
                          <div className="p-small" style={{ color: "var(--v-muted)", margin: "2px 0" }}>
                            Heard: <span lang="or">{v.heard}</span>
                          </div>
                        )}

                        {v.meaning && (
                          <p className="p-glossary-meaning">{v.meaning}</p>
                        )}

                        {v.context && (
                          <p className="p-small p-glossary-context">{v.context}</p>
                        )}

                        <div className="p-glossary-item-actions">
                          <button
                            type="button"
                            className="p-btn-text p-btn-sm"
                            onClick={() => openEditTermForm(v)}
                          >
                            Edit
                          </button>
                          {confirmRemoveId === v.id ? (
                            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <button
                                type="button"
                                className="p-btn-text p-btn-sm"
                                style={{ color: "var(--v-alert)" }}
                                onClick={() => {
                                  removeVocabEntry(v.id);
                                  setConfirmRemoveId(null);
                                }}
                              >
                                Confirm delete
                              </button>
                              <button
                                type="button"
                                className="p-btn-text p-btn-sm"
                                onClick={() => setConfirmRemoveId(null)}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="p-btn-text p-btn-sm"
                              style={{ color: "var(--v-muted)" }}
                              onClick={() => setConfirmRemoveId(v.id)}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Persistent Bottom Bar */}
        <div className="p-bottom-bar">
          <div className="p-bar-left">
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              onClick={() => goToStep(3)}
            >
              ← Back to Transcript Review
            </button>
          </div>
          <div className="p-bar-right">
            <button
              type="button"
              className="p-btn p-btn-brass"
              onClick={handleProceed}
              disabled={isSavingVocab}
            >
              {isSavingVocab ? "Saving glossary..." : "Continue to Punctuation Review"} <span className="p-ar">→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
