/**
 * USE AUTH HOOK
 * Main hook for authentication operations (Enoki + delegate key)
 */

"use client";

import { useCallback, useEffect } from "react";
import { useDisconnectWallet } from "@socialproof/dapp-kit";
import { useAtom, useSetAtom } from "jotai";
import {
  authAtom,
  sessionAtom,
  setAuthenticatedAtom,
  clearAuthAtom,
  setLoadingAtom,
} from "../state/atom";
import { trpc } from "@/shared/lib/trpc/client";

export function useAuth() {
  const [auth, setAuth] = useAtom(authAtom);
  const [session, setSession] = useAtom(sessionAtom);
  const setAuthenticated = useSetAtom(setAuthenticatedAtom);
  const clearAuth = useSetAtom(clearAuthAtom);
  const setLoading = useSetAtom(setLoadingAtom);

  // Wallet disconnect (clears dapp-kit autoConnect state)
  const { mutateAsync: disconnectWallet } = useDisconnectWallet();

  // tRPC mutations
  const connectEnokiMutation = trpc.auth.connectEnoki.useMutation();
  const connectDelegateKeyMutation = trpc.auth.connectDelegateKey.useMutation();
  const logoutMutation = trpc.auth.logout.useMutation();

  // Session validation query
  const sessionQuery = trpc.auth.getSession.useQuery(
    { sessionId: session?.sessionId || "" },
    {
      enabled: !!session?.sessionId,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
    }
  );

  /** Initialize authentication from persisted session. */
  useEffect(() => {
    if (session && !auth.isAuthenticated && sessionQuery.data) {
      setAuthenticated({
        isAuthenticated: true,
        user: sessionQuery.data.user,
        mysoAddress: sessionQuery.data.mysoAddress,
        provider: null,
      });
    } else if (session && sessionQuery.data === null && !sessionQuery.isLoading) {
      // Stale session — clear it
      setSession(null);
      setLoading(false);
    } else if (sessionQuery.isError || (!session && !auth.isAuthenticated)) {
      setLoading(false);
    }
  }, [session, sessionQuery.data, sessionQuery.isError, sessionQuery.isLoading, auth.isAuthenticated, setAuthenticated, setLoading, setSession]);

  /** Connect with Enoki zkLogin (two-phase: check returning user, then register). */
  const connectEnoki = useCallback(async (_params: {mysoAddress: string; accountId?: string}) => {
    throw new Error("Use passkey-backed agent setup in the chat app.");
  }, []);

  const connectDelegateKey = useCallback(async (_params: {accountId: string}) => {
    throw new Error("Private-key login is disabled.");
  }, []);

  const logout = useCallback(async () => {
    try {
      if (session?.sessionId) {
        await logoutMutation.mutateAsync({ sessionId: session.sessionId });
      }
    } catch (error) {
      console.error("Logout failed:", error);
    }
    // Always disconnect wallet and clear auth, even if tRPC logout fails
    try {
      await disconnectWallet();
    } catch {
      // Wallet may already be disconnected
    }
    clearAuth();
  }, [session, logoutMutation, disconnectWallet, clearAuth]);

  return {
    ...auth,
    session,
    connectEnoki,
    connectDelegateKey,
    logout,
    isLoginPending: connectEnokiMutation.isPending || connectDelegateKeyMutation.isPending,
    isLogoutPending: logoutMutation.isPending,
  };
}
