import type { StoredChatBinding } from "../bindings/binding-store.js";
import { getBindingKey } from "./runtime-manager.js";

export class ChatMessageQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(binding: StoredChatBinding, task: () => Promise<T>): Promise<T> {
    const key = getBindingKey(binding);
    const previous = this.tails.get(key) ?? Promise.resolve();

    const taskPromise = this.tails.has(key) ? previous.catch(() => undefined).then(task) : runNow(task);
    const current = taskPromise
      .finally(() => {
        if (this.tails.get(key) === current) {
          this.tails.delete(key);
        }
      });

    this.tails.set(key, current);
    return current;
  }
}

function runNow<T>(task: () => Promise<T>): Promise<T> {
  try {
    return task();
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}
