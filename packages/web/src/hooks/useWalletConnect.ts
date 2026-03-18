"use client";

import { useCallback, useState } from "react";

/**
 * WalletConnect integration hook.
 *
 * Provides wallet connection state and transaction signing for governance actions.
 * Currently uses a mock implementation. When the governance plugin (#466) ships,
 * this will be replaced with actual WalletConnect v2 / wagmi integration.
 */

export interface WalletState {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
}

export interface UseWalletConnectReturn {
  wallet: WalletState;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (data: Record<string, unknown>) => Promise<string>;
}

export function useWalletConnect(): UseWalletConnectReturn {
  const [wallet, setWallet] = useState<WalletState>({
    connected: false,
    address: null,
    chainId: null,
    connecting: false,
    error: null,
  });

  const connect = useCallback(async () => {
    setWallet((w) => ({ ...w, connecting: true, error: null }));

    // Mock: simulate WalletConnect connection delay
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Mock: simulate successful connection to Base chain
    setWallet({
      connected: true,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      chainId: 8453, // Base
      connecting: false,
      error: null,
    });
  }, []);

  const disconnect = useCallback(() => {
    setWallet({
      connected: false,
      address: null,
      chainId: null,
      connecting: false,
      error: null,
    });
  }, []);

  const signTransaction = useCallback(
    async (_data: Record<string, unknown>): Promise<string> => {
      if (!wallet.connected) {
        throw new Error("Wallet not connected");
      }

      // Mock: simulate transaction signing delay
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Mock: return fake transaction hash
      const mockHash =
        "0x" +
        Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      return mockHash;
    },
    [wallet.connected],
  );

  return { wallet, connect, disconnect, signTransaction };
}
