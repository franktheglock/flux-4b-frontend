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
    resultMeta: document.getElementById("result-meta"),
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
    statusTitle: document.getElementById("status-title"),
    statusMsg: document.getElementById("status-message"),
    statusHardware: document.getElementById("status-hardware"),
    statusProgressBar: document.getElementById("status-progress-bar"),
    statusTerminal: document.getElementById("status-terminal"),
    variantBadge: document.getElementById("variant-badge"),
    variantSelect: document.getElementById("model-variant"),
    downloadPrompt: document.getElementById("download-prompt"),
    downloadModelList: document.getElementById("download-model-list"),
    terminalContent: document.getElementById("terminal-content"),
    stepsInfoBtn: document.getElementById("steps-info-btn"),
    stepsHint: document.getElementById("steps-hint"),
    closeStepsHint: document.getElementById("close-steps-hint"),
    variations: document.getElementById("variations"),
    variationsGrid: document.getElementById("variations-grid"),
    stepProgressFill: document.getElementById("step-progress-fill"),
    stepCounter: document.getElementById("step-counter"),
    expandGalleryBtn: document.getElementById("expand-gallery"),
    galleryModal: document.getElementById("gallery-modal"),
    galleryModalGrid: document.getElementById("gallery-modal-grid"),
    closeGalleryModalBtn: document.getElementById("close-gallery-modal"),
    galleryLightbox: document.getElementById("gallery-lightbox"),
    lightboxImg: document.getElementById("lightbox-img"),
    lightboxPrompt: document.getElementById("lightbox-prompt"),
    lightboxPrev: document.getElementById("lightbox-prev"),
    lightboxNext: document.getElementById("lightbox-next"),
    lightboxClose: document.getElementById("lightbox-close"),
    lightboxDownload: document.getElementById("lightbox-download"),
    lightboxEdit: document.getElementById("lightbox-edit"),
  };

  const STEPS_HINT_THRESHOLD = 8;
  let currentMode = "t2i";
  let selectedFile = null;
  let selectedRefFile = null;
  let toastTimeout;
  let history = loadHistory();
  let modelDownloadPending = false;
  let lastDownloadVariants = [];

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
          id: entry.id ? String(entry.id) : String(entry.timestamp),
        }));
    } catch {
      return [];
    }
  }

  function persistHistory() {
    const save = () => {
      // Ensure we don't save large images to localStorage
      const toSave = history.map((item) => {
        // Create a copy without the large image
        const cleanItem = { ...item };
        delete cleanItem.image;
        
        // If thumb is somehow missing but we have an image in memory (shouldn't happen with new logic), 
        // we'd have a problem, but new logic sets image: null explicitly.
        return cleanItem;
      });
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(toSave.slice(0, MAX_HISTORY_ITEMS)));
      } catch {
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

  async function deleteImageFromDB(id) {
    try {
      const db = await openDB();
      const tx = db.transaction("images", "readwrite");
      const store = tx.objectStore("images");
      store.delete(id);
      return tx.complete || new Promise((res) => (tx.oncomplete = res));
    } catch (err) {
      console.warn("Failed to delete image from IndexedDB:", err);
      throw err;
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
    if (refs.resultMeta) refs.resultMeta.textContent = "";
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
    if (refs.resultMeta) refs.resultMeta.textContent = "";
    
    // Reset step progress
    if (refs.stepProgressFill) refs.stepProgressFill.style.width = "0%";
    if (refs.stepCounter) refs.stepCounter.textContent = "Step 0 / 0";
  }

  function describeHardware(hardware = {}) {
    const parts = [];
    if (hardware.gpu_name) {
      parts.push(hardware.gpu_name);
    }
    if (typeof hardware.total_vram_gb === "number") {
      parts.push(`${hardware.total_vram_gb.toFixed(1)} GB VRAM`);
    }
    if (hardware.backend_label) {
      parts.push(hardware.backend_label);
    }
    return parts.join(" • ");
  }

  function setStatusOverlayMode(mode, hardware = null) {
    const isPrompt = mode === "download_required";
    refs.downloadPrompt?.classList.toggle("hidden", !isPrompt);
    refs.statusProgressBar?.classList.toggle("hidden", isPrompt);
    refs.statusTerminal?.classList.toggle("hidden", isPrompt);

    if (refs.statusHardware) {
      const summary = describeHardware(hardware || {});
      refs.statusHardware.textContent = summary;
      refs.statusHardware.classList.toggle("hidden", !summary);
    }
  }

  function formatFitCopy(variant) {
    const fitLabel = variant.fit_label || "VRAM unknown";
    if (typeof variant.estimated_size_gb === "number") {
      return `${fitLabel} for roughly ${variant.estimated_size_gb.toFixed(2)} GB of model weights.`;
    }
    return fitLabel;
  }

  async function requestModelDownload(variantKey) {
    if (modelDownloadPending) return;
    modelDownloadPending = true;
    renderDownloadOptions({ available_variants: lastDownloadVariants });

    try {
      const formData = new FormData();
      formData.append("model_variant", variantKey);
      const response = await fetch("/api/download-model", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Failed to start model download");
      }

      if (refs.statusTitle) refs.statusTitle.textContent = "Downloading Model Assets";
      if (refs.statusMsg) refs.statusMsg.textContent = data.message || "Downloading model assets...";
      setStatusOverlayMode("downloading");
      setTimeout(pollModelStatus, 800);
    } catch (error) {
      modelDownloadPending = false;
      showToast(error.message || "Failed to start model download.");
    }
  }

  function renderDownloadOptions(status) {
    if (!refs.downloadModelList) return;

    const variants = Array.isArray(status.available_variants) ? [...status.available_variants] : [];
    variants.sort((left, right) => {
      const leftSize = typeof left.estimated_size_gb === "number" ? left.estimated_size_gb : Number.POSITIVE_INFINITY;
      const rightSize = typeof right.estimated_size_gb === "number" ? right.estimated_size_gb : Number.POSITIVE_INFINITY;
      return leftSize - rightSize;
    });
    lastDownloadVariants = variants;

    refs.downloadModelList.innerHTML = "";
    const fragment = document.createDocumentFragment();

    variants.forEach((variant) => {
      const card = document.createElement("article");
      card.className = "download-model-card";

      const header = document.createElement("div");
      header.className = "download-model-header";

      const nameWrap = document.createElement("div");
      const name = document.createElement("div");
      name.className = "download-model-name";
      name.textContent = variant.label;
      const size = document.createElement("div");
      size.className = "download-model-size";
      size.textContent = variant.size || "Unknown size";
      nameWrap.append(name, size);

      const fitBadge = document.createElement("span");
      fitBadge.className = `fit-badge ${variant.fit_status || "unknown"}`;
      fitBadge.textContent = variant.fit_label || "VRAM unknown";
      header.append(nameWrap, fitBadge);

      const meta = document.createElement("div");
      meta.className = "download-model-meta";
      meta.textContent = formatFitCopy(variant);

      const action = document.createElement("button");
      action.type = "button";
      action.className = "download-model-action";
      action.dataset.variantKey = variant.key;
      action.textContent = modelDownloadPending ? "Starting Download..." : `Download ${variant.label}`;
      action.disabled = modelDownloadPending;
      action.addEventListener("click", () => requestModelDownload(variant.key));

      card.append(header, meta, action);
      fragment.appendChild(card);
    });

    refs.downloadModelList.appendChild(fragment);
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

    // Store the raw result data so we can edit it later if needed
    refs.resultImage.dataset.rawResult = src;
    refs.resultImage.alt = "Generated result";
  }

  function formatGenerationTime(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      return null;
    }

    const seconds = ms / 1000;
    if (seconds < 10) {
      return `${seconds.toFixed(2)}s`;
    }
    return `${seconds.toFixed(1)}s`;
  }

  function buildHistoryItem(item, index) {
    const card = document.createElement("div");
    card.className = "gallery-item";
    card.setAttribute("role", "button");
    card.tabIndex = 0;
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
            ${item.variationLabel ? `<span>${escapeHtml(item.variationLabel)}</span>` : ""}
            ${item.generationTime ? `<span>Gen ${escapeHtml(item.generationTime)}</span>` : ""}
            ${item.seed !== "-1" ? `<span>Seed ${item.seed}</span>` : ""}
          </div>
        </div>
        <div class="gallery-actions">
          <button type="button" class="history-action-btn delete-btn" title="Remove from history">
            <i data-feather="trash-2"></i>
          </button>
          <button type="button" class="history-action-btn edit-btn" title="Edit this image">
            <i data-feather="edit-2"></i>
          </button>
          <button type="button" class="history-action-btn copy-trigger-btn" title="Copy options">
            <i data-feather="copy"></i>
          </button>
        </div>
        <div class="copy-overlay-centered hidden">
          <button type="button" class="big-copy-btn copy-img-btn" title="Copy Image">
            <i data-feather="image"></i>
            <span>Copy Image</span>
          </button>
          <button type="button" class="big-copy-btn copy-prompt-btn" title="Copy Prompt">
            <i data-feather="type"></i>
            <span>Copy Prompt</span>
          </button>
        </div>
      </div>
    `;

    // Handle clicks on the buttons vs the card itself
    card.addEventListener("click", async (e) => {
      const triggerBtn = e.target.closest(".copy-trigger-btn");
      const copyPromptBtn = e.target.closest(".copy-prompt-btn");
      const copyImgBtn = e.target.closest(".copy-img-btn");
      const editBtn = e.target.closest(".edit-btn");
      const deleteBtn = e.target.closest(".delete-btn");
      const overlay = card.querySelector(".copy-overlay-centered");
      const actions = card.querySelector(".gallery-actions");

      // Toggle copy overlay
      if (triggerBtn) {
        e.stopPropagation();
        overlay.classList.remove("hidden");
        actions.style.display = "none";
        return;
      }

      if (copyPromptBtn) {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(item.prompt);
          
          const originalHTML = copyPromptBtn.innerHTML;
          copyPromptBtn.innerHTML = '<i data-feather="check"></i> <span>Copied!</span>';
          if (typeof feather !== "undefined") feather.replace();
          
          showToast("Prompt copied!");
          
          setTimeout(() => {
            overlay.classList.add("hidden");
            actions.style.display = "flex";
            copyPromptBtn.innerHTML = originalHTML;
            if (typeof feather !== "undefined") feather.replace();
          }, 800);
        } catch (err) {
          showToast("Failed to copy prompt.");
        }
        return;
      }

      if (copyImgBtn) {
        e.stopPropagation();
        try {
          let full = null;
          if (item.diskUrl) {
            full = item.diskUrl;
          } else if (item.id) {
            full = await getImageFromDB(item.id);
          }
          const src = full || item.image || item.thumb;
          
          const response = await fetch(src);
          const blob = await response.blob();
          
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);

          const originalHTML = copyImgBtn.innerHTML;
          copyImgBtn.innerHTML = '<i data-feather="check"></i> <span>Copied!</span>';
          if (typeof feather !== "undefined") feather.replace();

          showToast("Image copied to clipboard!");
          
          setTimeout(() => {
            overlay.classList.add("hidden");
            actions.style.display = "flex";
            copyImgBtn.innerHTML = originalHTML;
            if (typeof feather !== "undefined") feather.replace();
          }, 800);
        } catch (err) {
          console.error("Copy failed", err);
          showToast("Copying failed. Use Download instead.");
        }
        return;
      }

      if (deleteBtn) {
        e.stopPropagation();
        if (!confirm("Remove this image from history?")) return;
        history = history.filter((h) => h.id !== item.id);
        renderHistory();
        persistHistory();
        if (item.id) {
          try { await deleteImageFromDB(item.id); } catch (err) { console.warn("Failed delete:", err); }
        }
        return;
      }

      if (editBtn) {
        e.stopPropagation();
        editHistoryItem(item);
        return;
      }

      // Default: Load history item into main view
      const isCopyOverlayActive = !overlay.classList.contains("hidden");
      if (isCopyOverlayActive) return;

      let full = null;
      if (item.diskUrl) {
        full = item.diskUrl; // Prioritize local disk path
      } else if (item.id) {
        try { full = await getImageFromDB(item.id); } catch (err) { full = null; }
      }
      await showResultImage(full || item.image || item.thumb);
      refs.resultContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    card.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      const activeTag = event.target?.tagName?.toLowerCase();
      if (activeTag === "button" || activeTag === "a" || activeTag === "input") {
        return;
      }

      event.preventDefault();
      await showResultImage(item.diskUrl || item.image || item.thumb);
      refs.resultContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    // Reset when mouse leaves the card entirely
    card.addEventListener("mouseleave", () => {
      const overlay = card.querySelector(".copy-overlay-centered");
      const actions = card.querySelector(".gallery-actions");
      if (overlay) overlay.classList.add("hidden");
      if (actions) actions.style.display = "flex";
    });

    // Final feather refresh for this card
    setTimeout(() => {
      if (typeof feather !== "undefined") feather.replace();
    }, 0);

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
    
    // Refresh icons since we just injected new items
    if (typeof feather !== "undefined") feather.replace();
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

  async function editHistoryItem(item) {
    // 1. Set mode to I2I
    setMode("i2i");

    // 2. Populate basic settings
    if (refs.prompt) refs.prompt.value = item.prompt || "";
    if (refs.steps) {
      refs.steps.value = item.steps || 8;
      document.getElementById("val-steps").textContent = refs.steps.value;
    }
    if (refs.guidance) {
      refs.guidance.value = item.guidance || 3.5;
      document.getElementById("val-guidance").textContent = refs.guidance.value;
    }
    if (refs.seed) refs.seed.value = item.seed || -1;

    // 3. Size (don't set width/height for I2I as model uses image size, but update sliders/inputs for visibility)
    if (item.size) {
      const [w, h] = item.size.split("x").map(n => parseInt(n));
      if (!isNaN(w) && !isNaN(h)) {
        if (refs.width) { refs.width.value = w; document.getElementById("num-width").value = w; }
        if (refs.height) { refs.height.value = h; document.getElementById("num-height").value = h; }
      }
    }

    // 4. Fetch the full-res image from Disk (preferred) or DB
    let full = null;
    if (item.diskUrl) {
      full = item.diskUrl;
    } else if (item.id) {
      try { full = await getImageFromDB(item.id); } catch { /* ignore */ }
    }
    const finalSrc = full || item.thumb || item.image;

    if (finalSrc) {
      // Convert dataURL to File so it works with the existing logic
      const res = await fetch(finalSrc);
      const blob = await res.blob();
      const file = new File([blob], "edited-image.png", { type: "image/png" });
      
      selectedFile = file;
      refs.uploadPreview.src = finalSrc;
      refs.uploadPreview.classList.remove("hidden");
      refs.clearUploadBtn.classList.remove("hidden");
    }

    // 5. Scroll to top and close modal/lightbox
    window.scrollTo({ top: 0, behavior: 'smooth' });
    closeLightbox();
    refs.galleryModal.classList.add("hidden");
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
      modelVariant: refs.variantSelect?.value || "bf16",
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
    formData.append("model_variant", settings.modelVariant || "bf16");

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
      const generationTime = formatGenerationTime(data.generation_time_ms);
      const diskUrls = Array.isArray(data.urls) ? data.urls : [];

      await showResultImage(mainImage, variations);

      if (refs.resultMeta) {
        refs.resultMeta.textContent = generationTime ? `Gen time ${generationTime}` : "";
      }

      const ts = Date.now();
      const historyEntries = [];
      const count = Math.max(variations.length, 1);

      for (let index = count - 1; index >= 0; index -= 1) {
        const imageSrc = variations[index] || mainImage;
        const thumb = await createThumbnail(imageSrc, 420, 0.72);
        const itemId = `${ts}-${index}`;
        try {
          await saveImageToDB(itemId, imageSrc);
        } catch (err) {
          console.warn("Failed to save full image to IndexedDB:", err);
        }

        historyEntries.push({
          thumb: thumb || imageSrc,
          image: null,
          diskUrl: diskUrls[index] || diskUrls[0] || null,
          id: itemId,
          generationTime,
          prompt: settings.prompt,
          steps: settings.steps,
          guidance: settings.guidance,
          seed: settings.seed,
          mode: settings.mode,
          size: settings.mode === "t2i" ? `${settings.width}×${settings.height}` : "image-conditioned",
          timestamp: ts,
          variationLabel: count > 1 ? `Variation ${index + 1} of ${count}` : null,
        });
      }

      historyEntries.forEach((entry) => addHistoryItem(entry));
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
    let logSource = null;
    
    // Connect to SSE log stream
    function connectLogs() {
      if (logSource) return;
      logSource = new EventSource("/api/logs");
      logSource.onmessage = (event) => {
        if (!refs.terminalContent) return;
        const line = document.createElement("div");
        line.textContent = `> ${event.data}`;
        refs.terminalContent.appendChild(line);
        // Autoscroll
        refs.terminalContent.scrollTop = refs.terminalContent.scrollHeight;
      };
      logSource.onerror = () => {
        if (logSource) logSource.close();
        logSource = null;
        setTimeout(connectLogs, 2000);
      };
    }

    try {
      const response = await fetch("/api/model-status");
      const data = await response.json();

      if (data.status === "ready") {
        refs.statusOverlay.classList.add("hidden");
        if (logSource) logSource.close();
        modelDownloadPending = false;
        // Update variant badge
        if (data.selected_variant && refs.variantSelect) {
          refs.variantSelect.value = data.selected_variant;
        }
        if (data.variant_label && refs.variantBadge) {
          refs.variantBadge.textContent = data.variant_label;
          refs.variantBadge.title = `Model: ${data.variant_label} (${data.variant_size})`;
        }
        return;
      }

      // If not ready, ensure logs are connecting
      if (refs.statusOverlay.classList.contains("hidden")) {
        refs.statusOverlay.classList.remove("hidden");
      }

      if (data.status === "download_required") {
        if (logSource) {
          logSource.close();
          logSource = null;
        }
        modelDownloadPending = false;
        if (refs.statusTitle) refs.statusTitle.textContent = "Choose a Model to Download";
        refs.statusMsg.textContent = data.message || "Choose a model to download.";
        setStatusOverlayMode("download_required", data.hardware);
        renderDownloadOptions(data);
        setTimeout(pollModelStatus, 3000);
        return;
      }

      setStatusOverlayMode(data.status, data.hardware);
      connectLogs();

      if (data.status === "downloading" && refs.statusTitle) {
        refs.statusTitle.textContent = "Downloading Model Assets";
      } else if (refs.statusTitle) {
        refs.statusTitle.textContent = "Loading Model Assets";
      }

      if (data.status === "error") {
        refs.statusMsg.textContent = `Error: ${data.message}`;
        refs.statusMsg.style.color = "var(--destructive)";
        return;
      }

      refs.statusMsg.style.color = "var(--text-muted)";
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

  // ── Full-screen Gallery Modal ────────────────────────────────────────────
  let lightboxIndex = 0;

  function buildGalleryModalGrid() {
    refs.galleryModalGrid.textContent = "";
    const fragment = document.createDocumentFragment();
    history.forEach((item, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "gallery-modal-item";
      card.setAttribute("aria-label", `View image ${index + 1}`);
      const img = document.createElement("img");
      img.src = item.thumb || item.image || "";
      img.loading = "lazy";
      img.alt = "";
      card.appendChild(img);
      card.addEventListener("click", () => openLightbox(index));
      fragment.appendChild(card);
    });
    refs.galleryModalGrid.appendChild(fragment);
  }

  async function openLightbox(index) {
    lightboxIndex = index;
    const item = history[index];
    if (!item) return;

    let full = null;
    if (item.diskUrl) {
      full = item.diskUrl;
    } else if (item.id) {
      try { full = await getImageFromDB(item.id); } catch { /* ignore */ }
    }
    refs.lightboxImg.src = full || item.thumb || item.image || "";
    refs.lightboxPrompt.textContent = item.prompt || "";
    refs.galleryLightbox.classList.remove("hidden");
    refs.lightboxPrev.classList.toggle("hidden", history.length <= 1);
    refs.lightboxNext.classList.toggle("hidden", history.length <= 1);
  }

  function closeLightbox() {
    refs.galleryLightbox.classList.add("hidden");
    refs.lightboxImg.src = "";
  }

  refs.expandGalleryBtn.addEventListener("click", () => {
    buildGalleryModalGrid();
    refs.galleryModal.classList.remove("hidden");
    feather.replace();
  });

  refs.closeGalleryModalBtn.addEventListener("click", () => {
    closeLightbox();
    refs.galleryModal.classList.add("hidden");
  });

  refs.galleryModal.addEventListener("click", (ev) => {
    if (ev.target === refs.galleryModal) {
      closeLightbox();
      refs.galleryModal.classList.add("hidden");
    }
  });

  refs.lightboxClose.addEventListener("click", closeLightbox);

  refs.lightboxPrev.addEventListener("click", () => {
    if (!history.length) return;
    openLightbox((lightboxIndex - 1 + history.length) % history.length);
  });

  refs.lightboxNext.addEventListener("click", () => {
    if (!history.length) return;
    openLightbox((lightboxIndex + 1) % history.length);
  });

  refs.lightboxDownload.addEventListener("click", () => {
    const src = refs.lightboxImg.src;
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = `flux-4b-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  refs.lightboxEdit.addEventListener("click", () => {
    const item = history[lightboxIndex];
    if (item) editHistoryItem(item);
  });

  // Arrow key navigation for lightbox
  document.addEventListener("keydown", (ev) => {
    if (refs.galleryLightbox.classList.contains("hidden")) return;
    if (ev.key === "ArrowLeft") refs.lightboxPrev.click();
    if (ev.key === "ArrowRight") refs.lightboxNext.click();
    if (ev.key === "Escape") closeLightbox();
  });
  // Escape also closes the gallery modal
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !refs.galleryModal.classList.contains("hidden") && refs.galleryLightbox.classList.contains("hidden")) {
      refs.galleryModal.classList.add("hidden");
    }
  });
  // ────────────────────────────────────────────────────────────────────────

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
