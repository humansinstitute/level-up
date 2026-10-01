import type { EventTemplate, Event } from "nostr-tools";

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: EventTemplate & { pubkey?: string }): Promise<Event>;
    };
  }
}

export {};
