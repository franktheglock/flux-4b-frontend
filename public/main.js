document.addEventListener("DOMContentLoaded", () => {
  const HISTORY_KEY = "flux_history_v2";
  const MAX_HISTORY_ITEMS = 12;

  const refs = {
    resultsPanel: document.getElementById("results-panel"),
    btnT2I: document.getElementById("btn-t2i"),
    btnI2I: document.getElementById("btn-i2i"),
    initImageGroup: document.getElementById("init-image-group"),
    refImageGroup: document.getElementById("ref-image-group"),
    t2iOnlyEls: document.querySelectorAll(".t2i-only"),
    prompt: document.getElementById("prompt"),
    width: document.getElementById("width"),
    height: document.getElementById("height"),
    steps: document.getElementById("steps"),
    guidance: document.getElementById("guidance"),
    seed: document.getElementById("seed"),
    uploadArea: document.getElementById("upload-area"),
    fileInput: document.getElementById("image-upload"),
    uploadPreview: document.getElementById("upload-preview"),
    clearUploadBtn: document.getElementById("clear-upload"),
    refUploadArea: document.getElementById("ref-upload-area"),
    refFileInput: document.getElementById("ref-image-upload"),
    refUploadPreview: document.getElementById("ref-upload-preview"),
    clearRefUploadBtn: document.getElementById("clear-ref-upload"),
    generateBtn: document.getElementById("generate-btn"),
    btnText: document.querySelector("#generate-btn .btn-text"),
    spinner: document.querySelector("#generate-btn .spinner"),
    resultPlaceholder: document.getElementById("result-placeholder"),
    resultEmpty: document.getElementById("result-empty"),
    resultLoading: document.getElementById("result-loading"),
    resultLoadingMeta: document.getElementById("result-loading-meta"),
    resultContainer: document.getElementById("result-container"),
    resultImage: document.getElementById("result-image"),
    downloadBtn: document.getElementById("download-btn"),
    fullscreenBtn: document.getElementById("fullscreen-btn"),
    galleryGrid: document.getElementById("gallery-grid"),
    clearHistoryBtn: document.getElementById("clear-history"),
    modal: document.getElementById("fullscreen-modal"),
    modalImage: document.getElementById("modal-image"),
    closeModalBtn: document.getElementById("close-modal"),
    toast: document.getElementById("error-toast"),
    toastMsg: document.getElementById("toast-message"),
    statusOverlay: document.getElementById("model-status-overlay"),
    statusMsg: document.getElementById("status-message"),
    stepsInfoBtn: document.getElementById("steps-info-btn"),
    stepsHint: document.getElementById("steps-hint"),
    closeStepsHint: document.getElementById("close-steps-hint"),
    variations: document.getElementById("variations"),
    variationsGrid: document.getElementById("variations-grid"),
    stepProgressFill: document.getElementById("step-progress-fill"),
    stepCounter: document.getElementById("step-counter"),
  };

  const STEPS_HINT_THRESHOLD = 8;
  let currentMode = "t2i";
  let selectedFile = null;
  let selectedRefFile = null;
  let toastTimeout;
  let history = loadHistory();

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .slice(0, MAX_HISTORY_ITEMS)
        .map((entry) => ({
          ...entry,
          id: entry.id || entry.timestamp,
        }));
    } catch {
      return [];
    }
  }

  function persistHistory() {
    const save = () => {
      // Omit the full 'image' base64 to avoid blowing up localStorage quota (5MB limit)
      const toSave = history.map(({ image, ...rest }) => rest);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(toSave.slice(0, MAX_HISTORY_ITEMS)));
      } catch {
        // Fallback for extreme cases (e.g. huge thumbs)
        const smaller = toSave.slice(0, Math.max(4, MAX_HISTORY_ITEMS - 4));
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(smaller));
        } catch {
          localStorage.removeItem(HISTORY_KEY);
        }
      }
    };

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(save, { timeout: 800 });
    } else {
      setTimeout(save, 0);
    }
  }

  /* IndexedDB helpers to store full-size images (avoids localStorage quota issues) */
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open("flux_history_db", 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("images")) {
            db.createObjectStore("images", { keyPath: "id" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (err) {
        dbPromise = null;
        reject(err);
      }
    });
    return dbPromise;
  }

  async function saveImageToDB(id, dataUrl) {
    try {
      const db = await openDB();
      const tx = db.transaction("images", "readwrite");
      const store = tx.objectStore("images");
      store.put({ id, dataUrl });
      return tx.complete || new Promise((res) => (tx.oncomplete = res));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async function getImageFromDB(id) {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("images", "readonly");
        const store = tx.objectStore("images");
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result ? req.result.dataUrl : null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function clearImagesFromDB() {
    try {
      const db = await openDB();
      const tx = db.transaction("images", "readwrite");
      const store = tx.objectStore("images");
      store.clear();
      return tx.complete || new Promise((res) => (tx.oncomplete = res));
    } catch {
      return null;
    }
  }

  /* Create a small JPEG thumbnail from a data URL to keep localStorage small */
  function createThumbnail(dataUrl, maxSize = 420, quality = 0.7) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const { width, height } = img;
        let w = width;
        let h = height;
        if (Math.max(w, h) > maxSize) {
          if (w > h) {
            h = Math.round((h * maxSize) / w);
            w = maxSize;
          } else {
            w = Math.round((w * maxSize) / h);
            h = maxSize;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#07111f";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const thumb = canvas.toDataURL("image/jpeg", quality);
        resolve(thumb);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function setMode(mode) {
    currentMode = mode;
    refs.btnT2I.classList.toggle("active", mode === "t2i");
    refs.btnI2I.classList.toggle("active", mode === "i2i");
    refs.initImageGroup.classList.toggle("hidden", mode === "t2i");
    refs.refImageGroup.classList.toggle("hidden", mode === "t2i");
    refs.t2iOnlyEls.forEach((el) => el.classList.toggle("hidden", mode !== "t2i"));
  }

  function updateRangeDisplays() {
    ["steps", "guidance", "variations"].forEach((id) => {
      const input = refs[id];
      const output = document.getElementById(`val-${id}`);
      if (!input || !output) return;
      output.textContent = input.value;
      input.addEventListener("input", (event) => {
        output.textContent = event.target.value;
        if (id === "steps") {
          maybeShowStepsHint(event.target.value);
        }
      });
    });
    maybeShowStepsHint(refs.steps?.value);

    // Sync width/height sliders and number inputs
    ["width", "height"].forEach((id) => {
      const slider = refs[id];
      const numInput = document.getElementById(`num-${id}`);
      if (!slider || !numInput) return;

      const clearActiveChips = () => {
        document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
      };

      // When slider moves, update the number box
      slider.addEventListener("input", (e) => {
        numInput.value = e.target.value;
        clearActiveChips();
      });

      // When number box changes, update slider (and keep within bounds/step if possible)
      numInput.addEventListener("change", (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val)) val = parseInt(slider.min, 10);
        
        // Clamp it strictly
        val = Math.max(slider.min, Math.min(slider.max, val));
        
        numInput.value = val;
        slider.value = val;
        clearActiveChips();
      });
    });

    let currentRatio = 1.0;
    let currentArea = 1048576; // 1MP default (1024x1024)

    function applyDimensions() {
      let h = Math.sqrt(currentArea / currentRatio);
      let w = currentArea / h;
      
      // Round to nearest 64 (FLUX optimization)
      w = Math.round(w / 64) * 64;
      h = Math.round(h / 64) * 64;
      
      // Hard clamp bounds
      w = Math.min(4096, Math.max(256, w));
      h = Math.min(4096, Math.max(256, h));

      if (refs.width) { refs.width.value = w; document.getElementById("num-width").value = w; }
      if (refs.height) { refs.height.value = h; document.getElementById("num-height").value = h; }
    }

    // Aspect Ratio chips logic
    document.querySelectorAll("#aspect-ratio-chips .preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#aspect-ratio-chips .preset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentRatio = parseFloat(btn.getAttribute("data-ratio"));
        applyDimensions();
      });
    });

    // Resolution (Megapixel) chips logic
    document.querySelectorAll("#resolution-chips .preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#resolution-chips .preset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentArea = parseFloat(btn.getAttribute("data-area"));
        applyDimensions();
      });
    });
  }

  function openStepsHint() {
    if (!refs.stepsHint) return;
    refs.stepsHint.classList.remove("hidden");
  }

  function closeStepsHint() {
    if (!refs.stepsHint) return;
    refs.stepsHint.classList.add("hidden");
  }

  function maybeShowStepsHint(value) {
    if (!refs.stepsHint) return;
    if (Number(value) > STEPS_HINT_THRESHOLD && refs.stepsHint.classList.contains("hidden")) {
      openStepsHint();
    }
  }

  function setGenerateState(isLoading) {
    refs.generateBtn.disabled = isLoading;
    refs.btnText.textContent = isLoading ? "Generating..." : "Generate Image";
    refs.spinner.classList.toggle("hidden", !isLoading);
  }

  function showIdleState() {
    refs.resultsPanel.dataset.state = "idle";
  }

  // Steps hint popup
  if (refs.stepsInfoBtn) {
    refs.stepsInfoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openStepsHint();
    });
  }
  if (refs.closeStepsHint) {
    refs.closeStepsHint.addEventListener("click", () => {
      closeStepsHint();
    });
  }
  // Close popup on outside click
  document.addEventListener("click", (e) => {
    if (!refs.stepsHint || refs.stepsHint.classList.contains("hidden")) return;
    if (!refs.stepsHint.contains(e.target) && e.target !== refs.stepsInfoBtn) {
      closeStepsHint();
    }
  });

  function showLoadingState(message = "Starting up…") {
    refs.resultsPanel.dataset.state = "loading";
    refs.resultLoadingMeta.textContent = message;
    
    // Reset step progress
    if (refs.stepProgressFill) refs.stepProgressFill.style.width = "0%";
    if (refs.stepCounter) refs.stepCounter.textContent = "Step 0 / 0";
  }

  async function showResultImage(src, variations = []) {
    showLoadingState("Decoding…");

    // Clear and hide variations grid if single image
    if (variations.length <= 1) {
      refs.variationsGrid.classList.add("hidden");
      refs.variationsGrid.innerHTML = "";
      refs.resultImage.classList.remove("hidden");
      refs.resultImage.src = src;
    } else {
      // Show variations grid
      refs.resultImage.classList.add("hidden");
      refs.variationsGrid.classList.remove("hidden");
      refs.variationsGrid.innerHTML = "";
      
      variations.forEach(vSrc => {
        const vImg = document.createElement("img");
        vImg.src = vSrc;
        vImg.className = "variation-img";
        vImg.onclick = () => {
          // Allow clicking a variation to make it the "main" one
          showResultImage(vSrc);
        };
        refs.variationsGrid.appendChild(vImg);
      });
      // Set the first variation as the "active" one for the download/fullscreen buttons
      refs.resultImage.src = variations[0];
    }

    try {
      const targetImg = variations.length <= 1 ? refs.resultImage : { decode: () => Promise.resolve() };
      if (typeof targetImg.decode === "function") {
        await targetImg.decode();
      } else {
        await new Promise((resolve, reject) => {
          targetImg.onload = resolve;
          targetImg.onerror = reject;
        });
      }
    } catch {
      // Continue and reveal the image even if decode is unavailable.
    }

    refs.resultsPanel.dataset.state = "result";
    refs.resultImage.alt = "Generated result";
  }

  function buildHistoryItem(item, index) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "gallery-item";
    card.setAttribute("aria-label", `Open history image ${index + 1}`);
    card.innerHTML = `
      <img src="${item.thumb || item.image}" alt="History image ${index + 1}" loading="lazy" decoding="async">
      <div class="gallery-overlay">
        <div class="gallery-info">
          <p class="history-mode">${item.mode === "i2i" ? "Image edit" : "Text render"}</p>
          <p class="history-prompt">${escapeHtml(item.prompt)}</p>
          <div class="history-meta">
            <span>${item.size}</span>
            <span>Steps ${item.steps}</span>
            <span>Guidance ${item.guidance}</span>
            ${item.seed !== "-1" ? `<span>Seed ${item.seed}</span>` : ""}
          </div>
        </div>
      </div>
    `;

    card.addEventListener("click", async () => {
      // Try to load the full image from IndexedDB; fall back to the thumbnail if absent
      let full = null;
      if (item.id) {
        try {
          full = await getImageFromDB(item.id);
        } catch (err) {
          console.warn("Could not retrieve full resolution image:", err);
          full = null;
        }
      }
      // If we found the full image, use it, otherwise use the original item.image or item.thumb
      await showResultImage(full || item.image || item.thumb);
      refs.resultContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    return card;
  }

  function renderHistory() {
    refs.galleryGrid.textContent = "";

    if (history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gallery-empty";
      empty.textContent = "No history yet";
      refs.galleryGrid.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    history.forEach((item, index) => fragment.appendChild(buildHistoryItem(item, index)));
    refs.galleryGrid.appendChild(fragment);
  }

  function addHistoryItem(item) {
    history.unshift(item);
    history = history.slice(0, MAX_HISTORY_ITEMS);
    renderHistory();
    persistHistory();
  }

  function showToast(message) {
    refs.toastMsg.textContent = message;
    refs.toast.classList.remove("hidden");

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      refs.toast.classList.add("hidden");
    }, 3200);
  }

  function attachUploadBehavior({ area, input, preview, clearButton, onSelect }) {
    area.addEventListener("click", (event) => {
      const icon = clearButton.querySelector("i");
      if (event.target !== clearButton && event.target !== icon) {
        input.click();
      }
    });

    input.addEventListener("change", (event) => {
      if (event.target.files?.length) {
        handleSelection(event.target.files[0]);
      }
    });

    area.addEventListener("dragover", (event) => {
      event.preventDefault();
      area.classList.add("dragover");
    });

    area.addEventListener("dragleave", () => area.classList.remove("dragover"));

    area.addEventListener("drop", (event) => {
      event.preventDefault();
      area.classList.remove("dragover");
      if (event.dataTransfer.files?.length) {
        handleSelection(event.dataTransfer.files[0]);
      }
    });

    clearButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(null);
      input.value = "";
      preview.src = "";
      preview.classList.add("hidden");
      clearButton.classList.add("hidden");
    });

    function handleSelection(file) {
      if (!file.type.startsWith("image/")) {
        showToast("Please upload an image file.");
        return;
      }

      onSelect(file);
      const reader = new FileReader();
      reader.onload = (event) => {
        preview.src = event.target.result;
        preview.classList.remove("hidden");
        clearButton.classList.remove("hidden");
      };
      reader.readAsDataURL(file);
    }
  }

  function getRequestSettings() {
    const settings = {
      prompt: (refs.prompt?.value || "").trim(),
      steps: refs.steps?.value || "50",
      guidance: refs.guidance?.value || "7.5",
      seed: refs.seed?.value || "-1",
      width: refs.width?.value || "1024",
      height: refs.height?.value || "1024",
      variations: refs.variations?.value || "1",
      mode: currentMode,
    };
    return settings;
  }

  async function handleGenerate() {
    const settings = getRequestSettings();

    if (!settings.prompt) {
      showToast("Please enter a prompt.");
      return;
    }

    if (settings.mode === "i2i" && !selectedFile) {
      showToast("Please upload a conditioning image for Image to Image.");
      return;
    }

    const formData = new FormData();
    formData.append("prompt", settings.prompt);
    formData.append("num_inference_steps", settings.steps || "50");
    formData.append("guidance_scale", settings.guidance || "3.5");
    formData.append("seed", settings.seed || "-1");
    formData.append("num_images_per_prompt", refs.variations.value);

    let endpoint = "/api/generate";

    if (settings.mode === "t2i") {
      formData.append("width", settings.width || "1024");
      formData.append("height", settings.height || "1024");
    } else {
      endpoint = "/api/edit";
      formData.append("image", selectedFile);
      if (selectedRefFile) {
        formData.append("reference_image", selectedRefFile);
      }
    }

    setGenerateState(true);
    showLoadingState(
      settings.mode === "i2i"
        ? "Encoding reference image…"
        : "Initialising latent noise…"
    );

    // Progress polling logic
    let progressInterval = setInterval(async () => {
      try {
        const statusRes = await fetch("/api/model-status");
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (status.is_generating && status.progress) {
            const { step, total } = status.progress;
            const percent = total > 0 ? Math.min(Math.round((step / total) * 100), 99) : 0;
            
            showLoadingState(`Sampling… ${percent}%`);
            if (refs.stepProgressFill) refs.stepProgressFill.style.width = `${percent}%`;
            if (refs.stepCounter) refs.stepCounter.textContent = `Step ${step} / ${total}`;
          } else if (status.loading) {
            showLoadingState(status.message || "Working...");
          }
        }
      } catch (err) {
        console.warn("Progress poll failed:", err);
      }
    }, 1000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      clearInterval(progressInterval);

      if (data.status !== "success") {
        throw new Error(data.message || "Failed to generate image");
      }

      // Update progress one last time for completeness
      if (refs.stepProgressFill) refs.stepProgressFill.style.width = "100%";

      const mainImage = data.images && data.images.length > 0 ? data.images[0] : data.image;
      const variations = data.images || [];

      await showResultImage(mainImage, variations);

      // Store main full image in IndexedDB and keep a compressed thumbnail in localStorage
      const ts = Date.now();
      const thumb = await createThumbnail(mainImage, 420, 0.72);
      try {
        await saveImageToDB(ts, mainImage);
      } catch (err) {
        console.warn("Failed to save full image to IndexedDB:", err);
      }

      addHistoryItem({
        thumb: thumb || mainImage,
        image: mainImage, // Keep original high-res in the metadata object for fallback
        id: ts,
        prompt: settings.prompt,
        steps: settings.steps,
        guidance: settings.guidance,
        seed: settings.seed,
        mode: settings.mode,
        size: settings.mode === "t2i" ? `${settings.width}×${settings.height}` : "image-conditioned",
        timestamp: ts,
      });
    } catch (error) {
      clearInterval(progressInterval);
      console.error(error);
      showToast(error.message || "Something went wrong.");
      showIdleState();
    } finally {
      setGenerateState(false);
    }
  }

  async function pollModelStatus() {
    try {
      const response = await fetch("/api/model-status");
      const data = await response.json();

      if (data.status === "ready") {
        refs.statusOverlay.classList.add("hidden");
        return;
      }

      if (data.status === "error") {
        refs.statusMsg.textContent = `Error: ${data.message}`;
        refs.statusMsg.style.color = "var(--destructive)";
        return;
      }

      refs.statusOverlay.classList.remove("hidden");
      refs.statusMsg.textContent = data.message || "Downloading model assets...";
      setTimeout(pollModelStatus, 3000);
    } catch (error) {
      console.error("Failed to fetch model status:", error);
      setTimeout(pollModelStatus, 5000);
    }
  }

  refs.btnT2I.addEventListener("click", () => setMode("t2i"));
  refs.btnI2I.addEventListener("click", () => setMode("i2i"));
  refs.generateBtn.addEventListener("click", handleGenerate);

  refs.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!refs.generateBtn.disabled && refs.prompt.value.trim()) {
        handleGenerate();
      }
    }
  });

  refs.downloadBtn.addEventListener("click", () => {
    const anchor = document.createElement("a");
    anchor.href = refs.resultImage.src;
    anchor.download = `flux-4b-${Date.now()}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  });

  refs.fullscreenBtn.addEventListener("click", () => {
    refs.modalImage.src = refs.resultImage.src;
    refs.modal.classList.remove("hidden");
  });

  refs.closeModalBtn.addEventListener("click", () => refs.modal.classList.add("hidden"));
  refs.modal.addEventListener("click", (event) => {
    if (event.target === refs.modal) {
      refs.modal.classList.add("hidden");
    }
  });

  refs.clearHistoryBtn.addEventListener("click", () => {
    if (!history.length || !confirm("Clear image history?")) {
      return;
    }

    (async () => {
      history = [];
      localStorage.removeItem(HISTORY_KEY);
      try {
        await clearImagesFromDB();
      } catch (err) {
        // ignore
      }
      renderHistory();
    })();
  });

  attachUploadBehavior({
    area: refs.uploadArea,
    input: refs.fileInput,
    preview: refs.uploadPreview,
    clearButton: refs.clearUploadBtn,
    onSelect: (file) => {
      selectedFile = file;
    },
  });

  attachUploadBehavior({
    area: refs.refUploadArea,
    input: refs.refFileInput,
    preview: refs.refUploadPreview,
    clearButton: refs.clearRefUploadBtn,
    onSelect: (file) => {
      selectedRefFile = file;
    },
  });

  updateRangeDisplays();
  setMode("t2i");
  showIdleState();
  renderHistory();
  pollModelStatus();
  feather.replace();
});
