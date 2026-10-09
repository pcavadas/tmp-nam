// src/state/activity.ts — one request at a time for a store that talks to the unit.

import { useCallback, useRef, useState } from "react";

/** The running request's activity, a setter for its steps, and `exclusive`, which
 * runs `f` as `what` and ignores calls made while another one runs. */
export function useActivity<A>() {
  const [activity, setActivity] = useState<A | null>(null);
  const running = useRef(false);

  const exclusive = useCallback(async (what: A, f: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setActivity(what);
    try {
      await f();
    } finally {
      running.current = false;
      setActivity(null);
    }
  }, []);

  return { activity, setActivity, exclusive };
}
