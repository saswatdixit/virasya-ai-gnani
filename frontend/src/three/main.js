import * as THREE from "three";
import { createManuscriptModel } from "./manuscriptModel.js";
import { createFloatingDecorations } from "./floatingDecorations.js";
export function initThreeScene() {
  const heroSceneCheck = document.getElementById("hero-scene");
  if (!heroSceneCheck) return;
  if (heroSceneCheck.querySelector("canvas")) return;

  return (() => {
    "use strict";
    document.documentElement.classList.add("js");
    const $ = (s, r = document) => r.querySelector(s),
      $$ = (s, r = document) => [...r.querySelectorAll(s)];
    const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = motionQuery.matches;
    const handleMotionChange = (e) => applyMotion(e.matches);
    motionQuery.addEventListener("change", handleMotionChange);
    const observer = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target
              .querySelectorAll(".reveal")
              .forEach((n) => n.classList.add("visible"));
            observer.unobserve(e.target);
          }
        }),
      { threshold: 0.12 },
    );
    $$(".reveal").forEach((e) => observer.observe(e.parentElement));
    let activePlan = "Starter",
      savedName = "";
    try {
      const saved = JSON.parse(
        localStorage.getItem("virasya-preview") || "null",
      );
      if (saved) {
        savedName = saved.name || "";
        if ($("#your-name")) $("#your-name").value = savedName;
        if ($("#your-focus")) $("#your-focus").value = saved.focus || "research";
      }
    } catch {}
    let lastFocus;
    function showDialog(d) {
      lastFocus = document.activeElement;
      document.querySelector(".mobile-menu")?.classList.remove("open");
      d.showModal();
      document.body.classList.add("modal-open");
    }
    function hideDialog(d) {
      d.close();
      document.body.classList.remove("modal-open");
      lastFocus?.focus();
    }
    $$(".dialog").forEach((d) => {
      $(".dialog-close", d).addEventListener("click", () => hideDialog(d));
      d.addEventListener("click", (e) => {
        const r = d.getBoundingClientRect();
        if (
          e.target === d &&
          (e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom)
        )
          hideDialog(d);
      });
      d.addEventListener("close", () =>
        document.body.classList.remove("modal-open"),
      );
      d.addEventListener("cancel", () => {
        document.body.classList.remove("modal-open");
        lastFocus?.focus();
      });
    });
    $$("[data-start]").forEach((b) =>
      b.addEventListener("click", (e) => {
        try {
          const raw = localStorage.getItem("virasya-preview");
          if (raw) {
            const saved = JSON.parse(raw);
            if (saved && typeof saved.name === "string" && saved.name.trim().length > 0) {
              e.preventDefault();
              window.history.pushState(null, "", "/preserve-your-story");
              window.dispatchEvent(new PopStateEvent("popstate"));
              window.scrollTo({ top: 0, behavior: "instant" });
              return;
            }
          }
        } catch {}
        activePlan = b.dataset.start;
        $("#selected-plan").textContent =
          activePlan.toUpperCase() + " / YOUR WORKSPACE PREVIEW";
        $("#setup-pane").hidden = false;
        $("#success-pane").hidden = true;
        $("#start-dialog").setAttribute("aria-labelledby", "dialog-title");
        showDialog($("#start-dialog"));
      }),
    );
    $("#setup-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#your-name")?.value.trim() || "";
      if (!name) {
        $("#your-name")?.setCustomValidity("Please add your first name.");
        $("#your-name")?.reportValidity();
        return;
      }
      $("#your-name")?.setCustomValidity("");
      savedName = name;
      try {
        const payload = {
          name,
          focus: $("#your-focus")?.value || "research",
          plan: activePlan || "Starter",
          completed: true,
          onboardingCompleted: true,
        };
        localStorage.setItem(
          "virasya-preview",
          JSON.stringify(payload),
        );
        const verify = localStorage.getItem("virasya-preview");
        if (!verify) {
          throw new Error("Unable to save preferences");
        }
      } catch {
        return;
      }
      hideDialog($("#start-dialog"));
      window.history.pushState(null, "", "/explore");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    $("#your-name")?.addEventListener("input", () =>
      $("#your-name").setCustomValidity(""),
    );
    $("#open-workspace")?.addEventListener("click", () => {
      hideDialog($("#start-dialog"));
      window.history.pushState(null, "", "/explore");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    $("#privacy-button")?.addEventListener("click", () =>
      showDialog($("#about-dialog")),
    );
    $("#clear-preview")?.addEventListener("click", () => {
      try {
        localStorage.removeItem("virasya-preview");
      } catch {}
      savedName = "";
      if ($("#your-name")) $("#your-name").value = "";
      if ($("#your-focus")) $("#your-focus").value = "research";
      if ($("#clear-status")) {
        $("#clear-status").textContent =
          "Your saved preferences have been cleared.";
      }
    });
    $(".back-top")?.addEventListener("click", () =>
      window.scrollTo({ top: 0, behavior: reduced ? "instant" : "smooth" }),
    );
    const footerWord = $(".footer-brand");
    const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
      smooth = (a, b, x) => {
        const p = clamp((x - a) / (b - a));
        return p * p * (3 - 2 * p);
      };
    // Deliberate reload pose matching reference image 2: unclipped, resting cleanly on dock plinth.
    const HERO_BASE_POSE = Object.freeze({
      rotation: Object.freeze({ x: -0.35, y: -0.25, z: -0.25 }),
      scale: Object.freeze({ x: 1.100, y: 1.100, z: 1.10 }),
      coreY: 0.06,
      cameraY: 1.7,
      lookAtY: -0.04,
    });
    const hero = $(".hero"),
      heroStage = $(".hero-stage"),
      art = $(".hero-art"),
      heroContainer = $("#hero-scene");
    let dirty = true,
      heroProgress = 0,
      activeView = "hero",
      renderVisible = true,
      ready = false,
      modelReady = false,
      firstFrameRendered = false;
    let renderer,
      scene,
      camera,
      core,
      dock,
      shadow,
      orbitals,
      mats,
      manuscript,
      groups = {},
      frameCount = 0,
      totalFrames = 0,
      lastFrameTime = 0,
      avgFrame = 16,
      renderMs = 0,
      host = heroContainer,
      mouseX = 0,
      mouseY = 0,
      px = 0,
      py = 0;
    let manualOpen = null,
      openY = 0;
    let lastMetrics = 0;
    let dragX = 0,
      dragY = 0,
      dragPX = 0,
      dragPY = 0,
      dragging = false,
      dragStart = null,
      pointerInteracted = false,
      exploded = false,
      openAmount = 0,
      renderDirty = true,
      frameAfterResize = 0,
      heroInside = true;
    const orbitStatus = $("#orbit-status");
    const heroLoadingStatus = $("#hero-loading-status");
    function setHeroLoadingStatus(message, state = "loading") {
      if (!heroLoadingStatus) return;
      heroLoadingStatus.textContent = message;
      heroLoadingStatus.dataset.state = state;
      heroLoadingStatus.hidden = false;
    }
    function revealHeroScene() {
      if (firstFrameRendered) return;
      firstFrameRendered = true;
      heroContainer.classList.add("loaded");
      art.classList.add("live");
      art.dataset.ready = "true";
      if (heroLoadingStatus) {
        heroLoadingStatus.hidden = true;
        heroLoadingStatus.textContent = "";
      }
    }
    function applyMotion(value) {
      reduced = value;
      document.documentElement.classList.toggle("motion-reduced", value);
      const motionBtn = $("#motion-button");
      if (motionBtn) {
        motionBtn.textContent = value
          ? "Resume motion"
          : "Pause motion";
        motionBtn.setAttribute("aria-pressed", value);
      }
      dirty = renderDirty = true;
      resizeScene();
    }
    $("#motion-button")?.addEventListener("click", () => applyMotion(!reduced));
    if (reduced) {
      document.documentElement.classList.add("motion-reduced");
      const motionBtn = $("#motion-button");
      if (motionBtn) {
        motionBtn.textContent = "Resume motion";
        motionBtn.setAttribute("aria-pressed", "true");
      }
    }
    function setExploded(value) {
      manualOpen = value;
      openY = scrollY;
      exploded = value;
      $$("[data-explode]").forEach((b) => {
        b.setAttribute("aria-pressed", value);
        $(".explode-label", b).textContent = value
          ? "Close the core"
          : "Open the core";
      });
      orbitStatus.textContent = value
        ? "Core open. Drag or use arrow keys to inspect the layers."
        : "Core assembled.";
      renderDirty = true;
    }
    $$("[data-explode]").forEach((b) =>
      b.addEventListener("click", () => setExploded(!exploded)),
    );
    function resetCore() {
      dragX = dragY = mouseX = mouseY = 0;
      if (reduced) dragPX = dragPY = px = py = 0;
      setExploded(false);
      orbitStatus.textContent = "View reset.";
      renderDirty = true;
    }
    $$("[data-reset-core]").forEach((b) =>
      b.addEventListener("click", resetCore),
    );
    for (const container of [heroContainer].filter(Boolean)) {
      container.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        pointerInteracted = true;
        dragStart = {
          x: e.clientX,
          y: e.clientY,
          rx: dragX,
          ry: dragY,
          id: e.pointerId,
          moved: false,
        };
        dragging = true;
        container.classList.add("dragging");
        container.setPointerCapture(e.pointerId);
        renderDirty = true;
      });
      container.addEventListener("pointermove", (e) => {
        const r = container.getBoundingClientRect();
        if (dragging && dragStart) {
          const dx = e.clientX - dragStart.x,
            dy = e.clientY - dragStart.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) dragStart.moved = true;
          dragX = dragStart.rx + dx * 0.009;
          dragY = clamp(dragStart.ry + dy * 0.006, -0.65, 0.65);
          renderDirty = true;
        } else if (e.pointerType !== "touch" && !reduced) {
          mouseX = ((e.clientX - r.left) / r.width - 0.5) * 0.18;
          mouseY = ((e.clientY - r.top) / r.height - 0.5) * 0.12;
          renderDirty = true;
        }
      });
      const release = (e) => {
        if (!dragStart) return;
        const wasTap = !dragStart.moved && e.type === "pointerup";
        dragging = false;
        dragStart = null;
        container.classList.remove("dragging");
        if (container.hasPointerCapture(e.pointerId))
          container.releasePointerCapture(e.pointerId);
        if (wasTap) setExploded(!exploded);
        renderDirty = true;
      };
      container.addEventListener("pointerup", release);
      container.addEventListener("pointercancel", release);
      container.addEventListener("pointerleave", () => {
        mouseX = mouseY = 0;
        renderDirty = true;
      });
      container.addEventListener("keydown", (e) => {
        if (
          ![
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Enter",
            " ",
            "Escape",
            "Home",
          ].includes(e.key)
        )
          return;
        e.preventDefault();
        if (e.key === "Enter" || e.key === " ") setExploded(!exploded);
        else if (e.key === "Escape" || e.key === "Home") resetCore();
        else {
          dragX +=
            e.key === "ArrowRight" ? 0.2 : e.key === "ArrowLeft" ? -0.2 : 0;
          dragY = clamp(
            dragY +
              (e.key === "ArrowDown" ? 0.12 : e.key === "ArrowUp" ? -0.12 : 0),
            -0.65,
            0.65,
          );
          renderDirty = true;
        }
      });
    }
    const scrollHandler = () => {
      dirty = true;
      if (manualOpen !== null && Math.abs(scrollY - openY) > 100)
        manualOpen = null;
    };
    const resizeHandler = () => {
      dirty = renderDirty = true;
      resizeScene();
    };
    const visibilityHandler = () => {
      lastFrameTime = 0;
      dirty = renderDirty = true;
    };
    window.addEventListener("scroll", scrollHandler, { passive: true });
    window.addEventListener("resize", resizeHandler, { passive: true });
    document.addEventListener("visibilitychange", visibilityHandler);
    function resizeScene() {
      if (!renderer || !camera) return;
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderDirty = true;
      frameAfterResize = 0;
    }
    async function initScene() {
      if (ready) return;
      ready = true;
      try {
        const T = THREE;
        renderer = new T.WebGLRenderer({
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
        renderer.outputEncoding = T.sRGBEncoding;
        renderer.toneMapping = T.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.98;
        host.appendChild(renderer.domElement);
        renderer.domElement.setAttribute("aria-hidden", "true");
        scene = new T.Scene();
        camera = new T.PerspectiveCamera(35, 1, 0.1, 80);
        core = new T.Group();
        scene.add(core);
        core.scale.setScalar(HERO_BASE_POSE.scale.x);
        core.rotation.set(
          HERO_BASE_POSE.rotation.x,
          HERO_BASE_POSE.rotation.y,
          HERO_BASE_POSE.rotation.z,
        );
        core.position.set(0, HERO_BASE_POSE.coreY, 0);
        const environment = await new Promise((res, rej) =>
          new T.TextureLoader().load(
            "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/2f4bbd6f-6938-403b-b919-a32eee29559c_original.webp",
            res,
            undefined,
            rej,
          ),
        );
        environment.mapping = T.EquirectangularReflectionMapping;
        environment.encoding = T.sRGBEncoding;
        const pmrem = new T.PMREMGenerator(renderer);
        scene.environment = pmrem.fromEquirectangular(environment).texture;
        environment.dispose();
        pmrem.dispose();
        const make = (color, roughness, metalness, extra = {}) =>
          new T.MeshStandardMaterial({
            color: new T.Color(color).convertSRGBToLinear(),
            roughness,
            metalness,
            envMapIntensity: 1.15,
            ...extra,
          });
        mats = {
          mint: make("#ccddd5", 0.18, 0.45),
          cream: make("#fff5df", 0.22, 0.08),
          copper: make("#ed631b", 0.19, 0.78, { envMapIntensity: 1.65 }),
          recess: make("#65260d", 0.27, 0.45),
          accent: make("#e75729", 0.22, 0.23),
          chrome: make("#d1e5df", 0.12, 1),
          teal: make("#07594f", 0.13, 0.85, { envMapIntensity: 2.2 }),
          glass: make("#064c40", 0.085, 0.88, { envMapIntensity: 1.8 }),
          dark: make("#061716", 0.18, 0.65),
          gold: make("#dfaf3f", 0.17, 0.74),
          light: make("#fff0c1", 0.25, 0.1, {
            emissive: "#ff8f25",
            emissiveIntensity: 1.6,
          }),
        };
        const opticalEnvironment = await new Promise((res, rej) =>
          new T.TextureLoader().load(
            "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/012296e6-a090-4dc1-a30d-73176af6188e_original.webp",
            res,
            undefined,
            rej,
          ),
        );
        opticalEnvironment.mapping = T.EquirectangularReflectionMapping;
        opticalEnvironment.encoding = T.sRGBEncoding;
        const opticalPmrem = new T.PMREMGenerator(renderer);
        const reflectionStage = new T.Scene();
        const reflectionDome = new T.Mesh(
          new T.SphereGeometry(15, 32, 16),
          new T.MeshBasicMaterial({
            map: opticalEnvironment,
            side: T.BackSide,
          }),
        );
        reflectionDome.rotation.y = 1.0;
        reflectionStage.add(reflectionDome);
        const reflectionCard = (x, y, z, w, h, color) => {
          const card = new T.Mesh(
            new T.PlaneGeometry(w, h),
            new T.MeshBasicMaterial({ color, side: T.DoubleSide }),
          );
          card.position.set(x, y, z);
          card.lookAt(0, 0, 0);
          reflectionStage.add(card);
        };
        reflectionCard(-3, 3, 4, 1.4, 3, new T.Color(3, 5, 5));
        reflectionCard(4, -0.5, 2, 0.6, 2.8, new T.Color(1.8, 3, 2.8));
        const opticalMap = opticalPmrem.fromScene(
          reflectionStage,
          0.03,
          0.1,
          40,
        ).texture;
        reflectionStage.traverse((o) => {
          o.geometry?.dispose();
          o.material?.dispose();
        });
        opticalEnvironment.dispose();
        opticalPmrem.dispose();
        for (const name of ["teal", "glass", "dark", "chrome"]) {
          mats[name].envMap = opticalMap;
          mats[name].envMapIntensity =
            name === "teal" ? 3.4 : name === "glass" ? 2.8 : 1.8;
        }
        manuscript = await createManuscriptModel(mats);
        core.add(manuscript.root);
        dock = manuscript.dock;
        scene.add(dock);
        orbitals = new T.Group();
        scene.add(orbitals);
        const floatingDecors = createFloatingDecorations(mats, opticalMap);
        orbitals.add(floatingDecors.group);
        groups.floatingDecors = floatingDecors;
        groups.manuscript = manuscript.root;
        const shadowCanvas = document.createElement("canvas");
        shadowCanvas.width = shadowCanvas.height = 128;
        const ctx = shadowCanvas.getContext("2d"),
          grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
        grad.addColorStop(0, "rgba(31,9,2,1)");
        grad.addColorStop(0.6, "rgba(31,9,2,.8)");
        grad.addColorStop(0.82, "rgba(31,9,2,.25)");
        grad.addColorStop(1, "rgba(52,21,8,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);
        const shadowTex = new T.CanvasTexture(shadowCanvas);
        shadow = new T.Mesh(
          new T.PlaneGeometry(3.5, 2.15),
          new T.MeshBasicMaterial({
            map: shadowTex,
            transparent: true,
            depthWrite: false,
            opacity: 0.8,
          }),
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = -1.81;
        scene.add(shadow);
        const hemi = new T.HemisphereLight("#fff9ed", "#65433b", 0.6);
        scene.add(hemi);
        const key = new T.DirectionalLight("#fff4df", 1.35);
        key.position.set(-3, 5, 6);
        scene.add(key);
        const rim = new T.DirectionalLight("#d5fff5", 0.65);
        rim.position.set(5, 1, -4);
        scene.add(rim);
        const warm = new T.DirectionalLight("#ffb786", 0.25);
        warm.position.set(-2, -3, 3);
        scene.add(warm);
        const opticalLight = new T.PointLight("#b2fff3", 1.3, 9, 1.5);
        opticalLight.position.set(-1.7, 2.8, 3.3);
        scene.add(opticalLight);
        renderer.domElement.addEventListener("webglcontextlost", () => {
          modelReady = false;
          heroContainer.classList.remove("loaded");
          art.classList.remove("live");
          setHeroLoadingStatus("Interactive manuscript is restoring…", "error");
        });
        renderer.domElement.addEventListener("webglcontextrestored", () =>
          location.reload(),
        );
        resizeScene();
        modelReady = true;
        dirty = renderDirty = true;
      } catch (e) {
        heroContainer.dataset.error = "true";
        setHeroLoadingStatus(
          "Interactive manuscript unavailable. Please refresh to try again.",
          "error",
        );
        console.warn("3D view unavailable.", e.message);
      }
    }
    initScene();
    const vis = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.target === hero) heroInside = e.isIntersecting;
        }
        renderVisible = heroInside;
        dirty = renderDirty = true;
      },
      { rootMargin: "100px" },
    );
    vis.observe(hero);
    function setVar(el, key, value) {
      el.style.setProperty(key, value);
    }
    const heroCopy = $(".hero-copy"),
      heroChapter = $(".hero-chapter"),
      heroGhost = $(".hero-ghost"),
      portal = $(".hero-portal"),
      portalContent = $(".hero-portal-content"),
      heroNotes = $$(".hero .float-note"),
      toolbar = $(".core-toolbar"),
      heroEyebrow = $("#hero-chapter-label"),
      ticks = $$(".chapter-ticks b");
    let animFrameId = null;
    let isDestroyed = false;

    function updateLayout() {
      if (isDestroyed || !hero || !document.body.contains(hero)) return;
      const y = scrollY,
        h = innerHeight,
        mobile = innerWidth < 761 || (innerWidth <= 900 && innerHeight >= 850),
        hr = hero.getBoundingClientRect();
      heroProgress = reduced
        ? 0
        : clamp(
            -hr.top / Math.max(1, hero.offsetHeight - heroStage.offsetHeight),
          );
      const p = heroProgress;
      const inHero = hr.bottom > h * 0.55 && hr.top <= 0;
      const header = $("#header");
      if (header) {
        header.classList.toggle("scrolled", y > 130);
        header.classList.toggle("hero-nav", inHero && y > 130 && p < 0.84);
      }
      const backTop = $(".back-top");
      if (backTop) {
        backTop.classList.toggle("show", y > h);
      }
      const scrollProgress = $(".scroll-progress");
      if (scrollProgress) {
        scrollProgress.style.transform =
          "scaleX(" +
          clamp(y / Math.max(1, document.documentElement.scrollHeight - h)) +
          ")";
      }
      const leave = smooth(0.05, 0.3, p),
        chapterIn = smooth(0.24, 0.39, p),
        chapterOut = smooth(0.64, 0.78, p),
        portalOpen = smooth(0.78, 0.985, p),
        portalText = smooth(0.8, 0.93, p);
      heroCopy.style.transform = `translate3d(0,${-leave * 100}px,${-leave * 170}px) rotateX(${leave * 8}deg)`;
      heroCopy.style.opacity = 1 - leave;
      heroCopy.style.visibility = leave >= 0.999 ? "hidden" : "visible";
      heroCopy.style.pointerEvents = leave > 0.5 ? "none" : "";
      heroChapter.style.opacity = chapterIn * (1 - chapterOut);
      heroChapter.style.transform = `translate3d(${(1 - chapterIn) * -45}px,${-chapterOut * 80}px,0)`;
      heroChapter.setAttribute(
        "aria-hidden",
        chapterIn < 0.8 || chapterOut > 0.5,
      );
      heroGhost.style.opacity = chapterIn * (1 - chapterOut) * 0.65;
      heroGhost.style.transform = `translate3d(${-p * 14}%,0,0)`;
      heroNotes.forEach((n, i) => {
        n.style.opacity = 1 - smooth(0.08, 0.26, p);
        n.style.translate = `${(i ? 1 : -1) * leave * 75}px ${-leave * (i ? 45 : 75)}px`;
      });
      $(".hero-note").style.opacity = 1 - leave;
      setVar($(".hero-orbits"), "--orbit-turn", p * 140 + "deg");
      $(".hero-orbits").style.opacity = 1 - portalOpen;
      heroContainer.style.translate = `${mobile ? 0 : -smooth(0.62, 0.82, p) * innerWidth * 0.12}px ${-smooth(0.14, 0.45, p) * (mobile ? 5 : 25)}px`;
      heroContainer.style.scale =
        1 + smooth(0.57, 0.88, p) * (mobile ? 0.16 : 0.28);
      portal.style.clipPath = `circle(${portalOpen * 125}% at ${mobile ? "50% 62%" : "72% 46%"})`;
      portalContent.style.opacity = portalText;
      portalContent.style.transform = `translateY(${(1 - portalText) * 45}px)`;
      portal.setAttribute("aria-hidden", portalText < 0.8);
      toolbar.style.opacity = 1 - smooth(0.66, 0.79, p);
      toolbar.style.visibility = p > 0.79 ? "hidden" : "visible";
      heroContainer.tabIndex = p > 0.79 ? -1 : 0;
      $(".hero-foot").style.opacity = 1 - smooth(0.78, 0.87, p);
      heroEyebrow.textContent =
        p < 0.3
          ? "01 / MEET VIRASYA"
          : p < 0.72
            ? "02 / A LITTLE LOOK INSIDE"
            : "03 / MAKE ROOM FOR BRILLIANT";
      ticks.forEach(
        (b, i) => (b.style.transform = `scaleX(${clamp(p * 3 - i + 0.08)})`),
      );
      if (!reduced) {
        $$(".trust-row").forEach((n) => {
          const q = clamp((h - n.getBoundingClientRect().top) / (h * 0.42));
          setVar(n, "--trust-wipe", (1 - q) * 100 + "%");
          setVar(n, "--trust-x", (1 - q) * -30 + "px");
        });
        const closing = $(".closing"),
          cr = closing.getBoundingClientRect(),
          cp = clamp((h - cr.top) / (h * 0.7));
        setVar(closing, "--closing-inset", (1 - cp) * 6 + "%");
        setVar(closing, "--closing-radius", (1 - cp) * 50 + "px");
        setVar(
          footerWord,
          "--footer-rise",
          clamp(
            (footerWord.getBoundingClientRect().top - h * 0.6) * 0.16,
            0,
            70,
          ) + "px",
        );
        setVar(footerWord, "--footer-turn", (1 - cp) * -40 + "deg");
      } else {
        setVar(footerWord, "--footer-rise", "0px");
      }
      dirty = false;
      renderDirty = true;
    }
    function tick(t) {
      if (isDestroyed || !document.getElementById("hero-scene")) {
        animFrameId = null;
        return;
      }
      animFrameId = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (dirty) updateLayout();
      if (
        !document.getElementById("hero-scene") ||
        !renderer ||
        !modelReady ||
        !renderVisible ||
        heroProgress > 0.99
      )
        return;
      const moving =
        Math.abs(dragPX - dragX) +
          Math.abs(dragPY - dragY) +
          Math.abs(openAmount - (exploded ? 1 : 0)) >
        0.002;
      if (reduced && !renderDirty && !moving && frameAfterResize > 1) return;
      const dt = lastFrameTime ? Math.min(t - lastFrameTime, 60) : 16;
      lastFrameTime = t;
      avgFrame = avgFrame * 0.96 + dt * 0.04;
      const ease = reduced ? 1 : 1 - Math.exp(-dt / 110);
      px += (mouseX - px) * ease;
      py += (mouseY - py) * ease;
      dragPX += (dragX - dragPX) * ease;
      dragPY += (dragY - dragPY) * ease;
      const p = heroProgress,
        heroPoseIsPristine =
          p === 0 && !dragX && !dragY && !exploded && !openAmount,
        breath =
          reduced || heroPoseIsPristine
            ? 0
            : Math.sin(t * 0.0008) * 0.028,
        scrollOpen =
          smooth(0.2, 0.45, p) * (1 - smooth(0.64, 0.82, p));
      const targetOpen =
        manualOpen !== null ? (manualOpen ? 1 : 0) : scrollOpen;
      openAmount += (targetOpen - openAmount) * ease;
      const open = openAmount;
      if (exploded !== open > 0.5) {
        exploded = open > 0.5;
        $$("[data-explode]").forEach((b) => {
          b.setAttribute("aria-pressed", exploded);
          $(".explode-label", b).textContent = exploded
            ? "Close the core"
            : "Open the core";
        });
      }
      const aspect = camera.aspect;
      core.scale.set(
        HERO_BASE_POSE.scale.x,
        HERO_BASE_POSE.scale.y,
        HERO_BASE_POSE.scale.z,
      );
      let distance =
        (innerWidth < 761 ? 11.0 : 10.1) *
        Math.max(1, (innerWidth < 761 ? 1.13 : 0.9) / aspect);
      distance -= smooth(0.6, 0.86, p) * 0.65;
      camera.position.set(0, HERO_BASE_POSE.cameraY ?? 0.82, distance);
      camera.lookAt(0, HERO_BASE_POSE.lookAtY ?? -0.92, 0);
      const hoverX = pointerInteracted ? px : 0,
        hoverY = pointerInteracted ? py : 0;
      core.rotation.set(
        HERO_BASE_POSE.rotation.x + hoverY + dragPY,
        HERO_BASE_POSE.rotation.y +
          hoverX +
          dragPX -
          smooth(0.15, 0.45, p) * 0.34 +
          smooth(0.56, 0.82, p) * 1.3,
        HERO_BASE_POSE.rotation.z + breath,
      );
      core.position.set(
        0,
        (HERO_BASE_POSE.coreY ?? 0.35) + 0.40 +
          smooth(0.15, 0.55, p) * 0.2 +
          (heroPoseIsPristine || reduced ? 0 : Math.sin(t * 0.001) * 0.045),
        0,
      );
      dock.visible = p < 0.36;
      shadow.visible = p < 0.5;
      dock.rotation.y = -0.32;
      dock.position.y = -smooth(0.15, 0.58, p) * 2.6;
      shadow.material.opacity = 0.8 * (1 - smooth(0.15, 0.5, p));
      orbitals.position.copy(core.position);
      orbitals.scale.setScalar(0.82);
      orbitals.rotation.set(0, dragPX * 0.12, breath * 0.8);
      groups.floatingDecors?.update(t, open, reduced);
      manuscript.update(open);
      const drawStart = performance.now();
      renderer.render(scene, camera);
      revealHeroScene();
      renderMs = renderMs * 0.95 + (performance.now() - drawStart) * 0.05;
      frameCount++;
      totalFrames++;
      frameAfterResize++;
      renderDirty = false;
      if (
        frameCount % 240 === 0 &&
        avgFrame > 29 &&
        renderer.getPixelRatio() > 1
      ) {
        renderer.setPixelRatio(Math.max(1, renderer.getPixelRatio() * 0.85));
        resizeScene();
      }
      if (t - lastMetrics > 500) {
        lastMetrics = t;
        host.dataset.frames = totalFrames;
        host.dataset.frameMs = avgFrame.toFixed(1);
        host.dataset.renderMs = renderMs.toFixed(2);
        host.dataset.view = activeView;
        host.dataset.progress = p.toFixed(3);
        host.dataset.rotation = dragPX.toFixed(2) + "," + dragPY.toFixed(2);
        host.dataset.exploded = (open > 0.5).toString();
      }
    }
    animFrameId = requestAnimationFrame(tick);

    function destroy() {
      isDestroyed = true;
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
      window.removeEventListener("scroll", scrollHandler);
      window.removeEventListener("resize", resizeHandler);
      document.removeEventListener("visibilitychange", visibilityHandler);
      try {
        motionQuery.removeEventListener("change", handleMotionChange);
      } catch {}
      observer.disconnect();
      if (renderer) {
        try {
          renderer.dispose();
          if (renderer.domElement && renderer.domElement.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
          }
        } catch {}
      }
    }
    return destroy;
  })();
}
