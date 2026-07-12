import { db, ensureFirebaseSession } from "./firebase.js";
import {
  collection, doc, query, where, orderBy, onSnapshot,
  getDoc, getDocs, getCountFromServer, addDoc, deleteDoc, updateDoc, setDoc,
  runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

/* ==========================================================================
   State
   ========================================================================== */
const LS_KEY = "gbf_user";
let currentUser = null;          // { id, name, role }
let sessionPersist = true;       // "keep me logged in": localStorage vs sessionStorage

function saveSession(user) {
  const s = JSON.stringify(user);
  if (sessionPersist) {
    localStorage.setItem(LS_KEY, s);
    sessionStorage.removeItem(LS_KEY);
  } else {
    sessionStorage.setItem(LS_KEY, s);
    localStorage.removeItem(LS_KEY);
  }
}

function clearSession() {
  localStorage.removeItem(LS_KEY);
  sessionStorage.removeItem(LS_KEY);
}
let unsubscribeFeed = null;
let unsubscribeMembers = null;
let unsubscribeStats = null;
let allSessions = [];   // full session history (for stats)
let membersDocs = [];   // latest users snapshot (shared by members + stats views)
let pendingSignup = null;        // holds {name, pin} while waiting for confirm tap
const cardEls = new Map();       // sessionId -> card element
const sessionsCache = new Map(); // sessionId -> latest data (feeds the admin edit list)
let editingId = null;            // session currently open in the admin edit form
let countdownTimer = null;

const usersCol = collection(db, "users");
const sessionsCol = collection(db, "sessions");

/* ---- Tournament (GB Futsal Season 4) ---- */
const regsCol = collection(db, "tournamentRegs");
const teamsCol = collection(db, "tournamentTeams");
const tourneyConfigRef = doc(db, "tournament", "season4");
let unsubscribeRegs = null;
let unsubscribeTeams = null;
let unsubscribeTourneyConfig = null;
let regsDocs = [];    // latest tournamentRegs snapshot
let teamsDocs = [];   // latest tournamentTeams snapshot
let editingRegId = null;   // registration open in the admin inline editor
let editingTeamId = null;  // team row open in the admin inline editor

const BATCHES = [
  { key: "b2021", label: "Batch 2021 onwards" },
  { key: "b2022", label: "Batch 2022" },
  { key: "b2023", label: "Batch 2023" },
  { key: "b2024", label: "Batch 2024" }
];
const batchLabel = key => BATCHES.find(b => b.key === key)?.label || key;
const POSITIONS = ["Goalkeeper", "Defender", "Midfielder", "Forward"];

const TOURNEY_DEFAULTS = {
  dateText: "Saturday (18th July) 4:30PM",
  deadlineText: "Tuesday (14th July) 6:00 PM",
  locationText: "Bashundhara Sports City",
  fees: { b2021: null, b2022: null, b2023: null, b2024: null },
  bkash: [
    { name: "Rezwan Talha", number: "01590097375" },
    { name: "Rakin Ahmed", number: "01997892233" }
  ]
};
let tourneyConfig = structuredClone(TOURNEY_DEFAULTS);

/* ==========================================================================
   Small helpers
   ========================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function normalizeName(raw) {
  return raw.trim().replace(/\s+/g, " ");
}

// PIN is hashed (salted with the lowercase name) before it ever leaves the
// browser — the raw 4-digit PIN is never stored in Firestore.
async function hashPin(nameLower, pin) {
  const data = new TextEncoder().encode(`${nameLower}::${pin}::gbf`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* Downscale an image file to a small square JPEG data-URL (~10 KB) so it can
   live inside the Firestore user document — no Firebase Storage needed. */
function fileToPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const S = 160;
      const canvas = document.createElement("canvas");
      canvas.width = S; canvas.height = S;
      const ctx = canvas.getContext("2d");
      const side = Math.min(img.width, img.height); // center-crop to square
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      let q = 0.82, out = canvas.toDataURL("image/jpeg", q);
      while (out.length > 60000 && q > 0.3) { q -= 0.12; out = canvas.toDataURL("image/jpeg", q); }
      out.length > 60000 ? reject(new Error("too-big")) : resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad-image")); };
    img.src = url;
  });
}

function setAvatar(el, photo, name) {
  el.innerHTML = "";
  if (photo) {
    const img = document.createElement("img");
    img.src = photo;
    img.alt = name;
    el.appendChild(img);
  } else {
    el.textContent = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  }
}

/* Animated count-up for the big stat numbers */
function animateNumber(el, target, format = (n) => n.toLocaleString()) {
  const from = el._shown ?? 0;
  if (from === target) { el.textContent = format(target); return; }
  el._shown = target;
  const t0 = performance.now(), dur = 900;
  cancelAnimationFrame(el._raf);
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = format(Math.round(from + (target - from) * eased));
    if (p < 1) el._raf = requestAnimationFrame(tick);
  };
  el._raf = requestAnimationFrame(tick);
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function setLoading(btn, on) {
  btn.classList.toggle("loading", on);
  btn.disabled = on;
}

function switchScreen(hideEl, showEl) {
  hideEl.classList.add("leaving");
  setTimeout(() => {
    hideEl.classList.add("hidden");
    hideEl.classList.remove("leaving");
    showEl.classList.remove("hidden");
  }, 330);
}

/* ==========================================================================
   Auth screen
   ========================================================================== */
const authScreen = $("#auth-screen");
const appScreen = $("#app-screen");
const authForm = $("#auth-form");
const authBtn = $("#auth-btn");
const authBtnLabel = $("#auth-btn-label");
const authSub = $("#auth-sub");
const authError = $("#auth-error");
const nameInput = $("#auth-name");
const pinBoxes = $$(".pin-box");

// PIN boxes: auto-advance, backspace to previous, digits only
pinBoxes.forEach((box, i) => {
  box.addEventListener("input", () => {
    box.value = box.value.replace(/\D/g, "").slice(0, 1);
    box.classList.toggle("filled", !!box.value);
    if (box.value && i < 3) pinBoxes[i + 1].focus();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !box.value && i > 0) pinBoxes[i - 1].focus();
  });
  box.addEventListener("paste", (e) => {
    e.preventDefault();
    const digits = (e.clipboardData.getData("text").match(/\d/g) || []).slice(0, 4);
    digits.forEach((d, j) => {
      if (pinBoxes[j]) { pinBoxes[j].value = d; pinBoxes[j].classList.add("filled"); }
    });
    pinBoxes[Math.min(digits.length, 3)].focus();
  });
});

function getPin() {
  return pinBoxes.map(b => b.value).join("");
}

/* Optional profile photo at signup */
let pendingPhoto = null;
const photoInput = $("#photo-input");
$("#photo-btn").addEventListener("click", () => photoInput.click());
photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  photoInput.value = "";
  if (!file) return;
  try {
    pendingPhoto = await fileToPhoto(file);
    const prev = $("#photo-preview");
    prev.innerHTML = `<img src="${pendingPhoto}" alt="preview" />`;
    $("#photo-btn").textContent = "Change photo";
    $("#photo-clear").classList.remove("hidden");
  } catch {
    toast("Couldn't read that image — try another one.", true);
  }
});
$("#photo-clear").addEventListener("click", () => {
  pendingPhoto = null;
  $("#photo-preview").innerHTML = "📷";
  $("#photo-btn").textContent = "Add a profile photo";
  $("#photo-clear").classList.add("hidden");
});

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.add("show");
  $("#auth-card").classList.add("shake");
  setTimeout(() => $("#auth-card").classList.remove("shake"), 500);
}

function resetSignupMode() {
  pendingSignup = null;
  authBtn.classList.remove("confirm-mode");
  authBtnLabel.textContent = "Let's play";
  authSub.textContent = "Enter your name and PIN to jump in";
  authSub.classList.remove("notice");
}

