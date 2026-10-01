import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { MAX_PROFILE_BATCH } from "./profile-data";
import { RepositoryError, SqliteTeamRepository } from "./storage";

function event(secret: Uint8Array, createdAt: number, name: string, picture?: string) {
  return finalizeEvent({kind:0,created_at:createdAt,tags:[],content:JSON.stringify({display_name:name,picture})},secret);
}

describe("shared server profile cache",()=>{
  test("verifies authors/signatures, sanitizes metadata, and keeps the newest event",()=>{
    const repo=new SqliteTeamRepository(":memory:");const ownerSecret=generateSecretKey();const ownerPubkey=getPublicKey(ownerSecret);const owner=repo.accountForNostr(ownerPubkey,nip19.npubEncode(ownerPubkey));repo.createTeam(owner.id,"Profile crew");
    const old=event(ownerSecret,10,"Old","http://unsafe.example/avatar.png");const latest=event(ownerSecret,20,"Newest","https://safe.example/avatar.png");const tampered={...event(ownerSecret,30,"Tampered"),content:"{}"};
    expect(repo.cacheProfiles(owner.id,[old,tampered,latest])).toEqual([expect.objectContaining({displayName:"Newest",picture:"https://safe.example/avatar.png"})]);
    expect(repo.cacheProfiles(owner.id,[old])).toEqual([]);
    expect(repo.currentTeam(owner.id)?.profiles).toEqual([expect.objectContaining({displayName:"Newest"})]);
    repo.close();
  });

  test("persists profiles across repository restart",()=>{
    const path=join(tmpdir(),`levelup-profiles-${crypto.randomUUID()}.sqlite`);const secret=generateSecretKey();const pubkey=getPublicKey(secret);let accountId="";
    try{const first=new SqliteTeamRepository(path);const account=first.accountForNostr(pubkey,nip19.npubEncode(pubkey));accountId=account.id;first.createTeam(account.id,"Restart crew");first.cacheProfiles(account.id,[event(secret,42,"Persistent")]);first.close();
      const second=new SqliteTeamRepository(path);expect(second.currentTeam(accountId)?.profiles[0]?.displayName).toBe("Persistent");second.close();
    }finally{rmSync(path,{force:true});rmSync(`${path}-wal`,{force:true});rmSync(`${path}-shm`,{force:true});}
  });

  test("bounds batches and hides unrelated cached public profiles",()=>{
    const repo=new SqliteTeamRepository(":memory:");const firstSecret=generateSecretKey(),secondSecret=generateSecretKey();const firstKey=getPublicKey(firstSecret),secondKey=getPublicKey(secondSecret);const first=repo.accountForNostr(firstKey,nip19.npubEncode(firstKey)),second=repo.accountForNostr(secondKey,nip19.npubEncode(secondKey));repo.createTeam(first.id,"First crew");repo.createTeam(second.id,"Second crew");
    expect(repo.cacheProfiles(first.id,[event(secondSecret,1,"Outsider")])).toEqual([]);
    expect(repo.profilesForAccount(first.id,[secondKey])).toEqual([]);
    expect(()=>repo.profilesForAccount(first.id,Array.from({length:MAX_PROFILE_BATCH+1},(_,index)=>index.toString(16).padStart(64,"0")))).toThrow(RepositoryError);
    repo.close();
  });
});
