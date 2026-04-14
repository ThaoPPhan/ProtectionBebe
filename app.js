const state = {
  connected: false,
  selectedPort: "",
  hrStreamOn: false,
  data: {
    T_BODY: null,
    HR: null,
    MOVE: null,
    T_AMB: null,
    HUM: null,
    CRY: 0,
    FIRE: 0,
    IR: null,
  },
  logs: [],
  lastRenderedLogs: "",
};

const ui = {
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  refreshPortsBtn: document.getElementById("refreshPortsBtn"),
  portSelect: document.getElementById("portSelect"),
  portStatus: document.getElementById("portStatus"),
  alarmPill: document.getElementById("alarmPill"),
  alarmStatus: document.getElementById("alarmStatus"),
  serialLog: document.getElementById("serialLog"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  rateRange: document.getElementById("rateRange"),
  rateValue: document.getElementById("rateValue"),
  sendRateBtn: document.getElementById("sendRateBtn"),
  readHrBtn: document.getElementById("readHrBtn"),
  toggleHrStreamBtn: document.getElementById("toggleHrStreamBtn"),
  hrControlStatus: document.getElementById("hrControlStatus"),
};

const metricIds = ["T_BODY", "HR", "MOVE", "T_AMB", "HUM", "CRY", "FIRE", "IR"];

let audioContext = null;

function setConnectionUi(connected) {
  ui.connectBtn.disabled = connected;
  ui.disconnectBtn.disabled = !connected;
  ui.portSelect.disabled = connected;
  ui.refreshPortsBtn.disabled = connected;
  ui.rateRange.disabled = !connected;
  ui.sendRateBtn.disabled = !connected;
  ui.readHrBtn.disabled = !connected;
  ui.toggleHrStreamBtn.disabled = !connected;
  ui.portStatus.textContent = connected ? "Connecte" : "Non connecte";

  if (!connected) {
    state.hrStreamOn = false;
    syncHrControlUi();
  }
}

function syncHrControlUi() {
  ui.toggleHrStreamBtn.textContent = state.hrStreamOn ? "Mode continu: ON" : "Mode continu: OFF";
  ui.hrControlStatus.textContent = state.hrStreamOn ? "Lecture continue active" : "Inactif";
}

function updateMetricUI() {
  for (const id of metricIds) {
    const el = document.getElementById(id);
    const value = state.data[id];
    if (value === null || value === undefined) {
      continue;
    }
    if (id === "MOVE" || id === "CRY" || id === "FIRE") {
      el.textContent = Number(value) === 1 ? "OUI" : "NON";
    } else if (id === "HR") {
      el.innerHTML = `${value} <small>bpm</small>`;
    } else if (id === "IR") {
      // Capteur 18-bit (MAX30102) : valeur brute max = 262143
      const IR_MAX = 262143;
      const pct = Math.min(100, Math.round((Number(value) / IR_MAX) * 100));
      el.innerHTML = `${pct} <small>%</small>`;
    } else {
      el.textContent = value;
    }
  }
}

function evaluateAlarm() {
  const { T_BODY, HR, CRY, FIRE } = state.data;

  const hrHighLow = HR !== null && (Number(HR) < 100 || Number(HR) > 180);
  const tempHighLow = T_BODY !== null && (Number(T_BODY) < 36.0 || Number(T_BODY) > 37.8);
  const danger = Number(CRY) === 1 || Number(FIRE) === 1 || hrHighLow || tempHighLow;

  ui.alarmPill.dataset.state = danger ? "danger" : "safe";
  ui.alarmStatus.textContent = danger ? "ALERTE" : "SAFE";

  if (danger) {
    playBeep();
  }
}

function playBeep() {
  if (!audioContext) {
    audioContext = new window.AudioContext();
  }
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 760;
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.2);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.2);
}

function parseLine(line) {
  const clean = line.trim();
  if (!clean || !clean.includes(":")) {
    return;
  }
  const [rawKey, rawValue] = clean.split(":");
  const key = rawKey.trim();
  const value = rawValue.trim();
  if (!metricIds.includes(key)) {
    return;
  }
  state.data[key] = value;
  updateMetricUI();
  evaluateAlarm();
}