nameInput.addEventListener("input", resetSignupMode);

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.classList.remove("show");

  const name = normalizeName(nameInput.value);
  const pin = getPin();
  if (name.length < 2) return showAuthError("Name needs at least 2 characters.");
  if (!/^\d{4}$/.test(pin)) return showAuthError("Enter all 4 PIN digits.");

  const nameLower = name.toLowerCase();
  setLoading(authBtn, true);

  try {
    await ensureFirebaseSession();
    const pinHash = await hashPin(nameLower, pin);

    // Two-step signup: first tap checks the name; if it's new, the button
    // morphs into an amber "confirm" state so a typo can't silently create
    // a fresh account.
    if (pendingSignup && pendingSignup.name === name && pendingSignup.pin === pin) {
      await createAccount(name, nameLower, pinHash);
      return;
    }

    const snap = await getDocs(query(usersCol, where("nameLower", "==", nameLower)));

    if (snap.empty) {
      pendingSignup = { name, pin };
      authBtn.classList.add("confirm-mode");
      authBtnLabel.textContent = `New player — tap to create "${name}"`;
      authSub.textContent = "No account with that name yet.";
      authSub.classList.add("notice");
      setLoading(authBtn, false);
      return;
    }

    const userDoc = snap.docs[0];
    if (userDoc.data().pinHash !== pinHash) {
      setLoading(authBtn, false);
      return showAuthError("Wrong PIN for that name.");
    }

    loginAs({ id: userDoc.id, name: userDoc.data().name, role: userDoc.data().role });
    toast(`Welcome back, ${userDoc.data().name}! ⚽`);
  } catch (err) {
    console.error(err);
    setLoading(authBtn, false);
    showAuthError("Connection problem — try again.");
  }
});

async function createAccount(name, nameLower, pinHash) {
  // First person to ever sign up becomes the admin.
  const countSnap = await getCountFromServer(usersCol);
  const role = countSnap.data().count === 0 ? "admin" : "member";

  const ref = await addDoc(usersCol, {
    name, nameLower, pinHash, role, createdAt: serverTimestamp(),
    ...(pendingPhoto ? { photo: pendingPhoto } : {})
  });

  loginAs({ id: ref.id, name, role });
  toast(role === "admin"
    ? `Account created — you're the Admin, ${name}! 👑`
    : `Welcome to the squad, ${name}! ⚽`);
}

function loginAs(user) {
  currentUser = user;
  sessionPersist = $("#remember-me").checked;
  saveSession(user);
  pendingPhoto = null;
  $("#photo-preview").innerHTML = "📷";
  $("#photo-btn").textContent = "Add a profile photo";
  $("#photo-clear").classList.add("hidden");
  resetSignupMode();
  setLoading(authBtn, false);
  enterApp();
}

$("#logout-btn").addEventListener("click", () => {
  clearSession();
  currentUser = null;
  if (unsubscribeFeed) { unsubscribeFeed(); unsubscribeFeed = null; }
  if (unsubscribeMembers) { unsubscribeMembers(); unsubscribeMembers = null; }
  if (unsubscribeStats) { unsubscribeStats(); unsubscribeStats = null; }
  if (unsubscribeRegs) { unsubscribeRegs(); unsubscribeRegs = null; }
  if (unsubscribeTeams) { unsubscribeTeams(); unsubscribeTeams = null; }
  if (unsubscribeTourneyConfig) { unsubscribeTourneyConfig(); unsubscribeTourneyConfig = null; }
  allSessions = [];
  membersDocs = [];
  regsDocs = [];
  teamsDocs = [];
  editingRegId = null;
  editingTeamId = null;
  clearInterval(countdownTimer);
  cardEls.clear();
  sessionsCache.clear();
  editingId = null;
  $("#feed").innerHTML = "";
  authForm.reset();
  pinBoxes.forEach(b => { b.value = ""; b.classList.remove("filled"); });
  switchScreen(appScreen, authScreen);
});

/* ==========================================================================
   Main app
   ========================================================================== */
function renderUserChip() {
  const chip = $("#user-chip");
  chip.innerHTML = "";
  chip.append(currentUser.name);
  if (currentUser.role === "admin") {
    const tag = document.createElement("span");
    tag.className = "role-tag";
    tag.textContent = "admin";
    chip.append(tag);
  }
}

function applyRoleUI() {
  renderUserChip();
  $$(".admin-only").forEach(el =>
    el.classList.toggle("hidden", currentUser.role !== "admin"));
  // If admin rights were just removed while on the Admin tab, bounce to Sessions
  if (currentUser.role !== "admin" && $(".tab.active")?.dataset.tab === "admin") {
    $$(".tab").find(t => t.dataset.tab === "feed")?.click();
  }
  $("#empty-hint").textContent = currentUser.role === "admin"
    ? "Head to the Admin tab to create the first session."
    : "Check back soon — the next game will show up here.";
  if (currentUser.role === "admin") renderEditList();
  renderRegs();
  renderTable();
  renderAuction();
  positionTabInk();
}

function enterApp() {
  applyRoleUI();
  switchScreen(authScreen, appScreen);
  setTimeout(positionTabInk, 380); // after the screen transition finishes
  startFeed();
  startMembers();
  startStats();
  startTournament();
}

/* ------------------ Tabs ------------------ */
const tabInk = $("#tab-ink");
function positionTabInk() {
  const active = $(".tab.active");
  if (!active || active.offsetWidth === 0) return;
  tabInk.style.left = active.offsetLeft + "px";
  tabInk.style.width = active.offsetWidth + "px";
}
window.addEventListener("resize", positionTabInk);

const VIEWS = { feed: "#view-feed", tourney: "#view-tourney", stats: "#view-stats", members: "#view-members", admin: "#view-admin" };

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab || tab.classList.contains("active")) return;
  $$(".tab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");
  positionTabInk();

  Object.values(VIEWS).forEach(sel => $(sel).classList.add("hidden"));
  if (tab.dataset.tab === "stats") {
    // Re-run the count-up every time the tab opens
    ["#tile-players", "#tile-taka"].forEach(sel => { $(sel)._shown = 0; });
    renderStats();
  }
  const showEl = $(VIEWS[tab.dataset.tab]);
  showEl.classList.remove("hidden");
  showEl.classList.add("entering");
  showEl.addEventListener("animationend", () => showEl.classList.remove("entering"), { once: true });
});

/* ------------------ Live feed ------------------ */
function startFeed() {
  if (unsubscribeFeed) unsubscribeFeed();

  // Only sessions from the last 3 hours onward (a game stays visible while
  // it's being played). where + orderBy on the same field → no composite index.
  const cutoff = Timestamp.fromMillis(Date.now() - 3 * 60 * 60 * 1000);
  const q = query(sessionsCol, where("time", ">=", cutoff), orderBy("time", "asc"));

  let firstLoad = true;
  unsubscribeFeed = onSnapshot(q, (snap) => {
    snap.docChanges().forEach((change, idx) => {
      const id = change.doc.id;
      if (change.type === "removed") {
        sessionsCache.delete(id);
        removeCard(id);
      } else if (change.type === "added") {
        sessionsCache.set(id, change.doc.data());
        addCard(id, change.doc.data(), firstLoad ? idx : 0);
      } else {
        sessionsCache.set(id, change.doc.data());
        updateCard(id, change.doc.data());
      }
    });
    renderEditList();
    // Keep DOM order in sync with query order (time asc)
    const feed = $("#feed");
    snap.docs.forEach(d => {
      const el = cardEls.get(d.id);
      if (el) feed.appendChild(el);
    });
    $("#feed-empty").classList.toggle("hidden", snap.size > 0);
    firstLoad = false;
  }, (err) => {
    console.error(err);
    toast("Lost connection to sessions feed.", true);
  });

  clearInterval(countdownTimer);
  countdownTimer = setInterval(refreshCountdowns, 30_000);
}

/* ------------------ Card rendering ------------------ */
const fmtDate = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
});

function countdownText(date) {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return { text: "LIVE now", soon: true };
  const mins = Math.round(diff / 60000);
  if (mins < 60) return { text: `in ${mins} min`, soon: true };
  const hours = Math.round(mins / 60);
  if (hours < 24) return { text: `in ${hours} h`, soon: hours <= 3 };
  const days = Math.round(hours / 24);
  return { text: `in ${days} day${days > 1 ? "s" : ""}`, soon: false };
}

function refreshCountdowns() {
  cardEls.forEach((card) => {
    const date = new Date(Number(card.dataset.timeMs));
    const cd = countdownText(date);
    const el = $(".card-countdown", card);
    el.textContent = cd.text;
    el.classList.toggle("soon", cd.soon);
  });
}

