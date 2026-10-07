# Jarvis: your laptop assistant, controlled from your iPhone

Talk or type to Jarvis on your iPhone, and he does the work on your laptop: developing Gia Mia,
handling files, opening apps, taking screenshots and more. He runs on Claude (through the Claude
Agent SDK, the same engine behind Claude Code), and asks your phone before anything risky.

```
 iPhone (app or "Hey Siri")  ──Tailscale (private)──▶  Laptop: Jarvis  ──▶  Claude (Anthropic API)
        ▲                                                   │
        └──────── progress, questions, Approve/Deny ◀───────┘
```

## What you need

- Your laptop (Windows 10/11 or a Mac), switched on.
- An **Anthropic API key**. Make a new one just for Jarvis at console.anthropic.com > API Keys,
  so his spending shows separately from Gia's Miss Curious Bae.
- About 30 minutes for the first setup.

## 1. Install the basics on the laptop (once)

| | Windows | Mac |
|---|---|---|
| **Node.js** (runs Jarvis) | nodejs.org, the "LTS" installer | nodejs.org, the "LTS" installer |
| **Git** (lets him save and ship code) | git-scm.com/download/win, keep the default options | Open Terminal, type `git --version`, and accept the install prompt |
| **Tailscale** (private link to your phone) | tailscale.com/download, then sign in | tailscale.com/download (App Store version is fine), then sign in |

Also install **Tailscale on your iPhone** from the App Store and sign in with the **same account**.
Leave it switched on. It only carries traffic between your own devices.

**Windows tip:** Settings > System > Power > set "When plugged in, put my device to sleep after" to
**Never**, so Jarvis stays reachable while it's on charge.

## 2. Get Jarvis and set him up

Open **PowerShell** (Windows) or **Terminal** (Mac) and run:

```bash
git clone https://github.com/<your-username>/jarvis-assistant.git
cd jarvis-assistant
npm install
npm run setup
```

The setup asks for his name, your API key (it checks the key works), where Gia Mia is (it can download
it for you), spending limits and the safety level. Then it shows a **QR code**.

**Windows:** the first time Jarvis starts, Windows Firewall asks whether to allow Node.js. Tick
**Private networks** and click Allow. That's how your phone reaches him.

To sign in to GitHub so he can ship Gia Mia updates, the first `git push` opens a browser
window to log in (on Windows) or asks for a token (on a Mac). The easiest way is to run this once in the Gia Mia folder:
`git push` and follow the prompts. After that, it's remembered.

## 3. Pair your iPhone

1. Point the iPhone **Camera** at the QR code and tap the link. Jarvis opens in Safari.
2. Tap **Share > Add to Home Screen**. He now has his own glowing-orb icon.

Keep the QR code and link private. Anyone with it, who is also on your Tailscale network, could control the laptop.
To change it, run `npm run setup` again and say yes to "Make a new pairing code".

## 4. Talk to him

Type, or tap the **🎤 on the iPhone keyboard** and speak. Some things to try:

- "Add the book diary to Gia Mia"
- "The period tracker should ask before marking a day. Fix it and show me what changed"
- "Ship it" (he updates WHATS_NEW.md, commits and asks before pushing. Once you approve, GitHub builds it and Gia gets an Update button)
- "Take a screenshot" / "How's the laptop doing?" / "Lock the laptop"
- "Open Spotify and set the volume to 40%"
- "Find my CV in Documents and send it to me"

Pick the **project** (📁 Gia Mia or 💻 General) at the top. He remembers the conversation per project,
so "now make it pink" follows on. Tap **✦** to start fresh. Tap **🔈** to have replies read aloud.

## 5. "Hey Siri, Jarvis" (optional)

In the **Shortcuts** app on your iPhone:

1. Tap **+**, name the shortcut **Jarvis**.
2. Add **Dictate Text** (set "Stop Listening" to *After Pause*).
3. Add **Get Contents of URL**:
   - URL: `http://<laptop-name>:7777/api/siri` (the same address as in the QR link, without the `#t=…` part)
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <your pairing code>` (the part after `#t=` in the link)
   - Request Body: **JSON**, with one field `text` = *Dictated Text*
4. Add **Speak Text** with *Contents of URL*.

Now say "Hey Siri, Jarvis", then your request. Quick tasks get a spoken answer. Longer ones carry on, and you
can follow them in the app.

## Safety: what he does on his own vs. asks first

- **On his own:** reading files, searching, editing files **inside the project**, everyday developer
  commands (npm, git status/add/commit, builds), opening apps, screenshots, volume, lock.
- **Asks your phone first:** pushing to GitHub, deleting anything, changes outside the project, system
  settings, admin commands, shutdown/restart, and (in "careful" mode) any other command.
  If you tap **Deny**, he stops that and asks what you'd like instead.
- **Stop** in the app cancels the current task immediately.
- He never stores your API key anywhere except `~/.jarvis/config.json` on the laptop.

## Costs

Each task is paid from your Anthropic API credit. Quick laptop tasks cost a penny or two; a Gia Mia change
is typically tens of pence, a bigger feature a few pounds. The app header shows this month's spending.
Limits (per task and per month) are set in `npm run setup`.

## Useful commands (on the laptop)

| Command | What it does |
|---|---|
| `npm run setup` | Change settings, API key, projects, limits, or make a new pairing code |
| `npm start` | Run Jarvis in this window (if he isn't set to start automatically) |
| `npm run practice` | Practice mode: try the phone app with pretend tasks, no AI used |
| `npm run autostart` / `npm run autostart -- off` | Start automatically with the laptop / stop doing that |
| `npm test` | Check the safety rules |

Logs (when started automatically) are in `~/.jarvis/server.log`.

## Troubleshooting

- **"Can't reach the laptop":** is it on, awake and connected to the internet? Is Tailscale on, on
  **both** the laptop and the iPhone (VPN icon at the top of the phone)?
- **Asks to pair again:** the pairing code changed. Scan the new QR from `npm run setup`.
- **Screenshot is black or fails:** the laptop is locked, or (Mac) Terminal/Node needs Screen Recording
  permission in System Settings > Privacy & Security.
- **"Anthropic rejected the API key":** make a new key in the Console and run `npm run setup`.
- **Push fails:** run `git push` once yourself in the Gia Mia folder to sign in to GitHub.

## Limits

- The laptop must be on (or asleep with wake-on-LAN set up). After a restart, sign in once.
- Admin pop-ups on Windows (UAC) need someone at the screen.
- Two-factor codes and "I'm not a robot" checks need you.