function renderLogs() {
  const content = state.logs.join("\n");
  if (content !== state.lastRenderedLogs) {
    ui.serialLog.textContent = content;
    ui.serialLog.scrollTop = ui.serialLog.scrollHeight;
    state.lastRenderedLogs = content;
  }
}

function populatePorts(ports) {
  ui.portSelect.innerHTML = "";
  if (!ports.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Aucun port detecte";
    ui.portSelect.appendChild(opt);
    ui.connectBtn.disabled = true;
    return;
  }

  for (const p of ports) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    ui.portSelect.appendChild(opt);
  }
  ui.connectBtn.disabled = false;
  state.selectedPort = ports[0];
}

async function refreshPorts() {
  try {
    const response = await fetch("/api/ports");
    if (!response.ok) {
      throw new Error("Impossible de recuperer les ports");
    }
    const payload = await response.json();
    populatePorts(payload.ports || []);
  } catch (error) {
    alert(`Erreur ports: ${error.message}`);
  }
}

async function connectSerial() {
  const port = ui.portSelect.value;
  if (!port) {
    alert("Selectionne un port d abord.");
    return;
  }

  try {
    const response = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port, baudrate: 115200 }),
    });
    if (!response.ok) {
      const details = await response.json();
      throw new Error(details.error || "Connexion STM32 impossible");
    }
    setConnectionUi(true);
  } catch (error) {
    alert(`Erreur connexion: ${error.message}`);
  }
}

async function disconnectSerial() {
  try {
    const response = await fetch("/api/disconnect", { method: "POST" });
    if (!response.ok) {
      throw new Error("Deconnexion impossible");
    }
    setConnectionUi(false);
  } catch (error) {
    alert(`Erreur deconnexion: ${error.message}`);
  }
}

async function pollState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) {
      throw new Error("Etat indisponible");
    }
    const payload = await response.json();
    state.connected = Boolean(payload.connected);
    state.data = { ...state.data, ...(payload.metrics || {}) };
    state.logs = payload.logs || [];

    if (state.connected) {
      setConnectionUi(true);
      ui.portStatus.textContent = `Connecte (${payload.port || "-"})`;
    } else {
      setConnectionUi(false);
    }

    updateMetricUI();
    evaluateAlarm();
    renderLogs();
  } catch (error) {
    ui.portStatus.textContent = "Serveur indisponible";
  }
}

async function sendCommand(command) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error || "Commande refusee");
  }
}

async function readHeartRateOnce() {
  try {
    await sendCommand("GET_HR");
    ui.hrControlStatus.textContent = "Demande HR envoyee";
  } catch (error) {
    alert(`Erreur heart rate: ${error.message}`);
  }
}

async function toggleHeartRateStream() {
  const nextState = !state.hrStreamOn;
  try {
    await sendCommand(`HR_STREAM:${nextState ? 1 : 0}`);
    state.hrStreamOn = nextState;
    syncHrControlUi();
  } catch (error) {
    alert(`Erreur mode heart rate: ${error.message}`);
  }
}

ui.connectBtn.addEventListener("click", async () => {
  await connectSerial();
});

ui.disconnectBtn.addEventListener("click", async () => {
  await disconnectSerial();
});

ui.clearLogBtn.addEventListener("click", () => {
  state.logs = [];
  state.lastRenderedLogs = "";
  ui.serialLog.textContent = "";
});

ui.refreshPortsBtn.addEventListener("click", async () => {
  await refreshPorts();
});

ui.portSelect.addEventListener("change", (event) => {
  state.selectedPort = event.target.value;
});

ui.rateRange.addEventListener("input", (event) => {
  ui.rateValue.textContent = `${event.target.value} Hz`;
});

ui.sendRateBtn.addEventListener("click", async () => {
  const hz = ui.rateRange.value;
  try {
    await sendCommand(`SET_RATE:${hz}`);
  } catch (error) {
    alert(`Erreur commande: ${error.message}`);
  }
});

ui.readHrBtn.addEventListener("click", async () => {
  await readHeartRateOnce();
});

ui.toggleHrStreamBtn.addEventListener("click", async () => {
  await toggleHeartRateStream();
});

setConnectionUi(false);
syncHrControlUi();
refreshPorts();
pollState();
setInterval(pollState, 350);
