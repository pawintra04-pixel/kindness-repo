// ============================================================
// FIREBASE BOOTSTRAP
// ------------------------------------------------------------
// Initializes the Firebase app via the official npm modular SDK
// (bundled by Vite), turns on IndexedDB offline persistence so
// reads stay instant and the app keeps working offline, and signs
// the device in anonymously so Firestore security rules can require
// an authenticated caller (request.auth != null).
//
// These config values are public Firebase identifiers by design —
// real protection comes from Firestore Security Rules + Auth, not
// from hiding the apiKey.
// ============================================================
import { initializeApp } from "firebase/app"
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore"
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "firebase/auth"

const firebaseConfig = {
  apiKey: "AIzaSyDKaawb7diEHvHMMRnJnR989IfK1mE37p0",
  authDomain: "kindness-repo.firebaseapp.com",
  projectId: "kindness-repo",
  storageBucket: "kindness-repo.firebasestorage.app",
  messagingSenderId: "456291938469",
  appId: "1:456291938469:web:fca195868cc9d01ea0dd4c",
}

export const app = initializeApp(firebaseConfig)

// Firestore is the source of truth. The persistent local cache is an
// IndexedDB read-through cache that keeps every screen instant and lets
// the app run offline; writes are queued and replayed automatically.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
})

export const auth = getAuth(app)

// Resolves once we have an authenticated (anonymous) user, so the data
// layer can wait before issuing reads/writes that the rules will gate.
export const authReady = new Promise((resolve) => {
  let settled = false
  onAuthStateChanged(auth, (user) => {
    if (user && !settled) {
      settled = true
      resolve(user)
    }
  })
  signInAnonymously(auth).catch((err) => {
    // If Anonymous Auth is not enabled in the Firebase console the app
    // still renders from cache/defaults; it just cannot sync until it is.
    console.error(
      "[kindness-repo] Anonymous sign-in failed. Enable Anonymous Auth in the Firebase console (Authentication > Sign-in method).",
      err,
    )
    if (!settled) {
      settled = true
      resolve(null)
    }
  })
})
