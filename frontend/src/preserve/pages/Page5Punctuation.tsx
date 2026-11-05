import React, { useState, useRef, useMemo } from "react";
import { usePreserve } from "../context/PreserveContext";
import {
  getPunctuationProfile,
  applyPunctuationMark,
  calculatePunctuationMetrics,
} from "../punctuationProfiles";
import type {
  PunctuationMarkItem,
  PunctuationCategory,
} from "../punctuationProfiles";

export default function Page5Punctuation() {
  const {
    state,
    goToStep,
    setManualPunct,
    selectedLanguage,
  } = usePreserve();

  // Story / transcript language derived dynamically:
  // 1. If ASR transcribed audio: tx.gnani?.requestedLanguage or tx.gnani?.language
  // 2. Story setup form: state.form.language
  // 3. Audio selection setting: selectedLanguage
  const activeLanguage = useMemo(() => {
    if (state.ed.loadedFrom === "gnani" || state.ed.loadedFrom === "vaani") {
      const asrLang = state.tx.gnani?.requestedLanguage || state.tx.gnani?.language;
      if (asrLang) return asrLang;
    }
    return (
      state.form.language ||
      state.tx.gnani?.requestedLanguage ||
      state.tx.gnani?.language ||
      selectedLanguage ||
      "Hindi"
    );
  }, [state.ed.loadedFrom, state.tx.gnani, state.form.language, selectedLanguage]);

  const profile = useMemo(() => getPunctuationProfile(activeLanguage), [activeLanguage]);

  // Initial text: carried forward from manual punctuation, working draft, or step 1 story + transcript
  const baseWorkingText = state.ed.text || state.tx.gnani?.text || state.tx.vaani?.text || state.form.story || "";
  const currentText = state.punct.manual !== null ? state.punct.manual : baseWorkingText;

  const [text, setText] = useState<string>(() => currentText);
  const unpunctuatedDraft = state.punct.unpunctuatedDraft || baseWorkingText;
  const [showRawTranscripts, setShowRawTranscripts] = useState(false);
  const [activeTab, setActiveTab] = useState<"recommended" | "all" | PunctuationCategory>("recommended");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Handle changes and persist to context
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    setManualPunct(val, {
      modelSuggestion: null,
      unpunctuatedDraft,
      isModelPunctuated: false,
    });
  };

  // Insertion of universal or language-specific punctuation mark at cursor position / wrapping selection
  const handleInsertMark = (item: PunctuationMarkItem) => {
    const el = textareaRef.current;
    const start = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;

    const { nextText, nextCursorPos } = applyPunctuationMark(text, item, start, end);
    setText(nextText);
    setManualPunct(nextText, {
      modelSuggestion: null,
      unpunctuatedDraft,
      isModelPunctuated: false,
    });

    if (el) {
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(nextCursorPos, nextCursorPos);
      }, 10);
    }
  };

  // Reset to original unpunctuated working draft
  const handleResetToDraft = () => {
    if (window.confirm("Reset transcript to the unpunctuated draft from Step 3?")) {
      const targetText = unpunctuatedDraft || baseWorkingText;
      setText(targetText);
      setManualPunct(targetText, {
        modelSuggestion: null,
        unpunctuatedDraft: targetText,
        isModelPunctuated: false,
      });
    }
  };

  const handleProceed = () => {
    setManualPunct(text, {
      modelSuggestion: null,
      unpunctuatedDraft,
      isModelPunctuated: false,
    });
    goToStep(6);
  };

  // Live statistics using language-aware metrics calculator
  const metrics = useMemo(() => calculatePunctuationMetrics(text), [text]);

  const rawGnaniText = state.tx.gnani?.text || state.tx.vaani?.text || "";

  return (
    <div className="p-compact-step">
      {/* Editorial Header */}
      <header className="p-compact-header">
        <div className="p-wrap">
          <div className="p-header-flex">
            <div>
              <div className="p-eyebrow">05 / PUNCTUATION REVIEW</div>
              <h1 className="p-compact-title" id="page-heading">
                Restore the breath of the spoken word.
              </h1>
              <p className="p-compact-lede">
                Review pauses, sentence cadence, and phrasing for authentic cultural preservation.
              </p>
            </div>
            <div className="p-header-meta">
              <span className="p-status-pill skip">
                AI PUNCTUATION MODEL COMING SOON
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="p-wrap p-form-workspace">
        {/* Subtle information note on manual punctuation & upcoming AI model */}
        <div
          role="note"
          style={{
            background: "rgba(184, 93, 50, 0.08)",
            border: "1px solid rgba(184, 93, 50, 0.25)",
            borderRadius: "6px",
            padding: "12px 18px",
            marginBottom: "20px",
            fontSize: "13px",
            color: "var(--v-ink, #2B2625)",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            lineHeight: 1.5,
          }}
        >
          <span style={{ fontSize: "16px", lineHeight: 1 }} aria-hidden="true">
            ✦
          </span>
          <div>
            <strong>Manual Punctuation Review:</strong> AI punctuation model coming soon. You have complete editorial control to refine sentence stops (including Purna Virama (Danda) and Double Danda for Indic languages, or periods), dialogue quotes, and pauses using the language-aware punctuation palette or by typing directly in the editor below.
          </div>
        </div>

        <div className="p-grid-review">
          {/* Main Workspace: Editor and Quick Palette */}
          <div className="p-card-panel">
            <div className="p-panel-header">
              <span className="p-panel-num">1</span>
              <div style={{ flex: 1, display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <h2 className="p-panel-title">Punctuation Editor</h2>
                  <p className="p-panel-sub">
                    Insert punctuation marks, dialogue quotes, and pauses, or edit directly in the text editor
                  </p>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "#8C4F00",
                      background: "#F2E8D5",
                      padding: "3px 8px",
                      borderRadius: "4px",
                      border: "1px solid #E2D3B8",
                    }}
                    title={`Active punctuation profile: ${profile.displayName} (${profile.scriptName})`}
                  >
                    Profile: {profile.displayName}
                  </span>
                  <button
                    type="button"
                    className="p-btn-text p-btn-sm"
                    onClick={handleResetToDraft}
                    title="Revert to Step 3 unpunctuated draft"
                  >
                    Reset to unpunctuated draft
                  </button>
                </div>
              </div>
            </div>

            {/* Universal & Language-Aware Palette Container */}
            <div
              className="p-punct-palette"
              style={{
                marginBottom: "14px",
                padding: "10px 14px",
                background: "#FAF6F0",
                borderRadius: "6px",
                border: "1px solid #EADCBA",
              }}
              role="toolbar"
              aria-label="Universal punctuation palette"
            >
              {/* Category Filter Tabs */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "6px",
                  marginBottom: "10px",
                  borderBottom: "1px solid #EFE4CC",
                  paddingBottom: "8px",
                }}
              >
                <span style={{ fontSize: "12px", fontWeight: 700, color: "#8C4F00", marginRight: "4px" }}>
                  Palette:
                </span>
                <button
                  type="button"
                  onClick={() => setActiveTab("recommended")}
                  style={{
                    background: activeTab === "recommended" ? "#8C4F00" : "transparent",
                    color: activeTab === "recommended" ? "#FFFFFF" : "#5A442E",
                    border: "1px solid " + (activeTab === "recommended" ? "#8C4F00" : "#D8C4A9"),
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  ★ {profile.isFallback || profile.languageKey === "Universal" ? "Recommended" : `Recommended for ${profile.languageKey}`}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("all")}
                  style={{
                    background: activeTab === "all" ? "#8C4F00" : "transparent",
                    color: activeTab === "all" ? "#FFFFFF" : "#5A442E",
                    border: "1px solid " + (activeTab === "all" ? "#8C4F00" : "#D8C4A9"),
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  All Symbols
                </button>
                {profile.availableGroups.map((grp) => (
                  <button
                    key={grp.id}
                    type="button"
                    onClick={() => setActiveTab(grp.id)}
                    style={{
                      background: activeTab === grp.id ? "#8C4F00" : "transparent",
                      color: activeTab === grp.id ? "#FFFFFF" : "#5A442E",
                      border: "1px solid " + (activeTab === grp.id ? "#8C4F00" : "#D8C4A9"),
                      borderRadius: "4px",
                      padding: "2px 8px",
                      fontSize: "11px",
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    {grp.name}
                  </button>
                ))}
              </div>

              {/* Marks Button Row */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                {/* 1. Recommended Tab */}
                {activeTab === "recommended" && (
                  <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "6px",
                        paddingBottom: "4px",
                        borderBottom: "1px dashed #EADCBA",
                      }}
                    >
                      <span style={{ fontSize: "12px", fontWeight: 700, color: "#8C4F00" }}>
                        {profile.isFallback || profile.languageKey === "Universal"
                          ? "General Recommended Punctuation"
                          : `Recommended for ${profile.languageKey}`}
                      </span>
                      {profile.recommendationNotes && (
                        <span style={{ fontSize: "11px", color: "var(--v-ink-muted, #6B625E)", fontStyle: "italic" }}>
                          {profile.recommendationNotes}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
                      {profile.primaryMarks.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="p-btn p-btn-ghost p-btn-sm"
                          onClick={() => handleInsertMark(item)}
                          title={item.title}
                          aria-label={item.ariaLabel || item.title}
                          style={{
                            fontFamily: item.fontFamily || profile.fontFamily,
                            fontSize: item.mark.length > 2 ? "13px" : "15px",
                            minWidth: "36px",
                            padding: "4px 8px",
                            background: "#FFFDF9",
                            border: "1px solid #D8C4A9",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                          }}
                        >
                          {item.display}{" "}
                          <span style={{ fontSize: "10px", marginLeft: "2px", opacity: 0.65, fontWeight: 400 }}>
                            {item.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 2. All Symbols Tab */}
                {activeTab === "all" && (
                  profile.availableGroups.map((grp) => (
                    <div
                      key={grp.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        paddingRight: "8px",
                        borderRight: "1px solid #E8DCBE",
                        marginRight: "4px",
                      }}
                    >
                      <span style={{ fontSize: "10px", textTransform: "uppercase", color: "#8C4F00", fontWeight: 700 }}>
                        {grp.name.split(" ")[0]}:
                      </span>
                      {grp.marks.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="p-btn p-btn-ghost p-btn-sm"
                          onClick={() => handleInsertMark(item)}
                          title={item.title}
                          aria-label={item.ariaLabel || item.title}
                          style={{
                            fontFamily: item.fontFamily || profile.fontFamily,
                            fontSize: item.mark.length > 2 ? "13px" : "15px",
                            minWidth: "32px",
                            padding: "4px 6px",
                            background: "#FFFDF9",
                            border: "1px solid #D8C4A9",
                          }}
                        >
                          {item.display}
                        </button>
                      ))}
                    </div>
                  ))
                )}

                {/* 3. Specific Category Tab */}
                {activeTab !== "recommended" && activeTab !== "all" && (
                  profile.availableGroups
                    .find((grp) => grp.id === activeTab)
                    ?.marks.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="p-btn p-btn-ghost p-btn-sm"
                        onClick={() => handleInsertMark(item)}
                        title={item.title}
                        aria-label={item.ariaLabel || item.title}
                        style={{
                          fontFamily: item.fontFamily || profile.fontFamily,
                          fontSize: "15px",
                          minWidth: "36px",
                          padding: "4px 8px",
                          background: "#FFFDF9",
                          border: "1px solid #D8C4A9",
                        }}
                      >
                        {item.display}{" "}
                        <span style={{ fontSize: "10px", marginLeft: "2px", opacity: 0.65, fontWeight: 400 }}>
                          {item.label}
                        </span>
                      </button>
                    ))
                )}
              </div>
            </div>

            {/* Main Textarea */}
            <div style={{ position: "relative" }}>
              <textarea
                ref={textareaRef}
                className="p-textarea-review"
                value={text}
                onChange={handleTextChange}
                placeholder={`Enter or refine your ${profile.displayName} transcript with proper punctuation, sentence stops, and pauses...`}
                rows={10}
                style={{
                  width: "100%",
                  minHeight: "240px",
                  fontSize: "17px",
                  lineHeight: 1.8,
                  padding: "16px",
                  borderRadius: "6px",
                  border: "1px solid #D8C4A9",
                  background: "#FFFDF9",
                  fontFamily: profile.fontFamily,
                  boxSizing: "border-box",
                }}
                aria-label={`Punctuated transcript in ${profile.displayName}`}
              />
            </div>

            {/* Live Metrics Row */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "16px",
                marginTop: "10px",
                fontSize: "12px",
                color: "var(--v-ink-muted, #6B625E)",
              }}
            >
              <span>Words: <strong>{metrics.words}</strong></span>
              <span>Characters: <strong>{metrics.characters}</strong></span>
              {metrics.dandas > 0 && <span>Dandas (।): <strong>{metrics.dandas}</strong></span>}
              {metrics.doubleDandas > 0 && <span>Double Dandas (॥): <strong>{metrics.doubleDandas}</strong></span>}
              {metrics.periods > 0 && <span>Periods (.): <strong>{metrics.periods}</strong></span>}
              <span>Total Sentences: <strong>{metrics.totalSentences}</strong></span>
              {metrics.commas > 0 && <span>Pauses (,): <strong>{metrics.commas}</strong></span>}
              {metrics.questions > 0 && <span>Questions (?): <strong>{metrics.questions}</strong></span>}
              {metrics.exclamations > 0 && <span>Exclamations (!): <strong>{metrics.exclamations}</strong></span>}
              {metrics.quotes > 0 && <span>Quotes: <strong>{metrics.quotes}</strong></span>}
            </div>
          </div>

          {/* Right Column: Story Overview & Cultural Context */}
          <div className="p-card-panel p-side-info">
            <h3 className="p-side-title">Story Overview</h3>
            <div className="p-side-item">
              <span className="p-side-label">Title</span>
              <strong className="p-side-val">{state.form.title || "Untitled story"}</strong>
            </div>
            <div className="p-side-item">
              <span className="p-side-label">Storyteller</span>
              <span className="p-side-val">{state.form.carrier || "Not specified"}</span>
            </div>
            <div className="p-side-item">
              <span className="p-side-label">Language / Dialect</span>
              <span className="p-side-val">{profile.displayName}</span>
            </div>

            {/* Carried Vocabulary Highlights */}
            {state.vocab.length > 0 && (
              <div style={{ marginTop: "16px" }}>
                <span className="p-side-label">Carried Cultural Glossary ({state.vocab.length})</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                  {state.vocab.map((term) => (
                    <span
                      key={term.id}
                      style={{
                        background: "#EBE3D5",
                        color: "#3D342E",
                        padding: "3px 8px",
                        borderRadius: "4px",
                        fontSize: "12px",
                        fontWeight: 600,
                      }}
                      title={term.meaning || term.preferred}
                    >
                      {term.preferred}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Raw Transcripts Accordion */}
            {rawGnaniText && (
              <div style={{ marginTop: "20px" }}>
                <button
                  type="button"
                  className="p-btn-text p-btn-sm"
                  onClick={() => setShowRawTranscripts((prev) => !prev)}
                  style={{ padding: 0, textDecoration: "underline" }}
                >
                  {showRawTranscripts ? "▲ Hide Raw ASR Transcript" : "▼ Cross-reference Raw ASR Transcript"}
                </button>

                {showRawTranscripts && (
                  <div style={{ marginTop: "10px", fontSize: "12px", lineHeight: 1.6, background: "#FAF6F0", padding: "10px", borderRadius: "6px" }}>
                    <div>
                      <strong style={{ color: "var(--v-terracotta, #B85D32)" }}>GNANI AI STT Transcript:</strong>
                      <p style={{ margin: "2px 0 0", color: "#4A403A" }}>{rawGnaniText}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="p-side-note" style={{ marginTop: "20px" }}>
              Punctuation edits here form the authoritative text preserved for future generations and the Explore catalog.
            </div>
          </div>
        </div>

        {/* Persistent Bottom Bar */}
        <div className="p-bottom-bar">
          <div className="p-bar-left">
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              onClick={() => goToStep(4)}
            >
              ← Back to Cultural Vocabulary
            </button>
          </div>
          <div className="p-bar-right">
            <button
              type="button"
              className="p-btn p-btn-brass"
              onClick={handleProceed}
            >
              Continue to Final Review <span className="p-ar">→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
