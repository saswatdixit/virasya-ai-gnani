import { useState, useEffect, useRef } from "react";
import "./myArchive.css";
import Header from "../components/layout/Header";
import { useAuth } from "../auth";
import { listStoriesFromBackend, type StoryPayload } from "../preserve/api";
import { getStoryAudioPlaybackUrl, isSupabaseConfigured, processPendingAudioCleanups } from "../supabase";
import { extractStoryTextOutputs } from "../preserve/utils";

type ArchiveTab = "all" | "private" | "public";

export default function MyArchivePage() {
  const { user, openAuthModal } = useAuth();
  const [stories, setStories] = useState<StoryPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ArchiveTab>("all");
  const [selectedStory, setSelectedStory] = useState<StoryPayload | null>(null);

  // Archival protection notice state & modal ref
  const [storyToDelete, setStoryToDelete] = useState<StoryPayload | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  // Playback state for Reader Modal
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [resolvingAudio, setResolvingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const readerDialogRef = useRef<HTMLDialogElement>(null);
  const audioRequestIdRef = useRef<number>(0);

  // Fetch stories on mount or user identity change
  useEffect(() => {
    let active = true;
    const currentUserId = user?.id;

    // Fix 3: Invalidate pending audio requests and close/clear reader state on logout or account switch
    audioRequestIdRef.current++;
    if (readerDialogRef.current && readerDialogRef.current.open) {
      readerDialogRef.current.close();
    }
    if (deleteDialogRef.current && deleteDialogRef.current.open) {
      deleteDialogRef.current.close();
    }
    setSelectedStory(null);
    setStoryToDelete(null);
    setPlaybackUrl(null);
    setAudioError(null);
    setResolvingAudio(false);

    if (!user) {
      setLoading(false);
      setStories([]);
      setError(null);
      return () => {
        active = false;
      };
    }

    // Fix 2: Immediately clear stale stories when a new user load begins
    setLoading(true);
    setError(null);
    setStories([]);

    async function loadUserArchive() {
      try {
        if (currentUserId) {
          processPendingAudioCleanups(currentUserId).catch(() => {});
        }
        const data = await listStoriesFromBackend();
        // Prevent race condition: ensure response belongs to current active user
        if (active && user?.id === currentUserId) {
          setStories(data);
        }
      } catch (err: any) {
        if (active && user?.id === currentUserId) {
          console.error("[MyArchive] Failed to load stories:", err);
          setError(err.message || "Failed to load sovereign archive stories.");
          // Fix 2: Ensure failed request cannot leave previous user's stories visible
          setStories([]);
        }
      } finally {
        if (active && user?.id === currentUserId) {
          setLoading(false);
        }
      }
    }

    loadUserArchive();

    return () => {
      active = false;
    };
  }, [user]);

  // Handle open reader dialog
  const handleOpenReader = (story: StoryPayload) => {
    setSelectedStory(story);
    setAudioError(null);
    setPlaybackUrl(null);

    if (story.audio) {
      setResolvingAudio(true);
      const reqId = ++audioRequestIdRef.current;
      const requestingUserId = user?.id;

      getStoryAudioPlaybackUrl(story.id || "", {
        storagePath: story.audio.storage_path,
        fallbackUrl: story.audio.url,
      })
        .then((url) => {
          if (audioRequestIdRef.current !== reqId || user?.id !== requestingUserId) return;
          if (url) {
            setPlaybackUrl(url);
          } else if (story.audio?.url) {
            setPlaybackUrl(story.audio.url);
          } else {
            setAudioError("Audio playback stream unavailable.");
          }
        })
        .catch((err) => {
          if (audioRequestIdRef.current !== reqId || user?.id !== requestingUserId) return;
          console.warn("[MyArchive] Audio resolution warning:", err);
          if (story.audio?.url) {
            setPlaybackUrl(story.audio.url);
          } else {
            setAudioError("Unable to authorize audio playback.");
          }
        })
        .finally(() => {
          if (audioRequestIdRef.current === reqId && user?.id === requestingUserId) {
            setResolvingAudio(false);
          }
        });
    }

    if (readerDialogRef.current && !readerDialogRef.current.open) {
      readerDialogRef.current.showModal();
    }
  };

  const handleCloseReader = () => {
    audioRequestIdRef.current++; // Invalidate pending audio request
    if (readerDialogRef.current && readerDialogRef.current.open) {
      readerDialogRef.current.close();
    }
    setSelectedStory(null);
    setPlaybackUrl(null);
    setAudioError(null);
    setResolvingAudio(false);
  };

  // Handle open archival protection notice dialog
  const handleRequestDelete = (e: React.MouseEvent, story: StoryPayload) => {
    e.stopPropagation();
    e.preventDefault();
    setStoryToDelete(story);
    if (deleteDialogRef.current && !deleteDialogRef.current.open) {
      deleteDialogRef.current.showModal();
    }
  };

  // Handle close archival protection notice dialog
  const handleCloseDeleteDialog = () => {
    if (deleteDialogRef.current && deleteDialogRef.current.open) {
      deleteDialogRef.current.close();
    }
    setStoryToDelete(null);
  };

  // Filter stories: My Archive exclusively displays preserved cultural records
  const preservedStories = stories.filter((s) => s.status === "preserved");

  const privatePreserved = preservedStories.filter(
    (s) => s.visibility === "private" || s.finalSettings?.visibility === "private"
  );
  const publicPreserved = preservedStories.filter(
    (s) => s.visibility === "public" || s.finalSettings?.visibility === "public"
  );

  let displayedStories: StoryPayload[] = [];
  if (activeTab === "all") {
    displayedStories = preservedStories;
  } else if (activeTab === "private") {
    displayedStories = privatePreserved;
  } else if (activeTab === "public") {
    displayedStories = publicPreserved;
  }

  // Calculate total words preserved
  const totalWords = preservedStories.reduce((acc, story) => {
    const text = story.final_text || story.writtenText || story.story || "";
    return acc + text.split(/\s+/).filter(Boolean).length;
  }, 0);

  return (
    <div className="archive-page">
      <a className="skip" href="#archive-main">
        Skip to content
      </a>
      <Header placeholder />

      <main id="archive-main" className="archive-main-wrap">
        <div className="archive-container">
          {/* Header */}
          <header className="archive-header">
            <div className="archive-eyebrow">
              <span className="archive-eyebrow-dot" aria-hidden="true" />
              <span>SOVEREIGN HERITAGE VAULT</span>
            </div>
            <h1 className="archive-title">My Archive & Sovereign Vault</h1>
            <p className="archive-lede">
              Your personal repository of preserved oral histories, folklore recordings, and dialect lexicons.
              Private recordings remain exclusively yours; public stories contribute to the living collective archive.
            </p>
            {!isSupabaseConfigured() && (
              <div
                style={{
                  marginTop: 16,
                  padding: "10px 16px",
                  background: "rgba(184, 93, 50, 0.1)",
                  border: "1px solid rgba(184, 93, 50, 0.25)",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "var(--walnut)",
                  display: "inline-block",
                }}
              >
                <strong>Offline Preview Mode:</strong> Connect Supabase credentials in .env to sync sovereign cloud stories across devices.
              </div>
            )}
          </header>

          {/* 1. Unauthenticated View */}
          {!user ? (
            <div className="archive-notice-card" role="region" aria-label="Sign in required">
              <div className="archive-notice-icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h2 className="archive-notice-title">Connect to Your Sovereign Archive</h2>
              <p className="archive-notice-desc">
                Sign in with your email magic link to access your preserved oral histories, heritage vault recordings,
                and multi-device preservation drafts.
              </p>
              <div className="archive-notice-actions">
                <button type="button" className="archive-cta-btn" onClick={openAuthModal}>
                  Sign in to Virasya ↗
                </button>
                <a href="/preserve-your-story" className="archive-tab-btn">
                  Preserve a Story as Guest →
                </a>
              </div>
            </div>
          ) : (
            <>
              {/* 2. Authenticated Statistics Bar */}
              <div className="archive-stats-row">
                <div className="archive-stat-card">
                  <span className="archive-stat-num">{preservedStories.length}</span>
                  <span className="archive-stat-label">Preserved Stories</span>
                </div>
                <div className="archive-stat-card">
                  <span className="archive-stat-num">{privatePreserved.length}</span>
                  <span className="archive-stat-label">Heritage Vault</span>
                </div>
                <div className="archive-stat-card">
                  <span className="archive-stat-num">{publicPreserved.length}</span>
                  <span className="archive-stat-label">Public Heritage Catalog</span>
                </div>
                <div className="archive-stat-card">
                  <span className="archive-stat-num">{totalWords.toLocaleString()}</span>
                  <span className="archive-stat-label">Words Preserved</span>
                </div>
              </div>

              {/* 3. Toolbar & Filter Tabs */}
              <div className="archive-toolbar">
                <div className="archive-tabs" role="tablist" aria-label="Filter archive stories">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "all"}
                    className={`archive-tab-btn ${activeTab === "all" ? "is-active" : ""}`}
                    onClick={() => setActiveTab("all")}
                  >
                    All Preserved ({preservedStories.length})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "private"}
                    className={`archive-tab-btn ${activeTab === "private" ? "is-active" : ""}`}
                    onClick={() => setActiveTab("private")}
                  >
                    Heritage Vault ({privatePreserved.length})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "public"}
                    className={`archive-tab-btn ${activeTab === "public" ? "is-active" : ""}`}
                    onClick={() => setActiveTab("public")}
                  >
                    Public Heritage ({publicPreserved.length})
                  </button>
                </div>

                <a href="/preserve-your-story" className="archive-cta-btn">
                  + Preserve New Story
                </a>
              </div>

              {/* 4. Loading State */}
              {loading && (
                <div className="archive-loading-state" role="status">
                  <p>Loading your sovereign archive records…</p>
                </div>
              )}

              {/* 5. Error State */}
              {error && (
                <div className="archive-error-banner" role="alert">
                  <span>{error}</span>
                  <button
                    type="button"
                    className="archive-tab-btn"
                    onClick={() => window.location.reload()}
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* 6. Empty State */}
              {!loading && !error && displayedStories.length === 0 && (
                <div className="archive-notice-card">
                  <div className="archive-notice-icon" aria-hidden="true">
                    📖
                  </div>
                  <h2 className="archive-notice-title">
                    {activeTab === "private"
                      ? "No Stories in Heritage Vault"
                      : activeTab === "public"
                      ? "No Public Stories Preserved"
                      : "No Preserved Stories Yet"}
                  </h2>
                  <p className="archive-notice-desc">
                    {activeTab === "private"
                      ? "Stories you preserve with 'Private (Only You)' visibility will be safely archived here in your Heritage Vault."
                      : activeTab === "public"
                      ? "Stories preserved with 'Public Heritage Archive' visibility will appear here and in the Explore catalog."
                      : "Capture and preserve cultural memories, folklore tales, and dialect narratives into your sovereign archive."}
                  </p>
                  <a href="/preserve-your-story" className="archive-cta-btn">
                    Preserve Your Story →
                  </a>
                </div>
              )}

              {/* 7. Stories Grid */}
              {!loading && displayedStories.length > 0 && (
                <div className="archive-grid">
                  {displayedStories.map((story) => {
                    const isPrivate =
                      story.visibility === "private" ||
                      story.finalSettings?.visibility === "private";
                    const isDraft = story.status === "draft";
                    const excerpt =
                      story.final_text ||
                      story.writtenText ||
                      story.story ||
                      "Oral heritage record preserved in Virasya.";
                    const provId =
                      story.provenance_id ||
                      story.finalSettings?.provenance_id ||
                      (story.id ? `VIR-${story.id.slice(-6).toUpperCase()}` : "VIR-DRAFT");
                    const dateStr = story.preserved_at || story.updated_at || story.created_at;

                    return (
                      <article key={story.id} className="archive-story-card">
                        <div className="archive-card-top">
                          <div className="archive-badge-group">
                            {isPrivate ? (
                              <span className="archive-pill private">Private (Only You)</span>
                            ) : (
                              <span className="archive-pill public">Public Heritage</span>
                            )}
                            <span className="archive-pill prov">{provId}</span>
                            {story.audio && <span className="archive-pill audio">Master Audio</span>}
                          </div>
                          <button
                            type="button"
                            className="archive-story-delete-btn"
                            onClick={(e) => handleRequestDelete(e, story)}
                            aria-label={`Archived story: ${story.title || "Untitled Story"} (preserved cultural asset)`}
                            title={`Archived story: ${story.title || "Untitled Story"} (preserved cultural assets cannot be deleted by standard clients)`}
                          >
                            ×
                          </button>
                        </div>

                        <h3 className="archive-story-title">{story.title || "Untitled Story"}</h3>

                        <div className="archive-story-meta">
                          <span>{story.carrier || "Storyteller"}</span> &middot;{" "}
                          <span>{story.language || "Hindi"}</span>
                          {story.place && <span> &middot; {story.place}</span>}
                        </div>

                        <p className="archive-story-excerpt">
                          {excerpt.length > 150 ? `${excerpt.slice(0, 150)}…` : excerpt}
                        </p>

                        <div className="archive-card-footer">
                          <span className="archive-date-text">
                            {dateStr ? new Date(dateStr).toLocaleDateString() : "Archived"}
                          </span>

                          <div className="archive-card-actions">
                            {isDraft ? (
                              <a href="/preserve-your-story" className="archive-read-btn">
                                Continue Editing →
                              </a>
                            ) : (
                              <button
                                type="button"
                                className="archive-read-btn"
                                onClick={() => handleOpenReader(story)}
                              >
                                Read & Listen →
                              </button>
                            )}

                            {!isPrivate && !isDraft && (
                              <a
                                href={`/explore?story=${story.id}`}
                                className="archive-tab-btn"
                                style={{ padding: "6px 12px", fontSize: 12 }}
                                title="View in Public Explore Catalog"
                              >
                                Explore ↗
                              </a>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* Narrative & Audio Reader Dialog Modal */}
      <dialog
        ref={readerDialogRef}
        className="archive-reader-dialog"
        aria-labelledby="reader-title"
        onCancel={handleCloseReader}
      >
        {selectedStory && (
          <div className="archive-reader-in">
            <header className="archive-reader-header">
              <button
                type="button"
                className="archive-reader-close"
                onClick={handleCloseReader}
                aria-label="Close narrative reader"
              >
                ×
              </button>
              <div className="archive-badge-group" style={{ marginBottom: 8 }}>
                {selectedStory.visibility === "private" ||
                selectedStory.finalSettings?.visibility === "private" ? (
                  <span className="archive-pill private">Heritage Vault (Private)</span>
                ) : (
                  <span className="archive-pill public">Public Heritage Archive</span>
                )}
                <span className="archive-pill prov">
                  {selectedStory.provenance_id ||
                    selectedStory.finalSettings?.provenance_id ||
                    `VIR-${selectedStory.id?.slice(-6).toUpperCase()}`}
                </span>
              </div>
              <h2 id="reader-title" className="archive-title" style={{ fontSize: 26, margin: 0 }}>
                {selectedStory.title || "Untitled Story"}
              </h2>
              <div className="archive-story-meta" style={{ margin: "6px 0 0" }}>
                <span>Storyteller: {selectedStory.carrier || "Community contributor"}</span> &middot;{" "}
                <span>Language: {selectedStory.language || "Hindi"}</span>
                {selectedStory.place && <span> &middot; Region: {selectedStory.place}</span>}
              </div>
            </header>

            <div className="archive-reader-body">
              {/* Authorized Audio Player */}
              {selectedStory.audio && (
                <div className="archive-player-box">
                  <div className="archive-player-title">Master Audio Playback</div>
                  {resolvingAudio ? (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--v-muted)" }}>
                      Authorizing sovereign audio stream…
                    </p>
                  ) : audioError ? (
                    <div style={{ fontSize: 13, color: "#dc2626" }}>
                      {audioError} (Private storage token check failed)
                    </div>
                  ) : playbackUrl ? (
                    <audio
                      controls
                      src={playbackUrl}
                      className="archive-player-native"
                      preload="metadata"
                    >
                      Your browser does not support audio playback.
                    </audio>
                  ) : (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--v-muted)" }}>
                      Audio recording not available.
                    </p>
                  )}
                </div>
              )}

              {/* Narrative Text */}
              {(() => {
                const { output1, output2, hasTwoOutputs } = extractStoryTextOutputs({
                  final_text: selectedStory.final_text || selectedStory.story,
                  written_text: selectedStory.writtenText || (selectedStory as any).written_text,
                });

                if (hasTwoOutputs) {
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, marginBottom: 28 }}>
                      <div className="archive-narrative-box" style={{ margin: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: "rgba(184, 93, 50, 0.12)", color: "var(--v-terracotta)", padding: "2px 6px", borderRadius: 3 }}>
                            Text Output 1
                          </span>
                          <h3 className="archive-player-title" style={{ margin: 0 }}>Written Story Context</h3>
                        </div>
                        <div className="archive-narrative-text">
                          {output1}
                        </div>
                      </div>

                      <div className="archive-narrative-box" style={{ margin: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: "rgba(184, 93, 50, 0.12)", color: "var(--v-terracotta)", padding: "2px 6px", borderRadius: 3 }}>
                            Text Output 2
                          </span>
                          <h3 className="archive-player-title" style={{ margin: 0 }}>Transcribed Audio Narrative</h3>
                        </div>
                        <div className="archive-narrative-text">
                          {output2}
                        </div>
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="archive-narrative-box">
                    <h3 className="archive-player-title">Preserved Narrative</h3>
                    <div className="archive-narrative-text">
                      {selectedStory.final_text || selectedStory.writtenText || selectedStory.story || ""}
                    </div>
                  </div>
                );
              })()}

              {/* Cultural Vocabulary Glossary */}
              {Array.isArray(selectedStory.vocabulary) && selectedStory.vocabulary.length > 0 && (
                <div style={{ marginBottom: 28 }}>
                  <h3 className="archive-player-title">Archived Cultural Glossary</h3>
                  <table className="archive-glossary-table">
                    <thead>
                      <tr>
                        <th>Preferred Term</th>
                        <th>Spoken / Heard</th>
                        <th>Meaning</th>
                        <th>Cultural Context</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedStory.vocabulary.map((vocabItem, idx) => (
                        <tr key={vocabItem.id || idx}>
                          <td>
                            <strong>{vocabItem.preferred}</strong>
                          </td>
                          <td>{vocabItem.heard || "—"}</td>
                          <td>{vocabItem.meaning || "—"}</td>
                          <td>{vocabItem.context || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Provenance Record */}
              <div className="archive-provenance-box">
                <strong>Cryptographic Provenance Certificate</strong>
                <div>
                  Provenance ID:{" "}
                  <code>
                    {selectedStory.provenance_id ||
                      selectedStory.finalSettings?.provenance_id ||
                      "VIR-RECORD"}
                  </code>
                </div>
                {selectedStory.provenance_hash && (
                  <div style={{ wordBreak: "break-all" }}>
                    Hash: <code>{selectedStory.provenance_hash}</code>
                  </div>
                )}
                <div>
                  Preserved Timestamp:{" "}
                  {selectedStory.preserved_at || selectedStory.created_at || "Immutable Record"}
                </div>
              </div>
            </div>
          </div>
        )}
      </dialog>

      {/* Archival Protection Modal */}
      <dialog
        ref={deleteDialogRef}
        className="archive-delete-dialog"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-desc"
        onCancel={handleCloseDeleteDialog}
      >
        {storyToDelete && (
          <div className="archive-delete-dialog-in">
            <h2 id="delete-dialog-title" className="archive-delete-dialog-title">
              Archived Cultural Asset
            </h2>
            <p id="delete-dialog-desc" className="archive-delete-dialog-desc">
              “{storyToDelete.title || "Untitled Story"}” is sealed and permanently preserved in the Sovereign Heritage Vault.
            </p>

            <div className="archive-preserved-notice">
              <strong>Archival Protection:</strong> Preserved stories are archived cultural assets and cannot be deleted by standard clients. Once sealed with cryptographic provenance, oral histories cannot be permanently deleted by standard users to ensure the communal and historical record remains untampered. If you require archival review or retraction, please contact preservation administrators.
            </div>

            <div className="archive-delete-dialog-actions" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="archive-tab-btn"
                onClick={handleCloseDeleteDialog}
                autoFocus
              >
                Understood
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
