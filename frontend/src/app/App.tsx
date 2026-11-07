import { useEffect, useState, useRef } from "react";
// @ts-ignore
import { initThreeScene } from "../three/main.js";
import { setupVirasyaBranding } from "../branding";
import Header from "../components/layout/Header";
import Hero from "../sections/Hero/Hero";
import Integrations from "../sections/Integrations/Integrations";
import Trust from "../sections/Trust/Trust";
import Faq from "../sections/Faq/Faq";
import Closing from "../sections/Closing/Closing";
import Dialogs from "../components/shared/Dialogs";
import PreserveApp from "../preserve/PreserveApp";
import ExplorePage from "../explore/ExplorePage";
import MyArchivePage from "../archive/MyArchivePage";
import { AuthProvider, AuthModal, useAuth } from "../auth";
import ErrorBoundary from "../components/shared/ErrorBoundary";
import { PreserveStoryIcon, CulturalHostIcon, SearchIcon } from "../components/shared/Icons";

interface PlaceholderConfig {
  eyebrow?: string;
  badge?: string;
  title: string;
  desc: string;
  icon?: React.ReactNode;
}

const PLACEHOLDER_CONFIGS: Record<string, PlaceholderConfig> = {
  "/search": {
    badge: "Coming Soon",
    eyebrow: "Sovereign Search",
    title: "Search the Living Archive",
    desc: "Coming soon — an archival search engine across preserved oral histories, folklore recordings, and regional dialect lexicons.",
    icon: <SearchIcon size={38} />,
  },
  "/culture-hosts": {
    badge: "Coming Soon",
    eyebrow: "Living Heritage Custodians",
    title: "Culture Hosts & Guilds",
    desc: "Coming soon — connect with native cultural custodians, storytellers, and community archives across India.",
    icon: <CulturalHostIcon size={38} />,
  },
};

function PlaceholderPage({ path }: { path: string }) {
  const config = PLACEHOLDER_CONFIGS[path] || {
    badge: "Coming Soon",
    eyebrow: "Archive Preservation",
    title: "Living Archive Section",
    desc: "This heritage preservation area is currently being prepared for sovereign archival storage.",
  };

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header placeholder />
      <main id="main" className="placeholder-view-section">
        <div className="placeholder-card">
          {config.badge && (
            <div className="placeholder-badge">
              <span className="placeholder-badge-dot" aria-hidden="true" />
              <span>{config.badge}</span>
            </div>
          )}
          {config.icon && <div className="placeholder-icon">{config.icon}</div>}
          {config.eyebrow && <div className="placeholder-eyebrow">{config.eyebrow}</div>}
          <h1 className="placeholder-title">{config.title}</h1>
          <p className="placeholder-desc">{config.desc}</p>
          <div className="placeholder-buttons">
            <a href="/" className="placeholder-btn-home">
              ← Back to Home
            </a>
            <a href="/explore" className="placeholder-btn-explore">
              Explore Stories
            </a>
            <a href="/preserve-your-story" className="placeholder-btn-preserve">
              <PreserveStoryIcon className="btn-preserve-icon" />
              Preserve a Story →
            </a>
          </div>
        </div>
      </main>
    </>
  );
}

