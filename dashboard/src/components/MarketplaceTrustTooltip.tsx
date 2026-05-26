"use client";
import { useId, useState } from "react";
import type { ApprovalBehavior, RiskLevel } from "@/lib/registry";

const APPROVAL_LABEL: Record<ApprovalBehavior, string> = {
  always_ask: "Always asks",
  ask_on_novel: "Asks on new",
  auto_approve: "Auto",
};

export function MarketplaceTrustTooltip({
  riskLevel,
  approvalBehavior,
  networkAccess,
  fileAccess,
}: {
  riskLevel?: RiskLevel;
  approvalBehavior?: ApprovalBehavior;
  networkAccess?: boolean;
  fileAccess?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  const items = [
    riskLevel && `Risk: ${riskLevel}`,
    approvalBehavior && `Approvals: ${APPROVAL_LABEL[approvalBehavior]}`,
    networkAccess && "Makes network requests",
    fileAccess && "Reads/writes local files",
  ].filter((x): x is string => Boolean(x));

  if (!items.length) return null;

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-label="Trust details"
        aria-describedby={open ? id : undefined}
        tabIndex={0}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          color: "var(--ink-3)",
          lineHeight: 1,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 7.25v3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          <circle cx="8" cy="5.25" r="0.75" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--bg-1, var(--surface))",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-2)",
            padding: "7px 10px",
            fontSize: "var(--fs-xs)",
            color: "var(--ink-2)",
            whiteSpace: "nowrap",
            zIndex: 50,
            boxShadow: "var(--shadow-m)",
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {items.map((item) => (
            <div key={item}>{item}</div>
          ))}
        </div>
      )}
    </div>
  );
}
