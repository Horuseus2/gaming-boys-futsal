// Firebase initialization — loaded as ES modules straight from the CDN,
// so no bundler/build step is needed (perfect for GitHub Pages).
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC4m7-FMxY6TH4pXRVQ0EBaGSp91yChY2U",
  authDomain: "gaming-boys-futsal.firebaseapp.com",
  projectId: "gaming-boys-futsal",
  storageBucket: "gaming-boys-futsal.firebasestorage.app",
  messagingSenderId: "938178160228",
  appId: "1:938178160228:web:ff4f8823d421c752922171",
  measurementId: "G-BRB5TSLPLJ"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Anonymous Firebase Auth session. The app's real identity system is the
// name+PIN check against the `users` collection; this anonymous session only
// exists so Firestore security rules can reject requests from outside the app.
export function ensureFirebaseSession() {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, (user) => {
      if (user) { stop(); resolve(user); }
    }, reject);
    signInAnonymously(auth).catch(reject);
  });
}
