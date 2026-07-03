# ⚽ Gaming Boys Futsal — RSVP App

A static, build-free web app (vanilla JS + Firebase via CDN) for organizing soccer sessions.
Players log in with just a **name + 4-digit PIN**, admins create sessions, everyone votes **In/Out** in realtime.

```
soccer-rsvp/
├── index.html          # App shell (auth screen, feed, admin panel)
├── css/styles.css      # All styling + animations
├── js/firebase.js      # Firebase config & initialization
├── js/app.js           # Auth, realtime feed, voting, admin logic
└── assets/gb-logo.png  # Gaming Boys logo
```

No build step. No npm. Push to GitHub Pages and it runs.

---

## 1. Firebase Console Setup (one-time, ~5 minutes)

Your project **gaming-boys-futsal** already exists and the config keys are already in `js/firebase.js`. Now:

### Step 1 — Create the Firestore database
1. Go to [Firebase Console](https://console.firebase.google.com/) → **gaming-boys-futsal**.
2. In the left sidebar: **Build → Firestore Database → Create database**.
3. Choose a location close to you (e.g. `europe-west` / `asia-south1`), start in **Production mode**.

### Step 2 — Enable Anonymous Authentication
The app signs every visitor in anonymously under the hood so your security rules can block outsiders (the real login is the name+PIN check).

1. **Build → Authentication → Get started**.
2. **Sign-in method** tab → enable **Anonymous** → Save.

### Step 3 — Set the Security Rules
**Firestore Database → Rules** tab, paste this and **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // users: { name, nameLower, pinHash, role, createdAt }
    match /users/{userId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.keys().hasAll(['name', 'nameLower', 'pinHash', 'role'])
        && request.resource.data.name is string
        && request.resource.data.name.size() >= 2
        && request.resource.data.name.size() <= 30
        && request.resource.data.pinHash is string
        && request.resource.data.role in ['admin', 'member'];
      // Accounts can't be edited or deleted from the app.
      allow update, delete: if false;
    }

    // sessions: { location, time, maxPlayers, inVotes, outVotes, ... }
    match /sessions/{sessionId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.location is string
        && request.resource.data.time is timestamp
        && request.resource.data.maxPlayers is int
        && request.resource.data.maxPlayers >= 2
        && request.resource.data.inVotes is list
        && request.resource.data.outVotes is list;
      // Voting only changes the two vote arrays; core fields stay immutable.
      allow update: if request.auth != null
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['inVotes', 'outVotes'])
        && request.resource.data.inVotes.size() <= resource.data.maxPlayers;
      allow delete: if request.auth != null;
    }
  }
}
```

### Step 4 — Collections
**Nothing to create manually.** Firestore creates collections on first write:

| Collection | Field | Type | Notes |
|---|---|---|---|
| `users` | `name` | string | Display name |
| | `nameLower` | string | Lowercased — enforces unique names |
| | `pinHash` | string | SHA-256 of the PIN (raw PIN never stored) |
| | `role` | string | `admin` or `member` |
| | `createdAt` | timestamp | |
| `sessions` | `location` | string | |
| | `time` | timestamp | Kick-off |
| | `maxPlayers` | number | Cap |
| | `inVotes` | array of strings | Player names voting In |
| | `outVotes` | array of strings | Player names voting Out |
| | `createdBy` | string | Admin's name |
| | `createdAt` | timestamp | |

### Step 5 — Authorize your GitHub Pages domain
1. **Authentication → Settings → Authorized domains → Add domain**.
2. Add `YOUR-USERNAME.github.io` (localhost is pre-authorized for testing).

---

## 2. Admin Account

- **The first person to sign up automatically becomes Admin.** Sign up yourself first!
- To promote someone later: Firebase Console → Firestore → `users` → open their document → change `role` to `admin`. (They'll get the Admin tab next time they open the app.)

---

## 3. Run Locally

Browsers block ES modules from `file://`, so serve the folder:

```bash
cd soccer-rsvp
python -m http.server 8000
# or: npx serve .
```

Open http://localhost:8000

---

## 4. Deploy to GitHub Pages

```bash
cd soccer-rsvp
git init
git add .
git commit -m "Gaming Boys Futsal RSVP app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save.**
Live in ~1 minute at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.
(All asset paths in the app are relative, so it works from a subpath.)

---

## 5. How It Works

- **Auth** — Name + PIN checked against the `users` collection. The PIN is salted with the name and SHA-256-hashed in the browser before being stored or compared. New names get a two-tap confirm (button turns amber) so a typo can't silently create an account. Login persists via `localStorage`.
- **Realtime** — The feed uses a Firestore `onSnapshot` listener; votes and new sessions appear instantly for everyone without refreshing. Sessions stay listed until 3 hours after kick-off.
- **Voting** — Runs in a Firestore **transaction**: the cap is re-checked server-side at commit time, so two people can't race for the last spot. When the In list is full, the In button fades and locks for anyone not already in.
- **Animations** — Staggered card entrance, FLIP-based name chips that slide between the In/Out lists, animated capacity bar, morphing buttons, tab ink slider.

## ⚠️ Honest security notes

- The Firebase config in `js/firebase.js` is **safe to publish** — it identifies the project; the security rules are what protect the data.
- This is a **PIN-based trust system for a friend group**, not bank-grade auth: anyone who can sign in anonymously (i.e., anyone using the app) can technically read the users list and vote arrays. Rules prevent account tampering and cap-breaking, but role checks for *creating* sessions are enforced in the UI, not by rules (rules can't know your name+PIN identity). Perfectly fine for a futsal squad; don't reuse a PIN you use elsewhere.
