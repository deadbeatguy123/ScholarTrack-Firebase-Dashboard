(function () {
  "use strict";

  const FIREBASE_DB_URL = "https://micropit-91298-default-rtdb.asia-southeast1.firebasedatabase.app";

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

  let firebaseDevices = {};
  let dashboardData = createEmptyDashboardData();
  let refreshInterval = DEFAULT_REFRESH_INTERVAL_MS;
  let autoRefreshTimer = null;
  let lastSuccessfulFetchAt = null;

  let sidebar = null;
  let mobileMenuToggle = null;
  let tablesGrid = null;
  let searchInput = null;
  let refreshIntervalSelect = null;
  let logsContainer = null;

  document.addEventListener("DOMContentLoaded", function () {
    initializeElements();
    setupEventListeners();
    renderEmptyDashboard();
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
    sidebar = document.getElementById("sidebar");
    mobileMenuToggle = document.getElementById("mobileMenuToggle");
    tablesGrid = document.getElementById("tablesGrid");
    searchInput = document.getElementById("searchInput");
    refreshIntervalSelect = document.getElementById("refreshInterval");
    logsContainer = document.querySelector(".logs-container");
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
      });
    }

    if (refreshIntervalSelect) {
      refreshIntervalSelect.addEventListener("change", updateRefreshInterval);
    }

    document.addEventListener("click", function (event) {
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
    });

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

  function renderEmptyDashboard() {
    firebaseDevices = {};
    dashboardData = mapFirebaseDevicesToDashboard(firebaseDevices);

    renderTables();
    renderLogs();
    updateStats();
    updateSensorDisplay();
    updateConnectionStatus(false, "Waiting for Firebase");
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

      renderTables(searchInput ? searchInput.value : "");
      renderLogs();
      updateStats();
      updateSensorDisplay();
      updateConnectionStatus(true, "Connected");
    } catch (error) {
      console.error("Firebase fetch error:", error);
      updateConnectionStatus(false, "Firebase read failed");
    }
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

      let warnings = 0;
      let status = "quiet";

      /*
        Strict rule:
        QR entries mean the table is occupied.
        Audio alone does not make a table occupied.
      */
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
        noiseLevel: toNumber(audio.received_db, 0),
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

    /*
      ESP32 audio.level is only the current sound state.
      It is NOT the accumulated warning count.
    */
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
    const manualStatus = String(audio.status || "").toLowerCase();

    if (["quiet", "moderate", "noisy"].includes(manualStatus)) {
      return manualStatus;
    }

    const receivedDb = toNumber(audio.received_db, 0);
    const noisyThreshold = toNumber(audio.noisy_threshold, 83);
    const loudThreshold = toNumber(audio.loud_threshold, 90);

    if (receivedDb >= loudThreshold) {
      return "noisy";
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
    if (table.available) {
      return createAvailableTableCard(table);
    }

    const isCritical = table.status === "critical" || table.warnings >= table.maxWarnings;
    const statusClass = sanitizeStatus(isCritical ? "critical" : table.status);
    const statusLabel = isCritical ? "Critical" : capitalize(statusClass);

    const firstStudent = table.students[0] || null;
    const studentSubtext = firstStudent
      ? getStudentSubtext(firstStudent, table.studentCount)
      : "QR registered";

    return `
      <article class="table-card smart-table-card ${isCritical ? "critical" : ""}">
        <div class="smart-card-header">
          <div class="smart-seat-icon">
            <span class="material-symbols-outlined">event_seat</span>
          </div>

          <h4 class="smart-table-title">Table ${escapeHtml(table.id)}</h4>

          <div class="smart-status-pill ${statusClass}">
            <span class="smart-status-dot"></span>
            <span>${escapeHtml(statusLabel)}</span>
          </div>
        </div>

        <div class="smart-card-content">
          <section class="smart-warning-box ${isCritical ? "critical" : ""}">
            <div class="smart-warning-row">
              <div class="smart-warning-icon">
                <span class="material-symbols-outlined">warning</span>
              </div>

              <div class="smart-warning-title">Warnings</div>

              <div class="smart-warning-bars">
                ${generateWarningBars(table.warnings, table.maxWarnings)}
              </div>

              <div class="smart-warning-count">${table.warnings} / ${table.maxWarnings}</div>
            </div>

            ${
              isCritical
                ? `
                  <button
                    class="smart-dispatch-btn"
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
            class="smart-students-box"
            type="button"
            onclick="showSeatedStudentsModal('${escapeJsString(table.id)}')"
            aria-label="View seated students for Table ${escapeHtml(table.id)}"
          >
            <div class="smart-students-label">
              <span class="smart-students-icon">
                <span class="material-symbols-outlined">groups</span>
              </span>
              <span>Seated Students</span>
            </div>

            <div class="smart-students-main">
              <div class="smart-avatar">
                ${escapeHtml(firstStudent ? firstStudent.initials : "ST")}
              </div>

              <div class="smart-student-text">
                <p>${table.studentCount} student${table.studentCount !== 1 ? "s" : ""}</p>
                <span>${escapeHtml(studentSubtext)}</span>
              </div>

              <div class="smart-mini-chart" aria-hidden="true">
                <i></i>
                <i></i>
                <i></i>
              </div>
            </div>
          </button>
        </div>
      </article>
    `;
  }

  function createAvailableTableCard(table) {
    return `
      <article class="table-card smart-table-card smart-available-card available">
        <div class="smart-card-header">
          <div class="smart-seat-icon muted">
            <span class="material-symbols-outlined">event_seat</span>
          </div>

          <h4 class="smart-table-title">Table ${escapeHtml(table.id)}</h4>

          <div class="smart-status-pill quiet">
            <span class="smart-status-dot"></span>
            <span>Quiet</span>
          </div>
        </div>

        <div class="smart-available-body">
          <span class="material-symbols-outlined">event_seat</span>
          <p>Available</p>
        </div>
      </article>
    `;
  }

  function generateWarningBars(warnings, maxWarnings) {
    let bars = "";

    for (let i = 0; i < maxWarnings; i += 1) {
      bars += `<span class="warning-bar-segment ${i < warnings ? "active" : ""}"></span>`;
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
      return row.map(function (cell) {
        return `"${String(cell).replaceAll('"', '""')}"`;
      }).join(",");
    }).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `scholartrack-report-${new Date().toISOString().slice(0, 10)}.csv`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  function showNotifications() {
    const activeTables = dashboardData.tables.filter(function (table) {
      return table.studentCount > 0 && (table.status === "noisy" || table.status === "critical");
    });

    if (activeTables.length === 0) {
      alert("No active noisy or critical occupied tables.");
      return;
    }

    alert(activeTables.map(function (table) {
      return `${capitalize(table.status)}: Table ${table.id}`;
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
    overlay.className = "student-modal-overlay hidden";

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
      <div class="dispatch-modal-card" role="dialog" aria-modal="true">
        <div class="dispatch-modal-icon">
          <span class="material-symbols-outlined">warning</span>
        </div>

        <h3>Dispatch intervention?</h3>

        <p>
         This will mark Table ${escapeHtml(table.id)} as handled and reset its warning count.
        </p>

        <div class="dispatch-modal-summary">
          <div>
            <span>Table</span>
            <strong>${escapeHtml(table.id)}</strong>
          </div>

          <div>
            <span>Current warnings</span>
            <strong>${table.warnings} / ${table.maxWarnings}</strong>
          </div>

          <div>
            <span>Seated students</span>
            <strong>${table.studentCount}</strong>
          </div>
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
    overlay.className = "dispatch-modal-overlay hidden";

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
      await resetWarningCountForTable(table);

      if (!isPlainObject(firebaseDevices[table.unitId])) {
        firebaseDevices[table.unitId] = {};
      }

      firebaseDevices[table.unitId].warning_count = 0;
      firebaseDevices[table.unitId].last_dispatch_status = "completed";
      firebaseDevices[table.unitId].last_dispatch_local_at = Date.now();

      if (isPlainObject(firebaseDevices[table.unitId].audio)) {
        delete firebaseDevices[table.unitId].audio.warning_count;
        delete firebaseDevices[table.unitId].audio.warningCount;
        delete firebaseDevices[table.unitId].audio.warnings;
      }

      dashboardData = mapFirebaseDevicesToDashboard(firebaseDevices);

      renderTables(searchInput ? searchInput.value : "");
      renderLogs();
      updateStats();
      updateSensorDisplay();

      closeDispatchConfirmModal();
    } catch (error) {
      console.error("Failed to reset warning count:", error);
      alert("Dispatch failed. Warning count was not reset. Check Firebase write rules.");
    }
  }

  async function resetWarningCountForTable(table) {
    const databaseUrl = normalizeFirebaseUrl(FIREBASE_DB_URL);
    const unitPath = `devices/${encodeURIComponent(table.unitId)}`;
    const unitUrl = `${databaseUrl}/${unitPath}.json?print=silent`;
    const audioUrl = `${databaseUrl}/${unitPath}/audio.json?print=silent`;

    const rootPatch = {
      warning_count: 0,
      warningCount: null,
      warnings: null,
      intervention_requested: false,
      last_dispatch_status: "completed",
      last_dispatch_at: {
        ".sv": "timestamp"
      }
    };

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

  function getStudentSubtext(student, studentCount) {
    const parts = [];

    if (student.studentId) {
      parts.push(`ID: ${student.studentId}`);
    }

    if (student.program) {
      parts.push(student.program);
    }

    if (studentCount > 1) {
      parts.push(`${studentCount} QR entries`);
    }

    return parts.length > 0 ? parts.join(" · ") : "QR registered";
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

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function capitalize(value) {
    const text = String(value || "");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function sanitizeStatus(status) {
    const cleanStatus = String(status || "quiet").toLowerCase();

    if (["quiet", "moderate", "noisy", "critical"].includes(cleanStatus)) {
      return cleanStatus;
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

  window.generateReport = generateReport;
  window.showNotifications = showNotifications;
  window.showAccount = showAccount;
  window.dispatchIntervention = dispatchIntervention;
  window.showSeatedStudentsModal = showSeatedStudentsModal;
  window.closeStudentsModal = closeStudentsModal;
  window.confirmDispatchIntervention = confirmDispatchIntervention;
  window.closeDispatchConfirmModal = closeDispatchConfirmModal;
  window.refreshData = refreshData;
})();