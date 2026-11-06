import { useState, useEffect, useRef, type FormEvent } from "react";
import { usePreserve } from "../context/PreserveContext";
import { wordCount, combineOptionalAndTranscribedText } from "../utils";
import AudioPlayer from "../components/AudioPlayer";
import { isBackendConfigured } from "../api";

export default function Page6FinalReview() {
  const {
    state,
    goToStep,
    setVisibility,
    setFinalConfirmed,
    setAudioPublicConsent,
    preserveStoryAction,
    resetAll,
  } = usePreserve();

  const { form, audio, ed, vocab, final, punct } = state;

  const [validationError, setValidationError] = useState("");
  const [isPreserving, setIsPreserving] = useState(false);
  const [showAudioPrivacyDialog, setShowAudioPrivacyDialog] = useState(false);
  const [hasConfirmedPrivateAudio, setHasConfirmedPrivateAudio] = useState(false);
  const audioDialogRef = useRef<HTMLDialogElement | null>(null);

  // Fall back unsupported disabled options (community/family) to 'private'
  useEffect(() => {
    if (final.visibility === "community" || final.visibility === "family") {
      setVisibility("private");
    }
  }, [final.visibility, setVisibility]);

  // Reset confirmation if audio, visibility, or consent changes so altered settings re-prompt
  useEffect(() => {
    setHasConfirmedPrivateAudio(false);
  }, [audio, final.visibility, final.audioPublicConsent]);

  // Synchronize HTML <dialog> lifecycle
  useEffect(() => {
    const dialog = audioDialogRef.current;
    if (!dialog) return;
    if (showAudioPrivacyDialog) {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "true");
        }
      }
    } else {
      if (dialog.open) {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute("open");
        }
      }
    }
  }, [showAudioPrivacyDialog]);

  // Carry forward punctuated manual text, or fall back to transcript draft or form story + transcript
  const opt = (form.story || "").trim();
  const txText = (state.tx.gnani?.text || state.tx.vaani?.text || "").trim();
  const speechPart = (punct.manual !== null ? punct.manual : ed.text || txText || "").trim();
  let finalText = "";
  if (opt && speechPart) {
    finalText = speechPart.startsWith(opt) ? speechPart : combineOptionalAndTranscribedText(opt, speechPart);
  } else {
    finalText = opt || speechPart || "";
  }
  const finalWordCount = wordCount(finalText);

  const isPublicAudioPlaybackEnabled = Boolean(
    audio && final.visibility === "public" && final.audioPublicConsent
  );

  const executePreservation = async () => {
    setValidationError("");
    setIsPreserving(true);
    try {
      await preserveStoryAction();
    } catch (err: any) {
      setValidationError(err.message || "Failed to preserve story. Please try again.");
    } finally {
      setIsPreserving(false);
    }
  };

  const handlePreserve = async (e: FormEvent) => {
    e.preventDefault();
    if (!final.confirmed) {
      setValidationError("Please check the confirmation box below to verify your story before preserving.");
      return;
    }

    // Part D: Audio privacy confirmation dialog
    // When audio is attached and public playback is not enabled, prompt for confirmation once
    if (audio && !isPublicAudioPlaybackEnabled && !hasConfirmedPrivateAudio) {
      setShowAudioPrivacyDialog(true);
      return;
    }

    await executePreservation();
  };

  const handleContinueWithPrivateAudio = async () => {
    setHasConfirmedPrivateAudio(true);
    setShowAudioPrivacyDialog(false);
    await executePreservation();
  };

  const handleGoBackFromAudioDialog = () => {
    setShowAudioPrivacyDialog(false);
  };

  const handleDialogBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    const dialog = audioDialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    const isInDialog =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;
    if (!isInDialog) {
      handleGoBackFromAudioDialog();
    }
  };

  // SUCCESS SCREEN
  if (final.isPreserved) {
    return (
      <div className="p-compact-step">
        <header className="p-compact-header p-success-header">
          <div className="p-wrap">
            <div className="p-header-flex">
              <div>
                <div className="p-eyebrow" style={{ color: "rgba(244, 235, 221, 0.9)" }}>
                  {final.isPreviewPreserved ? "06 / DEMO PRESERVATION RECEIPT (PREVIEW ONLY)" : "06 / PRESERVED IN PERPETUITY"}
                </div>
                <h1 className="p-compact-title" id="page-heading" style={{ color: "var(--v-cream)" }}>
                  {final.isPreviewPreserved ? "Preservation Certificate (Preview Mode)" : "This story has a place to live."}
                </h1>
                <p className="p-compact-lede" style={{ color: "var(--v-cream)" }}>
                  {final.isPreviewPreserved
                    ? "Demonstration of the Virasya provenance certificate and sovereign archival format. Permanent database persistence is not connected to this frontend preview."
                    : "Your cultural memory has been saved sovereignly to the Virasya repository with an immutable provenance record."}
                </p>
              </div>
              <div className="p-header-meta">
                <span className="p-status-pill done" style={{ background: "rgba(244,235,221,0.2)", color: "var(--v-cream)", borderColor: "rgba(244,235,221,0.4)" }}>
                  {final.isPreviewPreserved ? "DEMO RECEIPT (NOT PERSISTED)" : "IMMUTABLE RECORD"}
                </span>
              </div>
            </div>
          </div>
        </header>

        <div className="p-wrap p-form-workspace">
          <div className="p-card-panel p-success-card">
            <div className="p-panel-header">
              <span className="p-panel-num">✓</span>
              <div>
                <h2 className="p-panel-title">
                  {final.isPreviewPreserved ? "Demo Preservation Certificate" : "Preservation Certificate & Provenance"}
                </h2>
                <p className="p-panel-sub">
                  {final.isPreviewPreserved ? (
                    <span>Preview demonstration &middot; No remote database connected</span>
                  ) : (
                    <>Saved locally at <strong>data/output/stories/</strong></>
                  )}
                </p>
              </div>
            </div>

            <div className="p-success-meta-grid">
              <div className="p-success-meta-item">
                <span className="p-side-label">Story Title</span>
                <strong>{form.title || "Untitled Story"}</strong>
              </div>
              <div className="p-success-meta-item">
                <span className="p-side-label">Storyteller</span>
                <span>{form.carrier || "Not specified"}</span>
              </div>
              <div className="p-success-meta-item">
                <span className="p-side-label">Place of Origin</span>
                <span>{form.place || "Not specified"}</span>
              </div>
              <div className="p-success-meta-item">
                <span className="p-side-label">Language</span>
                <span>{form.language || "Odia"}</span>
              </div>
              <div className="p-success-meta-item">
                <span className="p-side-label">Recorded Word Count</span>
                <span>{finalWordCount} words</span>
              </div>
              <div className="p-success-meta-item">
                <span className="p-side-label">Archived Glossary Terms</span>
                <span>{vocab.length} terms</span>
              </div>
              <div className="p-success-meta-item">
                <span className="p-side-label">Punctuation Review</span>
                <span>Manual punctuation and transcript review (AI punctuation model coming soon)</span>
              </div>
              <div className="p-success-meta-item">
                <span className="p-side-label">Archive Visibility</span>
                <span>
                  {final.visibility === "private"
                    ? "Private (Only You)"
                    : final.visibility === "public"
                    ? "Public Heritage Archive"
                    : final.visibility}
                </span>
              </div>
            </div>

            {opt && speechPart ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, marginTop: 16 }}>
                <div className="p-success-excerpt" style={{ margin: 0, padding: 16, background: "rgba(48, 34, 29, 0.03)", borderRadius: 6, border: "1px solid var(--v-line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: "rgba(184, 93, 50, 0.12)", color: "var(--v-terracotta)", padding: "2px 6px", borderRadius: 3 }}>
                      Text Output 1
                    </span>
                    <h3 className="p-side-title" style={{ margin: 0 }}>Written Story Context</h3>
                  </div>
                  <p className="p-preserved-text" style={{ margin: 0, fontSize: 15, lineHeight: 1.8 }}>{opt}</p>
                </div>

                <div className="p-success-excerpt" style={{ margin: 0, padding: 16, background: "rgba(48, 34, 29, 0.03)", borderRadius: 6, border: "1px solid var(--v-line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: "rgba(184, 93, 50, 0.12)", color: "var(--v-terracotta)", padding: "2px 6px", borderRadius: 3 }}>
                      Text Output 2
                    </span>
                    <h3 className="p-side-title" style={{ margin: 0 }}>Transcribed Audio Narrative</h3>
                  </div>
                  <p className="p-preserved-text" style={{ margin: 0, fontSize: 15, lineHeight: 1.8 }}>{speechPart}</p>
                </div>
              </div>
            ) : (
              <div className="p-success-excerpt">
                <h3 className="p-side-title" style={{ marginBottom: 8 }}>
                  Preserved {form.language ? `${form.language} ` : ""}Narrative
                </h3>
                <p className="p-preserved-text">{finalText}</p>
              </div>
            )}

            {audio && (
              <div style={{ marginTop: 20 }}>
                <h3 className="p-side-title" style={{ marginBottom: 8 }}>Original Master Audio</h3>
                <AudioPlayer audio={audio} />
              </div>
            )}

            <div className="p-success-actions">
              <a
                href="/my-archive"
                className="p-btn p-btn-brass"
              >
                View in My Archive <span className="p-ar">↗</span>
              </a>

              {final.visibility === "public" && (
                <a
                  href="/explore"
                  className="p-btn p-btn-ghost"
                >
                  View in Explore Archive <span className="p-ar">↗</span>
                </a>
              )}

              <a
                href="/"
                className="p-btn p-btn-ghost"
              >
                Return to Homepage
              </a>

              <button
                type="button"
                className="p-btn-text"
                style={{ marginLeft: "auto" }}
                onClick={() => {
                  if (window.confirm("Start another preservation? This will start a fresh story workflow.")) {
                    resetAll();
                  }
                }}
              >
                + Preserve another story
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-compact-step">
      {/* Editorial Header */}
      <header className="p-compact-header">
        <div className="p-wrap">
          <div className="p-header-flex">
            <div>
              <div className="p-eyebrow">06 / FINAL REVIEW & PRESERVATION</div>
              <h1 className="p-compact-title" id="page-heading">
                A memory, kept in your words.
              </h1>
              <p className="p-compact-lede">
                Review the storyteller details, punctuated narrative, and archive settings before final sovereign preservation.
              </p>
            </div>
            <div className="p-header-meta">
              <span className="p-status-pill done">READY TO PRESERVE</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="p-wrap p-form-workspace">
        <form onSubmit={handlePreserve}>
          <div className="p-grid-review">
            {/* Column 1: The Final Record */}
            <div className="p-card-panel">
              <div className="p-panel-header">
                <span className="p-panel-num">1</span>
                <div>
                  <h2 className="p-panel-title">The Preservation Record</h2>
                  <p className="p-panel-sub">
                    Everything captured across the 5 previous steps
                  </p>
                </div>
              </div>

              {/* Story Narrative Box */}
              {opt && speechPart ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, marginBottom: 20 }}>
                  {/* Text Box 1: Written Story Context */}
                  <div className="p-narrative-review-box" style={{ background: "var(--v-field)", border: "1px solid var(--v-line)", borderRadius: 6, padding: "16px 20px" }}>
                    <div className="p-review-narrative-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--v-line)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ background: "rgba(184, 93, 50, 0.12)", color: "var(--v-terracotta)", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, textTransform: "uppercase" }}>
                          Text Output 1
                        </span>
                        <strong style={{ fontSize: 14, color: "var(--v-ink)" }}>Written Story Context</strong>
                      </div>
                      <span className="p-small" style={{ color: "var(--v-text-sub)" }}>
                        {wordCount(opt)} words · User notes
                      </span>
                    </div>
                    <div className="p-review-text" style={{ fontSize: "15px", lineHeight: "1.8", color: "var(--v-ink)", wordBreak: "break-word", overflowWrap: "anywhere" }}>
                      {opt.split(/\n\s*\n|\n/).filter(p => p.trim()).map((para, i) => (
                        <p key={i} style={{ margin: "0 0 10px 0" }}>{para}</p>
                      ))}
                    </div>
                  </div>

                  {/* Text Box 2: Transcribed Audio Narrative */}
                  <div className="p-narrative-review-box" style={{ background: "var(--v-field)", border: "1px solid var(--v-line)", borderRadius: 6, padding: "16px 20px" }}>
                    <div className="p-review-narrative-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--v-line)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ background: "rgba(184, 93, 50, 0.12)", color: "var(--v-terracotta)", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, textTransform: "uppercase" }}>
                          Text Output 2
                        </span>
                        <strong style={{ fontSize: 14, color: "var(--v-ink)" }}>Transcribed Audio Narrative</strong>
                      </div>
                      <span className="p-small" style={{ color: "var(--v-text-sub)" }}>
                        {wordCount(speechPart)} words · {punct.manual !== null ? "Manually punctuated" : "Oral draft"}
                      </span>
                    </div>
                    <div className="p-review-text" style={{ fontFamily: "'Noto Serif Odia', serif", fontSize: "16px", lineHeight: "1.8", color: "var(--v-ink)", wordBreak: "break-word", overflowWrap: "anywhere" }}>
                      {speechPart.split(/\n\s*\n|\n/).filter(p => p.trim()).map((para, i) => (
                        <p key={i} style={{ margin: "0 0 10px 0" }}>{para}</p>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-narrative-review-box">
                  <div className="p-review-narrative-top">
                    <span className="p-review-narrative-label">
                      {audio ? "Authoritative Odia Narrative" : "Preserved Written Story"}
                    </span>
                    <span className="p-small">
                      {finalWordCount} words · {punct.manual !== null ? "Manually punctuated" : "Oral draft"}
                    </span>
                  </div>
                  <div className="p-review-text" style={{ fontFamily: "'Noto Serif Odia', serif", fontSize: "16px", lineHeight: "1.8", wordBreak: "break-word", overflowWrap: "anywhere" }}>
                    {finalText}
                  </div>
                </div>
              )}

              {/* Master Audio Box */}
              {audio && (
                <div className="p-final-audio-box">
                  <div className="p-review-narrative-top">
                    <span className="p-review-narrative-label">Master Oral Recording</span>
                    <span className="p-small">Local audio repository</span>
                  </div>
                  <AudioPlayer audio={audio} />
                </div>
              )}

              {/* Preserved Vocabulary Pill List */}
              {vocab.length > 0 && (
                <div className="p-final-vocab-box">
                  <div className="p-review-narrative-top">
                    <span className="p-review-narrative-label">Cultural Glossary ({vocab.length} terms)</span>
                    <button
                      type="button"
                      className="p-btn-text p-btn-sm"
                      onClick={() => goToStep(4)}
                    >
                      Edit glossary
                    </button>
                  </div>
                  <div className="p-vocab-summary-list">
                    {vocab.map((v) => (
                      <div key={v.id} className="p-vocab-summary-item">
                        <strong>{v.preferred}</strong>
                        {v.meaning && <span className="p-small"> — {v.meaning}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Column 2: Metadata & Preservation Settings */}
            <div className="p-card-panel">
              <div className="p-panel-header">
                <span className="p-panel-num">2</span>
                <div>
                  <h2 className="p-panel-title">Archive Settings & Attestation</h2>
                  <p className="p-panel-sub">
                    Choose who can read and verify provenance
                  </p>
                </div>
              </div>

              {/* Story Details Card */}
              <div className="p-side-details-box">
                <div className="p-side-item">
                  <span className="p-side-label">Story Title</span>
                  <strong className="p-side-val">{form.title || "Untitled Story"}</strong>
                </div>
                <div className="p-side-item">
                  <span className="p-side-label">Storyteller</span>
                  <span className="p-side-val">{form.carrier || "Not specified"}</span>
                </div>
                <div className="p-side-item">
                  <span className="p-side-label">Place of Origin</span>
                  <span className="p-side-val">{form.place || "Not specified"}</span>
                </div>
                <div className="p-side-item">
                  <span className="p-side-label">Category</span>
                  <span className="p-side-val">{form.category || "General"}</span>
                </div>
                <div className="p-side-item">
                  <span className="p-side-label">Cultural Period</span>
                  <span className="p-side-val">{form.period || "Traditional"}</span>
                </div>
              </div>

              {/* Archive Visibility Selector */}
              <div className="p-field-group" style={{ marginTop: 24 }}>
                <label className="p-field-label" id="visibility-label">
                  Archive Visibility
                </label>
                <div className="p-radio-options" role="radiogroup" aria-labelledby="visibility-label">
                  {/* Option 1: Private (Only You) */}
                  <label className={`p-radio-card ${final.visibility === "private" ? "is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="visibility"
                      value="private"
                      checked={final.visibility === "private"}
                      onChange={() => setVisibility("private")}
                      className="p-radio-input"
                    />
                    <div className="p-radio-body">
                      <div className="p-radio-head">
                        <strong className="p-radio-title">Private (Only You)</strong>
                        <span className="p-radio-badge" style={{ background: "rgba(100, 116, 139, 0.15)", color: "var(--v-ink)" }}>
                          Sovereign Vault
                        </span>
                      </div>
                      <p className="p-radio-desc">
                        Preserved exclusively in your private sovereign archive. Accessible only to your authenticated account; excluded from the public Explore catalog.
                      </p>
                    </div>
                  </label>

                  {/* Option 2: Public Heritage Archive */}
                  <label className={`p-radio-card ${final.visibility === "public" ? "is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="visibility"
                      value="public"
                      checked={final.visibility === "public"}
                      onChange={() => setVisibility("public")}
                      className="p-radio-input"
                    />
                    <div className="p-radio-body">
                      <div className="p-radio-head">
                        <strong className="p-radio-title">Public Heritage Archive</strong>
                        <span className="p-radio-badge">Recommended</span>
                      </div>
                      <p className="p-radio-desc">
                        Published to the Virasya Explore catalog for researchers, community archives, and future generations.
                      </p>
                    </div>
                  </label>

                  {/* Option 3: Community Heritage (Coming Soon) */}
                  <label className="p-radio-card is-disabled" style={{ opacity: 0.6, cursor: "not-allowed" }}>
                    <input
                      type="radio"
                      name="visibility"
                      value="community"
                      disabled
                      aria-disabled="true"
                      className="p-radio-input"
                    />
                    <div className="p-radio-body">
                      <div className="p-radio-head">
                        <strong className="p-radio-title">Community Heritage</strong>
                        <span className="p-radio-badge" style={{ background: "rgba(180, 83, 9, 0.15)", color: "#b45309" }}>
                          Coming Soon
                        </span>
                      </div>
                      <p className="p-radio-desc">
                        Dialect and regional community collective vaults are in active development.
                      </p>
                    </div>
                  </label>

                  {/* Option 4: Family Circle (Coming Soon) */}
                  <label className="p-radio-card is-disabled" style={{ opacity: 0.6, cursor: "not-allowed" }}>
                    <input
                      type="radio"
                      name="visibility"
                      value="family"
                      disabled
                      aria-disabled="true"
                      className="p-radio-input"
                    />
                    <div className="p-radio-body">
                      <div className="p-radio-head">
                        <strong className="p-radio-title">Family Circle</strong>
                        <span className="p-radio-badge" style={{ background: "rgba(180, 83, 9, 0.15)", color: "#b45309" }}>
                          Coming Soon
                        </span>
                      </div>
                      <p className="p-radio-desc">
                        Restricted family sharing circles and lineage archives are in active development.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Confirmation Checkbox */}
              <div className="p-field-group" style={{ marginTop: 20 }}>
                <div className={`p-confirm-box ${final.confirmed ? "is-checked" : ""}`}>
                  <label className="p-confirm-label">
                    <input
                      type="checkbox"
                      checked={final.confirmed}
                      onChange={(e) => setFinalConfirmed(e.target.checked)}
                      className="p-confirm-input"
                    />
                    <span className="p-confirm-text">
                      I confirm this story has been reviewed for authenticity, accuracy of terminology, and respect for the storyteller’s voice.
                    </span>
                  </label>
                </div>

                {/* Explicit audio public playback consent if audio is present and visibility is public */}
                {audio && final.visibility === "public" && (
                  <div
                    className={`p-confirm-box ${final.audioPublicConsent ? "is-checked" : ""}`}
                    style={{ marginTop: 12 }}
                  >
                    <label className="p-confirm-label">
                      <input
                        type="checkbox"
                        checked={Boolean(final.audioPublicConsent)}
                        onChange={(e) => setAudioPublicConsent(e.target.checked)}
                        className="p-confirm-input"
                      />
                      <span className="p-confirm-text">
                        Allow voice recording to be streamed publicly in Explore archive. If unchecked, your written text and provenance remain public while the audio stays strictly private in your vault.
                      </span>
                    </label>
                  </div>
                )}

                {validationError && (
                  <p className="p-field-error" role="alert" style={{ marginTop: 10 }}>
                    {validationError}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Persistent Action Bar */}
          <div className="p-bottom-bar">
            <div className="p-bar-left">
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => goToStep(5)}
              >
                ← Back to Punctuation Review
              </button>
            </div>
            <div className="p-bar-right">
              <button
                type="submit"
                className="p-btn p-btn-brass"
                disabled={isPreserving}
              >
                {isPreserving
                  ? isBackendConfigured()
                    ? "Securing Sovereign Record…"
                    : "Generating Demo Receipt…"
                  : isBackendConfigured()
                  ? "Confirm & Preserve Story Permanently"
                  : "Preview Preservation Certificate (Demo Mode)"}{" "}
                <span className="p-ar">→</span>
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Part D: Audio Privacy Confirmation Dialog */}
      <dialog
        ref={audioDialogRef}
        className="dialog p-audio-privacy-dialog"
        aria-labelledby="audio-privacy-title"
        aria-describedby="audio-privacy-desc"
        onClick={handleDialogBackdropClick}
        onCancel={(e) => {
          e.preventDefault();
          handleGoBackFromAudioDialog();
        }}
      >
        <button
          type="button"
          className="dialog-close"
          onClick={handleGoBackFromAudioDialog}
          aria-label="Close dialog"
        >
          ×
        </button>

        <div className="eyebrow" style={{ color: "var(--v-terracotta)", marginBottom: 8, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>
          06 / SOVEREIGN AUDIO PRIVACY
        </div>

        <h2 id="audio-privacy-title" style={{ fontSize: 26, margin: "0 0 16px", color: "var(--v-ink)", fontFamily: "var(--v-font-head)" }}>
          Keep Audio Recording Private?
        </h2>

        <div id="audio-privacy-desc" style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24, fontSize: 13, lineHeight: 1.6, color: "var(--v-ink)" }}>
          <p style={{ margin: 0 }}>
            Your story visibility is set to <strong>{final.visibility === "public" ? "Public Heritage Archive" : "Private (Only You)"}</strong>. The story will be preserved according to this setting.
          </p>
          <p style={{ margin: 0, padding: "10px 14px", background: "rgba(184, 93, 50, 0.08)", border: "1px solid rgba(184, 93, 50, 0.25)", borderRadius: 6 }}>
            <strong>Audio Playback:</strong> Because public audio playback is not enabled, your original voice recording will remain strictly private in your sovereign vault and will <strong>not</strong> be available for public playback in Explore.
          </p>
          <p style={{ margin: 0, color: "var(--v-muted)" }}>
            {final.visibility === "public"
              ? "Your written narrative, cultural vocabulary, and provenance certificate will still be publicly readable in Explore."
              : "All text, metadata, and audio will remain completely confidential to your account."}
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            className="p-btn p-btn-brass"
            onClick={handleContinueWithPrivateAudio}
            style={{ width: "100%", justifyContent: "center" }}
            autoFocus
          >
            Continue with private audio
          </button>
          <button
            type="button"
            className="p-btn p-btn-ghost"
            onClick={handleGoBackFromAudioDialog}
            style={{ width: "100%", justifyContent: "center" }}
          >
            Go back
          </button>
        </div>
      </dialog>
    </div>
  );
}
