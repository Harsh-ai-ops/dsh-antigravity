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
- 📊 **Live Quota Badge**: A permanent badge in the DSH web UI (top-right) shows the active Google account and per-model quota bars, refreshed every 2 minutes.
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
2. Sign in with your Google account and click **Allow**.
3. The success page will show:
   - ✅ **Account linked status** and current rotation pool count.
   - 🔘 **[+ Link Another Account]** button to seamlessly connect 2nd or 3rd accounts right then and there.
   - 🔘 **[✓ Done / Start Using DSH]** button to finish.
4. The plugin saves your tokens locally to `~/.dsh/antigravity-keys.json`, starts the internal gateway (`http://127.0.0.1:8787/v1`), and registers all Antigravity models into your DSH model selector.

> **Port note**: the gateway defaults to port `8787`. If something else already listens there (e.g. a standalone gateway), the plugin logs a warning and continues — your models then route through whatever owns the port. To change it, set a `port` override in your profile's `cordis.patch.yml`:
>
> ```yaml
> - id: dsh-antigravity
>   config:
>     port: 8788
> ```

---

## Adding More Accounts Later

You can also link additional accounts anytime after the initial setup by asking the DSH agent in chat:

> *"Add another Antigravity account"* or *"Log in to Antigravity"*

The agent will execute the `antigravity_login` tool to add more accounts into the rotation pool. You can also ask *"check antigravity quota"* (`antigravity_status`) to see exactly how much quota each model family has left per account.

---

## Usage

In the DSH Web UI top navigation or Settings → Models, switch your model to:
- **`Antigravity / Gemini 3.7 Flash (High Thinking)`**
- or any of the other Antigravity models.

Enjoy coding with Gemini 3.7 High Thinking inside DeepSeek Harness!
