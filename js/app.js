import { db, ensureFirebaseSession } from "./firebase.js";
import {
  collection, doc, query, where, orderBy, onSnapshot,
  getDoc, getDocs, getCountFromServer, addDoc, deleteDoc,
  runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

/* ==========================================================================
   State
   ========================================================================== */
const LS_KEY = "gbf_user";
let currentUser = null;          // { id, name, role }
let unsubscribeFeed = null;
let pendingSignup = null;        // holds {name, pin} while waiting for confirm tap
const cardEls = new Map();       // sessionId -> card element
let countdownTimer = null;

const usersCol = collection(db, "users");
const sessionsCol = collection(db, "sessions");

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
    name, nameLower, pinHash, role, createdAt: serverTimestamp()
  });

  loginAs({ id: ref.id, name, role });
  toast(role === "admin"
    ? `Account created — you're the Admin, ${name}! 👑`
    : `Welcome to the squad, ${name}! ⚽`);
}

function loginAs(user) {
  currentUser = user;
  localStorage.setItem(LS_KEY, JSON.stringify(user));
  resetSignupMode();
  setLoading(authBtn, false);
  enterApp();
}

$("#logout-btn").addEventListener("click", () => {
  localStorage.removeItem(LS_KEY);
  currentUser = null;
  if (unsubscribeFeed) { unsubscribeFeed(); unsubscribeFeed = null; }
  clearInterval(countdownTimer);
  cardEls.clear();
  $("#feed").innerHTML = "";
  authForm.reset();
  pinBoxes.forEach(b => { b.value = ""; b.classList.remove("filled"); });
  switchScreen(appScreen, authScreen);
});

/* ==========================================================================
   Main app
   ========================================================================== */
function enterApp() {
  const chip = $("#user-chip");
  chip.innerHTML = "";
  chip.append(currentUser.name);
  if (currentUser.role === "admin") {
    const tag = document.createElement("span");
    tag.className = "role-tag";
    tag.textContent = "admin";
    chip.append(tag);
  }

  $$(".admin-only").forEach(el =>
    el.classList.toggle("hidden", currentUser.role !== "admin"));

  switchScreen(authScreen, appScreen);
  setTimeout(positionTabInk, 380); // after the screen transition finishes
  startFeed();
  $("#empty-hint").textContent = currentUser.role === "admin"
    ? "Head to the Admin tab to create the first session."
    : "Check back soon — the next game will show up here.";
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

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab || tab.classList.contains("active")) return;
  $$(".tab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");
  positionTabInk();

  const showAdmin = tab.dataset.tab === "admin";
  const showEl = showAdmin ? $("#view-admin") : $("#view-feed");
  const hideEl = showAdmin ? $("#view-feed") : $("#view-admin");
  hideEl.classList.add("hidden");
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
        removeCard(id);
      } else if (change.type === "added") {
        addCard(id, change.doc.data(), firstLoad ? idx : 0);
      } else {
        updateCard(id, change.doc.data());
      }
    });
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
  const max = data.maxPlayers || 0;
  const isFull = inNames.length >= max;
  const me = currentUser.name;
  const iAmIn = inNames.includes(me);
  const iAmOut = outNames.includes(me);

  // Capacity bar
  const fill = $(".capacity-fill", card);
  fill.style.width = max ? `${Math.min(100, (inNames.length / max) * 100)}%` : "0%";
  fill.classList.toggle("full", isFull);
  $(".capacity-text", card).textContent = `${inNames.length} / ${max}`;

  $(".list-in .list-count", card).textContent = inNames.length;
  $(".list-out .list-count", card).textContent = outNames.length;

  syncChips(card, inNames, outNames);

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

function removeCard(id) {
  const card = cardEls.get(id);
  if (!card) return;
  cardEls.delete(id);
  card.classList.add("removing");
  card.addEventListener("animationend", () => card.remove(), { once: true });
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
        if (inV.length >= d.maxPlayers) throw new Error("full");
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

/* ------------------ Admin ------------------ */
$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentUser?.role !== "admin") return;

  const location = normalizeName($("#s-location").value);
  const timeVal = $("#s-time").value;
  const max = parseInt($("#s-max").value, 10);
  const when = new Date(timeVal);

  if (!location) return toast("Enter a location.", true);
  if (!timeVal || isNaN(when.getTime())) return toast("Pick a valid time.", true);
  if (when.getTime() < Date.now()) return toast("Time is in the past.", true);
  if (!(max >= 2 && max <= 99)) return toast("Max players must be 2–99.", true);

  const btn = $("#create-btn");
  setLoading(btn, true);
  try {
    await addDoc(sessionsCol, {
      location,
      time: Timestamp.fromDate(when),
      maxPlayers: max,
      inVotes: [],
      outVotes: [],
      createdBy: currentUser.name,
      createdAt: serverTimestamp()
    });
    e.target.reset();
    $("#s-max").value = 10;
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
   Boot: restore saved login, verify it still exists, route to a screen
   ========================================================================== */
(async function boot() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch { /* corrupt */ }

  if (saved?.id && saved?.name) {
    try {
      await ensureFirebaseSession();
      const snap = await getDoc(doc(db, "users", saved.id));
      if (snap.exists()) {
        // Refresh role in case an admin promoted/demoted this user
        currentUser = { id: saved.id, name: snap.data().name, role: snap.data().role };
        localStorage.setItem(LS_KEY, JSON.stringify(currentUser));
        enterApp();
        $("#boot").classList.add("gone");
        return;
      }
      localStorage.removeItem(LS_KEY);
    } catch (err) {
      console.error("Session restore failed:", err);
    }
  }

  authScreen.classList.remove("hidden");
  $("#boot").classList.add("gone");
})();
