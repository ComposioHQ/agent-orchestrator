"use client";

import { formatAddress } from "@/lib/governance-types";
import type { WalletState } from "@/hooks/useWalletConnect";

interface WalletButtonProps {
  wallet: WalletState;
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
}

export function WalletButton({ wallet, onConnect, onDisconnect }: WalletButtonProps) {
  if (wallet.connecting) {
    return (
      <button
        disabled
        className="flex items-center gap-2 rounded-[7px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-text-muted)]"
      >
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-accent)]" />
        Connecting...
      </button>
    );
  }

  if (wallet.connected && wallet.address) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-[7px] border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.06)] px-3 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-status-ready)]" />
          <span className="font-mono text-[11px] text-[var(--color-text-primary)]">
            {formatAddress(wallet.address)}
          </span>
          {wallet.chainId && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]">
              ({wallet.chainId === 8453 ? "Base" : `Chain ${wallet.chainId}`})
            </span>
          )}
        </div>
        <button
          onClick={onDisconnect}
          className="rounded-[6px] border border-[var(--color-border-default)] px-2 py-1.5 text-[10px] text-[var(--color-text-muted)] hover:border-[var(--color-status-error)] hover:text-[var(--color-status-error)]"
          title="Disconnect wallet"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => void onConnect()}
      className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[11px] font-semibold"
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 6v3" />
      </svg>
      Connect Wallet
    </button>
  );
}
