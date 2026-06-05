// ============================================================
//  AUTH.JS — Firebase Authentication + User Profile Sync
// ============================================================

firebase.initializeApp(firebaseConfig);
const auth      = firebase.auth();
const db        = firebase.database();
const firestore = firebase.firestore(); // kept for legacy; meeting code uses RTDB

// ── Providers ─────────────────────────────────────────────
const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.addScope("profile");
googleProvider.addScope("email");

// ── Sign in with Google ───────────────────────────────────
async function signInWithGoogle() {
  try {
    showAuthSpinner();
    await auth.signInWithPopup(googleProvider);
  } catch (err) {
    hideAuthSpinner();
    showAuthError(_friendlyAuthError(err));
  }
}

// ── Sign in with Email/Password ───────────────────────────
async function signInWithEmail(email, password) {
  try {
    showAuthSpinner();
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    hideAuthSpinner();
    showAuthError(_friendlyAuthError(err));
  }
}

// ── Register with Email/Password ─────────────────────────
async function registerWithEmail(email, password, displayName) {
  try {
    showAuthSpinner();
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName });
    _upsertUserProfile(cred.user); // fire-and-forget
  } catch (err) {
    hideAuthSpinner();
    showAuthError(_friendlyAuthError(err));
  }
}

// ── Sign Out ──────────────────────────────────────────────
async function signOut() {
  await auth.signOut();
  window.location.href = "index.html";
}

// ── Save / Update User Profile in Realtime Database ───────
//    Fire-and-forget — never awaited in onAuthReady so it
//    can NEVER block the page from loading.
function _upsertUserProfile(user) {
  if (!user) return Promise.resolve();
  return db.ref("users/" + user.uid).update({
    uid:         user.uid,
    displayName: user.displayName || "Anonymous",
    email:       user.email       || "",
    photoURL:    user.photoURL    || "",
    lastSeen:    firebase.database.ServerValue.TIMESTAMP
  }).catch(() => {}); // silently ignore any write failures
}

// ── Auth State Observer ───────────────────────────────────
//    Callback fires IMMEDIATELY — profile save is fire-and-forget.
function onAuthReady(callback) {
  return auth.onAuthStateChanged(user => {
    if (user) _upsertUserProfile(user); // intentionally NOT awaited
    callback(user);
  });
}

// ── Get Current User ──────────────────────────────────────
function getCurrentUser() {
  return auth.currentUser;
}

// ── Generate Initials from Display Name ──────────────────
function getInitials(name) {
  if (!name) return "?";
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

// ── Friendly error messages ───────────────────────────────
function _friendlyAuthError(err) {
  const map = {
    "auth/user-not-found":       "No account found with that email.",
    "auth/wrong-password":       "Incorrect password.",
    "auth/email-already-in-use": "Email already registered. Try signing in.",
    "auth/weak-password":        "Password must be at least 8 characters.",
    "auth/invalid-email":        "Invalid email address.",
    "auth/popup-closed-by-user": "Sign-in window closed. Please try again.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/too-many-requests":    "Too many attempts. Try again later.",
    "auth/unauthorized-domain":
      "Google sign-in is blocked on this domain. " +
      "To fix it: go to Firebase Console → Authentication → Settings → Authorized domains → " +
      "Add domain → paste your site URL. " +
      "Until then, please use Email/Password login."
  };
  return map[err.code] || err.message;
}

// ── UI Helpers ────────────────────────────────────────────
function showAuthSpinner() {
  const el = document.getElementById("authSpinner");
  if (el) el.style.display = "flex";
}
function hideAuthSpinner() {
  const el = document.getElementById("authSpinner");
  if (el) el.style.display = "none";
}
function showAuthError(msg) {
  const el = document.getElementById("authError");
  if (el) { el.textContent = msg; el.style.display = "block"; }
}
function clearAuthError() {
  const el = document.getElementById("authError");
  if (el) { el.textContent = ""; el.style.display = "none"; }
}
