import { expect, it, vi } from "vitest";
import { createAmountPrivacy } from "./amountPrivacy";

it("закрывает суммы сразу, а во время встречного переключения ждёт последнюю запись", async () => {
  const privacy = createAmountPrivacy();
  const guard = vi.fn();
  let finish = () => {};
  const write = vi.fn((_hidden: boolean) => new Promise<void>(resolve => { finish = resolve; }));
  const first = privacy.toggle(false, write, guard);
  expect(privacy.state.getState().masked).toBe(true);
  await Promise.resolve();
  const last = privacy.toggle(false, write, guard);
  expect(write.mock.calls).toEqual([[true]]);
  finish();
  await first;
  await Promise.resolve();
  expect(write.mock.calls).toEqual([[true], [false]]);
  expect(privacy.state.getState().masked).toBe(true);
  finish();
  await last;
  expect(privacy.state.getState()).toEqual({ masked: false, failed: false, generation: 2 });
  expect(guard.mock.calls).toEqual([[true], [true], [false]]);
});

it("при ошибке сохраняет маску даже при старом открытом кеше и допускает явный повтор", async () => {
  const privacy = createAmountPrivacy();
  const guard = vi.fn();
  await privacy.toggle(false, async () => { throw new Error("диск"); }, guard);
  expect(privacy.state.getState()).toEqual({ masked: true, failed: true, generation: 1 });
  expect(guard).not.toHaveBeenCalledWith(false);
  const write = vi.fn(async () => {});
  await privacy.toggle(false, write, guard);
  expect(write).toHaveBeenCalledWith(false);
  expect(privacy.state.getState()).toEqual({ masked: false, failed: false, generation: 2 });
});
