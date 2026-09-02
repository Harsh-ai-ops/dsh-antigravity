// dsh-antigravity — Client half (DSH client-module bundle format).
// A permanent shell-overlay badge: active Google account + live quota bars
// for the main model families, refreshed every 2 minutes (manual ⟳ too).
// Status is read directly from the plugin gateway's /status endpoint — no
// host RPC needed, so it works in any profile that mounts the bundle.
//
// Consumed through package.json: dsh.client { platform: "web", inject: [...] }
// and exports["./client"]; loaded by window.__ModuleLoader__ as a factory.

window.__ModuleLoader__.load({
  id: "dsh-antigravity",
  factory: (require) => {
    const react = require("react");

    const FAMILIES = [
      { label: "G3.7", model: "gemini-3.7-flash-high" },
      { label: "G3.7T", model: "gemini-3.7-flash-tiered" },
      { label: "Cld", model: "claude-sonnet-4-6" },
      { label: "OSS", model: "gpt-oss-120b-medium" },
    ];

    // Gateway port must match the host config (default 8787).
    const STATUS_URL = "http://127.0.0.1:8787/status";

    function barColor(usedPct) {
      if (usedPct >= 80) return "#f87171";
      if (usedPct >= 50) return "#fbbf24";
      return "#34d399";
    }

    function Badge() {
      const [state, setState] = react.useState({ loading: true, data: null });

      const load = react.useCallback(async () => {
        setState(function (s) { return { ...s, loading: true }; });
        try {
          const res = await fetch(STATUS_URL);
          const data = await res.json();
          setState({ loading: false, data: data });
        } catch {
          setState({ loading: false, data: { connected: false, accounts: [] } });
        }
      }, []);

      react.useEffect(function () {
        load();
        const iv = setInterval(load, 120000);
        return function () { clearInterval(iv); };
      }, [load]);

      const data = state.data;

      if (!data) {
        return react.createElement("div", { className: "agw-badge" },
          react.createElement("span", { className: "agw-dot agw-off" }),
          react.createElement("span", null, "Antigravity…"));
      }

      if (!data.connected) {
        return react.createElement("div", {
          className: "agw-badge",
          title: "No Antigravity account linked yet — run dsh-antigravity login from a terminal, or ask the agent to use antigravity_login",
        },
          react.createElement("span", { className: "agw-dot agw-off" }),
          react.createElement("span", null, "Antigravity: not linked"));
      }

      const first = data.accounts && data.accounts[0];

      const meters = react.createElement("span", { className: "agw-meters" },
        FAMILIES.map(function (f) {
          let usedPct = 0;
          if (first && first.quota && first.quota[f.model]) {
            usedPct = first.quota[f.model].used_percent;
          }
          return react.createElement("span", {
            className: "agw-meter",
            key: f.model,
            title: f.model + ": " + usedPct + "% used",
          },
            react.createElement("span", { style: { color: "#94a3b8" } }, f.label),
            react.createElement("span", { className: "agw-bar" },
              react.createElement("i", { style: { width: Math.min(100, usedPct) + "%", background: barColor(usedPct) } })));
        }));

      return react.createElement("div", { className: "agw-badge" },
        react.createElement("span", {
          className: "agw-dot " + (first && first.quota ? "agw-ok" : "agw-warn"),
          title: data.total_accounts + " account(s) in rotation",
        }),
        react.createElement("span", { className: "agw-email", title: data.active_account },
          (data.active_account || "").split("@")[0]),
        meters,
        data.total_accounts > 1
          ? react.createElement("span", { style: { color: "#64748b" } }, "+" + (data.total_accounts - 1))
          : null,
        react.createElement("button", {
          className: "agw-refresh",
          title: "Refresh quota",
          onClick: load,
        }, "⟳"));
    }

    const inject = ["slots"];

    function apply(ctx) {
      // Styles as a plain <style> tag; the module system claims untagged
      // style tags for this plugin automatically (claimStyles).
      const style = document.createElement("style");
      style.textContent = `
    .agw-badge {
      position: fixed;
      right: 14px;
      top: 14px;
      z-index: 60;
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid #334155;
      border-radius: 9999px;
      padding: 6px 12px;
      font-size: 12px;
      color: #e2e8f0;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      pointer-events: auto;
      user-select: none;
    }
    .agw-badge .agw-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .agw-badge .agw-dot.agw-ok { background: #34d399; }
    .agw-badge .agw-dot.agw-warn { background: #fbbf24; }
    .agw-badge .agw-dot.agw-off { background: #64748b; }
    .agw-badge .agw-email { font-weight: 600; }
    .agw-badge .agw-meters { display: flex; gap: 6px; align-items: center; }
    .agw-badge .agw-meter { display: flex; gap: 3px; align-items: center; }
    .agw-badge .agw-meter .agw-bar {
      width: 34px; height: 5px; border-radius: 3px;
      background: #334155; overflow: hidden; display: inline-block;
    }
    .agw-badge .agw-meter .agw-bar > i { display: block; height: 100%; }
    .agw-badge .agw-refresh {
      background: none; border: none; color: #94a3b8; cursor: pointer;
      font-size: 13px; padding: 0 2px; line-height: 1;
    }
    .agw-badge .agw-refresh:hover { color: #e2e8f0; }
    @media (max-width: 720px) {
      .agw-badge { right: 8px; top: 8px; font-size: 10px; padding: 4px 8px; }
      .agw-badge .agw-email { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }
  `;
      document.head.append(style);

      ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "dsh-antigravity-status", label: () => "antigravity" },
        Badge
      )), "dsh-antigravity: status badge slot");
    }

    const module = { exports: {} };
    module.exports = { name: "dsh-antigravity", inject, apply };
    return module.exports;
  },
});
