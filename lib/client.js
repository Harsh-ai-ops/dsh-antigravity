// dsh-antigravity — Client half.
// A permanent shell-overlay badge: active Google account + live quota bars
// for the main model families, refreshed every 2 minutes (manual ⟳ too).

const FAMILIES = [
  { label: "G3.7", model: "gemini-3.7-flash-high" },
  { label: "G3.7T", model: "gemini-3.7-flash-tiered" },
  { label: "Cld", model: "claude-sonnet-4-6" },
  { label: "OSS", model: "gpt-oss-120b-medium" },
];

function barColor(usedPct) {
  if (usedPct >= 80) return "#f87171";
  if (usedPct >= 50) return "#fbbf24";
  return "#34d399";
}

function apply(ctx) {
  const slots = ctx.get("slots");
  if (slots === undefined) return;

  styles.insert(`
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
    .agw-badge .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .agw-badge .dot.ok { background: #34d399; }
    .agw-badge .dot.warn { background: #fbbf24; }
    .agw-badge .dot.bad { background: #f87171; }
    .agw-badge .dot.off { background: #64748b; }
    .agw-badge .email { font-weight: 600; }
    .agw-badge .meters { display: flex; gap: 6px; align-items: center; }
    .agw-badge .meter { display: flex; gap: 3px; align-items: center; }
    .agw-badge .meter .bar {
      width: 34px; height: 5px; border-radius: 3px;
      background: #334155; overflow: hidden; display: inline-block;
    }
    .agw-badge .meter .bar > i { display: block; height: 100%; }
    .agw-badge .refresh {
      background: none; border: none; color: #94a3b8; cursor: pointer;
      font-size: 13px; padding: 0 2px; line-height: 1;
    }
    .agw-badge .refresh:hover { color: #e2e8f0; }
    @media (max-width: 720px) {
      .agw-badge { right: 8px; top: 8px; font-size: 10px; padding: 4px 8px; }
      .agw-badge .email { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }
  `);

  function Badge() {
    const [state, setState] = React.useState({ loading: true, data: null });

    const load = React.useCallback(async () => {
      setState(function (s) { return { ...s, loading: true }; });
      try {
        const data = await host.call("antigravity/status", {});
        setState({ loading: false, data: data });
      } catch {
        setState({ loading: false, data: { connected: false, accounts: [] } });
      }
    }, []);

    React.useEffect(function () {
      load();
      const iv = setInterval(load, 120000);
      return function () { clearInterval(iv); };
    }, [load]);

    const data = state.data;

    if (!data) {
      return React.createElement("div", { className: "agw-badge" },
        React.createElement("span", { className: "dot off" }),
        React.createElement("span", null, "Antigravity…"));
    }

    if (!data.connected) {
      return React.createElement("div", {
        className: "agw-badge",
        title: "No Antigravity account linked — click to sign in",
        onClick: function () { host.call("antigravity/login", {}); },
      },
        React.createElement("span", { className: "dot off" }),
        React.createElement("span", null, "Link Google"));
    }

    const first = data.accounts && data.accounts[0];

    // Aggregate worst-case usage across accounts for each family.
    const meters = React.createElement("span", { className: "meters" },
      FAMILIES.map(function (f) {
        let usedPct = 0;
        if (first && first.quota && first.quota[f.model]) {
          usedPct = first.quota[f.model].used_percent;
        }
        return React.createElement("span", {
          className: "meter",
          key: f.model,
          title: f.model + ": " + usedPct + "% used",
        },
          React.createElement("span", { style: { color: "#94a3b8" } }, f.label),
          React.createElement("span", { className: "bar" },
            React.createElement("i", { style: { width: Math.min(100, usedPct) + "%", background: barColor(usedPct) } })));
      }));

    return React.createElement("div", { className: "agw-badge" },
      React.createElement("span", {
        className: "dot " + (first && first.quota ? "ok" : "warn"),
        title: data.total_accounts + " account(s) in rotation",
      }),
      React.createElement("span", { className: "email", title: data.active_account },
        (data.active_account || "").split("@")[0]),
      meters,
      data.total_accounts > 1
        ? React.createElement("span", { style: { color: "#64748b" } }, "+" + (data.total_accounts - 1))
        : null,
      React.createElement("button", {
        className: "refresh",
        title: "Refresh quota",
        onClick: load,
      }, "⟳"));
  }

  return slots.inject("shell.overlay", function () {
    return slots.register(
      { name: "shell.overlay", id: "dsh-antigravity-status", order: 10, label: "Antigravity quota" },
      function () { return React.createElement(Badge); }
    );
  });
}

export { apply };
export default { apply };
