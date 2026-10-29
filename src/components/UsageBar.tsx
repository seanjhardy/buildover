import { useEffect, useRef, useState } from "react";
import { LogIn, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useUsage, type ClaudeAccountSummary, type UsageBucket } from "../hooks/useUsage.js";
import { api } from "../lib/api.js";
import { paceSummary } from "../lib/usagePace.js";

function colorFor(util: number): string {
  if (util >= 90) return "var(--app-error)";
  if (util >= 70) return "var(--app-warning)";
  return "var(--app-claude-orange)";
}

function formatTimeUntil(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return mins > 0 ? `${mins}m` : "<1m";
}

/** Today's resets as a time, later ones as the weekday ("Wed 3pm"). */
function resets(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d
    .toLocaleTimeString(undefined, { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined, hour12: true })
    .replace(/\s/g, "")
    .toLowerCase();
  return d.getTime() - Date.now() < 86_400_000
    ? time
    : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function weekday(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.getTime() - Date.now() < 86_400_000
    ? resets(iso)
    : d.toLocaleDateString(undefined, { weekday: "short" });
}

function bucketBlocked(bucket: UsageBucket | null | undefined): boolean {
  if (!bucket || bucket.utilization < 100) return false;
  // A bucket whose reset time has already passed has effectively reset even if
  // the provider hasn't refreshed the reported number yet — don't block on it.
  if (bucket.resetsAt && new Date(bucket.resetsAt).getTime() <= Date.now())
    return false;
  return true;
}

/** A Decisions-style meter; `pace` marks where even use would be by now. */
function Meter({ name, bucket, pace }: { name: string; bucket: UsageBucket; pace?: number }) {
  const used = Math.round(Math.max(0, Math.min(100, bucket.utilization)));
  return (
    <div className={`meter ${used >= 90 ? "high" : ""}`}>
      <div className="meter-row">
        <span>{name}</span>
        <span className="meter-value">
          <span>{used >= 100 ? `back ${resets(bucket.resetsAt)}` : `${used}%`}</span>
          {used < 100 && (
            <span className="meter-reset">
              {bucket.resetsAt ? `resets ${resets(bucket.resetsAt)}` : "not started"}
            </span>
          )}
        </span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${used}%` }} />
        {pace != null && pace > 0 && pace < 100 && (
          <div className="meter-pace" style={{ left: `${pace}%` }} title={`Even pace: ${pace}% by now`} />
        )}
      </div>
    </div>
  );
}

export function UsageBar() {
  const {
    usage,
    claudeAuth,
    claudeError,
    claudeErrorStatus,
    error,
    loading,
    refresh,
    refreshClaudeAuth,
  } = useUsage();
  const [hover, setHover] = useState(false);
  // Opened by a click or tap, so the popover works without a mouse to hover.
  const [pinned, setPinned] = useState(false);
  // Where the trigger ends on screen; a phone pins the popover just below it.
  const [popoverTop, setPopoverTop] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setPinned(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pinned]);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [accountBusyId, setAccountBusyId] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  // A login waiting for the code claude.ai shows after signing in (the server
  // can't receive the OAuth callback itself). accountId null = primary.
  const [loginPrompt, setLoginPrompt] = useState<{ accountId: string | null; url: string } | null>(
    null,
  );
  const [loginCode, setLoginCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);

  const accounts = usage?.accounts ?? [];
  const autoSwitch = usage?.autoSwitch ?? true;
  const activeAccount = accounts.find((a) => a.active);
  // One row per Claude account. Before the server reports accounts, the
  // signed-in status alone stands in for the primary account.
  const claudeAccounts: ClaudeAccountSummary[] =
    accounts.length > 0
      ? accounts
      : claudeAuth || usage
        ? [
            {
              id: "primary",
              label: "Primary",
              active: true,
              loggedIn: claudeAuth?.loggedIn ?? false,
              email: claudeAuth?.email,
              fiveHour: usage?.fiveHour ?? null,
              sevenDay: usage?.sevenDay ?? null,
            },
          ]
        : [];

  // Polls /api/claude/accounts until the given account's login attempt
  // finishes (succeeded, failed, or timed out), mirroring handleClaudeLogin's
  // polling loop but scoped to one account among several.
  const pollAccountLogin = async (id: string) => {
    const deadline = Date.now() + 10 * 60_000;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const result = await api.getClaudeAccounts().catch(() => null);
        const account = result?.accounts.find((a) => a.id === id);
        if (!account) continue;
        if (account.login?.state === "running" && account.login.url) {
          setLoginPrompt({ accountId: id, url: account.login.url });
        }
        if (account.login?.state === "succeeded" && account.loggedIn) {
          await refresh();
          return;
        }
        if (account.login?.state === "failed") {
          throw new Error(account.login.error ?? "Claude login did not complete. Please try again.");
        }
      }
      throw new Error("Claude login timed out. Please try again.");
    } finally {
      setLoginPrompt(null);
      setLoginCode("");
    }
  };

  const submitLoginCode = async () => {
    if (!loginPrompt || codeBusy) return;
    setCodeBusy(true);
    try {
      await api.submitClaudeLoginCode(loginCode, loginPrompt.accountId ?? undefined);
      setLoginCode("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (loginPrompt.accountId) setAccountError(message);
      else setLoginError(message);
    } finally {
      setCodeBusy(false);
    }
  };

  const loginCodePanel = (accountId: string | null) =>
    loginPrompt && loginPrompt.accountId === accountId ? (
      <div className="usage-login-code">
        <a
          className="usage-login-button"
          href={loginPrompt.url}
          target="_blank"
          rel="noreferrer"
        >
          <LogIn size={12} />
          Open Claude sign-in
        </a>
        <div className="usage-note">Sign in, then paste the code claude.ai shows you:</div>
        <form
          className="usage-login-code-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitLoginCode();
          }}
        >
          <input
            value={loginCode}
            onChange={(e) => setLoginCode(e.target.value)}
            placeholder="Paste code"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="usage-login-button"
            disabled={codeBusy || !loginCode.trim()}
          >
            {codeBusy ? <RefreshCw size={12} className="spin" /> : "Submit"}
          </button>
        </form>
      </div>
    ) : null;

  const handleAddAccount = async () => {
    if (accountBusyId) return;
    setAccountError(null);
    setAccountBusyId("new");
    try {
      const created = await api.addClaudeAccount();
      setAccountBusyId(created.id);
      await api.startClaudeAccountLogin(created.id);
      await pollAccountLogin(created.id);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountBusyId(null);
    }
  };

  const handleAccountLogin = async (id: string) => {
    if (accountBusyId) return;
    setAccountError(null);
    setAccountBusyId(id);
    try {
      await api.startClaudeAccountLogin(id);
      await pollAccountLogin(id);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountBusyId(null);
    }
  };

  const handleActivateAccount = async (id: string) => {
    setAccountError(null);
    try {
      await api.activateClaudeAccount(id);
      await refresh();
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveAccount = async (id: string) => {
    setAccountError(null);
    try {
      await api.removeClaudeAccount(id);
      await refresh();
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleAutoSwitch = async () => {
    setAccountError(null);
    try {
      await api.setClaudeAutoSwitch(!autoSwitch);
      await refresh();
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
  };

  const session = usage?.fiveHour;
  const sessionPct = session ? Math.round(session.utilization) : null;
  const pace = paceSummary(claudeAccounts);
  const paceById = new Map(pace.accounts.map((a) => [a.id, a]));
  const n = pace.accounts.length;
  const paceHeadline =
    pace.verdict === "over"
      ? pace.runsOutAt
        ? `▲ Ahead of pace · runs out ${resets(pace.runsOutAt)}`
        : `▲ ${pace.delta}% ahead of pace · slow down`
      : pace.verdict === "under"
        ? `▼ ${-pace.delta}% behind pace · use more`
        : "● On pace";

  const claudeBlocked =
    !!usage &&
    [usage.fiveHour, usage.sevenDay, usage.sevenDaySonnet, usage.sevenDayOpus].some(
      bucketBlocked,
    );
  const isBlocked = claudeBlocked;
  const claudeSignedOut = claudeAuth?.loggedIn === false;

  const handleClaudeLogin = async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await api.startClaudeLogin();
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const status = await refreshClaudeAuth();
        if (status?.login.state === "running" && status.login.url) {
          setLoginPrompt({ accountId: null, url: status.login.url });
        }
        if (!status || status.login.state === "running") continue;
        if (status.login.state === "succeeded" && status.loggedIn) {
          await refresh();
          return;
        }
        throw new Error(
          status.login.error ?? "Claude login did not complete. Please try again.",
        );
      }
      throw new Error("Claude login timed out. Please try again.");
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoginBusy(false);
      setLoginPrompt(null);
      setLoginCode("");
    }
  };

  const fetchedAt = usage?.fetchedAt;

  return (
    <div
      ref={barRef}
      className="usage-bar"
      // Touch taps also fire enter events; only a real mouse hovers.
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
    >
      <button
        className="usage-trigger"
        onClick={(e) => {
          if (!pinned) {
            setPopoverTop(e.currentTarget.getBoundingClientRect().bottom);
            void refresh();
          }
          setPinned(!pinned);
        }}
        aria-expanded={pinned || hover}
        style={isBlocked || claudeSignedOut ? { fontWeight: 600 } : undefined}
      >
        {error && !usage && !claudeSignedOut && claudeErrorStatus !== 429 ? (
          <span style={{ color: "var(--app-error)" }}>usage error</span>
        ) : claudeSignedOut ? (
          <span style={{ color: "var(--app-error)" }}>Claude signed out</span>
        ) : claudeBlocked && pace.accounts.every((a) => a.left <= 0) ? (
          <span style={{ color: "var(--app-error)" }}>
            ⚠ Claude limit{session?.resetsAt ? ` · ${formatTimeUntil(session.resetsAt)}` : ""}
          </span>
        ) : pace.accounts.length > 0 ? (
          <>
            <span className={`usage-verdict ${pace.verdict}`}>
              {paceHeadline}
            </span>
          </>
        ) : sessionPct != null ? (
          <span style={{ color: colorFor(sessionPct) }}>Claude {sessionPct}%</span>
        ) : claudeErrorStatus === 429 ? (
          <span style={{ color: "var(--app-warning)" }}>Claude usage delayed</span>
        ) : (
          <span>{loading ? "loading usage…" : "usage"}</span>
        )}
        {loading && <span className="usage-trigger-sep">refreshing…</span>}
      </button>
      {(hover || pinned || loginPrompt) && (
        <div
          className="usage-popover"
          role="dialog"
          style={
            popoverTop != null
              ? ({ "--usage-popover-top": `${popoverTop + 8}px` } as React.CSSProperties)
              : undefined
          }
        >
          {isBlocked && (
            <div className="usage-limit-warning">
              ⚠ Limit reached on the account in use
            </div>
          )}

          {pace.accounts.length > 0 && (
            <div className={`usage-pace ${pace.verdict}`}>
              <div className="usage-pace-head">{paceHeadline}</div>
              <div className="meter-track usage-pace-track">
                <div className="meter-fill" style={{ width: `${Math.min(100, pace.used)}%` }} />
                <div className="meter-pace" style={{ left: `${pace.expected}%` }} />
              </div>
              <div className="usage-note">
                {Math.round(pace.used)}% used · {Math.round(pace.expected)}% expected
              </div>
            </div>
          )}

          {(usage || claudeAuth || claudeError || accounts.length > 0) && (
            <div className="usage-section">
              <div className="usage-provider-heading">
                <div
                  className="usage-popover-title"
                  style={{ color: "var(--app-claude-orange)" }}
                >
                  Claude Code
                </div>
                {claudeAccounts.length >= 2 && (
                  <label
                    className="usage-note"
                    style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={autoSwitch}
                      onChange={() => void handleToggleAutoSwitch()}
                    />
                    Auto-switch
                  </label>
                )}
              </div>
              {claudeAccounts.length >= 2 && usage?.autoReason && (
                <div className="usage-note">{usage.autoReason}</div>
              )}
              {claudeAccounts.map((account) => {
                const isPrimary = account.id === "primary";
                const busy = isPrimary ? loginBusy : accountBusyId === account.id;
                return (
                  <div key={account.id} className="usage-account-row">
                    <div className="usage-account-row-head">
                      <span
                        className={`usage-auth-state ${account.loggedIn ? "connected" : "disconnected"}`}
                        style={account.active && claudeAccounts.length >= 2 ? { fontWeight: 600 } : undefined}
                      >
                        {account.loggedIn
                          ? (account.email ?? account.label)
                          : `${account.email ?? account.label} · not signed in`}
                        {account.active && claudeAccounts.length >= 2 ? " · in use" : ""}
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {!account.active && account.loggedIn && (
                          <button
                            type="button"
                            className="usage-login-button"
                            onClick={() => void handleActivateAccount(account.id)}
                          >
                            Use
                          </button>
                        )}
                        <button
                          type="button"
                          className="usage-login-button"
                          disabled={busy}
                          title={account.loggedIn ? "Sign in again" : undefined}
                          onClick={() =>
                            void (isPrimary ? handleClaudeLogin() : handleAccountLogin(account.id))
                          }
                        >
                          {busy ? <RefreshCw size={11} className="spin" /> : <LogIn size={11} />}
                          {busy
                            ? loginPrompt?.accountId === (isPrimary ? null : account.id)
                              ? "Waiting for code…"
                              : "Starting sign-in…"
                            : account.loggedIn
                              ? "Re-login"
                              : "Sign in"}
                        </button>
                        {!isPrimary && (
                          <button
                            type="button"
                            className="usage-login-button"
                            title="Remove account"
                            onClick={() => void handleRemoveAccount(account.id)}
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                    {account.fiveHour && <Meter name="Session" bucket={account.fiveHour} />}
                    {account.sevenDay && (
                      <Meter name="Week" bucket={account.sevenDay} pace={paceById.get(account.id)?.expected} />
                    )}
                    {(() => {
                      const p = paceById.get(account.id);
                      if (!p) return null;
                      const text = p.runsOutAt
                        ? `Runs out ${resets(p.runsOutAt)}`
                        : p.delta <= -5
                          ? `${-p.delta}% behind pace`
                          : p.delta >= 5
                            ? `${p.delta}% ahead of pace`
                            : "On pace";
                      const tone = p.runsOutAt || p.delta >= 5 ? "over" : p.delta <= -5 ? "under" : "on";
                      return <div className={`usage-verdict ${tone}`}>{text}</div>;
                    })()}
                    {account.error && !isPrimary && (
                      <div className="usage-note" style={{ color: "var(--app-error)" }}>
                        {account.error}
                      </div>
                    )}
                    {loginCodePanel(isPrimary ? null : account.id)}
                  </div>
                );
              })}
              {usage?.stale && (
                <div className="usage-note" style={{ color: "var(--app-warning)" }}>
                  As of{" "}
                  {new Date(usage.fetchedAt).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  . Claude's usage endpoint is cooling down; live numbers load
                  automatically{usage.retryAt ? ` in ${formatTimeUntil(usage.retryAt)}` : ""}.
                </div>
              )}
              {claudeError && (
                <div
                  className="usage-note"
                  style={
                    claudeErrorStatus === 429
                      ? { color: "var(--app-warning)" }
                      : { color: "var(--app-error)" }
                  }
                >
                  {claudeError}
                </div>
              )}
              {/* A just-added account isn't in the list until the next refresh. */}
              {loginPrompt?.accountId &&
                !claudeAccounts.some((a) => a.id === loginPrompt.accountId) &&
                loginCodePanel(loginPrompt.accountId)}
              <button
                type="button"
                className="usage-login-button"
                disabled={accountBusyId !== null}
                onClick={() => void handleAddAccount()}
              >
                {accountBusyId === "new" ? (
                  <RefreshCw size={11} className="spin" />
                ) : (
                  <Plus size={11} />
                )}
                Add account
              </button>
              {(loginError || accountError) && (
                <div className="usage-note" style={{ color: "var(--app-error)" }}>
                  {loginError ?? accountError}
                </div>
              )}
            </div>
          )}

          {!usage && error && (
            <div style={{ color: "var(--app-error)", fontSize: 12 }}>{error}</div>
          )}

          <div className="usage-popover-foot">
            {(usage?.subscriptionType || claudeAuth?.subscriptionType) && (
              <span>
                {usage?.subscriptionType ?? claudeAuth?.subscriptionType}
              </span>
            )}
            {fetchedAt && (
              <span>
                fetched{" "}
                {new Date(fetchedAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
