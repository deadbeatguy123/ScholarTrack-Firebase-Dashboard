// ScholarTrack Firebase-only Dashboard
// Architecture: ESP32 readings / QR scans -> Firebase Realtime Database -> Website
// This file intentionally does NOT use /api/dashboard, /api/sensors, /api/command,

(function () {
  "use strict";

  console.log("ScholarTrack Firebase-only dashboard loaded.");

  /*
    CHANGE THIS ONLY IF YOUR FIREBASE REALTIME DATABASE URL IS DIFFERENT.

    Expected Firebase path:
    devices/unit_A/audio
    devices/unit_A/qr_codes

    Confirmed project mapping:
    devices/unit_A -> Table A1
  */
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
  let refreshInterval = DEFAULT_REFRESH_INTERVAL_MS;
  let autoRefreshTimer = null;
  let lastSuccessfulFetchAt = null;

  let dashboardData = createEmptyDashboardData();

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
        temperature: 0,
        humidity: 0,
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

    window.addEventListener("online", function () {
      refreshData();
    });

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

    window.addEventListener("beforeunload", function () {
      stopAutoRefresh();
    });
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

    if (!databaseUrl) {
      updateConnectionStatus(false, "Missing Firebase URL");
      console.error("FIREBASE_DB_URL is empty or invalid.");
      return;
    }

    try {
      const response = await fetch(`${databaseUrl}/devices.json?ts=${Date.now()}`, {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`Firebase read failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (isPlainObject(data) && data.error) {
        throw new Error(`Firebase error: ${data.error}`);
      }

      firebaseDevices = isPlainObject(data) ? data : {};
      lastSuccessfulFetchAt = Date.now();

      dashboardData = mapFirebaseDevicesToDashboard(firebaseDevices);

      console.log("Firebase devices:", firebaseDevices);
      console.log("Mapped dashboard tables:", dashboardData.tables);

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
      const device = isPlainObject(devices[tableConfig.unitId]) ? devices[tableConfig.unitId] : {};
      const audio = isPlainObject(device.audio) ? device.audio : {};

      const students = getCurrentStudentsFromDevice(device);
      const studentCount = students.length;
      const available = studentCount === 0;

      /*
        Strict occupancy rule:
        - qr_codes/current_students entries make a table occupied.
        - Audio alone never makes a table occupied.
        - Missing devices such as unit_B, unit_C, etc. stay Available.
      */
      let warnings = 0;
      let status = "quiet";

      if (!available) {
        warnings = getWarningCount(device, DEFAULT_MAX_WARNINGS);
        status = getStatusFromAudio(audio, warnings, DEFAULT_MAX_WARNINGS);
      }

      return {
        id: tableConfig.id,
        unitId: tableConfig.unitId,
        status: status,
        warnings: warnings,
        maxWarnings: DEFAULT_MAX_WARNINGS,
        studentCount: studentCount,
        students: students,
        available: available,
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
      tables: tables,
      occupancy: {
        current: currentOccupancy,
        max: tables.length * SEATS_PER_TABLE
      },
      warnings: activeWarnings,
      sensors: {
        temperature: 0,
        humidity: 0,
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
      key: key,
      payload: payload,
      name: name,
      studentId: studentId,
      program: program,
      scannedAt: scannedAt,
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
      audio.level ??
      0;

    return clamp(Math.round(toNumber(rawWarnings, 0)), 0, maxWarnings);
  }

  function getStatusFromAudio(audio, warnings, maxWarnings) {
    if (warnings >= maxWarnings) {
      return "critical";
    }

    const manualStatus = String(audio.status || "").toLowerCase();

    if (["quiet", "moderate", "noisy", "critical"].includes(manualStatus)) {
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

    if (filteredTables.length === 0) {
      tablesGrid.innerHTML = `
        <div class="table-card available">
          <div class="available-content">
            <span class="available-text">No matching table found</span>
          </div>
        </div>
      `;
      return;
    }

    tablesGrid.innerHTML = filteredTables.map(function (table) {
      return createTableCard(table);
    }).join("");
  }

  function createTableCard(table) {
    if (table.available) {
      return createAvailableTableCard(table);
    }

    const isCritical = table.status === "critical";
    const statusClass = sanitizeStatus(table.status);
    const statusLabel = isCritical ? "Critical" : capitalize(statusClass);

    const firstStudent = table.students[0] || null;
    const studentSubtext = firstStudent
      ? getStudentSubtext(firstStudent, table.studentCount)
      : "QR registered";

    return `
      <div class="table-card ${isCritical ? "critical" : ""}">
        <div class="table-header ${isCritical ? "critical-header" : ""}">
          <span class="table-name">Table ${escapeHtml(table.id)}</span>

          <div class="table-status">
            ${isCritical ? "" : `<span class="status-indicator ${statusClass}"></span>`}
            <span class="status-text ${statusClass}">${escapeHtml(statusLabel)}</span>
            ${isCritical ? '<span class="material-symbols-outlined">warning</span>' : ""}
          </div>
        </div>

        <div class="${isCritical ? "critical-content" : "table-content"}">
          <div class="warnings-section">
            <span class="warnings-label ${isCritical ? "critical-warnings-label" : ""}">Warnings</span>

            <div class="warnings-bar">
              ${generateWarningBars(table.warnings, table.maxWarnings)}
              <span class="warnings-count">${table.warnings}/${table.maxWarnings}</span>
            </div>
          </div>

          <div class="students-section">
            <span class="students-label">Seated Students</span>

            <div class="student-item">
              <div class="student-info">
                <div class="student-avatar avatar-primary">ST</div>

                <div class="student-details">
                  <p class="student-name ${isCritical ? "critical-student-name" : ""}">
                    ${table.studentCount} student${table.studentCount !== 1 ? "s" : ""}
                  </p>

                  <p class="student-id ${isCritical ? "critical-student-id" : ""}">
                    ${escapeHtml(studentSubtext)}
                  </p>
                </div>
              </div>

              <div class="student-actions">
                <span class="material-symbols-outlined">more_vert</span>
              </div>
            </div>
          </div>

          ${isCritical ? `<button class="intervention-btn" onclick="dispatchIntervention('${escapeJsString(table.id)}')">Dispatch Intervention</button>` : ""}
        </div>
      </div>
    `;
  }

  function createAvailableTableCard(table) {
    return `
      <div class="table-card available">
        <div class="table-header">
          <span class="table-name">Table ${escapeHtml(table.id)}</span>

          <div class="table-status">
            <span class="status-indicator quiet"></span>
            <span class="status-text quiet">Quiet</span>
          </div>
        </div>

        <div class="available-content">
          <span class="material-symbols-outlined available-icon">event_seat</span>
          <span class="available-text">Available</span>
        </div>
      </div>
    `;
  }

  function generateWarningBars(warnings, maxWarnings) {
    let bars = "";

    for (let i = 0; i < maxWarnings; i += 1) {
      bars += `<div class="warning-bar-segment ${i < warnings ? "active" : ""}"></div>`;
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
    const lastUpdateText = lastSuccessfulFetchAt ? ` · Updated ${formatTime(lastSuccessfulFetchAt)}` : "";

    sensorDataElement.textContent = `Noise: ${noiseLevel.toFixed(2)}dB${lastUpdateText}`;
  }

  function updateConnectionStatus(connected, text = "") {
    const statusElement = document.getElementById("connectionStatus");

    if (!statusElement) {
      return;
    }

    statusElement.textContent = text || (connected ? "Connected" : "Offline");
    statusElement.style.color = connected ? "#10b981" : "#ba1a1a";
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
    if (!page) {
      return;
    }

    document.querySelectorAll(".page").forEach(function (pageElement) {
      pageElement.classList.add("hidden");
    });

    const selectedPage = document.getElementById(`${page}Page`);

    if (selectedPage) {
      selectedPage.classList.remove("hidden");
    } else {
      const overviewPage = document.getElementById("overviewPage");
      if (overviewPage) {
        overviewPage.classList.remove("hidden");
      }
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

    const message = activeTables.map(function (table) {
      return `${capitalize(table.status)}: Table ${table.id}`;
    }).join("\n");

    alert(message);
  }

  function showAccount() {
    alert("ScholarTrack Firebase website dashboard.");
  }

  function dispatchIntervention(tableId) {
    alert(`Intervention noted for Table ${tableId}.`);
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
  window.refreshData = refreshData;
})();