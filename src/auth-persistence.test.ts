import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { createApp } from "./api";
import { AuthService } from "./auth";
import { SqliteTeamRepository } from "./storage";

const paths:string[]=[];afterEach(()=>{for(const path of paths.splice(0)){rmSync(path,{force:true});rmSync(`${path}-wal`,{force:true});rmSync(`${path}-shm`,{force:true});}});

test("hashed opaque sessions survive application and repository reconstruction",async()=>{
  const path=join(tmpdir(),`level-up-auth-${crypto.randomUUID()}.sqlite`);paths.push(path);const now=1_800_000_000;
  const secret=generateSecretKey();const probe=finalizeEvent({kind:1,created_at:1,tags:[],content:""},secret);
  const repository1=new SqliteTeamRepository(path,{now:()=>now*1000});const auth1=new AuthService({now:()=>now,accessMode:"open",sessionStore:repository1});const app1=createApp({repository:repository1,auth:auth1,staticRoot:"/tmp/none"});
  const challenge=await (await app1(new Request("http://level.test/api/auth/challenge",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pubkey:probe.pubkey})}))).json();
  const login=await app1(new Request("http://level.test/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nonce:challenge.nonce,pubkey:probe.pubkey,event:finalizeEvent(challenge.event,secret)})}));
  const cookie=login.headers.get("set-cookie")!.split(";",1)[0]!;expect(cookie).not.toContain(probe.pubkey);repository1.close();
  const repository2=new SqliteTeamRepository(path,{now:()=>now*1000});const auth2=new AuthService({now:()=>now,accessMode:"open",sessionStore:repository2});const app2=createApp({repository:repository2,auth:auth2,staticRoot:"/tmp/none"});
  const recovered=await app2(new Request("http://level.test/api/me",{headers:{Cookie:cookie}}));expect(recovered.status).toBe(200);
  const dbText=await Bun.file(path).arrayBuffer();expect(new TextDecoder().decode(dbText)).not.toContain(cookie.split("=")[1]!);
  await app2(new Request("http://level.test/api/auth/logout",{method:"POST",headers:{Cookie:cookie}}));expect((await app2(new Request("http://level.test/api/me",{headers:{Cookie:cookie}}))).status).toBe(401);repository2.close();
});