function addCard(id, data, staggerIndex) {
  const card = $("#card-template").content.firstElementChild.cloneNode(true);
  card.dataset.id = id;
  card.style.setProperty("--stagger", `${Math.min(staggerIndex, 6) * 0.09}s`);

  if (currentUser.role === "admin") {
    const del = $(".btn-delete", card);
    del.classList.remove("hidden");
    del.addEventListener("click", () => deleteSession(id, data.location));
  }
  $(".btn-in", card).addEventListener("click", () => vote(id, "in"));
  $(".btn-out", card).addEventListener("click", () => vote(id, "out"));

  const guestForm = $(".guest-form", card);
  $(".btn-guest-toggle", card).addEventListener("click", () => {
    guestForm.classList.toggle("hidden");
    if (!guestForm.classList.contains("hidden")) $(".guest-input", card).focus();
  });
  guestForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $(".guest-input", card);
    const guestName = normalizeName(input.value);
    if (guestName.length < 2) return toast("Guest name needs at least 2 characters.", true);
    input.value = "";
    guestForm.classList.add("hidden");
    await addGuest(id, guestName);
  });

  cardEls.set(id, card);
  $("#feed").appendChild(card);
  updateCard(id, data);
}

function updateCard(id, data) {
  const card = cardEls.get(id);
  if (!card) return;

  const date = data.time?.toDate ? data.time.toDate() : new Date();
  card.dataset.timeMs = date.getTime();

  $(".card-location", card).textContent = data.location;
  $(".card-time", card).textContent = fmtDate.format(date);
  const cd = countdownText(date);
  const cdEl = $(".card-countdown", card);
  cdEl.textContent = cd.text;
  cdEl.classList.toggle("soon", cd.soon);

  const inNames = data.inVotes || [];
  const outNames = data.outVotes || [];
  const guests = data.guests || [];
  const max = data.maxPlayers || 0;
  const totalIn = inNames.length + guests.length; // guests count toward the cap
  const isFull = totalIn >= max;
  const me = currentUser.name;
  const iAmIn = inNames.includes(me);
  const iAmOut = outNames.includes(me);

  // Capacity bar (players + guests)
  const fill = $(".capacity-fill", card);
  fill.style.width = max ? `${Math.min(100, (totalIn / max) * 100)}%` : "0%";
  fill.classList.toggle("full", isFull);
  $(".capacity-text", card).textContent =
    guests.length ? `${totalIn} / ${max} (${guests.length} guest${guests.length > 1 ? "s" : ""})` : `${totalIn} / ${max}`;

  $(".list-in .list-count", card).textContent = inNames.length;
  $(".list-out .list-count", card).textContent = outNames.length;
  $(".guest-count", card).textContent = guests.length;

  syncChips(card, inNames, outNames);
  syncGuestChips(card, guests);

  // Slot fee: total set by admin; per-head share recalculates automatically
  const feeEl = $(".fee", card);
  const totalFee = typeof data.totalFee === "number" ? data.totalFee : 0;
  feeEl.classList.toggle("hidden", totalFee <= 0);
  if (totalFee > 0) {
    $(".fee-total", card).innerHTML = `Total slot fee <b>৳${totalFee.toLocaleString()}</b>`;
    const eachEl = $(".fee-each", card);
    if (totalIn > 0) {
      const share = Math.ceil(totalFee / totalIn);
      const newHTML = `<b>৳${share.toLocaleString()}</b> per person`;
      if (eachEl.innerHTML !== newHTML) {
        eachEl.innerHTML = newHTML;
        const b = eachEl.querySelector("b");
        b.classList.add("pulse");
        b.addEventListener("animationend", () => b.classList.remove("pulse"), { once: true });
      }
    } else {
      eachEl.textContent = "join to split the cost";
    }
  }

  // Guest adding locked once the session is full
  $(".btn-guest-toggle", card).disabled = isFull;
  if (isFull) $(".guest-form", card).classList.add("hidden");

  // Payments: auto-listed from whoever is In (players + guests).
  // Everyone sees the state; only admins can tick the boxes.
  const payments = data.payments || {};
  const participants = [
    ...inNames.map(n => ({ key: n, label: n, owner: null })),
    ...guests.map(g => ({ key: `${g.addedBy}→${g.name}`, label: g.name, owner: g.addedBy }))
  ];
  const showPay = totalFee > 0 && participants.length > 0;
  $(".payments", card).classList.toggle("hidden", !showPay);
  if (showPay) {
    const paid = participants.filter(p => payments[p.key]).length;
    $(".pay-count", card).textContent = participants.length;
    const prog = $(".pay-progress", card);
    prog.textContent = `${paid}/${participants.length} paid`;
    prog.classList.toggle("all-paid", paid === participants.length);

    const rowsEl = $(".pay-rows", card);
    rowsEl.innerHTML = "";
    participants.forEach(p => {
      const isPaid = !!payments[p.key];
      const row = document.createElement("div");
      row.className = "pay-row" + (isPaid ? " paid" : "");
      const name = document.createElement("span");
      name.className = "pay-name";
      name.textContent = p.label;
      if (p.owner) {
        const own = document.createElement("span");
        own.className = "pay-owner";
        own.textContent = ` (guest of ${p.owner})`;
        name.appendChild(own);
      }
      const box = document.createElement("button");
      box.type = "button";
      box.className = "pay-check" + (isPaid ? " checked" : "");
      box.disabled = currentUser.role !== "admin";
      box.title = currentUser.role === "admin"
        ? (isPaid ? "Mark as unpaid" : "Mark as paid")
        : (isPaid ? "Paid" : "Not paid yet");
      box.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      box.addEventListener("click", () => togglePayment(card.dataset.id, p.key, !isPaid));
      row.append(name, box);
      rowsEl.appendChild(row);
    });
  }

  // Vote buttons
  const btnIn = $(".btn-in", card);
  const btnOut = $(".btn-out", card);
  btnIn.classList.toggle("selected", iAmIn);
  btnOut.classList.toggle("selected", iAmOut);
  $(".btn-label", btnIn).textContent = iAmIn ? "You're in ✓" : "I'm in";
  $(".btn-label", btnOut).textContent = iAmOut ? "You're out" : "I'm out";

  // Cap reached → lock the In button for anyone not already in (CSS fades it)
  btnIn.disabled = isFull && !iAmIn;
  btnOut.disabled = false;
  $(".full-note", card).classList.toggle("hidden", !isFull);
}

/* FLIP animation: chips slide between the In and Out lists */
function syncChips(card, inNames, outNames) {
  const inChips = $(".list-in .chips", card);
  const outChips = $(".list-out .chips", card);

  const existing = new Map();
  $$(".chip", card).forEach(ch => {
    if (!ch.classList.contains("chip-exit")) existing.set(ch.dataset.name, ch);
  });

  // FIRST: record where every chip currently is
  const firstRects = new Map();
  existing.forEach((el, name) => firstRects.set(name, el.getBoundingClientRect()));

  const placed = new Set();
  const place = (container, names) => {
    names.forEach(name => {
      let chip = existing.get(name);
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "chip chip-enter";
        chip.dataset.name = name;
        chip.textContent = name === currentUser.name ? `${name} (you)` : name;
        if (name === currentUser.name) chip.classList.add("me");
        chip.addEventListener("animationend", () => chip.classList.remove("chip-enter"), { once: true });
      }
      container.appendChild(chip); // moves the node if it already exists
      placed.add(name);
    });
  };
  place(inChips, inNames);
  place(outChips, outNames);

  // Chips no longer in either list → animate out, then remove
  existing.forEach((el, name) => {
    if (!placed.has(name)) {
      el.classList.add("chip-exit");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }
  });

  // LAST + INVERT + PLAY: slide moved chips from old position to new
  firstRects.forEach((oldRect, name) => {
    const el = existing.get(name);
    if (!el || !placed.has(name)) return;
    const newRect = el.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 },
       { transform: "translate(0, 0)", opacity: 1 }],
      { duration: 480, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
  });
}

/* Guest chips: "GuestName (guest of Member)" with × for the member who added
   them (and admins). Diffed by name+owner so unchanged chips don't re-animate. */
