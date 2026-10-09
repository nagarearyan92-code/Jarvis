# Jarvis: your personal AI assistant

Talk or type to Jarvis on your iPhone. He works in two modes, and switches automatically:

- **📱 Phone mode (works anywhere, no laptop):** answers anything, searches the web, reads links,
  remembers things about you, and runs **cloud coding tasks** on your GitHub projects (like Gia Mia).
  Claude does the coding in GitHub's cloud on a separate branch, and nothing ships until you tap **Ship it**.
- **💻 Laptop mode (when your laptop is on):** everything above, plus he controls the laptop itself.
  He can develop code there, handle files, open apps, take screenshots and more, and asks your phone
  before anything risky.

```
                      ┌──────────────▶ Claude (Anthropic API)        📱 phone mode
 iPhone: Jarvis app ──┤──────────────▶ GitHub: cloud coding tasks    📱 phone mode
                      └──Tailscale───▶ Laptop: Jarvis ──▶ Claude     💻 laptop mode
```

Your keys are stored only on your phone (and, for laptop mode, on your laptop). The code in this repo
contains no secrets, which is why the repo can be public for free hosting.

---

## Part 1: Phone mode (about 15 minutes, no laptop needed)

### 1. Put the app online (once)
1. This repo must be **public** (GitHub Pages is free for public repos). It contains no keys.
2. On GitHub, open this repo, then go to **Settings > Pages > Build and deployment > Source** and choose **GitHub Actions**.
3. Go to the **Actions** tab, open **Publish phone app** and tap **Run workflow**. After about a minute
   your app is live at `https://<your-username>.github.io/<repo-name>/`.

### 2. Add it to your iPhone
Open that address in **Safari**, tap **Share > Add to Home Screen**. Jarvis gets his glowing-orb icon.

### 3. Give Jarvis his keys (in the app: ⚙︎ Settings)
- **Anthropic API key:** at console.anthropic.com, go to **API Keys** and create a new key named "Jarvis".
  Paste it and tap **Test key**.
  Also set a monthly spending limit under **Settings > Limits** in the Console, because this key lives on your phone.
- **GitHub token (for cloud coding):** at github.com go to **Settings > Developer settings > Personal access
  tokens > Fine-grained tokens > Generate new token**.
  - Repository access: **Only select repositories**, then pick the repos Jarvis may work on (e.g. gia-foodtracker).
  - Permissions: **Contents: Read and write**, **Issues: Read and write**, **Pull requests: Read and write**.
  - Paste it, list your project repos (e.g. `nagarearyan92-code/gia-foodtracker`) and tap **Test GitHub**.
- **Memory:** anything you'd like him to always know ("I live in London", "keep answers short").

### 4. Switch on cloud coding for a repo (once per repo)
Gia Mia already has the workflow file (`.github/workflows/claude.yml`) and coding rules (`CLAUDE.md`). For each repo:
1. Install the **Claude GitHub app** on it: github.com/apps/claude, then **Configure** and select the repo.
2. In the repo, go to **Settings > Secrets and variables > Actions > New repository secret**.
   Name it **`ANTHROPIC_API_KEY`** and paste an Anthropic key.
3. For a new repo, copy `.github/workflows/claude.yml` from gia-foodtracker and adjust its allowed commands.

**Test GitHub** in Settings shows "ready" for repos that have the workflow file.

### "Hey Siri, Jarvis" (phone mode, no laptop needed)
A web app can't be woken by "Hey Siri" on its own, but a Shortcut called **Jarvis** can ask Claude and speak the answer:
1. **Shortcuts** app > **+** > name it **Jarvis**.
2. **Dictate Text** (Stop Listening: After Pause).
3. **Get Contents of URL**: `https://api.anthropic.com/v1/messages`, Method **POST**.
   Headers: `x-api-key` = your key, `anthropic-version` = `2023-06-01`, `content-type` = `application/json`.
   Request Body **JSON**: `model` (Text) `claude-sonnet-5-5`, `max_tokens` (Number) `2000`,
   `system` (Text) `You are Jarvis, Aryan's assistant. Answer in one to three short spoken sentences. No lists or emoji.`,
   `messages` (Array) with one Dictionary item: `role` (Text) `user`, `content` (Text) = **Dictated Text**.
4. **Get Dictionary Value**: Value for `content` in Contents of URL.
5. **Repeat with Each** item in Dictionary Value, and inside it **Get Dictionary Value**: Value for `text` in Repeat Item.
6. After End Repeat: **Combine Text** (Repeat Results, with Spaces), then **Speak Text** (Combined Text). Pick the voice in Speak Text's options.

