(function () {
  "use strict";

  const FIREBASE_DB_URL = "https://micropit-91298-default-rtdb.asia-southeast1.firebasedatabase.app";
  const THREE_STRIKE_IMAGE_SRC = "assets/three-strikes-noise.png";
  const NO_WARNINGS_IMAGE_SRC = "assets/no-warnings-sign.png";
  const DISPATCH_SIREN_IMAGE_SRC = "assets/dispatch-siren.png";
  const DISPATCH_POLICE_IMAGE_SRC = "assets/dispatch-police.png";

  const TABLE_CONFIG = [
    { id: "A1", unitId: "unit_A" },
    { id: "A2", unitId: "unit_B" },
    { id: "A3", unitId: "unit_C" },
    { id: "A4", unitId: "unit_D" },
    { id: "B1", unitId: "unit_E" },
    { id: "B2", unitId: "unit_F" },
    { id: "B3", unitId: "unit_G" },
    { id: "B4", unitId: "unit_H" }
  ];

  const SEATS_PER_TABLE = 4;
  const DEFAULT_MAX_WARNINGS = 3;
  const DEFAULT_REFRESH_INTERVAL_MS = 5000;
  const OVERVIEW_TITLE_SCROLL_RANGE_PX = 150;

  let firebaseDevices = {};
  let dashboardData = createEmptyDashboardData();
  let refreshInterval = DEFAULT_REFRESH_INTERVAL_MS;
  let autoRefreshTimer = null;
  let lastSuccessfulFetchAt = null;
  let scrollFrame = null;

  let audioContext = null;
  let audioUnlocked = false;

  const visibleNoiseTables = new Set();
  const previousWarningCounts = new Map();
  const threeStrikeAlertedTables = new Set();

  let threeStrikeAlertQueue = [];
  let threeStrikeModalOpen = false;

  let mainContent = null;
  let sidebar = null;
  let mobileMenuToggle = null;
  let tablesGrid = null;
  let searchInput = null;
  let searchClearBtn = null;
  let refreshIntervalSelect = null;
  let logsContainer = null;
  let contentArea = null;

  document.addEventListener("DOMContentLoaded", function () {
    initializeElements();
    setupEventListeners();
    setupAudioUnlockListeners();
    renderEmptyDashboard();
    setHeaderMode("overview");
    refreshData();
    startAutoRefresh();
  });

  function createEmptyDashboardData() {
    return {
      tables: [],
      occupancy: {
        current: 0,
        max: TABLE_CONFIG.length * SEATS_PER_TABLE
      },
      warnings: 0,
      sensors: {
        noiseLevel: 0
      }
    };
  }

  function initializeElements() {
    mainContent = document.getElementById("mainContent");
    sidebar = document.getElementById("sidebar");
    mobileMenuToggle = document.getElementById("mobileMenuToggle");
    tablesGrid = document.getElementById("tablesGrid");
    searchInput = document.getElementById("searchInput");
    searchClearBtn = document.getElementById("searchClearBtn");
    refreshIntervalSelect = document.getElementById("refreshInterval");
    logsContainer = document.querySelector(".logs-container");
    contentArea = document.getElementById("contentArea");
  }

  function setupEventListeners() {
    if (mobileMenuToggle) {
      mobileMenuToggle.addEventListener("click", toggleMobileMenu);
    }

    document.querySelectorAll(".nav-item, .mobile-nav-item").forEach(function (item) {
      item.addEventListener("click", function (event) {
        event.preventDefault();

        const page = item.getAttribute("data-page");

        if (page === "alerts") {
          showNotifications();
          return;
        }

        navigateToPage(page);
      });
    });

    if (searchInput) {
      searchInput.addEventListener("input", function (event) {
        renderTables(event.target.value);
        updateSearchClearButton();
      });
    }

    if (searchClearBtn) {
      searchClearBtn.addEventListener("click", function () {
        if (!searchInput) {
          return;
        }

        searchInput.value = "";
        updateSearchClearButton();
        renderTables("");
        searchInput.focus();
      });
    }

    if (refreshIntervalSelect) {
      refreshIntervalSelect.addEventListener("change", updateRefreshInterval);
    }

    if (contentArea) {
      contentArea.addEventListener("scroll", function () {
        requestScrollMotionUpdate();
      }, { passive: true });
    }

    document.addEventListener("click", function (event) {
      playSoundForInteraction(event);

      if (
        window.innerWidth <= 768 &&
        sidebar &&
        sidebar.classList.contains("open") &&
        !sidebar.contains(event.target) &&
        mobileMenuToggle &&
        !mobileMenuToggle.contains(event.target)
      ) {
        closeMobileMenu();
      }
    }, true);

    window.addEventListener("resize", requestScrollMotionUpdate);
    window.addEventListener("online", refreshData);

    window.addEventListener("offline", function () {
      updateConnectionStatus(false, "Browser offline");
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopAutoRefresh();
      } else {
        refreshData();
        startAutoRefresh();
      }
    });

    window.addEventListener("beforeunload", stopAutoRefresh);
  }

  function setupAudioUnlockListeners() {
    const unlock = function () {
      unlockAudioContext();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };

    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock, { passive: true });
  }

  function unlockAudioContext() {
    const context = getAudioContext();

    if (!context) {
      return;
    }

    if (context.state === "suspended") {
      context.resume()
        .then(function () {
          audioUnlocked = true;
        })
        .catch(function () {
          audioUnlocked = false;
        });

      return;
    }

    audioUnlocked = true;
  }

  function getAudioContext() {
    if (audioContext) {
      return audioContext;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextConstructor) {
      return null;
    }

    audioContext = new AudioContextConstructor();
    return audioContext;
  }

  function playSoundForInteraction(event) {
    const interactiveElement = event.target.closest(
      "button, .nav-item, .mobile-nav-item, .students-box, .status-toggle-button, .brand-home"
    );

    if (!interactiveElement) {
      return;
    }

    if (
      interactiveElement.classList.contains("dispatch-confirm-btn") ||
      interactiveElement.classList.contains("dispatch-btn")
    ) {
      playUiSound("success");
      return;
    }

    if (
      interactiveElement.classList.contains("dispatch-cancel-btn") ||
      interactiveElement.classList.contains("student-modal-close") ||
      interactiveElement.classList.contains("noise-close-button") ||
      interactiveElement.classList.contains("search-clear-btn") ||
      interactiveElement.classList.contains("three-strike-close-btn")
    ) {
      playUiSound("soft");
      return;
    }

    playUiSound("tap");
  }

  function playUiSound(type) {
    const context = getAudioContext();

    if (!context || !audioUnlocked || context.state !== "running") {
      return;
    }

    if (type === "alert") {
      playToneSequence([
        { frequency: 740, start: 0.00, duration: 0.08, gain: 0.032 },
        { frequency: 960, start: 0.10, duration: 0.10, gain: 0.036 },
        { frequency: 1180, start: 0.23, duration: 0.16, gain: 0.030 }
      ]);
      return;
    }

    if (type === "success") {
      playToneSequence([
        { frequency: 520, start: 0.00, duration: 0.05, gain: 0.020 },
        { frequency: 780, start: 0.06, duration: 0.08, gain: 0.024 }
      ]);
      return;
    }

    if (type === "soft") {
      playToneSequence([
        { frequency: 420, start: 0.00, duration: 0.045, gain: 0.014 }
      ]);
      return;
    }

    playToneSequence([
      { frequency: 620, start: 0.00, duration: 0.035, gain: 0.014 }
    ]);
  }

  function playToneSequence(notes) {
    notes.forEach(function (note) {
      playTone(note.frequency, note.start, note.duration, note.gain);
    });
  }

  function playTone(frequency, startOffset, duration, maxGain) {
    const context = getAudioContext();

    if (!context || context.state !== "running") {
      return;
    }

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now + startOffset);

    gainNode.gain.setValueAtTime(0.0001, now + startOffset);
    gainNode.gain.exponentialRampToValueAtTime(maxGain, now + startOffset + 0.012);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);

    oscillator.start(now + startOffset);
    oscillator.stop(now + startOffset + duration + 0.03);
  }

  function requestScrollMotionUpdate() {
    if (scrollFrame) {
      return;
    }

    scrollFrame = window.requestAnimationFrame(function () {
      scrollFrame = null;
      updateOverviewTitleMotion();
    });
  }

  function updateOverviewTitleMotion() {
    if (!mainContent || !contentArea) {
      return;
    }

    const overviewPage = document.getElementById("overviewPage");
    const isOverviewVisible = overviewPage && !overviewPage.classList.contains("hidden");

    if (!isOverviewVisible) {
      setOverviewTitleMotionProgress(0);
      return;
    }

    const scrollTop = Math.max(contentArea.scrollTop, 0);
    const progress = clamp(scrollTop / OVERVIEW_TITLE_SCROLL_RANGE_PX, 0, 1);

    setOverviewTitleMotionProgress(progress);
  }

  function setOverviewTitleMotionProgress(progress) {
    if (!mainContent) {
      return;
    }

    const p = clamp(progress, 0, 1);
    const opacity = Math.max(1 - p, 0);

    mainContent.style.setProperty("--overview-title-shift", `${-130 * p}px`);
    mainContent.style.setProperty("--overview-legend-shift", `${135 * p}px`);
    mainContent.style.setProperty("--overview-title-opacity", opacity.toFixed(3));
    mainContent.style.setProperty("--overview-legend-opacity", opacity.toFixed(3));

    mainContent.classList.toggle("overview-page-header-hidden", p >= 0.985);
  }

  function setHeaderMode(page) {
    if (!mainContent) {
      return;
    }

    const shouldHideHeader = page !== "overview";
    mainContent.classList.toggle("header-hidden", shouldHideHeader);

    if (shouldHideHeader) {
      setOverviewTitleMotionProgress(0);
      return;
    }

    setTimeout(function () {
      updateOverviewTitleMotion();
    }, 30);
  }

  function renderEmptyDashboard() {
    firebaseDevices = {};
    dashboardData = mapFirebaseDevicesToDashboard(firebaseDevices);

    renderTables();
    renderLogs();
    updateStats();
    updateSensorDisplay();
    updateConnectionStatus(false, "Waiting for Firebase");
    updateSearchClearButton();
  }

  async function refreshData() {
    const databaseUrl = normalizeFirebaseUrl(FIREBASE_DB_URL);

    try {
      const response = await fetch(`${databaseUrl}/devices.json?ts=${Date.now()}`, {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`Firebase read failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      firebaseDevices = isPlainObject(data) ? data : {};
      dashboardData = mapFirebaseDevicesToDashboard(firebaseDevices);
      lastSuccessfulFetchAt = Date.now();

      pruneNoiseViewState();
      handleThreeStrikeTransitions(dashboardData.tables);
      renderTables(searchInput ? searchInput.value : "");
      renderLogs();
      updateStats();
      updateSensorDisplay();
      updateConnectionStatus(true, "Connected");
      updateSearchClearButton();
      requestScrollMotionUpdate();
    } catch (error) {
      console.error("Firebase fetch error:", error);
      updateConnectionStatus(false, "Firebase read failed");
    }
  }

  function handleThreeStrikeTransitions(tables) {
    tables.forEach(function (table) {
      const previousCount = previousWarningCounts.get(table.id);
      const currentCount = table.warnings;

      if (currentCount < DEFAULT_MAX_WARNINGS) {
        threeStrikeAlertedTables.delete(table.id);
      }

      const reachedThreeStrikes = currentCount >= DEFAULT_MAX_WARNINGS;
      const crossedIntoThreeStrikes =
        previousCount === undefined || previousCount < DEFAULT_MAX_WARNINGS;

      if (
        reachedThreeStrikes &&
        crossedIntoThreeStrikes &&
        !threeStrikeAlertedTables.has(table.id)
      ) {
        threeStrikeAlertedTables.add(table.id);
        enqueueThreeStrikeAlert(table);
      }

      previousWarningCounts.set(table.id, currentCount);
    });
  }

  function enqueueThreeStrikeAlert(table) {
    threeStrikeAlertQueue.push({
      id: table.id,
      unitId: table.unitId,
      warnings: table.warnings,
      maxWarnings: table.maxWarnings,
      studentCount: table.studentCount,
      noiseLevel: table.noiseLevel
    });

    showNextThreeStrikeAlert();
  }

  function showNextThreeStrikeAlert() {
    if (threeStrikeModalOpen || threeStrikeAlertQueue.length === 0) {
      return;
    }

    const alertData = threeStrikeAlertQueue.shift();
    showThreeStrikeAlertModal(alertData);
  }

  function showThreeStrikeAlertModal(alertData) {
    const overlay = ensureThreeStrikeAlertModal();

    threeStrikeModalOpen = true;

    overlay.innerHTML = `
      <div class="three-strike-modal-card" role="dialog" aria-modal="true">
        <div class="three-strike-visual">
          <img
            src="${escapeHtml(THREE_STRIKE_IMAGE_SRC)}"
            alt="Noisy students illustration"
            onerror="this.closest('.three-strike-visual').classList.add('image-missing'); this.remove();"
          />
          <div class="three-strike-visual-overlay"></div>
          <div class="three-strike-floating-badge">
            <span class="material-symbols-outlined">campaign</span>
            <strong>Three Strikes</strong>
          </div>
        </div>

        <div class="three-strike-content">
          <h3>Table ${escapeHtml(alertData.id)} just reached three strikes.</h3>
          <p>This table may need attention because it reached the maximum warning count.</p>

          <div class="three-strike-actions">
            <button type="button" class="three-strike-close-btn" onclick="closeThreeStrikeAlertModal()">
              Close
            </button>
          </div>
        </div>
      </div>
    `;

    overlay.classList.remove("hidden");
    document.body.classList.add("modal-open");
    playUiSound("alert");
  }

  function ensureThreeStrikeAlertModal() {
    let overlay = document.getElementById("threeStrikeAlertOverlay");

    if (overlay) {
      return overlay;
    }

    overlay = document.createElement("div");
    overlay.id = "threeStrikeAlertOverlay";
    overlay.className = "modal-overlay three-strike-overlay hidden";

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        closeThreeStrikeAlertModal();
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function closeThreeStrikeAlertModal() {
    const overlay = document.getElementById("threeStrikeAlertOverlay");

    if (overlay) {
      overlay.classList.add("hidden");
      overlay.innerHTML = "";
    }

    threeStrikeModalOpen = false;
    document.body.classList.remove("modal-open");
    playUiSound("soft");

    window.setTimeout(showNextThreeStrikeAlert, 120);
  }

  function pruneNoiseViewState() {
    const validTableIds = new Set(dashboardData.tables.map(function (table) {
      return table.id;
    }));

    Array.from(visibleNoiseTables).forEach(function (tableId) {
      if (!validTableIds.has(tableId)) {
        visibleNoiseTables.delete(tableId);
      }
    });
  }

  function mapFirebaseDevicesToDashboard(devices) {
    const tables = TABLE_CONFIG.map(function (tableConfig) {
      const device = isPlainObject(devices[tableConfig.unitId])
        ? devices[tableConfig.unitId]
        : {};

      const audio = isPlainObject(device.audio) ? device.audio : {};
      const students = getCurrentStudentsFromDevice(device);
      const studentCount = students.length;
      const available = studentCount === 0;

      const noisyThreshold = toNumber(audio.noisy_threshold, 83);
      const loudThreshold = toNumber(audio.loud_threshold, 90);
      const receivedDb = toNumber(audio.received_db, 0);
      const audioLevel = Number.isFinite(Number(audio.level)) ? Number(audio.level) : null;

      let warnings = 0;
      let status = "quiet";

      if (!available) {
        warnings = getWarningCount(device, DEFAULT_MAX_WARNINGS);

        if (warnings >= DEFAULT_MAX_WARNINGS) {
          status = "critical";
        } else {
          status = getStatusFromAudio(audio);
        }
      }

      return {
        id: tableConfig.id,
        unitId: tableConfig.unitId,
        status,
        warnings,
        maxWarnings: DEFAULT_MAX_WARNINGS,
        studentCount,
        students,
        available,
        noiseLevel: receivedDb,
        noisyThreshold,
        loudThreshold,
        audioLevel,
        updatedAt: audio.updated_at || device.updated_at || null
      };
    });

    const currentOccupancy = tables.reduce(function (sum, table) {
      return sum + table.studentCount;
    }, 0);

    const activeWarnings = tables.reduce(function (sum, table) {
      return sum + table.warnings;
    }, 0);

    const highestNoise = tables.reduce(function (max, table) {
      return Math.max(max, table.noiseLevel || 0);
    }, 0);

    return {
      tables,
      occupancy: {
        current: currentOccupancy,
        max: tables.length * SEATS_PER_TABLE
      },
      warnings: activeWarnings,
      sensors: {
        noiseLevel: highestNoise
      }
    };
  }

  function getCurrentStudentsFromDevice(device) {
    const source = device.current_students || device.qr_codes || {};
    const entries = getObjectEntries(source);

    return entries.map(function ([key, value]) {
      return normalizeStudentRecord(key, value);
    });
  }

  function normalizeStudentRecord(key, value) {
    const record = isPlainObject(value) ? value : { payload: String(value ?? "") };

    const payload = String(
      record.payload ||
      record.name ||
      record.student_name ||
      record.student_id ||
      key ||
      "Registered Student"
    );

    const scannedAt =
      record.scanned_at ||
      record.created_at ||
      record.timestamp ||
      null;

    const hashLike = /^[a-f0-9]{32,}$/i.test(payload.trim());
    const idMatch = payload.match(/\b\d{6,12}\b/);

    let studentId = record.student_id || record.id || "";
    let name = record.name || record.student_name || "";
    let program = record.program || record.course || "";

    if (!studentId && idMatch) {
      studentId = idMatch[0];
    }

    if (!name && idMatch) {
      const beforeId = payload.slice(0, idMatch.index).trim();
      const afterId = payload.slice(idMatch.index + idMatch[0].length).trim();

      name = beforeId || "Registered Student";
      program = afterId || "";
    }

    if (!name && hashLike) {
      name = "Registered Student";
      studentId = `#${payload.slice(0, 8)}`;
    }

    if (!name) {
      name = payload || "Registered Student";
    }

    if (!studentId && !hashLike) {
      studentId = key;
    }

    return {
      key,
      payload,
      name,
      studentId,
      program,
      scannedAt,
      initials: getInitials(name)
    };
  }

  function getWarningCount(device, maxWarnings) {
    const audio = isPlainObject(device.audio) ? device.audio : {};

    const rawWarnings =
      device.warning_count ??
      device.warningCount ??
      device.warnings ??
      audio.warning_count ??
      audio.warningCount ??
      audio.warnings ??
      0;

    return clamp(Math.round(toNumber(rawWarnings, 0)), 0, maxWarnings);
  }

  function getStatusFromAudio(audio) {
    const manualStatus = String(audio.status || "").toLowerCase().trim();

    if (["quiet", "normal", "silent"].includes(manualStatus)) {
      return "quiet";
    }

    if (["moderate", "noise"].includes(manualStatus)) {
      return "moderate";
    }

    if (["critical", "noisy", "loud", "very_loud", "too_loud"].includes(manualStatus)) {
      return "critical";
    }

    const level = Number(audio.level);

    if (Number.isFinite(level)) {
      if (level >= 2) {
        return "critical";
      }

      if (level >= 1) {
        return "moderate";
      }

      return "quiet";
    }

    const receivedDb = toNumber(audio.received_db, 0);
    const noisyThreshold = toNumber(audio.noisy_threshold, 83);
    const loudThreshold = toNumber(audio.loud_threshold, 90);

    if (receivedDb >= loudThreshold) {
      return "critical";
    }

    if (receivedDb >= noisyThreshold) {
      return "moderate";
    }

    return "quiet";
  }

  function renderTables(searchTerm = "") {
    if (!tablesGrid) {
      return;
    }

    const normalizedSearch = String(searchTerm).trim().toLowerCase();

    const filteredTables = normalizedSearch
      ? dashboardData.tables.filter(function (table) {
          const tableMatches =
            table.id.toLowerCase().includes(normalizedSearch) ||
            table.unitId.toLowerCase().includes(normalizedSearch) ||
            table.status.toLowerCase().includes(normalizedSearch);

          const studentMatches = table.students.some(function (student) {
            return [
              student.name,
              student.studentId,
              student.program,
              student.payload
            ].some(function (value) {
              return String(value || "").toLowerCase().includes(normalizedSearch);
            });
          });

          return tableMatches || studentMatches;
        })
      : dashboardData.tables;

    tablesGrid.innerHTML = filteredTables.map(createTableCard).join("");
  }

  function createTableCard(table) {
    const noiseViewOpen = visibleNoiseTables.has(table.id);

    if (table.available) {
      return createAvailableTableCard(table, noiseViewOpen);
    }

    const isDispatchReady = table.warnings >= table.maxWarnings;
    const statusClass = sanitizeStatus(isDispatchReady ? "critical" : table.status);
    const statusLabel = capitalize(statusClass);
    const firstStudent = table.students[0] || null;

    return `
      <article class="table-card occupied-card ${isDispatchReady ? "critical" : ""} ${noiseViewOpen ? "noise-mode" : ""}">
        <div class="table-card-header">
          <div class="seat-icon">
            <span class="material-symbols-outlined">event_seat</span>
          </div>

          <h4>Table ${escapeHtml(table.id)}</h4>

          ${createStatusToggle(table, statusClass, statusLabel, noiseViewOpen)}
        </div>

        ${
          noiseViewOpen
            ? createNoiseViewBody(table, isDispatchReady)
            : `
              <div class="table-card-body">
                <section class="warning-box ${isDispatchReady ? "critical" : ""}">
                  <div class="warning-row">
                    <button
                      class="warning-reset-button"
                      type="button"
                      onclick="showWarningResetModal('${escapeJsString(table.id)}')"
                      aria-label="Reset warning count for Table ${escapeHtml(table.id)}"
                      title="Reset warnings"
                    >
                      <span class="material-symbols-outlined warning-symbol">warning</span>
                      <span class="material-symbols-outlined reset-symbol">close</span>
                    </button>

                    <div class="warning-label">Warnings</div>

                    <div class="warning-bars">
                      ${generateWarningBars(table.warnings, table.maxWarnings)}
                    </div>
                  </div>

                  ${
                    isDispatchReady
                      ? `
                        <button
                          class="dispatch-btn"
                          type="button"
                          onclick="dispatchIntervention('${escapeJsString(table.id)}')"
                        >
                          <span class="material-symbols-outlined">send</span>
                          <span>Dispatch Intervention</span>
                        </button>
                      `
                      : ""
                  }
                </section>

                <button
                  class="students-box"
                  type="button"
                  onclick="showSeatedStudentsModal('${escapeJsString(table.id)}')"
                  aria-label="View seated students for Table ${escapeHtml(table.id)}"
                >
                  <div class="students-label">
                    <span class="students-label-icon">
                      <span class="material-symbols-outlined">groups</span>
                    </span>
                    <span>Seated Students</span>
                  </div>

                  <div class="students-main">
                    <div class="student-avatar">
                      ${escapeHtml(firstStudent ? firstStudent.initials : "ST")}
                    </div>

                    <div class="student-text">
                      <p>${table.studentCount} student${table.studentCount !== 1 ? "s" : ""}</p>
                    </div>

                    <div class="student-chart" aria-hidden="true">
                      <i></i>
                      <i></i>
                      <i></i>
                    </div>
                  </div>
                </button>
              </div>
            `
        }
      </article>
    `;
  }

  function createAvailableTableCard(table, noiseViewOpen) {
    return `
      <article class="table-card available-card available ${noiseViewOpen ? "noise-mode" : ""}">
        <div class="table-card-header">
          <div class="seat-icon muted">
            <span class="material-symbols-outlined">event_seat</span>
          </div>

          <h4>Table ${escapeHtml(table.id)}</h4>

          ${createStatusToggle(table, "quiet", "Quiet", noiseViewOpen)}
        </div>

        ${
          noiseViewOpen
            ? createNoiseViewBody(table, false)
            : `
              <div class="available-body">
                <span class="material-symbols-outlined">event_seat</span>
                <p>Available</p>
              </div>
            `
        }
      </article>
    `;
  }

  function createStatusToggle(table, statusClass, statusLabel, noiseViewOpen) {
    if (noiseViewOpen) {
      return `
        <button
          class="noise-close-button"
          type="button"
          onclick="toggleNoiseView('${escapeJsString(table.id)}')"
          aria-label="Close noise level view for Table ${escapeHtml(table.id)}"
          title="Close noise view"
        >
          <span class="material-symbols-outlined">close</span>
        </button>
      `;
    }

    return `
      <button
        class="table-status-pill status-toggle-button ${statusClass}"
        type="button"
        onclick="toggleNoiseView('${escapeJsString(table.id)}')"
        aria-label="View current noise level for Table ${escapeHtml(table.id)}"
        title="View noise level"
      >
        <span></span>
        <strong>${escapeHtml(statusLabel)}</strong>
      </button>
    `;
  }

  function createNoiseViewBody(table, isDispatchReady) {
    const noiseLevel = toNumber(table.noiseLevel, 0);
    const scale = getNoiseScale(table);

    return `
      <div class="table-card-body noise-view-body">
        <section
          class="noise-visual-panel"
          style="
            --noise-percent: ${scale.noisePercent}%;
            --quiet-solid-end: ${scale.quietSolidEnd}%;
            --moderate-start: ${scale.moderateStart}%;
            --critical-start: ${scale.criticalStart}%;
            --critical-blend-end: ${scale.criticalBlendEnd}%;
          "
        >
          <div class="noise-visual-header">
            <div>
              <span class="noise-eyebrow">Current Noise Level</span>
              <strong>${noiseLevel.toFixed(2)} dB</strong>
            </div>
          </div>

          <div class="noise-meter-shell">
            <div class="noise-gradient-meter" aria-label="Noise level gradient meter">
              <span class="noise-meter-cover"></span>
            </div>

            <div class="noise-meter-labels">
              <span>Quiet</span>
              <span>Moderate</span>
              <span>Critical</span>
            </div>
          </div>
        </section>

        ${
          isDispatchReady
            ? `
              <button
                class="dispatch-btn noise-dispatch-btn"
                type="button"
                onclick="dispatchIntervention('${escapeJsString(table.id)}')"
              >
                <span class="material-symbols-outlined">send</span>
                <span>Dispatch Intervention</span>
              </button>
            `
            : ""
        }
      </div>
    `;
  }

  function getNoiseScale(table) {
    const noiseLevel = toNumber(table.noiseLevel, 0);
    const noisyThreshold = Math.max(toNumber(table.noisyThreshold, 83), 1);
    const loudThreshold = Math.max(toNumber(table.loudThreshold, 90), noisyThreshold + 1);
    const upperBound = Math.max(loudThreshold + 10, 100);

    const noisePercent = clamp((noiseLevel / upperBound) * 100, 0, 100);
    const moderateStart = clamp((noisyThreshold / upperBound) * 100, 0, 96);
    const criticalStart = clamp((loudThreshold / upperBound) * 100, moderateStart + 1, 98);

    return {
      noisePercent: roundToOne(noisePercent),
      moderateStart: roundToOne(moderateStart),
      quietSolidEnd: roundToOne(Math.max(moderateStart - 6, 0)),
      criticalStart: roundToOne(criticalStart),
      criticalBlendEnd: roundToOne(Math.min(criticalStart + 6, 100))
    };
  }

  function toggleNoiseView(tableId) {
    if (visibleNoiseTables.has(tableId)) {
      visibleNoiseTables.delete(tableId);
    } else {
      visibleNoiseTables.add(tableId);
    }

    renderTables(searchInput ? searchInput.value : "");
  }

  function generateWarningBars(warnings, maxWarnings) {
    let bars = "";

    for (let i = 0; i < maxWarnings; i += 1) {
      bars += `<span class="warning-segment ${i < warnings ? "active" : ""}"></span>`;
    }

    return bars;
  }

  function renderLogs() {
    if (!logsContainer) {
      return;
    }

    const logs = [];

    dashboardData.tables.forEach(function (table) {
      table.students.forEach(function (student) {
        logs.push({
          time: normalizeTimestamp(student.scannedAt),
          action: `${student.name} seated at Table ${table.id}`
        });
      });

      if (table.studentCount > 0 && table.warnings > 0) {
        logs.push({
          time: normalizeTimestamp(table.updatedAt),
          action: `Warning level ${table.warnings}/${table.maxWarnings} recorded for Table ${table.id}`
        });
      }
    });

    logs.sort(function (a, b) {
      return b.time - a.time;
    });

    if (logs.length === 0) {
      logsContainer.innerHTML = `
        <div class="log-entry">
          <span class="log-time">--:--</span>
          <span class="log-action">No active Firebase QR scans yet.</span>
        </div>
      `;
      return;
    }

    logsContainer.innerHTML = logs.slice(0, 20).map(function (log) {
      return `
        <div class="log-entry">
          <span class="log-time">${escapeHtml(formatTime(log.time))}</span>
          <span class="log-action">${escapeHtml(log.action)}</span>
        </div>
      `;
    }).join("");
  }

  function updateStats() {
    const occupancyElement = document.getElementById("occupancy");
    const warningsElement = document.getElementById("warnings");

    if (occupancyElement) {
      occupancyElement.textContent = `${dashboardData.occupancy.current} / ${dashboardData.occupancy.max}`;
    }

    if (warningsElement) {
      warningsElement.textContent = `${String(dashboardData.warnings).padStart(2, "0")} Active`;
    }

    updateHeaderPopovers();
  }

  function updateHeaderPopovers() {
    const current = dashboardData.occupancy.current;
    const max = dashboardData.occupancy.max;
    const available = Math.max(max - current, 0);
    const occupancyPercent = max > 0 ? Math.round((current / max) * 1000) / 10 : 0;

    const donut = document.getElementById("occupancyDonut");
    const percentText = document.getElementById("occupancyPercent");
    const occupiedSeatsText = document.getElementById("occupiedSeatsTooltip");
    const availableSeatsText = document.getElementById("availableSeatsTooltip");
    const warningTableList = document.getElementById("warningTableList");

    if (donut) {
      donut.style.setProperty("--occupancy-percent", `${occupancyPercent}%`);
    }

    if (percentText) {
      percentText.textContent = `${occupancyPercent}%`;
    }

    if (occupiedSeatsText) {
      occupiedSeatsText.textContent = `${current} seat${current === 1 ? "" : "s"}`;
    }

    if (availableSeatsText) {
      availableSeatsText.textContent = `${available} seat${available === 1 ? "" : "s"}`;
    }

    if (warningTableList) {
      const warningTables = dashboardData.tables.filter(function (table) {
        return table.warnings > 0;
      });

      if (warningTables.length === 0) {
        warningTableList.innerHTML = `<div class="empty-warning-row">No active warnings.</div>`;
        return;
      }

      warningTableList.innerHTML = warningTables.map(function (table) {
        return `
          <div class="warning-table-row">
            <span>Table ${escapeHtml(table.id)}</span>
            <strong>${table.warnings}</strong>
          </div>
        `;
      }).join("");
    }
  }

  function updateSearchClearButton() {
    if (!searchInput || !searchClearBtn) {
      return;
    }

    const hasValue = searchInput.value.trim().length > 0;
    searchClearBtn.classList.toggle("visible", hasValue);
  }

  function updateSensorDisplay() {
    const sensorDataElement = document.getElementById("sensorData");

    if (!sensorDataElement) {
      return;
    }

    const noiseLevel = toNumber(dashboardData.sensors.noiseLevel, 0);
    const updatedText = lastSuccessfulFetchAt ? ` · Updated ${formatTime(lastSuccessfulFetchAt)}` : "";
    sensorDataElement.textContent = `Noise: ${noiseLevel.toFixed(2)}dB${updatedText}`;
  }

  function updateConnectionStatus(connected, text = "") {
    const statusElement = document.getElementById("connectionStatus");

    if (!statusElement) {
      return;
    }

    statusElement.textContent = text || (connected ? "Connected" : "Offline");
    statusElement.style.color = connected ? "#10b981" : "#dc2626";
  }

  function goHome() {
    if (searchInput) {
      searchInput.value = "";
      updateSearchClearButton();
    }

    visibleNoiseTables.clear();

    navigateToPage("overview");
    renderTables("");

    if (contentArea) {
      contentArea.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    }

    closeMobileMenu();
  }

  function toggleMobileMenu() {
    if (sidebar) {
      sidebar.classList.toggle("open");
    }
  }

  function closeMobileMenu() {
    if (sidebar) {
      sidebar.classList.remove("open");
    }
  }

  function navigateToPage(page) {
    document.querySelectorAll(".page").forEach(function (pageElement) {
      pageElement.classList.add("hidden");
    });

    const selectedPage = document.getElementById(`${page}Page`);

    if (selectedPage) {
      selectedPage.classList.remove("hidden");
    }

    document.querySelectorAll(".nav-item, .mobile-nav-item").forEach(function (item) {
      item.classList.remove("active");

      if (item.getAttribute("data-page") === page) {
        item.classList.add("active");
      }
    });

    setHeaderMode(page);

    if (contentArea && page !== "overview") {
      contentArea.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    }

    if (window.innerWidth <= 768) {
      closeMobileMenu();
    }
  }

  function updateRefreshInterval() {
    if (!refreshIntervalSelect) {
      return;
    }

    const seconds = parseInt(refreshIntervalSelect.value, 10);

    refreshInterval = Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : DEFAULT_REFRESH_INTERVAL_MS;

    startAutoRefresh();
  }

  function startAutoRefresh() {
    stopAutoRefresh();

    autoRefreshTimer = setInterval(function () {
      refreshData();
    }, refreshInterval);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function generateReport() {
    const rows = [
      ["Table", "Unit", "Status", "Warnings", "Students", "Noise dB", "Last Updated"]
    ];

    dashboardData.tables.forEach(function (table) {
      rows.push([
        `Table ${table.id}`,
        table.unitId,
        table.status,
        String(table.warnings),
        String(table.studentCount),
        String(table.noiseLevel),
        table.updatedAt ? formatDateTime(normalizeTimestamp(table.updatedAt)) : ""
      ]);
    });

    const csv = rows.map(function (row) {
      return row.map(escapeCsvCell).join(",");
    }).join("\r\n");

    downloadBlob(
      "\ufeff" + csv,
      `scholartrack-report-${new Date().toISOString().slice(0, 10)}.csv`,
      "text/csv;charset=utf-8"
    );
  }

  function showNotifications() {
    const activeTables = dashboardData.tables.filter(function (table) {
      return table.studentCount > 0 && table.status === "critical";
    });

    if (activeTables.length === 0) {
      alert("No active critical occupied tables.");
      return;
    }

    alert(activeTables.map(function (table) {
      return `Critical: Table ${table.id}`;
    }).join("\n"));
  }

  function showAccount() {
    alert("ScholarTrack Firebase website dashboard.");
  }

  function showSeatedStudentsModal(tableId) {
    const table = dashboardData.tables.find(function (item) {
      return item.id === tableId;
    });

    if (!table) {
      alert(`Table ${tableId} was not found.`);
      return;
    }

    const overlay = ensureStudentModal();

    const studentRows = table.students.length > 0
      ? table.students.map(function (student, index) {
          const displayName = student.name || "Registered Student";
          const displayId = student.studentId || "No ID found";
          const displayProgram = student.program || "Program not provided";
          const displayPayload = student.payload || "";

          return `
            <div class="student-modal-row">
              <div class="student-modal-avatar">
                ${escapeHtml(student.initials || "ST")}
              </div>

              <div class="student-modal-info">
                <div class="student-modal-name">${escapeHtml(displayName)}</div>

                <div class="student-modal-meta">
                  <span>ID: ${escapeHtml(displayId)}</span>
                  <span>${escapeHtml(displayProgram)}</span>
                </div>

                ${
                  displayPayload && displayPayload !== displayName
                    ? `<div class="student-modal-payload">${escapeHtml(displayPayload)}</div>`
                    : ""
                }
              </div>

              <div class="student-modal-number">${index + 1}</div>
            </div>
          `;
        }).join("")
      : `
        <div class="student-modal-empty">
          No students are currently seated at this table.
        </div>
      `;

    overlay.innerHTML = `
      <div class="student-modal-card" role="dialog" aria-modal="true">
        <div class="student-modal-header">
          <div>
            <p class="student-modal-eyebrow">Seated Students</p>
            <h3>Table ${escapeHtml(table.id)}</h3>
            <p>${table.studentCount} active QR entr${table.studentCount === 1 ? "y" : "ies"}</p>
          </div>

          <button class="student-modal-close" type="button" onclick="closeStudentsModal()">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>

        <div class="student-modal-list">
          ${studentRows}
        </div>
      </div>
    `;

    overlay.classList.remove("hidden");
    document.body.classList.add("modal-open");
  }

  function ensureStudentModal() {
    let overlay = document.getElementById("studentModalOverlay");

    if (overlay) {
      return overlay;
    }

    overlay = document.createElement("div");
    overlay.id = "studentModalOverlay";
    overlay.className = "modal-overlay hidden";

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        closeStudentsModal();
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function closeStudentsModal() {
    const overlay = document.getElementById("studentModalOverlay");

    if (overlay) {
      overlay.classList.add("hidden");
      overlay.innerHTML = "";
    }

    document.body.classList.remove("modal-open");
  }

  function dispatchIntervention(tableId) {
    const table = dashboardData.tables.find(function (item) {
      return item.id === tableId;
    });

    if (!table) {
      alert(`Table ${tableId} was not found.`);
      return;
    }

    showDispatchConfirmModal(table);
  }

  function showDispatchConfirmModal(table) {
    const overlay = ensureDispatchConfirmModal();

    overlay.innerHTML = `
      <div class="dispatch-modal-card visual-modal-card dispatch-visual-card" role="dialog" aria-modal="true">
        <div class="visual-modal-hero dispatch-hero">
          <img
            class="dispatch-police-img"
            src="${escapeHtml(DISPATCH_POLICE_IMAGE_SRC)}"
            alt="Intervention illustration"
            onerror="this.closest('.dispatch-hero').classList.add('police-missing'); this.remove();"
          />

          <img
            class="dispatch-siren-img"
            src="${escapeHtml(DISPATCH_SIREN_IMAGE_SRC)}"
            alt="Siren illustration"
            onerror="this.classList.add('hidden');"
          />

          <div class="visual-modal-overlay"></div>

          <div class="visual-modal-badge dispatch-badge">
            <span class="material-symbols-outlined">local_police</span>
            <strong>Intervention</strong>
          </div>
        </div>

        <div class="visual-modal-content">
          <h3>Dispatch intervention?</h3>

          <p>
            This will generate a CSV report for Table ${escapeHtml(table.id)}
            and reset its warning count.
          </p>

          <div class="visual-modal-mini-info danger">
            <span class="material-symbols-outlined">warning</span>
            <strong>Table ${escapeHtml(table.id)} has ${table.warnings} / ${table.maxWarnings} warnings.</strong>
          </div>

          <div class="dispatch-modal-actions">
            <button type="button" class="dispatch-cancel-btn" onclick="closeDispatchConfirmModal()">
              Cancel
            </button>

            <button type="button" class="dispatch-confirm-btn" onclick="confirmDispatchIntervention('${escapeJsString(table.id)}')">
              Confirm Dispatch
            </button>
          </div>
        </div>
      </div>
    `;

    overlay.classList.remove("hidden");
    document.body.classList.add("modal-open");
  }

  function ensureDispatchConfirmModal() {
    let overlay = document.getElementById("dispatchConfirmOverlay");

    if (overlay) {
      return overlay;
    }

    overlay = document.createElement("div");
    overlay.id = "dispatchConfirmOverlay";
    overlay.className = "modal-overlay hidden";

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        closeDispatchConfirmModal();
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function closeDispatchConfirmModal() {
    const overlay = document.getElementById("dispatchConfirmOverlay");

    if (overlay) {
      overlay.classList.add("hidden");
      overlay.innerHTML = "";
    }

    document.body.classList.remove("modal-open");
  }

  async function confirmDispatchIntervention(tableId) {
    const table = dashboardData.tables.find(function (item) {
      return item.id === tableId;
    });

    if (!table) {
      alert(`Table ${tableId} was not found.`);
      return;
    }

    try {
      downloadDispatchCsv(table);
      await resetWarningCountForTable(table, "dispatch");

      updateLocalWarningCount(table, 0);

      closeDispatchConfirmModal();
    } catch (error) {
      console.error("Failed to complete dispatch:", error);
      alert("Dispatch failed. The CSV file may have downloaded, but the warning count was not reset. Check Firebase write rules.");
    }
  }

  function showWarningResetModal(tableId) {
    const table = dashboardData.tables.find(function (item) {
      return item.id === tableId;
    });

    if (!table) {
      alert(`Table ${tableId} was not found.`);
      return;
    }

    const overlay = ensureWarningResetModal();

    if (table.warnings <= 0) {
      overlay.innerHTML = `
        <div class="dispatch-modal-card visual-modal-card no-warning-visual-card" role="dialog" aria-modal="true">
          <div class="visual-modal-hero no-warning-hero">
            <img
              src="${escapeHtml(NO_WARNINGS_IMAGE_SRC)}"
              alt="No warnings illustration"
              onerror="this.closest('.no-warning-hero').classList.add('image-missing'); this.remove();"
            />

            <div class="visual-modal-overlay no-warning-overlay"></div>

            <div class="visual-modal-badge no-warning-badge">
              <span class="material-symbols-outlined">check_circle</span>
              <strong>Clear</strong>
            </div>
          </div>

          <div class="visual-modal-content">
            <h3>No warnings recorded</h3>

            <p>
              Table ${escapeHtml(table.id)} currently has no active warnings to reset.
            </p>

            <div class="dispatch-modal-actions single-action">
              <button type="button" class="dispatch-cancel-btn modal-wide-btn" onclick="closeWarningResetModal()">
                Close
              </button>
            </div>
          </div>
        </div>
      `;

      overlay.classList.remove("hidden");
      document.body.classList.add("modal-open");
      return;
    }

    overlay.innerHTML = `
      <div class="dispatch-modal-card visual-modal-card reset-visual-card" role="dialog" aria-modal="true">
        <div class="reset-visual-icon">
          <span class="material-symbols-outlined">restart_alt</span>
        </div>

        <div class="visual-modal-content reset-visual-content">
          <h3>Reset warnings?</h3>

          <p>
            Are you sure you want to reset Table ${escapeHtml(table.id)}'s warning count?
          </p>

          <div class="visual-modal-mini-info">
            <span class="material-symbols-outlined">warning</span>
            <strong>Current warnings: ${table.warnings} / ${table.maxWarnings}</strong>
          </div>

          <div class="dispatch-modal-actions">
            <button type="button" class="dispatch-cancel-btn" onclick="closeWarningResetModal()">
              Cancel
            </button>

            <button type="button" class="dispatch-confirm-btn" onclick="confirmWarningReset('${escapeJsString(table.id)}')">
              Reset Warnings
            </button>
          </div>
        </div>
      </div>
    `;

    overlay.classList.remove("hidden");
    document.body.classList.add("modal-open");
  }

  function ensureWarningResetModal() {
    let overlay = document.getElementById("warningResetOverlay");

    if (overlay) {
      return overlay;
    }

    overlay = document.createElement("div");
    overlay.id = "warningResetOverlay";
    overlay.className = "modal-overlay hidden";

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        closeWarningResetModal();
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function closeWarningResetModal() {
    const overlay = document.getElementById("warningResetOverlay");

    if (overlay) {
      overlay.classList.add("hidden");
      overlay.innerHTML = "";
    }

    document.body.classList.remove("modal-open");
  }

  async function confirmWarningReset(tableId) {
    const table = dashboardData.tables.find(function (item) {
      return item.id === tableId;
    });

    if (!table) {
      alert(`Table ${tableId} was not found.`);
      return;
    }

    try {
      await resetWarningCountForTable(table, "manual_reset");
      updateLocalWarningCount(table, 0);
      closeWarningResetModal();
    } catch (error) {
      console.error("Failed to reset warning count:", error);
      alert("Warning reset failed. Check Firebase write rules.");
    }
  }

  function updateLocalWarningCount(table, count) {
    if (!isPlainObject(firebaseDevices[table.unitId])) {
      firebaseDevices[table.unitId] = {};
    }

    firebaseDevices[table.unitId].warning_count = count;
    firebaseDevices[table.unitId].last_warning_reset_local_at = Date.now();

    if (isPlainObject(firebaseDevices[table.unitId].audio)) {
      delete firebaseDevices[table.unitId].audio.warning_count;
      delete firebaseDevices[table.unitId].audio.warningCount;
      delete firebaseDevices[table.unitId].audio.warnings;
    }

    if (count < DEFAULT_MAX_WARNINGS) {
      threeStrikeAlertedTables.delete(table.id);
    }

    previousWarningCounts.set(table.id, count);

    dashboardData = mapFirebaseDevicesToDashboard(firebaseDevices);

    renderTables(searchInput ? searchInput.value : "");
    renderLogs();
    updateStats();
    updateSensorDisplay();
  }

  function downloadDispatchCsv(table) {
    const generatedAt = new Date();
    const safeTableId = String(table.id).replace(/[^a-z0-9_-]/gi, "_");
    const filename = `dispatch-intervention-table-${safeTableId}-${generatedAt.toISOString().slice(0, 10)}.csv`;

    const rows = [
      ["ScholarTrack Dispatch Intervention Report"],
      [],
      ["Table", table.id],
      ["Generated At", formatDateTime(generatedAt.getTime())],
      ["Warnings Before Dispatch", `${table.warnings} / ${table.maxWarnings}`],
      ["Total Seated Students", String(table.studentCount)],
      [],
      ["#", "Student Name", "ID Number", "Program", "Scanned At", "Raw QR Payload"]
    ];

    if (table.students.length > 0) {
      table.students.forEach(function (student, index) {
        rows.push([
          String(index + 1),
          student.name || "Registered Student",
          student.studentId || "No ID found",
          student.program || "Program not provided",
          student.scannedAt ? formatDateTime(normalizeTimestamp(student.scannedAt)) : "",
          student.payload || ""
        ]);
      });
    } else {
      rows.push(["", "No students were seated at this table during dispatch.", "", "", "", ""]);
    }

    const csv = rows.map(function (row) {
      return row.map(escapeCsvCell).join(",");
    }).join("\r\n");

    downloadBlob(
      "\ufeff" + csv,
      filename,
      "text/csv;charset=utf-8"
    );
  }

  async function resetWarningCountForTable(table, reason) {
    const databaseUrl = normalizeFirebaseUrl(FIREBASE_DB_URL);
    const unitPath = `devices/${encodeURIComponent(table.unitId)}`;
    const unitUrl = `${databaseUrl}/${unitPath}.json?print=silent`;
    const audioUrl = `${databaseUrl}/${unitPath}/audio.json?print=silent`;

    const rootPatch = {
      warning_count: 0,
      warningCount: null,
      warnings: null,
      last_warning_reset_reason: reason || "manual_reset",
      last_warning_reset_at: {
        ".sv": "timestamp"
      }
    };

    if (reason === "dispatch") {
      rootPatch.intervention_requested = false;
      rootPatch.last_dispatch_status = "completed";
      rootPatch.last_dispatch_at = {
        ".sv": "timestamp"
      };
    }

    const audioPatch = {
      warning_count: 0,
      warningCount: null,
      warnings: null
    };

    const rootResponse = await fetch(unitUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(rootPatch)
    });

    if (!rootResponse.ok) {
      throw new Error(`Root warning reset failed: ${rootResponse.status}`);
    }

    const audioResponse = await fetch(audioUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(audioPatch)
    });

    if (!audioResponse.ok) {
      throw new Error(`Audio warning reset failed: ${audioResponse.status}`);
    }
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  function escapeCsvCell(value) {
    const text = String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  }

  function getInitials(name) {
    const cleanName = String(name || "ST").trim();

    if (!cleanName || cleanName.toLowerCase() === "registered student") {
      return "ST";
    }

    const words = cleanName.split(/\s+/).filter(Boolean);

    if (words.length === 1) {
      return words[0].slice(0, 2).toUpperCase();
    }

    return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  }

  function getObjectEntries(value) {
    if (Array.isArray(value)) {
      return value
        .map(function (item, index) {
          return [String(index), item];
        })
        .filter(function ([, item]) {
          return item !== null && item !== undefined;
        });
    }

    if (isPlainObject(value)) {
      return Object.entries(value);
    }

    return [];
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function roundToOne(value) {
    return Math.round(value * 10) / 10;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function capitalize(value) {
    const text = String(value || "");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function sanitizeStatus(status) {
    const cleanStatus = String(status || "quiet").toLowerCase().trim();

    if (["quiet", "moderate", "critical"].includes(cleanStatus)) {
      return cleanStatus;
    }

    if (["noisy", "loud", "very_loud", "too_loud"].includes(cleanStatus)) {
      return "critical";
    }

    return "quiet";
  }

  function normalizeTimestamp(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
      return Date.now();
    }

    if (number < 10000000000) {
      return number * 1000;
    }

    return number;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
      return "--:--";
    }

    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatDateTime(timestamp) {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleString();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeJsString(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function normalizeFirebaseUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  window.goHome = goHome;
  window.generateReport = generateReport;
  window.showNotifications = showNotifications;
  window.showAccount = showAccount;
  window.dispatchIntervention = dispatchIntervention;
  window.showSeatedStudentsModal = showSeatedStudentsModal;
  window.closeStudentsModal = closeStudentsModal;
  window.confirmDispatchIntervention = confirmDispatchIntervention;
  window.closeDispatchConfirmModal = closeDispatchConfirmModal;
  window.showWarningResetModal = showWarningResetModal;
  window.confirmWarningReset = confirmWarningReset;
  window.closeWarningResetModal = closeWarningResetModal;
  window.toggleNoiseView = toggleNoiseView;
  window.refreshData = refreshData;
  window.closeThreeStrikeAlertModal = closeThreeStrikeAlertModal;
})();