function syncGuestChips(card, guests) {
  const container = $(".guest-chips", card);
  const keyOf = g => `${g.name}|${g.addedBy}`;
  const existing = new Map();
  $$(".chip.guest", container).forEach(ch => existing.set(ch.dataset.key, ch));

  const wanted = new Set(guests.map(keyOf));
  existing.forEach((el, key) => {
    if (!wanted.has(key)) {
      el.classList.add("chip-exit");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }
  });

  guests.forEach(g => {
    const key = keyOf(g);
    if (existing.has(key) && !existing.get(key).classList.contains("chip-exit")) return;
    const chip = document.createElement("span");
    chip.className = "chip guest chip-enter";
    chip.dataset.key = key;

    const nameEl = document.createElement("span");
    nameEl.textContent = g.name;
    const ownerEl = document.createElement("span");
    ownerEl.className = "guest-owner";
    ownerEl.textContent = g.addedBy === currentUser.name ? "(your guest)" : `(guest of ${g.addedBy})`;
    chip.append(nameEl, ownerEl);

    if (g.addedBy === currentUser.name || currentUser.role === "admin") {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "guest-remove";
      rm.title = "Remove guest";
      rm.textContent = "✕";
      rm.addEventListener("click", () => removeGuest(card.dataset.id, g));
      chip.append(rm);
    }
    chip.addEventListener("animationend", () => chip.classList.remove("chip-enter"), { once: true });
    container.appendChild(chip);
  });
}

async function addGuest(sessionId, guestName) {
  const me = currentUser.name;
  const ref = doc(db, "sessions", sessionId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("gone");
      const d = snap.data();
      const guests = d.guests || [];
      if ((d.inVotes || []).length + guests.length >= d.maxPlayers) throw new Error("full");
      if (guests.some(g => g.name.toLowerCase() === guestName.toLowerCase() && g.addedBy === me))
        throw new Error("dupe");
      guests.push({ name: guestName, addedBy: me });
      tx.update(ref, { guests });
    });
    toast(`${guestName} added as your guest 🎟️`);
  } catch (err) {
    if (err.message === "full") toast("Session is full — no room for guests.", true);
    else if (err.message === "dupe") toast("You already added a guest with that name.", true);
    else if (err.message === "gone") toast("That session was deleted.", true);
    else { console.error(err); toast("Could not add guest.", true); }
  }
}

async function removeGuest(sessionId, guest) {
  const ref = doc(db, "sessions", sessionId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("gone");
      const guests = (snap.data().guests || [])
        .filter(g => !(g.name === guest.name && g.addedBy === guest.addedBy));
      tx.update(ref, { guests });
    });
    toast(`${guest.name} removed.`);
  } catch (err) {
    console.error(err);
    toast("Could not remove guest.", true);
  }
}

function removeCard(id) {
  const card = cardEls.get(id);
  if (!card) return;
  cardEls.delete(id);
  card.classList.add("removing");
  card.addEventListener("animationend", () => card.remove(), { once: true });
}

async function togglePayment(sessionId, key, paid) {
  if (currentUser.role !== "admin") return;
  const ref = doc(db, "sessions", sessionId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("gone");
      const payments = { ...(snap.data().payments || {}) };
      if (paid) payments[key] = true; else delete payments[key];
      tx.update(ref, { payments });
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't update payment.", true);
  }
}

/* ------------------ Stats ------------------ */
function startStats() {
  if (unsubscribeStats) unsubscribeStats();
  // Full history — the feed listener only watches upcoming sessions
  const q = query(sessionsCol, orderBy("time", "asc"));
  unsubscribeStats = onSnapshot(q, (snap) => {
    allSessions = snap.docs.map(d => d.data());
    renderStats();
  }, (err) => console.error("stats listener:", err));
}

function renderStats() {
  const list = $("#stats-list");
  if (!currentUser || !membersDocs.length) return;

  const now = Date.now();
  const played = allSessions.filter(s => s.time?.toMillis && s.time.toMillis() <= now);

  const rows = membersDocs.map(d => {
    const u = d.data();
    const joined = u.createdAt?.toMillis ? u.createdAt.toMillis() : 0;
    // sessions the member could have attended: kicked off after they joined
    const possible = played.filter(s => s.time.toMillis() >= joined);
    const attended = possible.filter(s => (s.inVotes || []).includes(u.name));
    return {
      id: d.id, name: u.name, photo: u.photo,
      attended: attended.length, possible: possible.length,
      rate: possible.length ? attended.length / possible.length : 0
    };
  }).sort((a, b) =>
    b.attended - a.attended || b.rate - a.rate || a.name.localeCompare(b.name));

  // Hero tiles: total players + total taka spent on played sessions
  animateNumber($("#tile-players"), membersDocs.length);
  const spent = played.reduce((sum, s) => sum + (typeof s.totalFee === "number" ? s.totalFee : 0), 0);
  animateNumber($("#tile-taka"), spent, n => `৳${n.toLocaleString()}`);
  $("#tile-taka-sub").textContent = played.length
    ? `across ${played.length} session${played.length > 1 ? "s" : ""} played`
    : "no sessions played yet";

  // Podium: top 3 by appearances
  const top = rows.filter(r => r.attended > 0).slice(0, 3);
  $("#podium-card").classList.toggle("hidden", top.length === 0);
  const podium = $("#podium");
  podium.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"], stepH = [86, 62, 44], cls = ["first", "second", "third"];
  const order = top.length === 3 ? [1, 0, 2] : top.map((_, i) => i); // 2nd–1st–3rd layout
  order.forEach(rank => {
    const r = top[rank];
    const col = document.createElement("div");
    col.className = `podium-col ${cls[rank]}`;
    col.innerHTML = `
      <span class="podium-medal">${medals[rank]}</span>
      <div class="podium-avatar"></div>
      <span class="podium-name"></span>
      <span class="podium-count"><b></b> games</span>
      <div class="podium-step" style="height:${stepH[rank]}px"></div>`;
    setAvatar($(".podium-avatar", col), r.photo, r.name);
    $(".podium-name", col).textContent = r.name;
    $(".podium-count b", col).textContent = r.attended;
    podium.appendChild(col);
  });

  $("#stats-empty").classList.toggle("hidden", played.length > 0);
  list.innerHTML = "";

  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "member-row" + (i === 0 && r.attended > 0 ? " top-rank" : "");
    row.style.setProperty("--stagger", `${Math.min(i, 10) * 0.05}s`);
    const pct = r.possible ? Math.round(r.rate * 100) : 0;

    row.innerHTML = `
      <div class="stat-rank"></div>
      <div class="member-avatar"></div>
      <div class="stat-body">
        <div class="stat-top">
          <span class="stat-name"></span>
          <span class="stat-score"><b></b> / <span class="stat-possible"></span></span>
        </div>
        <div class="stat-bar"><div class="stat-fill"></div></div>
        <div class="stat-pct"></div>
      </div>`;
    $(".stat-rank", row).textContent = i === 0 && r.attended > 0 ? "🏆" : i + 1;
    setAvatar($(".member-avatar", row), r.photo, r.name);
    $(".stat-name", row).textContent = r.id === currentUser.id ? `${r.name} (you)` : r.name;
    $(".stat-score b", row).textContent = r.attended;
    $(".stat-possible", row).textContent = r.possible;
    $(".stat-pct", row).textContent = r.possible
      ? `${pct}% of possible sessions attended`
      : "no sessions since joining yet";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => { $(".stat-fill", row).style.width = `${pct}%`; }));
    list.appendChild(row);
  });
}

/* ------------------ Voting ------------------ */
async function vote(sessionId, choice) {
  const me = currentUser.name;
  const ref = doc(db, "sessions", sessionId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("gone");
      const d = snap.data();
      const inV = (d.inVotes || []).filter(n => n !== me);
      const outV = (d.outVotes || []).filter(n => n !== me);
      if (choice === "in") {
        if (inV.length + (d.guests || []).length >= d.maxPlayers) throw new Error("full");
        inV.push(me);
      } else {
        outV.push(me);
      }
      tx.update(ref, { inVotes: inV, outVotes: outV });
    });
  } catch (err) {
    if (err.message === "full") toast("Session just filled up! 😬", true);
    else if (err.message === "gone") toast("That session was deleted.", true);
    else { console.error(err); toast("Vote failed — try again.", true); }
  }
}

