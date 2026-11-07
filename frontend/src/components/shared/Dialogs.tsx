import React, { useState } from "react";
import {
  saveOnboardingData,
  clearOnboardingData,
  navigateTo,
  closeOnboardingDialog,
} from "./onboarding";

export default function Dialogs() {
  const [error, setError] = useState<string>("");
  const [clearStatus, setClearStatus] = useState<string>("");

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const nameInput = form.elements.namedItem("name") as HTMLInputElement | null;
    const focusSelect = form.elements.namedItem("focus") as HTMLSelectElement | null;
    const name = nameInput?.value?.trim() || "";

    if (!name) {
      if (nameInput) {
        nameInput.setCustomValidity("Please add your first name.");
        nameInput.reportValidity();
      }
      return;
    }

    if (nameInput) {
      nameInput.setCustomValidity("");
    }

    const focus = focusSelect?.value || "research";
    const saved = saveOnboardingData(name, focus, "Starter");

    if (!saved) {
      setError(
        "Unable to save your onboarding preferences. Please check your browser storage settings and try again."
      );
      return;
    }

    setError("");
    closeOnboardingDialog();
    navigateTo("/explore");
  };

  const handleClose = (dialogId: string) => {
    const dialog = document.getElementById(dialogId) as HTMLDialogElement | null;
    if (dialog) {
      if (typeof dialog.close === "function") {
        dialog.close();
      }
      document.body.classList.remove("modal-open");
    }
  };

  const handleClearPreferences = () => {
    clearOnboardingData();
    const nameInput = document.getElementById("your-name") as HTMLInputElement | null;
    const focusSelect = document.getElementById("your-focus") as HTMLSelectElement | null;
    if (nameInput) nameInput.value = "";
    if (focusSelect) focusSelect.value = "research";
    setClearStatus("Your saved preferences have been cleared.");
  };

  return (
    <>
      <dialog
        className="dialog"
        id="start-dialog"
        aria-labelledby="dialog-title"
      >
        <button
          type="button"
          className="dialog-close"
          aria-label="Close workspace preview"
          onClick={() => handleClose("start-dialog")}
        >
          ×
        </button>
        <div id="setup-pane">
          <img
            src="/virasya-logo.png"
            alt="Virasya"
            className="dialog-brand-logo"
            width="48"
            height="48"
          />
          <p className="eyebrow" id="selected-plan">
            YOUR FIRST STEP
          </p>
          <h2 id="dialog-title">Hello, possibility.</h2>
          <p>
            Let's give your day a little more room. Make this archive preview
            yours.
          </p>
          <form id="setup-form" onSubmit={handleSubmit}>
            <label htmlFor="your-name">WHAT SHOULD VIRASYA CALL YOU?</label>
            <input
              id="your-name"
              name="name"
              placeholder="Your first name"
              autoComplete="given-name"
              required
              maxLength={45}
              onChange={() => {
                if (error) setError("");
                const el = document.getElementById("your-name") as HTMLInputElement | null;
                if (el) el.setCustomValidity("");
              }}
            />
            <label htmlFor="your-focus">WHAT'S ON YOUR MIND?</label>
            <select id="your-focus" name="focus">
              <option value="research">Finding clarity through research</option>
              <option value="create">Making something new</option>
              <option value="coordinate">Keeping the work moving</option>
            </select>
            {error && (
              <p
                className="fine p-field-error"
                style={{ color: "#d32f2f", marginTop: "8px" }}
                role="alert"
              >
                {error}
              </p>
            )}
            <button className="btn ink" type="submit">
              Let's find your flow <span className="arrow">↗</span>
            </button>
            <p className="fine">
              A local product preview. No account, payment, or connected tools.
              Your name stays in this browser.
            </p>
          </form>
        </div>
        <div id="success-pane" className="success-pane" hidden={true}>
          <img
            src="/virasya-logo.png"
            alt="Virasya"
            className="dialog-brand-logo"
            width="48"
            height="48"
          />
          <h2 id="welcome-title">Room for brilliant.</h2>
          <p>
            Your archive preview is ready. Pick a starting point, run a sample
            workflow, and see how a little help feels.
          </p>
          <button className="btn ink" id="open-workspace">
            Explore your archive <span className="arrow">↗</span>
          </button>
        </div>
      </dialog>
      <dialog
        className="dialog"
        id="about-dialog"
        aria-labelledby="about-title"
      >
        <button
          type="button"
          className="dialog-close"
          aria-label="Close about preview"
          onClick={() => handleClose("about-dialog")}
        >
          ×
        </button>
        <img
          src="/virasya-logo.png"
          alt="Virasya"
          className="dialog-brand-logo"
          width="48"
          height="48"
        />
        <h2 id="about-title">A little transparency.</h2>
        <p>
          Virasya is an original interactive product concept. The archive
          workflows use sample content; they do not call a live AI service.
          Pricing and integrations illustrate the proposed product.
        </p>
        <p style={{ marginTop: "15px" }}>
          Everything on this page runs in your browser. No analytics, external
          accounts, or messages. Your optional first name and preferred workflow
          are saved only on this device.
        </p>
        <button
          type="button"
          className="btn ink"
          id="clear-preview"
          onClick={handleClearPreferences}
        >
          Clear my saved preferences <span className="arrow">↗</span>
        </button>
        <p className="fine" id="clear-status" aria-live="polite">
          {clearStatus}
        </p>
      </dialog>
    </>
  );
}