function AppContent() {
  const [currentPath, setCurrentPath] = useState(() => {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/private-vault") {
      window.history.replaceState(
        null,
        "",
        "/heritage-vault" + window.location.search + window.location.hash
      );
      return "/heritage-vault";
    }
    return path;
  });
  const { openAuthModal, authModalOpen } = useAuth();
  const openedForRouteRef = useRef(false);

  useEffect(() => {
    const handleLocationChange = () => {
      const path = window.location.pathname.replace(/\/+$/, "") || "/";
      if (path === "/private-vault") {
        window.history.replaceState(
          null,
          "",
          "/heritage-vault" + window.location.search + window.location.hash
        );
        setCurrentPath("/heritage-vault");
      } else {
        setCurrentPath(path);
      }
    };
    window.addEventListener("popstate", handleLocationChange);
    return () => window.removeEventListener("popstate", handleLocationChange);
  }, []);

  // Universal internal SPA navigation handler for links across the app
  useEffect(() => {
    const handleLinkClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;

      // Allow in-page hash anchor navigation (e.g. #faq, #get-started) to behave natively
      if (href.startsWith("#")) {
        return;
      }

      // External protocol checks
      if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("tel:")) {
        if (!anchor.href.startsWith(window.location.origin)) {
          return;
        }
      }

      if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
        return;
      }

      try {
        const targetUrl = new URL(anchor.href, window.location.origin);
        if (targetUrl.origin === window.location.origin) {
          e.preventDefault();
          let cleanPath = targetUrl.pathname.replace(/\/+$/, "") || "/";
          if (cleanPath === "/private-vault") {
            cleanPath = "/heritage-vault";
          }
          if (cleanPath !== currentPath) {
            window.history.pushState(null, "", cleanPath + targetUrl.search + targetUrl.hash);
            setCurrentPath(cleanPath);
            window.scrollTo({ top: 0, behavior: "instant" });
          } else if (targetUrl.hash) {
            const targetEl = document.querySelector(targetUrl.hash);
            if (targetEl) {
              targetEl.scrollIntoView({ behavior: "smooth" });
            }
          } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }
      } catch {
        // Fall back to native browser navigation
      }
    };

    document.addEventListener("click", handleLinkClick);
    return () => document.removeEventListener("click", handleLinkClick);
  }, [currentPath]);

  const isLoginOrProfileRoute =
    currentPath === "/login" || currentPath === "/profile" || currentPath === "/signup";

  // When /login, /profile, or /signup is loaded directly, open the authentic AuthModal
  useEffect(() => {
    if (isLoginOrProfileRoute && !openedForRouteRef.current) {
      openedForRouteRef.current = true;
      openAuthModal();
    }
  }, [isLoginOrProfileRoute, openAuthModal]);

  // Clean up URL to "/" when modal closes if opened from a login/profile/signup route
  useEffect(() => {
    if (!authModalOpen && openedForRouteRef.current) {
      openedForRouteRef.current = false;
      const path = window.location.pathname.replace(/\/+$/, "");
      if (path === "/login" || path === "/profile" || path === "/signup") {
        window.history.pushState(null, "", "/");
        setCurrentPath("/");
      }
    }
  }, [authModalOpen]);

  // Redirect legacy /private-vault to canonical /heritage-vault
  useEffect(() => {
    if (currentPath === "/private-vault") {
      window.history.replaceState(
        null,
        "",
        "/heritage-vault" + window.location.search + window.location.hash
      );
      setCurrentPath("/heritage-vault");
    }
  }, [currentPath]);

  const isPreserveRoute = currentPath.startsWith("/preserve-your-story");
  const isExploreRoute = currentPath === "/explore";
  const isArchiveRoute =
    currentPath === "/my-archive" ||
    currentPath === "/heritage-vault" ||
    currentPath === "/private-vault";
  const isPlaceholder = currentPath in PLACEHOLDER_CONFIGS;

  const isHomeRoute =
    !isPreserveRoute &&
    !isExploreRoute &&
    !isArchiveRoute &&
    !isPlaceholder;

  useEffect(() => {
    setupVirasyaBranding();
    if (isHomeRoute) {
      const cleanup = initThreeScene();
      return () => {
        if (typeof cleanup === "function") {
          cleanup();
        }
      };
    }
  }, [isHomeRoute]);

  const renderContent = () => {
    // 1. Explore Page
    if (isExploreRoute) {
      return <ExplorePage />;
    }

    // 2. Preserve Workflow (Steps 1-6)
    if (isPreserveRoute) {
      return <PreserveApp />;
    }

    // 3. My Archive & Sovereign Vault
    if (isArchiveRoute) {
      return <MyArchivePage />;
    }

    // 4. Configured Placeholders (Search, Hosts)
    if (isPlaceholder) {
      return <PlaceholderPage path={currentPath} />;
    }

    // 4. Home Landing Page (also rendered behind the auth modal if navigating directly to /login or /profile)
    return (
      <>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="scroll-progress" aria-hidden="true"></div>
        <Header />
        <main id="main">
          <Hero />
          <Integrations />
          <Trust />
          <Faq />
          <Closing />
        </main>
        <button className="back-top" aria-label="Back to top">
          ↑
        </button>
        <Dialogs />
      </>
    );
  };

  return <ErrorBoundary>{renderContent()}</ErrorBoundary>;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
      <AuthModal />
    </AuthProvider>
  );
}
