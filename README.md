# DSH Antigravity Plugin (`dsh-antigravity`)

Route Google Antigravity models (including **Gemini 3.7 Flash with High Thinking**, Claude Sonnet 4.6, Claude Opus Thinking, and GPT-OSS 120B) directly into DeepSeek Harness with automatic multi-account token rotation and OAuth sign-in.

---

## Features

- 🚀 **1-Step Install**: Uses DSH's native profile plugin system (`dsh plugin add`).
- 🧠 **Full Model Catalog**:
  - `antigravity/gemini-3.7-flash-high` *(Gemini 3.7 Flash with High Thinking)*
  - `antigravity/gemini-3.7-flash` *(Tiered automatic thinking)*
  - `antigravity/gemini-3.7-flash-medium` & `-low`
  - `antigravity/gemini-3.6-flash-high` & `-tiered`
  - `antigravity/gemini-pro-agent` & `gemini-3.1-pro-low`
  - `antigravity/claude-sonnet-4-6` & `claude-opus-4-6-thinking`
  - `antigravity/gpt-oss-120b-medium`
- 🔄 **Multi-Account Rotation**: Add multiple Google accounts; rate limits (429) automatically roll over to the next account.
- 🛡️ **Built-in Schema Sanitizer**: Automatically cleans rich tool schemas down to Antigravity's required protobuf format so tool calls never throw 400s.
- 🔌 **Zero External Dependencies**: Does not require `superoc`, `opencode`, or `bun`. Everything runs inside DSH.

---

## Installation for Friends

### Step 1: Install the plugin into DSH

In your terminal / PowerShell:

```bash
dsh plugin --profile web add "github:Harsh-ai-ops/dsh-antigravity"
```

*(Or from a local folder / tarball: `dsh plugin --profile web add ./path/to/dsh-antigravity`)*

### Step 2: Start DSH

Start your DSH Web GUI:

```bash
dsh web
```

**Zero-touch setup happens automatically on startup**:
1. If no account is linked, your default browser will **automatically open** to the Google OAuth sign-in page.
2. Sign in and click Allow.
3. The plugin captures your token, starts the internal gateway (`http://127.0.0.1:8787/v1`), and registers all Antigravity models directly into DSH.

---

## Adding More Accounts (Multi-Account Rotation)

If you want to pool multiple Google accounts for higher rate limits and automatic 429 rotation, you can add another account at any time by asking the DSH agent in chat:

> *"Add another Antigravity account"* or *"Log in to Antigravity"*

The agent will execute the `antigravity_login` tool to link additional accounts into `~/.dsh/antigravity-keys.json`.

---

## Usage

In the DSH Web UI top navigation or Settings → Models, switch your model to:
- **`Antigravity / Gemini 3.7 Flash (High Thinking)`**
- or any of the other Antigravity models.

Enjoy coding with Gemini 3.7 High Thinking inside DeepSeek Harness!
