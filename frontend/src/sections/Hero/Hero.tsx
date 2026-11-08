import { PreserveStoryIcon } from "../../components/shared/Icons";
import {
  isOnboardingCompleted,
  openOnboardingDialog,
  navigateTo,
} from "../../components/shared/onboarding";

export default function Hero() {
  const handlePreserveClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (isOnboardingCompleted()) {
      navigateTo("/preserve-your-story");
    } else {
      openOnboardingDialog();
    }
  };

  return (
    <>
      <section className="hero" id="home" aria-labelledby="hero-heading">
        <div className="hero-stage wrap">
          <div className="hero-copy">
            <div className="eyebrow">WHERE STORIES BECOME LEGACY.</div>
            <h1 id="hero-heading">
              <span>Every Story</span>
              <span>Begins At Home.</span>
            </h1>
            <p>
              Meet Virasya, the thoughtful archive that turns your memories into
              meaning.
              <br /> Our stories and traditions, kept alive through people.
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="btn"
                data-start="Starter"
                onClick={handlePreserveClick}
              >
                <PreserveStoryIcon className="btn-preserve-icon" />
                <span>Preserve your story</span>{" "}
                <span className="arrow" aria-hidden={true}>
                  ↗
                </span>
              </button>
              <a className="text-link" href="#integrations">
                <span className="round-icon" aria-hidden={true}>
                  ▶
                </span>{" "}
                Explore Virasya
              </a>
            </div>
          </div>
          <div className="hero-orbits" aria-hidden={true}>
            <i></i>
            <i></i>
            <i></i>
          </div>
          <div className="hero-art">
            <div
              id="hero-loading-status"
              className="hero-loading-status"
              role="status"
              aria-live="polite"
            >
              Loading interactive manuscript…
            </div>
          </div>
          <div
            id="hero-scene"
            className="hero-scene"
            tabIndex={0}
            role="group"
            aria-label="Interactive 3D Virasya manuscript. Drag to rotate. Arrow keys rotate, Enter opens the core, Escape resets."
            aria-describedby="orbit-status"
          ></div>
          <span className="hero-note">
            01 /<br />
            YOUR HERITAGE.
            <br />
            YOUR LEGACY.
          </span>
          <div className="float-note note-two">
            <span className="check-dot">✓</span>Your stories, remembered.
          </div>
          <div className="hero-ghost" aria-hidden={true}>
            A LITTLE MORE.
          </div>
          <div className="hero-chapter" aria-hidden={true}>
            <div className="eyebrow">A closer look at possibility.</div>
            <h2>
              The Past ,
              <br /> Kept Alive .
            </h2>
            <p>Ancient wisdom. Living stories. Endless possibilities.</p>
          </div>
          <div className="core-toolbar">
            <span>
              Drag to explore <b aria-hidden={true}>↔</b>
            </span>
            <button data-explode="" aria-pressed={false}>
              <span className="explode-label">Open the core</span>
              <span className="open-icon" aria-hidden={true}>
                +
              </span>
            </button>
            <button
              className="reset-core"
              data-reset-core=""
              aria-label="Reset 3D view"
            >
              ↺
            </button>
          </div>
          <div className="hero-foot">
            <span id="hero-chapter-label">01 / DISCOVER VIRASYA</span>
            <div className="chapter-ticks" aria-hidden={true}>
              <i>
                <b></b>
              </i>
              <i>
                <b></b>
              </i>
              <i>
                <b></b>
              </i>
            </div>
            <a href="#integrations">
              SCROLL TO GO DEEPER{" "}
              <span className="arrow" aria-hidden={true}>
                ↓
              </span>
            </a>
          </div>
          <div className="hero-portal" aria-hidden={true}>
            <div className="hero-portal-content">
              <img
                src="/virasya-logo.png"
                alt="Virasya"
                className="hero-portal-logo"
                width="80"
                height="80"
              />
              <div className="eyebrow">03 / A LEGACY IN THE MAKING.</div>
              <h2>
                Your Story Begins Here.
                <br />
                <span>Its Legacy Lives On.</span>
              </h2>
            </div>
          </div>
        </div>
      </section>
      <span id="orbit-status" className="sr-only" aria-live="polite">
        Drag to rotate, or use arrow keys. Enter opens the core. Escape resets
        the view.
      </span>
    </>
  );
}
