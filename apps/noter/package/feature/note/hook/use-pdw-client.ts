"use client";

/**
 * memory Status Hook
 *
 * Simple hook to check if Memory is configured (MEMORY_KEY set).
 * No client-side SDK needed — all operations go through server.
 */

import { useState, useEffect } from "react";

export function useMemoryStatus() {
  const [isConfigured, setIsConfigured] = useState(false);

  useEffect(() => {
    // Check server health to see if Memory is configured
    fetch("/api/memory/health")
      .then((res) => {
        setIsConfigured(res.ok);
      })
      .catch(() => {
        setIsConfigured(false);
      });
  }, []);

  return { isConfigured };
}
