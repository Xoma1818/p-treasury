import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { AGGREGATE_STALE_MS } from "./queryPolicy";

test("Home remount reuses aggregates but mutations and a new date fetch fresh data", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let calls = 0;
  const options = { queryKey: ["totals", "2026-11-19"], queryFn: async () => ++calls, staleTime: AGGREGATE_STALE_MS };
  try {
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    const unmount = observer.subscribe(() => {});
    expect(observer.getCurrentResult().isFetching).toBe(false);
    expect(calls).toBe(1);
    unmount();
    await client.invalidateQueries(); // Mutation while Home is not mounted.
    await client.fetchQuery(options);
    expect(calls).toBe(2);
    const stop = observer.subscribe(() => {});
    await client.invalidateQueries(); // Background event while Home is visible.
    expect(observer.getCurrentResult().data).toBe(3);
    stop();
    await client.fetchQuery({ ...options, queryKey: ["totals", "2026-11-20"] });
    expect(calls).toBe(4);
    client.setQueryData(options.queryKey, 4, { updatedAt: Date.now() - AGGREGATE_STALE_MS - 1 });
    await client.fetchQuery(options);
    expect(calls).toBe(5);
  } finally {
    client.clear();
  }
});

test.each(["forecast", "cushion", "checks", "budgetWarnings", "netWorth"])("%s dated card cache still refreshes after prefix invalidation", async (key) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let calls = 0;
  const options = { queryKey: [key, "2026-11-20"], queryFn: async () => ++calls, staleTime: AGGREGATE_STALE_MS };
  try {
    await client.fetchQuery(options);
    await client.fetchQuery(options);
    expect(calls).toBe(1);
    await client.invalidateQueries({ queryKey: [key] });
    await client.fetchQuery(options);
    expect(calls).toBe(2);
  } finally {
    client.clear();
  }
});