Say "Hey Siri, Jarvis", then your question. The key sits inside the Shortcut, so don't share the Shortcut.

### Using phone mode
- "What's on in London this weekend?" / "Summarise this: <link>" / "Remember Gia is vegetarian when you suggest restaurants"
- "Add a book diary to Gia Mia". He writes the task and asks you to **Start** it. Claude works in the cloud
  for a few minutes. In **🛠 Tasks** you'll see *Working…*, then *Ready to ship* with a summary.
  **Ship it** shows exactly which files changed and asks once more. Shipping merges it, and for Gia Mia,
  GitHub then builds the new version and Gia gets the Update button.
- Changed your mind? **Discard**. Want changes? Tell Jarvis: "on the book diary task, make the covers bigger".

---

## Part 2: Laptop mode (later, about 30 minutes)

### 1. Install the basics on the laptop (once)

| | Windows | Mac |
|---|---|---|
| **Node.js** (runs Jarvis) | nodejs.org, the "LTS" installer | nodejs.org, the "LTS" installer |
| **Git** | git-scm.com/download/win, keep the default options | In Terminal type `git --version` and accept the install |
| **Tailscale** (private link to your phone) | tailscale.com/download, then sign in | tailscale.com/download, then sign in |

Install **Tailscale on your iPhone** too and sign in with the **same account**.
In the Tailscale admin console (login.tailscale.com), go to **DNS** and turn on **HTTPS Certificates**. This lets
the online app reach your laptop securely.

**Windows tip:** Settings > System > Power > set "When plugged in, put my device to sleep after" to **Never**.

### 2. Set Jarvis up on the laptop
```bash
git clone https://github.com/<your-username>/<repo-name>.git jarvis
cd jarvis
npm install
npm run setup
```
Setup asks for names, your Anthropic key, project folders (it can download Gia Mia), spending limits, the
safety level and your **phone app address** from Part 1. Then it shows a **QR code**. Scan it with the iPhone
Camera and the Jarvis app pairs with your laptop. From then on he uses **💻 Laptop mode** whenever the laptop
is reachable, and **📱 Phone mode** otherwise. Tap the mode chip to switch by hand.

**Windows:** when Windows Firewall asks about Node.js, tick **Private networks** and click Allow.
Run `git push` once in the Gia Mia folder to sign in to GitHub so he can ship from the laptop.

### Laptop-mode safety
- **On his own:** reading, searching, editing files **inside the project**, everyday developer commands,
  opening apps, screenshots, volume, lock.
- **Asks your phone first:** pushing to GitHub, deleting anything, changes outside the project, system settings,
  admin commands, shutdown/restart, and (in "careful" mode) any other command.
- **Stop** cancels immediately. Spending limits per task and per month are set in `npm run setup`.

### "Hey Siri, Jarvis" (laptop mode, optional)
In **Shortcuts**: **Dictate Text**, then **Get Contents of URL** (POST `https://<laptop>.<tailnet>.ts.net/api/siri`,
header `Authorization: Bearer <pairing code>`, JSON body `text` = Dictated Text), then **Speak Text**.

### Laptop commands
| Command | What it does |
|---|---|
| `npm run setup` | Change settings, key, projects, limits, phone app address, or make a new pairing code |
| `npm run pair` | Show the pairing QR, laptop address and pairing code again |
| `npm start` | Run Jarvis in this window |
| `npm run practice` | Practice mode: pretend tasks, no AI used |
| `npm run autostart` / `npm run autostart -- off` | Start with the laptop / stop doing that |
| `npm test` | Check the safety rules |

---

## Costs
Everything is pay-as-you-go from your Anthropic credit:
- **Chats:** about a penny or two each.
- **Web searches:** about 1p each.
- **Coding tasks:** typically tens of pence, and bigger features a few pounds.

GitHub's free plan covers the cloud coding and app hosting for personal use.

## Troubleshooting
- **Phone mode says the key was rejected:** create a new key and paste it in ⚙︎ Settings.
- **Tasks stay on "Starting":** check the repo has the Claude GitHub app installed and the `ANTHROPIC_API_KEY`
  secret, and look at the repo's **Actions** tab for errors.
- **Can't reach the laptop:** is it on and awake, with Tailscale on **both** devices? Jarvis falls back to
  phone mode automatically.
- **Pairing code changed:** scan the new QR from `npm run setup`.
- **Home-screen app still says phone mode only:** iPhone home-screen apps don't share Safari's storage. In the paired
  Safari tab open ⚙︎ Settings, tap **Copy pairing for the home-screen app**, then paste it in the home-screen app's
  ⚙︎ Settings and tap **Pair**. Or run `npm run pair` and type the laptop address and pairing code there.
