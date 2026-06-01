# Passport Appointment Watcher

Watches the U.S. Department of State **Online Passport Appointment System**
(`passportappointment.travel.state.gov`) and **alarms the instant a real,
bookable slot opens** at the passport agency you choose — so you can grab a
last‑minute cancellation for your own urgent‑travel appointment. Slots appear
and vanish in seconds; this watches so you don't have to.

> **What it does / doesn't do.** It only *watches* and *alerts you* — it does
> **not** book for you, fill in your information, solve CAPTCHAs, or bypass any
> security. When it finds a real opening it makes noise; **you** click the slot
> and finish booking (you get a ~15‑minute hold once you select one). Use it for
> **your own** legitimate appointment. Not affiliated with the U.S. government.

## What you need

- **Windows 10 or 11**
- **Google Chrome or Microsoft Edge** (Edge comes with Windows, so you're covered)
- A phone with the free **[ntfy](https://ntfy.sh/)** app (optional but recommended — that's how you get alerted away from the computer)

## Quick start

**Easiest (no tech setup):** download **`passport-appointment-watcher.exe`** from the
[Releases page](https://github.com/yosseld/passport-appointment-watcher/releases) and double‑click it. Skip to *First run* below.

**From source (if you prefer):**
1. Install [Node.js](https://nodejs.org/) (LTS) — or just run `setup.cmd`, which installs it for you.
2. Double‑click **`setup.cmd`** (installs dependencies).
3. Double‑click **`start.cmd`** to run.

## First run

1. A **setup window** opens in the browser — **pick your passport agency** from
   the dropdown and click **Start watching** (the zip is filled in for you).
2. The console prints a **PHONE ALERTS** link like `https://ntfy.sh/passport-...`.
   Open the **ntfy** app on your phone, tap **+**, and subscribe to that exact
   topic. (Private unless you share the link.)
3. **Complete Step 1 (Travel Plans)** in the browser until you reach the
   **"Find an Agency"** page, then leave the window open.
4. Done — it watches your agency and **screams + pushes your phone** the moment a
   *real* slot opens. Pick the open window → **Next** → finish booking.

Stop anytime by closing the window or pressing **Ctrl+C**.

## Switch agencies

Re‑open the picker: double‑click **`configure.cmd`** (or run
`passport-appointment-watcher.exe --configure`), choose a different agency, and click Start.
_(Advanced: you can also edit `agency` / `searchZip` directly in the config file
whose path is printed at startup.)_

## How it works (the short version)

An agency can be in three states, and only the third is worth waking you for:

1. **Not selectable** — fully booked, no "Select" button.
2. **Selectable but empty** — you can open its calendar, but every day says
   *"no appointments available."* (A common false signal.)
3. **Selectable with a real open window** — a bookable time/AM‑PM slot. ← alarms.

So when your agency becomes selectable, the watcher **clicks in, checks the
calendar, and only alarms on a genuine opening** (with a double‑check to ignore
half‑loaded pages). It reloads the calendar aggressively (~4–8s) because slots
vanish fast, and it **remembers your session** so it never makes you redo Step 1
if it restarts.

## Options (config file or environment variables)

| Setting | Default | Meaning |
|---|---|---|
| `agency` | `Miami` | Agency name to watch |
| `searchZip` | `33130` | Zip the watcher searches to surface the agency |
| `ntfyTopic` | _(auto)_ | Your private phone‑alert topic |
| `calMinMs` / `calMaxMs` | `4000` / `8000` | Calendar reload interval (ms) |
| `pollMinMs` / `pollMaxMs` | `12000` / `18000` | Agency‑list check interval (ms) |

Test the alarm anytime: `node watcher.js --test` (or `test-alarm.cmd`).

## Troubleshooting

- **"Could not launch Chrome or Edge"** — install Google Chrome.
- **"not in results for <zip>"** — your zip doesn't surface that agency; try a zip closer to it.
- **Stops watching / "session expired"** — the gov session timed out; just redo Step 1 and it resumes.
- Please keep the intervals reasonable — it's a real government server.

## Build the .exe yourself

With Node.js installed, double‑click **`build.cmd`** (or run `npm install && npm run build`).
It produces `passport-appointment-watcher.exe` (~40 MB) bundling Node + dependencies — recipients only
need Chrome or Edge. Distribute it via your repo's **Releases**, not committed in the repo.

## License

MIT — see [LICENSE](LICENSE).
