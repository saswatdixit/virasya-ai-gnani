import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "../preserve/preserve.css";
import "./explore.css";
import Header from "../components/layout/Header";
import {
  fetchExploreFeed,
  fetchExploreStoryDetail,
  type ExploreStoryCard,
  type ExploreDetailStory,
} from "../preserve/api";
import { SAMPLE_EXPLORE_STORIES } from "./sampleStories";
import { PreserveStoryIcon } from "../components/shared/Icons";
import { getStoryAudioPlaybackUrl } from "../supabase";
import { extractStoryTextOutputs } from "../preserve/utils";

const CATEGORIES = [
  "All",
  "Food and recipes",
  "Oral history",
  "Family memory",
  "Language and sayings",
  "Traditional knowledge",
  "Songs and folklore",
  "Customs and rituals",
];

const LANGUAGES = [
  "All",
  "Hindi",
  "Bengali",
  "Gujarati",
  "Kannada",
  "Malayalam",
  "Marathi",
  "Punjabi",
  "Tamil",
  "English (India)",
  "Telugu",
  "Other",
];

function ExploreAudioPlayer({
  storyId,
  audio,
}: {
  storyId: string;
  audio: NonNullable<ExploreDetailStory["audio"]>;
}) {
  const [playbackSrc, setPlaybackSrc] = useState<string | null>(audio.url || null);
  const [isResolving, setIsResolving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const refreshedOnceRef = useRef<boolean>(false);

  useEffect(() => {
    let active = true;
    refreshedOnceRef.current = false;

    // Direct playback for local, blob, or workbench audio
    if (
      audio.url &&
      (audio.url.startsWith("blob:") ||
        audio.url.startsWith("data:") ||
        audio.url.startsWith("/api/audio/"))
    ) {
      setPlaybackSrc(audio.url);
      setErrorMsg(null);
      return;
    }

    // Resolve fresh authorized signed URL from Supabase
    setIsResolving(true);
    setErrorMsg(null);

    getStoryAudioPlaybackUrl(storyId, { fallbackUrl: audio.url, storagePath: audio.storage_path })
      .then((freshUrl) => {
        if (!active) return;
        if (freshUrl) {
          setPlaybackSrc(freshUrl);
        } else if (audio.url) {
          setPlaybackSrc(audio.url);
        } else {
          setErrorMsg("Audio playback ticket unavailable.");
        }
      })
      .catch((err) => {
        if (!active) return;
        console.warn("[ExploreAudio] Playback resolution error:", err);
        if (audio.url) {
          setPlaybackSrc(audio.url);
        } else {
          const msg =
            err?.message?.includes("function was not found") || err?.message?.includes("NOT_FOUND")
              ? "Audio playback service is initializing. Please try again in a few moments."
              : err?.message || "Audio recording is currently unavailable.";
          setErrorMsg(msg);
        }
      })
      .finally(() => {
        if (active) setIsResolving(false);
      });

    return () => {
      active = false;
    };
  }, [storyId, audio.url, audio.storage_path]);

  const handleAudioError = async () => {
    // If the browser audio element failed to load (e.g. token expired), attempt a fresh refresh
    if (!refreshedOnceRef.current) {
      refreshedOnceRef.current = true;
      setIsResolving(true);
      try {
        const fresh = await getStoryAudioPlaybackUrl(storyId, { storagePath: audio.storage_path });
        if (fresh) {
          setPlaybackSrc(fresh);
          setErrorMsg(null);
          setIsResolving(false);
          return;
        }
      } catch (e) {
        console.warn("[ExploreAudio] Token refresh failed:", e);
      }
      setIsResolving(false);
    }
    setErrorMsg("Audio playback expired. Click below to refresh authorization.");
  };

  const handleManualRefresh = async () => {
    setIsResolving(true);
    setErrorMsg(null);
    try {
      const fresh = await getStoryAudioPlaybackUrl(storyId, { storagePath: audio.storage_path });
      if (fresh) {
        setPlaybackSrc(fresh);
      } else {
        setErrorMsg("Unable to refresh playback authorization.");
      }
    } catch (e: any) {
      const msg =
        e?.message?.includes("function was not found") || e?.message?.includes("NOT_FOUND")
          ? "Audio playback service is initializing. Please try again in a few moments."
          : e?.message || "Failed to refresh playback ticket.";
      setErrorMsg(msg);
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div className="exp-audio-box">
      <div className="exp-audio-top">
        <div className="exp-audio-label">Preserved Audio Recording</div>
        <span className="exp-audio-pill">Native Master Audio</span>
      </div>

      <div className="exp-audio-player-wrap">
        {isResolving && !playbackSrc ? (
          <div style={{ padding: "12px", fontSize: "13px", color: "var(--v-text-sub)" }}>
            Obtaining authorized archival playback ticket…
          </div>
        ) : errorMsg ? (
          <div style={{ padding: "10px 0" }}>
            <p style={{ color: "var(--v-terracotta, #B85D32)", fontSize: "13px", margin: "0 0 8px" }}>
              {errorMsg}
            </p>
            <button
              type="button"
              className="p-btn-text p-btn-sm"
              onClick={handleManualRefresh}
              disabled={isResolving}
              style={{ textDecoration: "underline", cursor: "pointer" }}
            >
              {isResolving ? "Refreshing ticket…" : "↻ Refresh Playback Ticket"}
            </button>
          </div>
        ) : playbackSrc ? (
          <audio
            controls
            preload="metadata"
            src={playbackSrc}
            className="exp-native-audio"
            onError={handleAudioError}
          >
            Your browser does not support the audio element.
          </audio>
        ) : null}
      </div>

      <div className="exp-audio-meta">
        <span className="exp-audio-badge">
          {audio.storage_path ? "Stored sovereignly in repository" : "Archival audio record"}
        </span>
      </div>
    </div>
  );
}

export default function ExplorePage() {
  const [stories, setStories] = useState<ExploreStoryCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedLanguage, setSelectedLanguage] = useState("All");

  const [showPreviewStories, setShowPreviewStories] = useState(false);

  const [activeStoryId, setActiveStoryId] = useState<string | null>(null);
  const [detailStory, setDetailStory] = useState<ExploreDetailStory | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const triggerButtonRef = useRef<HTMLElement | null>(null);

  const handleCloseDetail = useCallback(() => {
    setActiveStoryId(null);
    setDetailStory(null);
    if (triggerButtonRef.current) {
      setTimeout(() => {
        triggerButtonRef.current?.focus();
        triggerButtonRef.current = null;
      }, 50);
    }
  }, []);

  // Keyboard navigation & body scroll lock for story reader modal
  useEffect(() => {
    if (!activeStoryId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCloseDetail();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, [activeStoryId, handleCloseDetail]);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchExploreFeed({
        search: searchQuery.trim() || undefined,
        category: selectedCategory !== "All" ? selectedCategory : undefined,
        language: selectedLanguage !== "All" ? selectedLanguage : undefined,
      });
      setStories(data.stories || []);
    } catch (err: any) {
      console.warn("Could not retrieve stories from archive:", err);
      setError(err?.message || "Failed to load stories from the living archive.");
      setStories([]);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, selectedCategory, selectedLanguage]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadFeed();
    }, 250);
    return () => clearTimeout(timer);
  }, [loadFeed]);

  // Reactive filtering across authorized sample stories when preview mode is toggled on
  const filteredSampleStories = useMemo(() => {
    if (!showPreviewStories) return [];
    return SAMPLE_EXPLORE_STORIES.filter((s) => {
      if (selectedCategory !== "All" && s.category !== selectedCategory) return false;
      if (selectedLanguage !== "All" && s.language !== selectedLanguage) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = s.title.toLowerCase().includes(q);
        const matchCarrier = s.carrier.toLowerCase().includes(q);
        const matchPlace = s.place.toLowerCase().includes(q);
        const matchExcerpt = s.excerpt.toLowerCase().includes(q);
        if (!matchTitle && !matchCarrier && !matchPlace && !matchExcerpt) return false;
      }
      return true;
    });
  }, [showPreviewStories, selectedCategory, selectedLanguage, searchQuery]);

  const handleOpenDetail = async (storyId: string, event?: React.MouseEvent) => {
    if (event?.currentTarget instanceof HTMLElement) {
      triggerButtonRef.current = event.currentTarget;
    } else if (document.activeElement instanceof HTMLElement) {
      triggerButtonRef.current = document.activeElement;
    }

    setActiveStoryId(storyId);
    setDetailStory(null);
    setDetailLoading(true);
    try {
      const detail = await fetchExploreStoryDetail(storyId);
      setDetailStory(detail.story);
    } catch (err) {
      console.error("Failed to load story detail:", err);
    } finally {
      setDetailLoading(false);
    }
  };

  const hasRealStories = stories.length > 0;
  const isShowingSampleContent = !hasRealStories && showPreviewStories;
  const activeStoriesList = hasRealStories ? stories : filteredSampleStories;

  return (
    <div className="preserve-experience" style={{ minHeight: "100vh", background: "var(--v-bg)" }}>
      {/* Homepage Main Navigation Header */}
      <Header placeholder />

      <main id="main-content" className="exp-wrap">
        {/* Editorial Hero */}
        <section className="exp-hero" aria-labelledby="explore-heading">
          <div className="exp-hero-top">
            <div>
              <div className="p-eyebrow">06 / THE LIVING ARCHIVE</div>
              <h1 className="p-title" id="explore-heading" style={{ fontSize: "clamp(38px, 5.5vw, 76px)", margin: "8px 0 16px" }}>
                Stories that keep our heritage alive.
              </h1>
              <p className="p-lede" style={{ maxWidth: "64ch", margin: 0 }}>
                Explore oral histories, culinary legacies, dialects, and ancestral memories preserved sovereignly by families and communities across Odisha.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }}>
              <div className="exp-stats-pill">
                <span>●</span>
                <span>
                  {stories.length} {stories.length === 1 ? "story preserved" : "public stories preserved"}
                  {isShowingSampleContent ? " (3 preview stories shown)" : ""}
                </span>
              </div>
              <a href="/preserve-your-story" className="p-btn p-btn-brass">
                <PreserveStoryIcon className="btn-preserve-icon" />
                Preserve your story <span className="p-ar">↗</span>
              </a>
            </div>
          </div>
        </section>

        {/* Search & Filters */}
        <section className="exp-toolbar" aria-label="Explore search and filters">
          <div className="exp-search-row">
            <div className="exp-search-box">
              <svg className="exp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="search"
                className="exp-search-input"
                placeholder="Search stories by title, storyteller, place, or keywords…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search stories"
              />
            </div>

            {/* Language filter selector */}
            <div style={{ minWidth: 160 }}>
              <select
                className="p-select"
                value={selectedLanguage}
                onChange={(e) => setSelectedLanguage(e.target.value)}
                aria-label="Filter by language"
                style={{ height: "100%", width: "100%", padding: "12px 16px" }}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang === "All" ? "All Languages" : lang}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Category Filter Pills */}
          <div className="exp-cat-pills" role="tablist" aria-label="Story categories">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={selectedCategory === cat}
                className={`exp-cat-btn ${selectedCategory === cat ? "is-active" : ""}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        </section>

        {/* Stories Grid */}
        {loading ? (
          <div style={{ textAlign: "center", padding: "72px 0" }}>
            <div className="p-spinner" style={{ margin: "0 auto 16px" }} />
            <p className="p-lede">Loading the living archive…</p>
          </div>
        ) : error ? (
          <div className="exp-empty">
            <p style={{ color: "var(--v-alert)", fontWeight: 600 }}>{error}</p>
            <div className="p-row" style={{ justifyContent: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
              <button type="button" className="p-btn p-btn-dark p-btn-sm" onClick={loadFeed}>
                Retry loading
              </button>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => {
                  setError(null);
                  setShowPreviewStories(true);
                }}
              >
                Explore Preview Stories (Demo Mode) →
              </button>
            </div>
          </div>
        ) : !hasRealStories && !showPreviewStories ? (
          /* Thoughtful, Attractive Empty State */
          <div className="exp-empty">
            <div className="p-eyebrow">06 / THE LIVING ARCHIVE</div>
            <h2 className="p-title" style={{ fontSize: 32, margin: "8px 0 12px" }}>
              0 public stories preserved yet.
            </h2>
            <p className="p-lede" style={{ maxWidth: "52ch", margin: "0 auto 24px" }}>
              The sovereign archive is currently awaiting its first public recordings. You can preserve a story now or view preview sample cards to test the archive layout and audio player.
            </p>
            <div className="p-row" style={{ justifyContent: "center", gap: 14, flexWrap: "wrap" }}>
              <button
                type="button"
                className="p-btn p-btn-dark"
                onClick={() => setShowPreviewStories(true)}
              >
                Explore Preview Stories (Demo Mode) →
              </button>
              <a href="/preserve-your-story" className="p-btn p-btn-brass">
                <PreserveStoryIcon className="btn-preserve-icon" />
                Preserve a new story <span className="p-ar">↗</span>
              </a>
            </div>
          </div>
        ) : (
          <div>
            {/* Clear Preview Stories Disclaimer Banner */}
            {isShowingSampleContent && (
              <div
                style={{
                  marginBottom: 20,
                  padding: "12px 18px",
                  background: "rgba(184, 93, 50, 0.08)",
                  border: "1px dashed rgba(184, 93, 50, 0.35)",
                  borderRadius: 6,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      display: "inline-block",
                      background: "#B85D32",
                      color: "#fff",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    Preview Content
                  </span>
                  <span style={{ fontSize: 13, color: "var(--v-ink)" }}>
                    These authorized sample stories demonstrate the archive layout and filter controls. They are not counted as genuine preserved community records.
                  </span>
                </div>
                <button
                  type="button"
                  className="p-btn-text p-btn-sm"
                  onClick={() => setShowPreviewStories(false)}
                >
                  Hide preview stories (Show 0 preserved)
                </button>
              </div>
            )}

            {activeStoriesList.length === 0 ? (
              <div className="exp-empty" style={{ padding: "48px 0" }}>
                <div className="p-eyebrow">NO MATCHING PREVIEWS</div>
                <h3 className="p-title" style={{ fontSize: 24, margin: "8px 0 10px" }}>
                  No preview stories match this filter.
                </h3>
                <p className="p-lede" style={{ maxWidth: "48ch", margin: "0 auto 20px", fontSize: 15 }}>
                  Try resetting the category or language filter to view available demo records.
                </p>
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  onClick={() => {
                    setSelectedCategory("All");
                    setSelectedLanguage("All");
                    setSearchQuery("");
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="exp-grid">
                {activeStoriesList.map((story) => {
                  const isDemo = story.id.startsWith("demo-story-");
                  return (
                    <article key={story.id} className="exp-card">
                      <div>
                        <div className="exp-card-meta">
                          <span className="exp-card-cat">{story.category || "CULTURAL MEMORY"}</span>
                          <span className="exp-card-lang">{story.language || "Odia"}</span>
                          {isDemo && (
                            <span
                              style={{
                                background: "rgba(184, 93, 50, 0.12)",
                                color: "#8C4F00",
                                border: "1px solid rgba(184, 93, 50, 0.3)",
                                padding: "2px 7px",
                                borderRadius: 4,
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: "0.05em",
                                textTransform: "uppercase",
                              }}
                            >
                              Preview Story / Demo Content
                            </span>
                          )}
                        </div>

                        <h2 className="exp-card-title">{story.title}</h2>
                        <div className="exp-card-carrier">
                          Carried by {story.carrier || "Community contributor"}
                          {story.place && ` · ${story.place}`}
                          {story.period && ` · ${story.period}`}
                        </div>

                        <p className="exp-card-snippet p-odia-text" lang="or">
                          {story.excerpt}
                        </p>
                      </div>

                      <div className="exp-card-foot">
                        <div>
                          {story.provenance_id && (
                            <span className="exp-badge-prov" title="Cryptographically verified sovereign record">
                              ✓ {story.provenance_id.slice(0, 16)}…
                            </span>
                          )}
                          {story.vocabulary_count > 0 && (
                            <span className="p-small" style={{ display: "block", color: "var(--v-text-sub)", marginTop: 2 }}>
                              ✦ {story.vocabulary_count} cultural {story.vocabulary_count === 1 ? "term" : "terms"}
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          className="p-btn p-btn-sm p-btn-dark"
                          onClick={(e) => handleOpenDetail(story.id, e)}
                        >
                          Read & Listen <span className="p-ar">↗</span>
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Story Reader Drawer / Modal */}
      {activeStoryId && (
        <div className="exp-modal-backdrop" onClick={handleCloseDetail}>
          <div className="exp-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Preserved story detail">
            <div className="exp-drawer-topbar">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="p-eyebrow" style={{ margin: 0 }}>Heritage Archive Record</span>
                {detailStory?.id.startsWith("demo-story-") && (
                  <span
                    style={{
                      background: "rgba(184, 93, 50, 0.12)",
                      color: "#8C4F00",
                      border: "1px solid rgba(184, 93, 50, 0.3)",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    Demo Record · Preview Mode
                  </span>
                )}
              </div>
              <button
                type="button"
                className="exp-drawer-close"
                onClick={handleCloseDetail}
                aria-label="Close story reader"
              >
                ✕ Close
              </button>
            </div>

            {detailLoading ? (
              <div style={{ textAlign: "center", padding: "64px 0" }}>
                <div className="p-spinner" style={{ margin: "0 auto 14px" }} />
                <p>Loading preserved record…</p>
              </div>
            ) : detailStory ? (
              <div>
                <div className="exp-drawer-header">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <span className="p-eyebrow" style={{ margin: 0 }}>
                      {detailStory.category || "HERITAGE RECORD"} · {detailStory.language || "Odia"}
                    </span>
                    <span className="p-status-pill done">
                      {detailStory.id.startsWith("demo-story-") ? "PREVIEW RECORD (DEMO)" : "SOVEREIGN PRESERVED"}
                    </span>
                  </div>

                  <h1 className="exp-drawer-title">
                    {detailStory.title}
                  </h1>

                  <p className="p-lede exp-drawer-carrier">
                    Told by <strong>{detailStory.carrier || "Community contributor"}</strong>
                    {detailStory.place && ` · Rooted in ${detailStory.place}`}
                    {detailStory.period && ` · Circa ${detailStory.period}`}
                  </p>

                  {detailStory.provenance_id && (
                    <div className="exp-drawer-prov-badge">
                      <span>✓</span>
                      <span style={{ wordBreak: "break-all" }}>
                        {detailStory.id.startsWith("demo-story-") ? "Demonstration Provenance: " : "Sovereign Provenance Hash: "}
                        <strong>{detailStory.provenance_id}</strong>
                      </span>
                    </div>
                  )}
                </div>

                {/* Preserved Audio Recording If Present */}
                {detailStory.audio && (detailStory.has_audio ?? true) && (
                  <ExploreAudioPlayer storyId={detailStory.id} audio={detailStory.audio} />
                )}

                {/* Preserved Narrative Outputs */}
                {(() => {
                  const { output1, output2, hasTwoOutputs } = extractStoryTextOutputs(detailStory);

                  if (hasTwoOutputs) {
                    return (
                      <section className="exp-narrative-section">
                        <div className="p-eyebrow" style={{ marginBottom: 10 }}>
                          PRESERVED NARRATIVE & CONTEXT
                        </div>

                        <div className="exp-narrative-dual-grid">
                          {/* Text Box 1: Written Story Context */}
                          <div className="exp-narrative-box exp-narrative-box-written">
                            <div className="exp-narrative-box-header">
                              <span className="exp-narrative-box-tag">Text Output 1</span>
                              <h3 className="exp-narrative-box-title">Written Story Context</h3>
                              <p className="exp-narrative-box-sub">User-provided background notes & context</p>
                            </div>
                            <div className="exp-narrative-box-body" lang="or">
                              {output1
                                .split(/\n\s*\n|\n/)
                                .filter((p) => p.trim())
                                .map((para, i) => (
                                  <p key={i} className="exp-narrative-para">
                                    {para}
                                  </p>
                                ))}
                            </div>
                          </div>

                          {/* Text Box 2: Transcribed Audio Narrative */}
                          <div className="exp-narrative-box exp-narrative-box-transcribed">
                            <div className="exp-narrative-box-header">
                              <span className="exp-narrative-box-tag">Text Output 2</span>
                              <h3 className="exp-narrative-box-title">Transcribed Audio Narrative</h3>
                              <p className="exp-narrative-box-sub">Oral recording transcript & speech text</p>
                            </div>
                            <div className="p-odia-text exp-narrative-box-body" lang="or">
                              {output2
                                .split(/\n\s*\n|\n/)
                                .filter((p) => p.trim())
                                .map((para, i) => (
                                  <p key={i} className="exp-narrative-para">
                                    {para}
                                  </p>
                                ))}
                            </div>
                          </div>
                        </div>
                      </section>
                    );
                  }

                  // Single narrative output fallback (oral recording transcript or single written story)
                  const singleText = output2 || output1;
                  return (
                    <section className="exp-narrative-section">
                      <div className="p-eyebrow" style={{ marginBottom: 10 }}>
                        PRESERVED NARRATIVE
                      </div>
                      <div className="exp-narrative-box exp-narrative-box-single">
                        <div className="exp-narrative-box-header">
                          <h3 className="exp-narrative-box-title">
                            {detailStory.audio ? "Transcribed Audio Narrative" : "Preserved Narrative"}
                          </h3>
                        </div>
                        <div className="p-odia-text exp-narrative-box-body" lang="or">
                          {singleText ? (
                            singleText
                              .split(/\n\s*\n|\n/)
                              .filter((p) => p.trim())
                              .map((para, i) => (
                                <p key={i} className="exp-narrative-para">
                                  {para}
                                </p>
                              ))
                          ) : (
                            <em style={{ color: "var(--v-text-sub)" }}>No transcript text preserved.</em>
                          )}
                        </div>
                      </div>
                    </section>
                  );
                })()}

                {/* Cultural Glossary */}
                {detailStory.vocabulary && detailStory.vocabulary.length > 0 && (
                  <section style={{ marginBottom: 40 }}>
                    <div className="p-eyebrow">CULTURAL GLOSSARY ({detailStory.vocabulary.length})</div>
                    <h3 className="p-group-h" style={{ fontSize: 20, margin: "4px 0 16px" }}>
                      Preserved dialect terms and meanings
                    </h3>

                    <div style={{ display: "grid", gap: 14 }}>
                      {detailStory.vocabulary.map((v, i) => (
                        <div
                          key={i}
                          style={{
                            padding: "16px 20px",
                            background: "var(--v-field)",
                            border: "1px solid var(--v-line)",
                            borderRadius: 4,
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                            <strong className="p-odia-text" lang="or" style={{ fontSize: 20, color: "var(--v-terracotta)" }}>
                              {v.preferred}
                            </strong>
                            {v.heard && v.heard !== v.preferred && (
                              <span className="p-small" style={{ color: "var(--v-text-sub)" }}>
                                Heard as: <em>{v.heard}</em>
                              </span>
                            )}
                          </div>
                          {v.meaning && (
                            <p style={{ margin: "6px 0 4px", fontSize: 15, color: "var(--v-ink)" }}>
                              {v.meaning}
                            </p>
                          )}
                          {v.context && (
                            <p className="p-small" style={{ margin: 0, color: "var(--v-text-sub)" }}>
                              Cultural context: {v.context}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Sovereign Archival Provenance Record */}
                <section style={{ marginBottom: 32, borderTop: "1px solid var(--v-line2)", paddingTop: 24 }}>
                  <div className="p-eyebrow">ARCHIVAL PROVENANCE & AUTHENTICITY</div>
                  <p className="p-small" style={{ margin: "4px 0 16px", color: "var(--v-text-sub)" }}>
                    Preserved through the GNANI AI transcription pipeline, with storyteller review and cultural context.
                  </p>

                  <div style={{ display: "grid", gap: 10, background: "var(--v-field)", padding: "16px 20px", borderRadius: 4, border: "1px solid var(--v-line)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                      <span className="p-small" style={{ fontWeight: 600 }}>Archival Identifier</span>
                      <code style={{ fontSize: 13, color: "var(--v-brown)", background: "rgba(185, 150, 91, 0.15)", padding: "2px 8px", borderRadius: 3, wordBreak: "break-all" }}>
                        {detailStory.provenance_id || detailStory.id}
                      </code>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, fontSize: 13 }}>
                      <span style={{ color: "var(--v-text-sub)" }}>Preservation Date</span>
                      <span>
                        {detailStory.preserved_at
                          ? new Date(detailStory.preserved_at).toLocaleDateString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "Archived Record"}
                      </span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, fontSize: 13 }}>
                      <span style={{ color: "var(--v-text-sub)" }}>Oral Preservation Pipeline</span>
                      <span>{detailStory.audio ? "GNANI AI Speech-to-Text" : "Direct Script Preservation"}</span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, fontSize: 13 }}>
                      <span style={{ color: "var(--v-text-sub)" }}>Punctuation & Editorial Review</span>
                      <span>Manual punctuation and transcript review (AI punctuation model coming soon)</span>
                    </div>
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