/* ------------------ Edit sessions (admin) ------------------ */
function toLocalInputValue(date) {
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function renderEditList(force = false) {
  if (currentUser?.role !== "admin") return;
  // Background snapshot updates must not clobber an open form — but calls
  // from the Edit/Cancel/Save buttons (force) always re-render.
  if (!force && editingId && sessionsCache.has(editingId)) return;
  if (editingId && !sessionsCache.has(editingId)) editingId = null; // edited session vanished

  const list = $("#edit-list");
  list.innerHTML = "";
  const entries = [...sessionsCache.entries()]
    .sort((a, b) => (a[1].time?.toMillis?.() ?? 0) - (b[1].time?.toMillis?.() ?? 0));
  $("#edit-empty").classList.toggle("hidden", entries.length > 0);

  entries.forEach(([id, d]) => {
    const row = document.createElement("div");
    row.className = "edit-row";
    row.dataset.id = id;
    const date = d.time?.toDate ? d.time.toDate() : new Date();

    const head = document.createElement("div");
    head.className = "edit-row-head";
    head.innerHTML = `
      <div class="edit-row-info">
        <div class="edit-row-location"></div>
        <div class="edit-row-time"></div>
      </div>`;
    $(".edit-row-location", head).textContent = d.location;
    $(".edit-row-time", head).textContent =
      `${fmtDate.format(date)} · ${(d.inVotes || []).length + (d.guests || []).length}/${d.maxPlayers} filled · fee ৳${(d.totalFee || 0).toLocaleString()}`;

    const btn = document.createElement("button");
    btn.className = "btn btn-edit";
    btn.textContent = editingId === id ? "Editing…" : "Edit";
    btn.addEventListener("click", () => { editingId = editingId === id ? null : id; renderEditList(true); });
    head.appendChild(btn);
    row.appendChild(head);

    if (editingId === id) {
      btn.classList.add("btn-cancel");
      btn.textContent = "Close";
      const form = document.createElement("form");
      form.className = "edit-form";
      form.innerHTML = `
        <div class="field">
          <input type="text" class="e-location" placeholder=" " required maxlength="60" />
          <label>Location</label>
        </div>
        <div class="field">
          <input type="datetime-local" class="e-time" required />
          <label class="label-fixed">Kick-off time</label>
        </div>
        <div class="field">
          <input type="number" class="e-max" placeholder=" " min="2" max="99" required />
          <label>Max players</label>
        </div>
        <div class="field">
          <input type="number" class="e-fee" placeholder=" " min="0" max="1000000" required />
          <label>Total slot fee (৳)</label>
        </div>
        <div class="edit-form-actions">
          <button type="submit" class="btn btn-primary"><span class="btn-label">Save changes</span><span class="btn-spinner"></span></button>
          <button type="button" class="btn btn-cancel">Cancel</button>
        </div>`;
      $(".e-location", form).value = d.location;
      $(".e-time", form).value = toLocalInputValue(date);
      $(".e-max", form).value = d.maxPlayers;
      $(".e-fee", form).value = d.totalFee || 0;
      $(".btn-cancel", form).addEventListener("click", () => { editingId = null; renderEditList(true); });
      form.addEventListener("submit", (e) => { e.preventDefault(); saveSessionEdit(id, form); });
      row.appendChild(form);
    }
    list.appendChild(row);
  });
}

async function saveSessionEdit(id, form) {
  const d = sessionsCache.get(id);
  if (!d) { editingId = null; renderEditList(); return; }

  const location = normalizeName($(".e-location", form).value);
  const timeVal = $(".e-time", form).value;
  const max = parseInt($(".e-max", form).value, 10);
  const fee = parseInt($(".e-fee", form).value, 10);
  const when = new Date(timeVal);
  const occupied = (d.inVotes || []).length + (d.guests || []).length;
  const timeChanged = when.getTime() !== (d.time?.toDate ? d.time.toDate().getTime() : 0);

  if (!location) return toast("Enter a location.", true);
  if (!timeVal || isNaN(when.getTime())) return toast("Pick a valid time.", true);
  if (timeChanged && when.getTime() < Date.now()) return toast("Time is in the past.", true);
  if (!(max >= 2 && max <= 99)) return toast("Max players must be 2–99.", true);
  if (max < occupied) return toast(`${occupied} spots already taken — cap can't go below that.`, true);
  if (!(fee >= 0)) return toast("Slot fee can't be negative.", true);

  const btn = $(".btn-primary", form);
  setLoading(btn, true);
  try {
    await updateDoc(doc(db, "sessions", id), {
      location, time: Timestamp.fromDate(when), maxPlayers: max, totalFee: fee
    });
    editingId = null;
    toast("Session updated ✏️");
    renderEditList(true);
  } catch (err) {
    console.error(err);
    setLoading(btn, false);
    toast("Update failed.", true);
  }
}

/* ------------------ Members ------------------ */
const fmtJoined = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function memberRow(docSnap, index, withActions) {
  const u = docSnap.data();
  const isMe = docSnap.id === currentUser.id;
  const row = document.createElement("div");
  row.className = "member-row" + (u.role === "admin" ? " is-admin" : "");
  row.style.setProperty("--stagger", `${Math.min(index, 10) * 0.05}s`);
  row.innerHTML = `
    <div class="member-avatar"></div>
    <div class="member-info">
      <div class="member-name"></div>
      <div class="member-joined"></div>
    </div>
    <div class="actions"><span class="member-role"></span></div>`;

  const avatarEl = $(".member-avatar", row);
  setAvatar(avatarEl, u.photo, u.name);
  if (isMe) {
    // Members can add/change their own photo any time from their row
    const wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className = "avatar-edit";
    wrap.title = "Change your photo";
    avatarEl.replaceWith(wrap);
    wrap.appendChild(avatarEl);
    wrap.addEventListener("click", () => pickMyPhoto());
  }
  $(".member-name", row).textContent = isMe ? `${u.name} (you)` : u.name;
  $(".member-joined", row).textContent =
    `Joined ${u.createdAt?.toDate ? fmtJoined.format(u.createdAt.toDate()) : "—"}`;
  $(".member-role", row).textContent = u.role;

  if (withActions && !isMe) {
    const btn = document.createElement("button");
    btn.className = "btn btn-role" + (u.role === "admin" ? " demote" : "");
    btn.textContent = u.role === "admin" ? "Remove admin" : "Make admin";
    btn.addEventListener("click", () => setRole(docSnap.id, u.name, u.role === "admin" ? "member" : "admin"));
    $(".actions", row).appendChild(btn);
  }
  return row;
}

function startMembers() {
  if (unsubscribeMembers) unsubscribeMembers();
  const q = query(usersCol, orderBy("createdAt", "asc"));
  unsubscribeMembers = onSnapshot(q, (snap) => {
    // Live self-role sync: if another admin promoted/demoted me, update the UI
    const meDoc = snap.docs.find(d => d.id === currentUser.id);
    if (meDoc && meDoc.data().role !== currentUser.role) {
      currentUser.role = meDoc.data().role;
      saveSession(currentUser);
      applyRoleUI();
      toast(currentUser.role === "admin"
        ? "You've been promoted to Admin! 👑"
        : "Your admin rights were removed.");
    }

    membersDocs = snap.docs;
    renderStats();

    $("#members-count").textContent = snap.size;
    const membersList = $("#members-list");
    membersList.innerHTML = "";
    snap.docs.forEach((d, i) => membersList.appendChild(memberRow(d, i, false)));

    const rolesList = $("#roles-list");
    rolesList.innerHTML = "";
    if (currentUser.role === "admin") {
      snap.docs.forEach((d, i) => rolesList.appendChild(memberRow(d, i, true)));
    }
  }, (err) => {
    console.error(err);
    toast("Could not load members.", true);
  });
}

let myPhotoInput = null;
function pickMyPhoto() {
  if (!myPhotoInput) {
    myPhotoInput = document.createElement("input");
    myPhotoInput.type = "file";
    myPhotoInput.accept = "image/*";
    myPhotoInput.addEventListener("change", async () => {
      const file = myPhotoInput.files[0];
      myPhotoInput.value = "";
      if (!file) return;
      try {
        const photo = await fileToPhoto(file);
        await updateDoc(doc(db, "users", currentUser.id), { photo });
        toast("Profile photo updated 📸");
      } catch (err) {
        console.error(err);
        toast("Couldn't update photo — try another image.", true);
      }
    });
  }
  myPhotoInput.click();
}

async function setRole(userId, name, newRole) {
  const verb = newRole === "admin" ? `Make ${name} an admin?` : `Remove ${name}'s admin rights?`;
  if (!confirm(verb)) return;
  try {
    await updateDoc(doc(db, "users", userId), { role: newRole });
    toast(newRole === "admin" ? `${name} is now an admin 👑` : `${name} is now a member.`);
  } catch (err) {
    console.error(err);
    toast("Role change failed.", true);
  }
}

/* ------------------ Admin ------------------ */
$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentUser?.role !== "admin") return;

  const location = normalizeName($("#s-location").value);
  const timeVal = $("#s-time").value;
  const max = parseInt($("#s-max").value, 10);
  const fee = parseInt($("#s-fee").value, 10);
  const when = new Date(timeVal);

  if (!location) return toast("Enter a location.", true);
  if (!timeVal || isNaN(when.getTime())) return toast("Pick a valid time.", true);
  if (when.getTime() < Date.now()) return toast("Time is in the past.", true);
  if (!(max >= 2 && max <= 99)) return toast("Max players must be 2–99.", true);
  if (!(fee >= 0)) return toast("Slot fee can't be negative.", true);

  const btn = $("#create-btn");
  setLoading(btn, true);
  try {
    await addDoc(sessionsCol, {
      location,
      time: Timestamp.fromDate(when),
      maxPlayers: max,
      totalFee: fee,
      inVotes: [],
      outVotes: [],
      guests: [],
      createdBy: currentUser.name,
      createdAt: serverTimestamp()
    });
    e.target.reset();
    $("#s-max").value = 10;
    $("#s-fee").value = 0;
    toast("Session created! 🎉");
    $$(".tab").find(t => t.dataset.tab === "feed")?.click();
  } catch (err) {
    console.error(err);
    toast("Could not create session.", true);
  } finally {
    setLoading(btn, false);
  }
});

