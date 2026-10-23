import type { ServerMessage } from "./types";

/**
 * Keeps a WebSocket to the office open, reconnecting with backoff. Each reconnect starts with a fresh
 * snapshot. `before` runs ahead of every attempt (e.g. asking for the view password).
 */
export function connect(onMessage: (msg: ServerMessage) => void, onStatus: (up: boolean) => void, before: () => Promise<void> = async () => {}): void {
  let delay = 500;

  const open = async () => {
    await before();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    socket.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    socket.onmessage = (e) => onMessage(JSON.parse(e.data as string) as ServerMessage);
    socket.onclose = () => {
      onStatus(false);
      setTimeout(() => void open(), delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };

  void open();
}
