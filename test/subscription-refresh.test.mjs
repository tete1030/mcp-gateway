import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { SQLiteEventStore } from '../src/store.mjs';
import { McpEvents, EVENT_NAME } from '../src/events.mjs';

test('client-driven refresh extends a finite lease without duplicating subscriptions, including after restart', async t => {
  const directory=await mkdtemp(join(tmpdir(),'mcp-gateway-refresh-proof-'));
  const file=join(directory,'events.sqlite'),owner='public-refresh-fixture-owner';
  const secret=`whsec_${Buffer.alloc(32,9).toString('base64')}`;
  const input={name:EVENT_NAME,arguments:{kind:'cat'},
    delivery:{mode:'webhook',url:'https://public-refresh-fixture.example/callback',secret}};
  let time=Date.parse('2026-10-07T00:00:00Z'),store,engine,challengeCount=0;
  const reopen=async()=>{
    store=await SQLiteEventStore.open({file,key:Buffer.alloc(32,8)});
    engine=new McpEvents({store,authorize:async principal=>principal===owner,now:()=>new Date(time),
      send:async(_url,p)=>{
        // The fixture clock deliberately advances by hours; verify its signature
        // at the signed fixture time rather than the verifier's real wall clock.
        assert.equal(new Webhook(secret).sign(p.headers['webhook-id'],new Date(Number(p.headers['webhook-timestamp'])*1000),p.body),p.headers['webhook-signature']);
        const body=JSON.parse(p.body);
        assert.equal(body.type,'verification');challengeCount++;
        return{status:200,body:JSON.stringify({challenge:body.challenge})};
      }});
  };
  await reopen();t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const original=await engine.subscribe(owner,input);
  assert.equal(Date.parse(original.refreshBefore),time+3600_000);
  const generation=(await store.listSubscriptions(owner))[0].generation;
  time+=55*60_000;
  const refreshed=await engine.subscribe(owner,input);
  assert.equal(refreshed.id,original.id);assert.equal(Date.parse(refreshed.refreshBefore),time+3600_000);
  assert.ok(Date.parse(refreshed.refreshBefore)>Date.parse(original.refreshBefore));
  assert.equal((await store.listSubscriptions(owner)).length,1);
  assert.equal((await store.listSubscriptions(owner))[0].generation,generation);
  store.close();await reopen();
  assert.equal((await store.listSubscriptions(owner))[0].refreshBefore,refreshed.refreshBefore);
  time+=55*60_000;
  const afterRestart=await engine.subscribe(owner,{...input,ttlMs:null});
  assert.equal(afterRestart.id,original.id);assert.equal(Date.parse(afterRestart.refreshBefore),time+3600_000);
  assert.equal((await store.listSubscriptions(owner)).length,1);assert.equal(challengeCount,3);
  assert.equal(await store.pendingCount(owner),0);
  time+=3600_001;
  assert.equal(await engine.hasAudience(owner,EVENT_NAME,{kind:'cat'}),false);
  assert.deepEqual((await engine.publish(owner,{kind:'cat',source:'synthetic_poc',message:'Expired public fixture only'})).queued,[]);
});