async function deleteSession(id, location) {
  if (!confirm(`Delete the session at "${location}"? This can't be undone.`)) return;
  try {
    await deleteDoc(doc(db, "sessions", id));
    toast("Session deleted.");
  } catch (err) {
    console.error(err);
    toast("Delete failed.", true);
  }
}

/* ==========================================================================
   Tournament — GB Futsal Season 4
   ========================================================================== */

/* ---- sub-tabs ---- */
$("#tourney-subtabs").addEventListener("click", (e) => {
  const sub = e.target.closest(".subtab");
  if (!sub || sub.classList.contains("active")) return;
  $$(".subtab").forEach(s => s.classList.remove("active"));
  sub.classList.add("active");
  $$(".subview").forEach(v => v.classList.add("hidden"));
  const showEl = $(`#sub-${sub.dataset.sub}`);
  showEl.classList.remove("hidden");
  showEl.classList.add("entering");
  showEl.addEventListener("animationend", () => showEl.classList.remove("entering"), { once: true });
  if (sub.dataset.sub === "players") {
    ["#tile-regs", "#tile-fees"].forEach(sel => { $(sel)._shown = 0; });
    renderRegs();
  }
});

/* ---- listeners ---- */
function startTournament() {
  if (unsubscribeTourneyConfig) unsubscribeTourneyConfig();
  unsubscribeTourneyConfig = onSnapshot(tourneyConfigRef, (snap) => {
    tourneyConfig = { ...structuredClone(TOURNEY_DEFAULTS), ...(snap.exists() ? snap.data() : {}) };
    tourneyConfig.fees = { ...TOURNEY_DEFAULTS.fees, ...(tourneyConfig.fees || {}) };
    renderInfo();
    renderRegs(); // fees tile depends on config
  }, (err) => console.error("tourney config:", err));

  if (unsubscribeRegs) unsubscribeRegs();
  unsubscribeRegs = onSnapshot(query(regsCol, orderBy("createdAt", "asc")), (snap) => {
    regsDocs = snap.docs;
    renderRegs();
    renderAuction();
  }, (err) => console.error("regs listener:", err));

  if (unsubscribeTeams) unsubscribeTeams();
  unsubscribeTeams = onSnapshot(teamsCol, (snap) => {
    teamsDocs = snap.docs;
    renderTable();
    renderAuction();
  }, (err) => console.error("teams listener:", err));
}

/* ---- 1) tournament info (admin-editable) ---- */
function feeText(v) {
  return typeof v === "number" && v > 0 ? `৳${v.toLocaleString()}` : "TBA";
}

function renderInfo() {
  const c = tourneyConfig;
  const disp = $("#info-display");
  disp.innerHTML = `
    <div class="cup-info-row">📅 <b>DATE:</b> <span></span></div>
    <div class="cup-info-row deadline-row">⏳ <b>Registration deadline:</b> <span></span></div>
    <div class="cup-info-row">📍 <b>Location:</b> <span></span></div>
    <div class="cup-info-block"><b>Registration Fee:</b><ul class="cup-list" id="fee-list"></ul></div>
    <div class="cup-info-block"><b>Bkash —</b><ul class="cup-list" id="bkash-list"></ul></div>
    <p class="cup-note">Please put your name in the reference.</p>`;
  const spans = disp.querySelectorAll(".cup-info-row span");
  spans[0].textContent = c.dateText;
  spans[1].textContent = c.deadlineText;
  spans[2].textContent = c.locationText;
  const feeList = $("#fee-list", disp);
  BATCHES.forEach(b => {
    const li = document.createElement("li");
    li.textContent = `${b.label.replace("Batch ", "Batch – ")}: `;
    const val = document.createElement("span");
    val.className = "fee-val";
    val.textContent = feeText(c.fees[b.key]);
    li.appendChild(val);
    feeList.appendChild(li);
  });
  const bkList = $("#bkash-list", disp);
  (c.bkash || []).forEach(p => {
    const li = document.createElement("li");
    li.textContent = `${p.name}: `;
    const num = document.createElement("b");
    num.textContent = p.number;
    li.appendChild(num);
    bkList.appendChild(li);
  });
}

$("#info-edit-btn").addEventListener("click", () => {
  const form = $("#info-form");
  const open = form.classList.toggle("hidden");
  $("#info-edit-btn").textContent = open ? "Edit info" : "Close";
  if (!open) {
    const c = tourneyConfig;
    $("#i-date").value = c.dateText;
    $("#i-deadline").value = c.deadlineText;
    $("#i-location").value = c.locationText;
    BATCHES.forEach(b => { $(`#i-fee-${b.key}`).value = c.fees[b.key] ?? ""; });
    $("#i-bk-name1").value = c.bkash?.[0]?.name || "";
    $("#i-bk-num1").value = c.bkash?.[0]?.number || "";
    $("#i-bk-name2").value = c.bkash?.[1]?.name || "";
    $("#i-bk-num2").value = c.bkash?.[1]?.number || "";
  }
});
$("#info-cancel").addEventListener("click", () => {
  $("#info-form").classList.add("hidden");
  $("#info-edit-btn").textContent = "Edit info";
});

$("#info-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentUser?.role !== "admin") return;
  const fees = {};
  BATCHES.forEach(b => {
    const v = parseInt($(`#i-fee-${b.key}`).value, 10);
    fees[b.key] = Number.isFinite(v) && v >= 0 ? v : null;
  });
  const bkash = [
    { name: normalizeName($("#i-bk-name1").value), number: $("#i-bk-num1").value.trim() },
    { name: normalizeName($("#i-bk-name2").value), number: $("#i-bk-num2").value.trim() }
  ].filter(p => p.name && p.number);
  const btn = $("#info-form .btn-primary");
  setLoading(btn, true);
  try {
    await setDoc(tourneyConfigRef, {
      dateText: normalizeName($("#i-date").value),
      deadlineText: normalizeName($("#i-deadline").value),
      locationText: normalizeName($("#i-location").value),
      fees, bkash
    }, { merge: true });
    $("#info-form").classList.add("hidden");
    $("#info-edit-btn").textContent = "Edit info";
    toast("Tournament info updated ✏️");
  } catch (err) {
    console.error(err);
    toast("Could not save info.", true);
  } finally {
    setLoading(btn, false);
  }
});

