# Splash AI

Kelvin's own AI. Wake it with your voice, tell it what to do, and it does it on your Windows laptop or your Android phone. It switches between free AI models on its own when one runs out, writes notes as you talk, keeps every conversation until you delete it, and learns from your corrections.

```
splash-ai/
  shared/     brain, model router and the animated core (used by both apps)
  desktop/    Windows app (Electron)  -> .exe
  mobile/     Android app (Capacitor) -> .apk
  scripts/    sync-shared.js copies /shared into both apps
```

## 1. What to install first (once)

1. **Node.js 20 LTS or newer**: https://nodejs.org
2. **For the APK only: Android Studio** (https://developer.android.com/studio). Open it once so it installs the Android SDK. It ships with the Java 17 that Capacitor 6 needs.
   Then set these (PowerShell, then reopen the terminal):
   ```powershell
   setx ANDROID_HOME "$env:LOCALAPPDATA\Android\Sdk"
   setx JAVA_HOME "C:\Program Files\Android\Android Studio\jbr"
   ```
3. **Optional but recommended: Ollama** (https://ollama.com/download), the model that never runs out because it runs on your own laptop:
   ```powershell
   ollama pull llama3.2
   ```

## 2. Build the Windows app (.exe)

```powershell
cd splash-ai\desktop
npm install
npm start          # runs it right away to test
npm run dist       # builds the installer and the portable exe
```

You get two files in `desktop\dist\`:
- `Splash AI Setup 1.0.0.exe` installs it with a desktop shortcut.
- `SplashAI-Portable-1.0.0.exe` runs without installing. Copy it to any of your other Windows PCs.

On first launch it downloads the offline voice model (about 40 MB, once). Windows asks to allow it on your network: allow **Private networks** so your phone can reach it.

## 3. Build the Android app (.apk)

```powershell
cd splash-ai\mobile
npm install
npm run setup      # first time only: creates the android project
npm run apk        # builds the apk
```

The APK is at `mobile\android\app\build\outputs\apk\debug\app-debug.apk`. Copy it to your phone and install it (allow "install unknown apps" when asked).

## 4. Turn the models on (about 10 minutes)

Open Splash AI on the laptop, go to **Settings, Models**. Each model has a **Get a free key** link. Sign up, copy the key, paste it in, and press **Save settings**. Each key you add is one more model in the rotation. The order on that screen is the order it tries them; use the arrows to change it.

| Model | Free key page |
|---|---|
| Google Gemini | aistudio.google.com/apikey |
| Groq (also powers the sharp speech recognition) | console.groq.com/keys |
| OpenRouter, free models | openrouter.ai/keys |
| Mistral | console.mistral.ai/api-keys |
| GitHub Models (a GitHub token) | github.com/settings/tokens |
| Hugging Face | huggingface.co/settings/tokens |
| OpenAI (paid; paste the **secret key** that starts with `sk-`) | platform.openai.com/api-keys |
| GLM 5.2 by Z.ai (paid) | z.ai/manage-apikey/apikey-list |
| Claude (paid, pay per use, needs credit on your Anthropic account) | platform.claude.com/settings/keys |
| Ollama, on your laptop | no key |

When a model hits its limit it "rests" (you'll see this in Settings) and the next one answers. It tries the rested ones again later, so they rotate as their limits reset. If a model name stops working because the provider renamed it, edit the model name in the same box.

## 5. Link your phone to your laptop

1. Laptop: **Settings, Phone link**. You'll see a QR code and a 6-number PIN (it lasts 10 minutes; press **New PIN** for another).
2. Phone: **Settings, Your laptop**, tap **Scan QR code** and point it at the laptop screen. That's it: it links and copies the model keys if the phone has none yet.
   No camera? Tap **Pair with PIN** and type the laptop's address (e.g. `192.168.1.20`) and the 6 numbers.
3. Away from home? Install **Tailscale** on both (free) and use the laptop's Tailscale address instead.

To let the phone use Ollama on your laptop too, run this once on the laptop and restart Ollama:
```powershell
setx OLLAMA_HOST "0.0.0.0"
```

## Using it

- **Wake it:** say "Hey Splash AI" (or any wake word you add in Settings), then your command. A beep means it's listening, a second beep means it heard you.
- **Talk without the wake word:** click the core, the mic button, or press **Ctrl+Space** anywhere in Windows.
- **Wake words:** add as many as you want in Settings. Under the core it shows "Heard: ..." so you can see how it hears you. If it hears "hey splash eye", add that spelling as a wake word too.
- **Follow-ups:** after it answers, it listens for about 8 seconds without the wake word ("Any follow-up? Just talk"). While it's thinking the mic stays open too: anything else you say gets added and answered right after. It waits 2.5 seconds of silence before deciding you've finished, so short pauses won't cut you off. Say the wake word while it's speaking to interrupt it.
- **Telling it to stop listening:** say "stop listening", "leave me alone", "I'm not talking to you", "that's all" or "abeg rest" and it goes quiet: no follow-ups and no open mic, only the wake word wakes it. Say "turn off the mic" to switch the mic off completely; click the mic (or Ctrl+Space) to turn it back on. "Stop", "wait", "never mind" or "forget it" cancels what it was about to say.
- **Talking to someone else:** when it hears you without the wake word (during a follow-up or while it's thinking), it works out whether you were talking to it. If you were talking to someone else or to yourself, it stays quiet and shows your words faded with "not for me".
- **Research papers:** say "write me a research paper on ..." (add "short" or "long" if you like). It searches real published papers in OpenAlex, Crossref and arXiv, writes section by section, and opens a Word file with APA references saved in `Documents\Splash AI\Research`. It takes a few minutes and needs at least one online model ticked. It reads abstracts, not full papers, so check the key claims before using it.
- **Documents:** on the laptop, click the paperclip or drag a PDF, Word (.docx) or text file onto the window. On the phone, tap the paperclip. Then ask about it: "explain this to me", "what's on page 3?", "what does it say about payment?". It says which page the answer came from. A long document takes a minute or so the first time you ask for a summary. Parts of the text are sent to whichever online model answers. Scanned PDFs (pictures of pages) can't be read yet. While a document is attached, it asks before doing anything on your computer, because files can contain hidden instructions.
- **Operating the laptop:** ask it to do things in any app, like "open Calculator and work out 25 times 4" or "in Chrome, search for flights to Abuja". It looks at the window in front, finds the buttons and boxes, then clicks, types and presses keys, checking as it goes. It must look before it touches anything, and stops if the window changes. It asks before sending, paying or deleting. With Gemini, OpenAI or Claude ticked it can also see a picture of the screen (that picture is sent to the model), which helps in apps that don't report their buttons.
- **Voice:** it speaks as **Abeo**, a natural Nigerian man's voice, by default. Change it in **Settings, Voice** (Ezinne, Ryan, Andrew, or the offline Windows voices). The natural voices need internet and come from Microsoft's free Edge read-aloud service; if that ever fails, it falls back to the Windows voice.
- **Closing the window** hides it to the tray; it keeps listening. Quit from the tray icon.
- **Phone:** tap the core to talk, or turn on **Wake** for hands-free while the app is open. After it answers it listens once more for a follow-up. When linked to the laptop it uses the same Abeo voice; otherwise it uses the phone's own Nigerian English voice if installed.

Things to try:
- "Create a folder called Invoices on my desktop and put a file in it called todo.txt"
- "What's taking up space in my Downloads folder?"
- "Open Chrome and go to funkque.com"
- "Turn the volume down to 30 percent"
- From the phone: "On my laptop, take a screenshot"
- "Remember that my shop opens at 8am"

**Teaching it:** when it gets something wrong, just correct it ("No, I keep my projects in D:\Work"). It saves the lesson and follows it from then on, on both devices. You can see, add and delete lessons in the **Memory** tab.

## Where your data lives

- Laptop: `Documents\Splash AI\` holds `conversations\`, `notes\` (one file per day) and `memory.json`. Nothing is deleted unless you delete it.
- Settings and keys: `%APPDATA%\Splash AI\config.json`.
- Phone: stored inside the app, synced with the laptop whenever they're linked.

## Confirmations

By default it asks before deleting files, overwriting files, or running commands. Deleted files go to the Recycle Bin unless you tell it "permanently". You can switch the confirmation off in Settings if you want it to just do things.

## If something goes wrong

- **`npm run dist` fails downloading Electron:** run it again; it's usually a network hiccup.
- **"Voice is off" on the laptop:** check Windows Settings, Privacy, Microphone, and allow desktop apps. Port 7777 must be free (change it in Settings, Phone link).
- **APK build says JAVA_HOME or SDK not found:** redo step 1.2 and open a new terminal.
- **A plugin version error during `npm install` in mobile:** run `npm install` again with `--legacy-peer-deps`.
- **Every model failed:** open Settings, Models; the error under each one tells you why (bad key, renamed model, limit reached).
