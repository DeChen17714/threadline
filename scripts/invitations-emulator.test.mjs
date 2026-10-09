import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'

const project='demo-threadline'
const endpoint=`http://127.0.0.1:5001/${project}/asia-southeast1/command`
const dataUrl=`http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents`
const adminHeaders={Authorization:'Bearer owner','Content-Type':'application/json'}
async function account(){ const r=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`${randomUUID()}@example.test`,password:randomUUID(),returnSecureToken:true})}); assert.equal(r.status,200); return r.json() }
async function invoke(user, operation, input, requestId=randomUUID()){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:5174',...(user?{Authorization:`Bearer ${user.idToken}`}:{})},body:JSON.stringify({data:{operation,input,requestId}})}); return {status:response.status,body:await response.json()} }
function success(r){assert.equal(r.status,200);assert.ok(!r.body.error);return r.body.result}
async function room(owner){return success(await invoke(owner,'createRoom',{name:'Invitation privacy room',description:'Private description'})).roomId}
async function read(user, roomId){return fetch(`${dataUrl}/rooms/${roomId}`,{headers:{Authorization:`Bearer ${user.idToken}`}})}
async function patch(path,fields){const keys=Object.keys(fields).map(k=>`updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');const r=await fetch(`${dataUrl}/${path}?${keys}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({fields})});assert.equal(r.status,200)}

test('once-only hash invitation admission, rotation/revoke replay and privacy',async()=>{
 const owner=await account(), member=await account(), outsider=await account(); const roomId=await room(owner)
 const requestId=randomUUID();const issued=success(await invoke(owner,'issueInvite',{roomId},requestId))
 assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(Buffer.from(issued.token,'base64url').length,32)
 assert.ok(issued.expiresAt>Date.now()+23*60*60*1000 && issued.expiresAt<=Date.now()+24*60*60*1000)
 const hash=createHash('sha256').update(issued.token).digest('hex')
 const stored=await fetch(`${dataUrl}/invites/${hash}`,{headers:adminHeaders}).then(r=>r.json());assert.ok(stored.fields);assert.equal(JSON.stringify(stored).includes(issued.token),false)
 const replay=success(await invoke(owner,'issueInvite',{roomId},requestId));assert.equal(replay.token,undefined);assert.equal(replay.tokenUnavailable,true);assert.equal(replay.operationId,issued.operationId)
 const metadata=success(await invoke(owner,'getOperation',{operationId:issued.operationId}));assert.equal(metadata.token,undefined);assert.equal(metadata.tokenUnavailable,true)
 assert.notEqual((await invoke(outsider,'getOperation',{operationId:issued.operationId})).status,200)
 const receipt=await fetch(`${dataUrl}/receipts/${issued.operationId}`,{headers:adminHeaders}).then(r=>r.json());assert.equal(JSON.stringify(receipt).includes(issued.token),false)
 assert.notEqual((await invoke(outsider,'issueInvite',{roomId})).status,200)
 assert.notEqual((await invoke(outsider,'revokeInvite',{roomId})).status,200)
 assert.notEqual((await invoke(null,'previewInvite',{token:issued.token})).status,200)
 assert.equal((await read(member,roomId)).status,403)
 const preview=success(await invoke(member,'previewInvite',{token:issued.token}));assert.equal(preview.room.name,'Invitation privacy room')
 const joinId=randomUUID();const joined=success(await invoke(member,'joinRoom',{token:issued.token},joinId));assert.equal(joined.roomId,roomId)
 success(await invoke(member,'joinRoom',{token:issued.token},joinId));assert.equal((await read(member,roomId)).status,200)
 const current=await fetch(`${dataUrl}/rooms/${roomId}`,{headers:adminHeaders}).then(r=>r.json());assert.equal(current.fields.memberIds.arrayValue.values.filter(x=>x.stringValue===member.localId).length,1)
 const publicRoomBody=await (await read(member,roomId)).text();assert.equal(publicRoomBody.includes(issued.token),false);assert.equal(publicRoomBody.includes(hash),false)
 const replacement=success(await invoke(owner,'issueInvite',{roomId}));assert.notEqual(replacement.token,issued.token)
 assert.notEqual((await invoke(owner,'issueInvite',{roomId:await room(owner)},requestId)).status,200)
 for(const action of ['previewInvite','joinRoom']){const denied=await invoke(outsider,action,{token:issued.token});assert.notEqual(denied.status,200);assert.equal(JSON.stringify(denied.body).includes('Private description'),false);assert.equal(denied.body.result,undefined)}
 assert.notEqual((await invoke(member,'joinRoom',{token:issued.token},joinId)).status,200)
 success(await invoke(owner,'revokeInvite',{roomId}));assert.notEqual((await invoke(outsider,'joinRoom',{token:replacement.token})).status,200);assert.equal((await read(outsider,roomId)).status,403)
})

test('expiry and capacity serialize admission and do not leak invalid-room metadata',async()=>{
 const owner=await account(),a=await account(),b=await account();const roomId=await room(owner)
 const issued=success(await invoke(owner,'issueInvite',{roomId}));const hash=createHash('sha256').update(issued.token).digest('hex')
 await patch(`invites/${hash}`,{expiresAt:{timestampValue:new Date(Date.now()-1000).toISOString()}})
 for(const operation of ['previewInvite','joinRoom']){const r=await invoke(a,operation,{token:issued.token});assert.notEqual(r.status,200);assert.equal(r.body.result,undefined)}
 const fresh=success(await invoke(owner,'issueInvite',{roomId}));const existing=[owner.localId,...Array.from({length:18},()=>randomUUID())]
 await patch(`rooms/${roomId}`,{memberIds:{arrayValue:{values:existing.map(uid=>({stringValue:uid}))}},members:{arrayValue:{values:existing.map(uid=>({mapValue:{fields:{uid:{stringValue:uid},label:{stringValue:'Fixture member'}}}}))}}})
 const results=await Promise.all([invoke(a,'joinRoom',{token:fresh.token}),invoke(b,'joinRoom',{token:fresh.token})]);assert.equal(results.filter(r=>r.status===200).length,1)
 const after=await fetch(`${dataUrl}/rooms/${roomId}`,{headers:adminHeaders}).then(r=>r.json());assert.equal(after.fields.memberIds.arrayValue.values.length,20)
 const loser=results[0].status===200?b:a;assert.equal((await read(loser,roomId)).status,403)
 const raceRoom=await room(owner);const raceInvite=success(await invoke(owner,'issueInvite',{roomId:raceRoom}));await Promise.all([invoke(a,'joinRoom',{token:raceInvite.token}),invoke(owner,'revokeInvite',{roomId:raceRoom})]);assert.notEqual((await invoke(b,'joinRoom',{token:raceInvite.token})).status,200)
 await patch(`rooms/${raceRoom}`,{state:{stringValue:'deleting'}});assert.notEqual((await invoke(a,'joinRoom',{token:raceInvite.token})).status,200)
})
