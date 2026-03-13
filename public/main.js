document.addEventListener("DOMContentLoaded", () => {
  // Mode Switching
  const btnT2I = document.getElementById("btn-t2i");
  const btnI2I = document.getElementById("btn-i2i");
    const initImageGroup = document.getElementById('init-image-group');
    const refImageGroup = document.getElementById('ref-image-group');
    const t2iOnlyEls = document.querySelectorAll('.t2i-only');
    
    let currentMode = 't2i';

    function setMode(mode) {
        currentMode = mode;
        if (mode === 't2i') {
            btnT2I.classList.add('active');
            btnI2I.classList.remove('active');
            initImageGroup.classList.add('hidden');
            refImageGroup.classList.add('hidden');
            t2iOnlyEls.forEach(el => el.classList.remove('hidden'));
        } else {
            btnI2I.classList.add('active');
            btnT2I.classList.remove('active');
            initImageGroup.classList.remove('hidden');
            refImageGroup.classList.remove('hidden');
            t2iOnlyEls.forEach(el => el.classList.add('hidden'));
        }
    }

  btnT2I.addEventListener("click", () => setMode("t2i"));
  btnI2I.addEventListener("click", () => setMode("i2i"));

  // Range Sliders display update
  const ranges = ["width", "height", "steps", "guidance"];
  ranges.forEach((id) => {
    const input = document.getElementById(id);
    const display = document.getElementById(`val-${id}`);
    if (input && display) {
      input.addEventListener("input", (e) => {
        display.textContent = e.target.value;
      });
    }
  });

    // --- Base Image Upload Logic ---
    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('image-upload');
    const uploadPreview = document.getElementById('upload-preview');
    const clearUploadBtn = document.getElementById('clear-upload');
    let selectedFile = null;

    uploadArea.addEventListener('click', (e) => {
        if (e.target !== clearUploadBtn && e.target !== clearUploadBtn.querySelector('i')) {
            fileInput.click();
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    function handleFile(file) {
        if (!file.type.startsWith('image/')) {
            showToast('Please upload an image file.');
            return;
        }
        selectedFile = file;
        const reader = new FileReader();
        reader.onload = (e) => {
            uploadPreview.src = e.target.result;
            uploadPreview.classList.remove('hidden');
            clearUploadBtn.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }

    clearUploadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedFile = null;
        fileInput.value = '';
        uploadPreview.src = '';
        uploadPreview.classList.add('hidden');
        clearUploadBtn.classList.add('hidden');
    });

    // --- Reference Image Upload Logic ---
    const refUploadArea = document.getElementById('ref-upload-area');
    const refFileInput = document.getElementById('ref-image-upload');
    const refUploadPreview = document.getElementById('ref-upload-preview');
    const clearRefUploadBtn = document.getElementById('clear-ref-upload');
    let selectedRefFile = null;

    refUploadArea.addEventListener('click', (e) => {
        if (e.target !== clearRefUploadBtn && e.target !== clearRefUploadBtn.querySelector('i')) {
            refFileInput.click();
        }
    });

    refFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleRefFile(e.target.files[0]);
        }
    });

    refUploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        refUploadArea.classList.add('dragover');
    });

    refUploadArea.addEventListener('dragleave', () => {
        refUploadArea.classList.remove('dragover');
    });

    refUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        refUploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleRefFile(e.dataTransfer.files[0]);
        }
    });

    function handleRefFile(file) {
        if (!file.type.startsWith('image/')) {
            showToast('Please upload an image file.');
            return;
        }
        selectedRefFile = file;
        const reader = new FileReader();
        reader.onload = (e) => {
            refUploadPreview.src = e.target.result;
            refUploadPreview.classList.remove('hidden');
            clearRefUploadBtn.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }

    clearRefUploadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedRefFile = null;
        refFileInput.value = '';
        refUploadPreview.src = '';
        refUploadPreview.classList.add('hidden');
        clearRefUploadBtn.classList.add('hidden');
    });

  // Generation Logic
  const generateBtn = document.getElementById("generate-btn");
  const btnText = generateBtn.querySelector(".btn-text");
  const spinner = generateBtn.querySelector(".spinner");

  const resultPlaceholder = document.getElementById("result-placeholder");
  const resultContainer = document.getElementById("result-container");
  const resultImage = document.getElementById("result-image");
  const downloadBtn = document.getElementById("download-btn");
  const fullscreenBtn = document.getElementById("fullscreen-btn");
  
  // History Logic
  const galleryGrid = document.getElementById("gallery-grid");
  const clearHistoryBtn = document.getElementById("clear-history");
  let history = JSON.parse(localStorage.getItem("flux_history") || "[]");

  function saveHistory() {
    // Keep only last 20 items to save localStorage space (base64 is large)
    if (history.length > 20) history = history.slice(0, 20);
    localStorage.setItem("flux_history", JSON.stringify(history));
  }

  function renderHistory() {
    galleryGrid.innerHTML = history.length === 0 
      ? '<div class="gallery-empty">No history yet</div>' 
      : "";
    
    history.forEach((item, index) => {
      const el = document.createElement("div");
      el.className = "gallery-item";
      el.innerHTML = `
        <img src="${item.image}" alt="History image">
        <div class="gallery-overlay">
          <div class="gallery-info">
            <p class="history-prompt">${item.prompt}</p>
            <div class="history-meta">
              <span>Steps: ${item.steps}</span>
              <span>Guidance: ${item.guidance}</span>
              ${item.seed != -1 ? `<span>Seed: ${item.seed}</span>` : ""}
            </div>
          </div>
        </div>
      `;
      el.addEventListener("click", () => {
        resultImage.src = item.image;
        resultPlaceholder.classList.add("hidden");
        resultContainer.classList.remove("hidden");
        // Scroll to top of results
        resultContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      galleryGrid.appendChild(el);
    });
  }

  clearHistoryBtn.addEventListener("click", () => {
    if (confirm("Clear image history?")) {
      history = [];
      saveHistory();
      renderHistory();
    }
  });

  // Initial render
  renderHistory();

  async function handleGenerate() {
    const prompt = document.getElementById("prompt").value.trim();
    if (!prompt) {
      showToast("Please enter a prompt.");
      return;
    }

    if (currentMode === "i2i" && !selectedFile) {
      showToast("Please upload a conditioning image for Image to Image.");
      return;
    }

    // Set Loading State
    generateBtn.disabled = true;
    btnText.textContent = "Generating...";
    spinner.classList.remove("hidden");

    // Hide previous results
    resultContainer.classList.add("hidden");
    resultPlaceholder.classList.remove("hidden");
    resultPlaceholder.style.opacity = "0.8";
    resultPlaceholder.innerHTML = `
            <i data-feather="loader" class="spinner" style="width: 48px; height: 48px; color: var(--accent-color);"></i>
            <p>Processing with FLUX.2-klein-4B...</p>
        `;
    feather.replace();

    try {
      const formData = new FormData();
      formData.append("prompt", prompt);
      formData.append(
        "num_inference_steps",
        document.getElementById("steps").value,
      );
      formData.append(
        "guidance_scale",
        document.getElementById("guidance").value,
      );
      formData.append("seed", document.getElementById("seed").value);

      let endpoint = "/api/generate";

            if (currentMode === 't2i') {
                formData.append('width', document.getElementById('width').value);
                formData.append('height', document.getElementById('height').value);
            } else {
                endpoint = '/api/edit';
                formData.append('image', selectedFile);
                if (selectedRefFile) {
                    formData.append('reference_image', selectedRefFile);
                }
            }

      const response = await fetch(endpoint, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (data.status === "success") {
        resultImage.src = data.image; // This is a base64 string
        resultPlaceholder.classList.add("hidden");
        resultContainer.classList.remove("hidden");

        // Save to History
        const currentItem = {
          image: data.image,
          prompt: prompt,
          steps: document.getElementById("steps").value,
          guidance: document.getElementById("guidance").value,
          seed: document.getElementById("seed").value,
          timestamp: Date.now()
        };
        history.unshift(currentItem);
        saveHistory();
        renderHistory();

      } else {
        throw new Error(data.message || "Failed to generate image");
      }
    } catch (err) {
      console.error(err);
      showToast(err.message);
      resultPlaceholder.innerHTML = `
                <div class="placeholder-icon">
                    <i data-feather="image"></i>
                </div>
                <p>Your creation will appear here</p>
            `;
      feather.replace();
      resultPlaceholder.style.opacity = "0.4";
      resultPlaceholder.style.opacity = "0.4";
    } finally {
      generateBtn.disabled = false;
      btnText.textContent = "Generate Image";
      spinner.classList.add("hidden");
    }
  }

  generateBtn.addEventListener("click", handleGenerate);

  // Enter key to generate
  document.getElementById("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (
        !generateBtn.disabled &&
        document.getElementById("prompt").value.trim()
      ) {
        handleGenerate();
      }
    }
  });

  // Actions Overlay
  downloadBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = resultImage.src;
    a.download = `flux-4b-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  // Fullscreen Modal
  const modal = document.getElementById("fullscreen-modal");
  const modalImage = document.getElementById("modal-image");
  const closeModalBtn = document.getElementById("close-modal");

  fullscreenBtn.addEventListener("click", () => {
    modalImage.src = resultImage.src;
    modal.classList.remove("hidden");
  });

  closeModalBtn.addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
    }
  });

  // Toast Notification
  const toast = document.getElementById("error-toast");
  const toastMsg = document.getElementById("toast-message");
  let toastTimeout;

    function showToast(message) {
        toastMsg.textContent = message;
        toast.classList.remove('hidden');
        
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }

    // --- Model Status Polling ---
    const statusOverlay = document.getElementById('model-status-overlay');
    const statusMsg = document.getElementById('status-message');
    
    async function pollModelStatus() {
        try {
            const response = await fetch('/api/model-status');
            const data = await response.json();
            
            if (data.status === 'ready') {
                statusOverlay.classList.add('hidden');
                console.log("Model is ready!");
                return; // Stop polling
            } else if (data.status === 'error') {
                statusMsg.textContent = "Error: " + data.message;
                statusMsg.style.color = "var(--destructive)";
                // Keep overlay visible but stop animation if desired
                return;
            } else {
                // Still loading
                statusOverlay.classList.remove('hidden');
                statusMsg.textContent = data.message || "Downloading model assets...";
                setTimeout(pollModelStatus, 3000); // Check again in 3s
            }
        } catch (err) {
            console.error("Failed to fetch model status:", err);
            setTimeout(pollModelStatus, 5000); // Retry after 5s
        }
    }

    // Start polling on load
    pollModelStatus();
});