/* ---- registration form ---- */
let pendingRegPhoto = null;
const regPhotoInput = $("#reg-photo-input");
$("#reg-photo-btn").addEventListener("click", () => regPhotoInput.click());
regPhotoInput.addEventListener("change", async () => {
  const file = regPhotoInput.files[0];
  regPhotoInput.value = "";
  if (!file) return;
  try {
    pendingRegPhoto = await fileToPhoto(file);
    $("#reg-photo-preview").innerHTML = `<img src="${pendingRegPhoto}" alt="preview" />`;
    $("#reg-photo-btn").textContent = "Change photo";
    $("#reg-photo-clear").classList.remove("hidden");
  } catch {
    toast("Couldn't read that image — try another one.", true);
  }
});
$("#reg-photo-clear").addEventListener("click", () => {
  pendingRegPhoto = null;
  $("#reg-photo-preview").innerHTML = "📷";
  $("#reg-photo-btn").textContent = "Upload your photo";
  $("#reg-photo-clear").classList.add("hidden");
});

$("#reg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = normalizeName($("#r-name").value);
  const position = $("#r-position").value;
  const batch = $("#r-batch").value;
  const txn = $("#r-txn").value.trim();

  if (name.length < 2) return toast("Enter your full name.", true);
  if (!POSITIONS.includes(position)) return toast("Pick your position.", true);
  if (!BATCHES.some(b => b.key === batch)) return toast("Pick your batch.", true);
  if (!pendingRegPhoto) return toast("Your photo is required.", true);
  if (txn.length < 4) return toast("Enter the Bkash transaction ID.", true);
  if (regsDocs.some(d => d.data().name.toLowerCase() === name.toLowerCase()))
    return toast(`${name} is already registered.`, true);

  const btn = $("#reg-btn");
  setLoading(btn, true);
  try {
    await addDoc(regsCol, {
      name, position, batch, txn, photo: pendingRegPhoto,
      submittedBy: currentUser.name, createdAt: serverTimestamp()
    });
    e.target.reset();
    $("#reg-photo-clear").click();
    toast(`${name} registered for Season 4! 🏆`);
  } catch (err) {
    console.error(err);
    toast("Registration failed — try again.", true);
  } finally {
    setLoading(btn, false);
  }
});

/* ---- 2) registered players ---- */
function renderRegs() {
  if (!currentUser) return;
  const list = $("#regs-list");
  if (!list) return;

  animateNumber($("#tile-regs"), regsDocs.length);
  $("#regs-count").textContent = regsDocs.length;
  $("#regs-empty").classList.toggle("hidden", regsDocs.length > 0);

  // Admin-only: fees collected = per-batch fee × registrations of that batch
  if (currentUser.role === "admin") {
    const total = regsDocs.reduce((sum, d) =>
      sum + (tourneyConfig.fees[d.data().batch] || 0), 0);
    animateNumber($("#tile-fees"), total, n => `৳${n.toLocaleString()}`);
    const unset = BATCHES.filter(b => !(tourneyConfig.fees[b.key] > 0)).length;
    $("#tile-fees-sub").textContent = unset
      ? `${unset} batch fee${unset > 1 ? "s" : ""} not set yet`
      : "all batch fees set";
  }

  list.innerHTML = "";
  // Captains float to the top of the list
  const sorted = [...regsDocs].sort((a, b) =>
    (b.data().captain === true) - (a.data().captain === true));
  sorted.forEach((d, i) => {
    const r = d.data();
    const row = document.createElement("div");
    row.className = "member-row" + (r.captain ? " captain" : "");
    row.style.setProperty("--stagger", `${Math.min(i, 10) * 0.05}s`);

    if (editingRegId === d.id) {
      row.appendChild(regEditForm(d));
      list.appendChild(row);
      return;
    }

    row.innerHTML = `
      <div class="member-avatar"></div>
      <div class="member-info">
        <div class="member-name"></div>
        <div class="member-joined reg-batch"></div>
      </div>
      <div class="actions"><span class="reg-pos"></span></div>`;
    setAvatar($(".member-avatar", row), r.photo, r.name);
    const nameEl = $(".member-name", row);
    nameEl.textContent = r.name;
    if (r.captain) {
      const band = document.createElement("span");
      band.className = "cap-badge";
      band.textContent = "Ⓒ CAPTAIN";
      nameEl.appendChild(band);
    }
    $(".reg-batch", row).textContent = batchLabel(r.batch);
    $(".reg-pos", row).textContent = r.position;

    if (currentUser.role === "admin") {
      const actions = $(".actions", row);
      const cap = document.createElement("button");
      cap.className = "btn btn-role" + (r.captain ? " demote" : "");
      cap.textContent = r.captain ? "Unmake captain" : "Make captain";
      cap.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "tournamentRegs", d.id), { captain: !r.captain });
          toast(r.captain ? `${r.name} is no longer captain.` : `${r.name} is now a captain Ⓒ`);
        } catch (err) { console.error(err); toast("Could not update captain.", true); }
      });
      const edit = document.createElement("button");
      edit.className = "btn btn-role";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => { editingRegId = d.id; renderRegs(); });
      actions.append(cap);
      const del = document.createElement("button");
      del.className = "btn btn-role demote";
      del.textContent = "✕";
      del.title = "Remove registration";
      del.addEventListener("click", async () => {
        if (!confirm(`Remove ${r.name}'s registration?`)) return;
        try { await deleteDoc(doc(db, "tournamentRegs", d.id)); toast(`${r.name} removed.`); }
        catch (err) { console.error(err); toast("Delete failed.", true); }
      });
      actions.append(edit, del);
    }
    list.appendChild(row);
  });
}

function regEditForm(d) {
  const r = d.data();
  const form = document.createElement("form");
  form.className = "edit-form reg-edit-form";
  form.innerHTML = `
    <div class="field"><input type="text" class="re-name" placeholder=" " required maxlength="30" /><label>Name</label></div>
    <div class="field field-select">
      <select class="re-position">${POSITIONS.map(p => `<option>${p}</option>`).join("")}</select>
      <label>Position</label>
    </div>
    <div class="field field-select">
      <select class="re-batch">${BATCHES.map(b => `<option value="${b.key}">${b.label}</option>`).join("")}</select>
      <label>Batch</label>
    </div>
    <div class="field"><input type="text" class="re-txn" placeholder=" " required maxlength="40" /><label>Bkash transaction ID</label></div>
    <div class="edit-form-actions">
      <button type="submit" class="btn btn-primary"><span class="btn-label">Save</span><span class="btn-spinner"></span></button>
      <button type="button" class="btn btn-cancel">Cancel</button>
    </div>`;
  $(".re-name", form).value = r.name;
  $(".re-position", form).value = r.position;
  $(".re-batch", form).value = r.batch;
  $(".re-txn", form).value = r.txn;
  $(".btn-cancel", form).addEventListener("click", () => { editingRegId = null; renderRegs(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = normalizeName($(".re-name", form).value);
    const txn = $(".re-txn", form).value.trim();
    if (name.length < 2 || txn.length < 4) return toast("Fill every field.", true);
    try {
      await updateDoc(doc(db, "tournamentRegs", d.id), {
        name, position: $(".re-position", form).value,
        batch: $(".re-batch", form).value, txn
      });
      editingRegId = null;
      toast("Registration updated ✏️");
    } catch (err) {
      console.error(err);
      toast("Update failed.", true);
    }
  });
  return form;
}

/* ---- 3) tournament table ---- */
$("#team-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentUser?.role !== "admin") return;
  const name = normalizeName($("#t-name").value);
  if (name.length < 2) return toast("Enter a team name.", true);
  if (teamsDocs.some(d => d.data().name.toLowerCase() === name.toLowerCase()))
    return toast("That team already exists.", true);
  const btn = $("#team-btn");
  setLoading(btn, true);
  try {
    await addDoc(teamsCol, { name, wins: 0, draws: 0, losses: 0, gd: 0, createdAt: serverTimestamp() });
    e.target.reset();
    toast(`${name} added to the table ⚽`);
  } catch (err) {
    console.error(err);
    toast("Could not add team.", true);
  } finally {
    setLoading(btn, false);
  }
});

