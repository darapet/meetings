# MeetAI — darapet-meeting

AI-powered video conferencing. All credentials are already embedded — just follow the 4 steps below to go live.

---

## Your Project Details (already configured)

| Setting | Value |
|---|---|
| Firebase Project | `darapet-meeting` |
| Auth Domain | `darapet-meeting.firebaseapp.com` |
| Realtime DB | `darapet-meeting-default-rtdb.firebaseio.com` |
| Mistral Keys | 5 keys configured with auto-rotation |
| AI Model | `mistral-small-latest` |

---

## 4 Steps to Go Live

### Step 1 — Firebase: Enable Authentication

1. Open [console.firebase.google.com](https://console.firebase.google.com) → select **darapet-meeting**
2. Left sidebar → **Authentication** → **Get started**
3. Click **Sign-in method** tab → enable **Google** → Save
4. Enable **Email/Password** → Save

### Step 2 — Firebase: Enable Realtime Database

1. Left sidebar → **Realtime Database** → **Create database**
2. Choose any region → **Start in test mode** → Done
3. Go to the **Rules** tab → replace everything with:

```json
{
  "rules": {
    "presence": {
      "$meetingId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "signals": {
      "$meetingId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "rooms": {
      "$meetingId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

4. Click **Publish**

### Step 3 — Firebase: Enable Firestore

1. Left sidebar → **Firestore Database** → **Create database**
2. **Start in test mode** → choose a region → Done
3. Go to the **Rules** tab → paste the contents of `firestore.rules` from this folder → **Publish**

### Step 4 — Deploy to GitHub Pages

1. Create a new GitHub repo (public)
2. Upload **all files from this folder** to the repo root
3. Repo → **Settings** → **Pages** → Source: **Deploy from branch** → `main` → `/ (root)` → **Save**
4. Wait ~1 minute → your site is live at `https://YOUR_USERNAME.github.io/YOUR_REPO/`
5. Back in Firebase → **Authentication** → **Settings** → **Authorized domains** → **Add domain** → paste your GitHub Pages URL (e.g. `your-username.github.io`)

---

## First Time You Load the Dashboard

If the meeting history list shows a Firebase error in the browser console (F12), it will include a **link to create a Firestore index** — click it, wait ~1 minute, reload. This only happens once.

---

## Features

| Feature | How it works |
|---|---|
| 🎥 Video / Audio | WebRTC peer-to-peer, Firebase RTDB for signaling |
| 🎙️ Live Transcription | Web Speech API (Chrome/Edge only) |
| 🤖 AI Chat | Mistral AI — 5 keys with auto-rotation |
| 📖 Book Mode Summary | Mistral compiles transcript into chapters |
| 👑 Host Persistence | Host UID stored in Firestore — restored on any rejoin |
| ⏹ Stop / Continue | Stop AI voice instantly, resume with "Continue" |
| 🖥️ Screen Share | Replaces video track for all participants |
| 🔒 Host Privacy Toggle | Hide AI panels from guests with one click |
| 💬 Chat | Real-time via Firestore |
| 📝 Private Notes | Saved in browser localStorage per meeting |
| ⬇️ Download | Export transcript, summary, or notes as .txt |

---

## Browser Requirements

Use **Chrome** or **Edge** for the full experience. Firefox and Safari support video/audio but not live transcription.

---

## File Structure

```
index.html          → Sign in / Register
dashboard.html      → Create & join meetings
meeting.html        → Full meeting room
firestore.rules     → Paste into Firebase Firestore Rules
database.rules.json → Paste into Firebase Realtime Database Rules
css/style.css       → Global design
css/meeting.css     → Meeting room layout
js/config.js        → All credentials (already filled in)
js/auth.js          → Firebase Auth
js/webrtc.js        → WebRTC + signaling
js/transcription.js → Live speech-to-text
js/ai.js            → Mistral AI
js/meeting.js       → Main orchestration
```
