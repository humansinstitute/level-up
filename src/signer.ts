import type { Event, EventTemplate } from "nostr-tools";
import type { IdentityVault } from "./identity-vault";

export type SignerKind = "extension" | "device";

export interface NostrSigner {
  kind: SignerKind;
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
}

export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate & { pubkey?: string }): Promise<Event>;
}

export class Nip07Signer implements NostrSigner {
  readonly kind = "extension" as const;
  private pubkey: string | undefined;
  constructor(private readonly provider: Nip07Provider) {}
  async getPublicKey(): Promise<string> {
    this.pubkey = await this.provider.getPublicKey();
    return this.pubkey;
  }
  signEvent(event: EventTemplate): Promise<Event> { return this.provider.signEvent({ ...event, ...(this.pubkey ? { pubkey: this.pubkey } : {}) }); }
}

export class DeviceSigner implements NostrSigner {
  readonly kind = "device" as const;
  constructor(private readonly vault: IdentityVault) {}
  async getPublicKey(): Promise<string> {
    const pubkey = this.vault.publicKey();
    if (!pubkey) throw new Error("Unlock this device account before signing.");
    return pubkey;
  }
  async signEvent(event: EventTemplate): Promise<Event> { return this.vault.sign(event); }
}