function renderTable() {
  if (!currentUser) return;
  const body = $("#table-body");
  if (!body) return;
  const isAdmin = currentUser.role === "admin";

  const rows = teamsDocs.map(d => {
    const t = d.data();
    const wins = t.wins || 0, draws = t.draws || 0, losses = t.losses || 0, gd = t.gd || 0;
    return {
      id: d.id, name: t.name, wins, draws, losses, gd,
      played: wins + draws + losses,
      pts: wins * 3 + draws // win 3 · draw 1 · loss 0
    };
  }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || a.name.localeCompare(b.name));

  $("#table-empty").classList.toggle("hidden", rows.length > 0);
  body.innerHTML = "";

  rows.forEach((t, i) => {
    const tr = document.createElement("tr");
    tr.style.setProperty("--stagger", `${Math.min(i, 10) * 0.04}s`);

    const cells = [`<td>${i + 1}</td>`, `<td class="t-name th-team"></td>`];
    if (isAdmin) {
      cells.push(`<td>${t.played}</td>`);
      ["wins", "draws", "losses", "gd"].forEach(f => {
        cells.push(`<td><input type="number" class="t-input" data-field="${f}" ${f === "gd" ? "" : 'min="0"'} max="999" min="-999" value="${t[f]}" /></td>`);
      });
      cells.push(`<td class="t-pts">${t.pts}</td>`);
      cells.push(`<td><button type="button" class="t-del-btn" title="Delete team">✕</button></td>`);
    } else {
      cells.push(`<td>${t.played}</td><td>${t.wins}</td><td>${t.draws}</td><td>${t.losses}</td><td>${t.gd > 0 ? "+" + t.gd : t.gd}</td><td class="t-pts">${t.pts}</td>`);
    }
    tr.innerHTML = cells.join("");
    $(".t-name", tr).textContent = t.name;

    if (isAdmin) {
      $$(".t-input", tr).forEach(input => {
        input.addEventListener("change", async () => {
          const f = input.dataset.field;
          let v = parseInt(input.value, 10);
          if (!Number.isFinite(v)) v = 0;
          if (f !== "gd" && v < 0) v = 0;
          try {
            await updateDoc(doc(db, "tournamentTeams", t.id), { [f]: v });
          } catch (err) {
            console.error(err);
            toast("Could not save result.", true);
          }
        });
      });
      $(".t-del-btn", tr).addEventListener("click", async () => {
        if (!confirm(`Delete team "${t.name}"?`)) return;
        try { await deleteDoc(doc(db, "tournamentTeams", t.id)); toast(`${t.name} deleted.`); }
        catch (err) { console.error(err); toast("Delete failed.", true); }
      });
    }
    body.appendChild(tr);
  });
}

/* ---- 4) auction ---- */
let auctionIndex = 0;

$("#auc-prev").addEventListener("click", () => moveAuction(-1));
$("#auc-next").addEventListener("click", () => moveAuction(1));
function moveAuction(dir) {
  if (!regsDocs.length) return;
  auctionIndex = (auctionIndex + dir + regsDocs.length) % regsDocs.length;
  const p = $("#auction-player");
  p.classList.remove("swap");
  void p.offsetWidth; // restart the swap animation
  p.classList.add("swap");
  renderAuction();
}

function renderAuction() {
  if (!currentUser) return;
  const stage = $("#auction-stage");
  if (!stage) return;

  $("#auction-empty").classList.toggle("hidden", regsDocs.length > 0);
  stage.classList.toggle("hidden", regsDocs.length === 0);

  if (regsDocs.length) {
    auctionIndex = Math.min(auctionIndex, regsDocs.length - 1);
    const d = regsDocs[auctionIndex];
    const r = d.data();

    setAvatar($("#auc-photo"), r.photo, r.name);
    const nameEl = $("#auc-name");
    nameEl.textContent = r.name;
    if (r.captain) {
      const band = document.createElement("span");
      band.className = "cap-badge";
      band.textContent = "Ⓒ";
      nameEl.appendChild(band);
    }
    $("#auc-meta").textContent = `${r.position} · ${batchLabel(r.batch)}`;
    $("#auc-counter").textContent = `${auctionIndex + 1} / ${regsDocs.length}`;

    // status: sold / unsold
    const status = $("#auc-status");
    status.innerHTML = "";
    const soldTeam = teamsDocs.find(t => t.id === r.teamId);
    if (soldTeam) {
      const tag = document.createElement("span");
      tag.className = "sold-tag";
      tag.textContent = `SOLD → ${soldTeam.data().name}`;
      if (currentUser.role === "admin") {
        const un = document.createElement("button");
        un.type = "button";
        un.className = "sold-unassign";
        un.title = "Unassign";
        un.textContent = "✕";
        un.addEventListener("click", () => assignPlayer(d.id, null, r.name));
        tag.appendChild(un);
      }
      status.appendChild(tag);
    } else {
      const tag = document.createElement("span");
      tag.className = "unsold-tag";
      tag.textContent = "Not sold yet";
      status.appendChild(tag);
    }

    // admin: team buttons under the player
    const picks = $("#auc-teams");
    picks.innerHTML = "";
    teamsDocs.forEach(t => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "team-pick" + (t.id === r.teamId ? " current" : "");
      btn.textContent = t.data().name;
      btn.addEventListener("click", () =>
        assignPlayer(d.id, t.id === r.teamId ? null : t.id, r.name, t.data().name));
      picks.appendChild(btn);
    });
    if (!teamsDocs.length) {
      picks.innerHTML = `<span class="ts-empty">No teams yet — add them in the Table tab.</span>`;
    }
  }

  renderTeamsheets();
}

async function assignPlayer(regId, teamId, playerName, teamName) {
  if (currentUser.role !== "admin") return;
  try {
    await updateDoc(doc(db, "tournamentRegs", regId), { teamId: teamId || null });
    toast(teamId ? `${playerName} sold to ${teamName}! 🔨` : `${playerName} unassigned.`);
  } catch (err) {
    console.error(err);
    toast("Could not assign player.", true);
  }
}

function renderTeamsheets() {
  const wrap = $("#teamsheets");
  if (!wrap) return;
  $("#teamsheets-empty").classList.toggle("hidden", teamsDocs.length > 0);
  wrap.innerHTML = "";

  teamsDocs.forEach((t, i) => {
    const squad = regsDocs.filter(d => d.data().teamId === t.id)
      .sort((a, b) => (b.data().captain === true) - (a.data().captain === true));
    const card = document.createElement("div");
    card.className = "teamsheet";
    card.style.setProperty("--stagger", `${Math.min(i, 8) * 0.06}s`);

    const h = document.createElement("h3");
    h.textContent = t.data().name;
    const count = document.createElement("span");
    count.className = "ts-count";
    count.textContent = squad.length;
    h.appendChild(count);
    card.appendChild(h);

    const list = document.createElement("div");
    list.className = "ts-players";
    if (!squad.length) {
      list.innerHTML = `<span class="ts-empty">No players yet</span>`;
    } else {
      squad.forEach(d => {
        const r = d.data();
        const row = document.createElement("div");
        row.className = "ts-player";
        const av = document.createElement("div");
        av.className = "ts-avatar";
        setAvatar(av, r.photo, r.name);
        const nm = document.createElement("span");
        nm.className = "ts-name" + (r.captain ? " is-cap" : "");
        nm.textContent = r.captain ? `${r.name} Ⓒ` : r.name;
        const pos = document.createElement("span");
        pos.className = "ts-pos";
        pos.textContent = r.position.slice(0, 3);
        row.append(av, nm, pos);
        list.appendChild(row);
      });
    }
    card.appendChild(list);
    wrap.appendChild(card);
  });
}

/* ==========================================================================
   Boot: restore saved login, verify it still exists, route to a screen
   ========================================================================== */
(async function boot() {
  let saved = null;
  try {
    const fromLocal = localStorage.getItem(LS_KEY);
    const fromSession = sessionStorage.getItem(LS_KEY);
    sessionPersist = !!fromLocal;
    saved = JSON.parse(fromLocal || fromSession);
  } catch { /* corrupt */ }

  if (saved?.id && saved?.name) {
    try {
      await ensureFirebaseSession();
      const snap = await getDoc(doc(db, "users", saved.id));
      if (snap.exists()) {
        // Refresh role in case an admin promoted/demoted this user
        currentUser = { id: saved.id, name: snap.data().name, role: snap.data().role };
        saveSession(currentUser);
        enterApp();
        $("#boot").classList.add("gone");
        return;
      }
      clearSession();
    } catch (err) {
      console.error("Session restore failed:", err);
    }
  }

  authScreen.classList.remove("hidden");
  $("#boot").classList.add("gone");
})();
