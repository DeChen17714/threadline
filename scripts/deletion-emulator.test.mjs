import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PROJECT_ID, commandEndpoint, documentsBaseUrl, authSignUpUrl } from './emulator-test-env.mjs'

const project = PROJECT_ID
const endpoint = commandEndpoint
const database = `projects/${project}/databases/(default)`
const documents = documentsBaseUrl('(default)')
const adminHeaders = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
async function account() {
  const r = await fetch(authSignUpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: randomUUID(), returnSecureToken: true }),
  })
  assert.equal(r.status, 200)
  return r.json()
}
async function invoke(user,operation,input,requestId=randomUUID()){const r=await fetch(endpoint,{method:'POST',headers:{Origin:'http://127.0.0.1:5174','Content-Type':'application/json',Authorization:`Bearer ${user.idToken}`},body:JSON.stringify({data:{operation,input,requestId}})});return {status:r.status,body:await r.json()}}
function success(r){assert.equal(r.status,200);assert.equal(r.body.error,undefined);return r.body.result}
async function create(owner){return success(await invoke(owner,'createRoom',{name:'Deletion fixture',description:'Private room content'})).roomId}
async function adminRead(path){return fetch(`${documents}/${path}`,{headers:adminHeaders})}
async function patch(path,fields){const query=Object.keys(fields).map(k=>`updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');const r=await fetch(`${documents}/${path}?${query}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({fields})});assert.equal(r.status,200)}
async function seed(roomId,count=430){const writes=[...Array.from({length:count},(_,i)=>({update:{name:`${database}/documents/rooms/${roomId}/messages/${i}`,fields:{text:{stringValue:`PRIVATE-SENTINEL-${roomId}`},seq:{integerValue:String(i+1)}}}})),...Array.from({length:40},(_,i)=>({update:{name:`${database}/documents/rooms/${roomId}/generations/${i}`,fields:{text:{stringValue:`PRIVATE-SENTINEL-${roomId}`}}}}))];for(let start=0;start<writes.length;start+=200){const r=await fetch(`${documents}:batchWrite`,{method:'POST',headers:adminHeaders,body:JSON.stringify({writes:writes.slice(start,start+200)})});assert.equal(r.status,200);const result=await r.json();assert.ok(result.status.every(x=>!x.code))}}
async function memberRead(user,roomId){return fetch(`${documents}/rooms/${roomId}`,{headers:{Authorization:`Bearer ${user.idToken}`}})}
async function job(id){const r=await adminRead(`maintenanceJobs/${id}`);assert.equal(r.status,200);return r.json()}

test('creator deletion fences immediately, batches descendants before parent and survives interruption/replay',async()=>{
 const owner=await account(),member=await account(),outsider=await account();const roomId=await create(owner)
 const invite=success(await invoke(owner,'issueInvite',{roomId}))
 const memberRequestId=randomUUID()
 const memberReq=success(await invoke(member,'requestJoin',{token:invite.token},memberRequestId))
 assert.equal(memberReq.joinRequestId,memberRequestId)
 assert.equal(memberReq.joinStatus,'pending')
 assert.equal(memberReq.roomId,undefined)
 const decided=success(await invoke(owner,'decideJoin',{roomId,joinRequestId:memberRequestId,decision:'approve'}))
 assert.equal(decided.joinStatus,'approved')
 const memberStatus=success(await invoke(member,'getJoinStatus',{joinRequestId:memberRequestId}))
 assert.equal(memberStatus.joinStatus,'approved')
 assert.equal(memberStatus.roomId,roomId)
 assert.equal((await memberRead(member,roomId)).status,200)
 const outsiderRequestId=randomUUID()
 const outsiderReq=success(await invoke(outsider,'requestJoin',{token:invite.token},outsiderRequestId))
 assert.equal(outsiderReq.joinRequestId,outsiderRequestId)
 assert.equal(outsiderReq.joinStatus,'pending')
 assert.equal((await adminRead(`joinRequests/${memberRequestId}`)).status,200)
 assert.equal((await adminRead(`joinRequests/${outsiderRequestId}`)).status,200)
 assert.equal((await adminRead(`joinQueues/${roomId}`)).status,200)
 await seed(roomId)
 assert.notEqual((await invoke(member,'deleteRoom',{roomId})).status,200);assert.equal((await memberRead(member,roomId)).status,200)
 const requestId=randomUUID();const admitted=success(await invoke(owner,'deleteRoom',{roomId},requestId));assert.equal(admitted.status,'pending')
 const privateJobRead=await fetch(`${documents}/maintenanceJobs/${admitted.operationId}`,{headers:{Authorization:`Bearer ${owner.idToken}`}});assert.equal(privateJobRead.status,403)
 const receipt=await (await adminRead(`receipts/${owner.localId}_deleteRoom_${requestId}`)).text();assert.equal(receipt.includes('Private room content'),false);assert.equal(receipt.includes(invite.token),false)
 assert.equal((await memberRead(member,roomId)).status,403);assert.notEqual((await invoke(outsider,'requestJoin',{token:invite.token})).status,200);assert.notEqual((await invoke(outsider,'joinRoom',{token:invite.token})).status,200);assert.notEqual((await invoke(owner,'issueInvite',{roomId})).status,200)
 assert.equal(success(await invoke(owner,'deleteRoom',{roomId})).operationId,admitted.operationId)
 assert.notEqual((await invoke(owner,'deleteRoom',{roomId:await create(owner)},requestId)).status,200)
 const first=success(await invoke(owner,'resumeMaintenance',{operationId:admitted.operationId}));assert.equal(first.status,'pending');assert.ok(first.deletedCount>0&&first.deletedCount<=200);assert.equal((await adminRead(`rooms/${roomId}`)).status,200)
 const discover=success(await invoke(owner,'listPendingOperations',{cursor:null}));assert.ok(discover.operations.some(x=>x.operationId===admitted.operationId));assert.equal(success(await invoke(outsider,'listPendingOperations',{cursor:null})).operations.some(x=>x.operationId===admitted.operationId),false)
 for(const operation of ['resumeMaintenance','getOperation'])assert.notEqual((await invoke(outsider,operation,{operationId:admitted.operationId})).status,200)
 assert.equal(success(await invoke(owner,'getOperation',{operationId:admitted.operationId})).status,'pending')
 let previous=first.deletedCount,result=first
 for(let attempts=0;result.status!=='complete'&&attempts<10;attempts++){result=success(await invoke(owner,'resumeMaintenance',{operationId:admitted.operationId}));assert.ok(result.deletedCount>=previous&&result.deletedCount-previous<=200);previous=result.deletedCount}
 assert.equal(result.status,'complete');assert.ok(result.deletedCount>0);assert.equal((await adminRead(`rooms/${roomId}`)).status,404)
 const messages=await adminRead(`rooms/${roomId}/messages`);assert.equal((await messages.json()).documents,undefined)
 const generations=await adminRead(`rooms/${roomId}/generations`);assert.equal((await generations.json()).documents,undefined)
 assert.equal((await adminRead(`joinRequests/${memberRequestId}`)).status,404)
 assert.equal((await adminRead(`joinRequests/${outsiderRequestId}`)).status,404)
 assert.equal((await adminRead(`joinQueues/${roomId}`)).status,404)
 const remainingRequests=await fetch(`${documents}:runQuery`,{method:'POST',headers:adminHeaders,body:JSON.stringify({structuredQuery:{from:[{collectionId:'joinRequests'}],where:{fieldFilter:{field:{fieldPath:'roomId'},op:'EQUAL',value:{stringValue:roomId}}}}})}).then(r=>r.json())
 assert.ok(!remainingRequests[0]?.document)
 assert.equal((await adminRead(`quotaBuckets/requestJoin_${member.localId}`)).status,200)
 assert.equal((await adminRead(`quotaBuckets/requestJoin_${outsider.localId}`)).status,200)
 const storedJob=await job(admitted.operationId);assert.equal(JSON.stringify(storedJob).includes('PRIVATE-SENTINEL'),false);assert.equal(JSON.stringify(storedJob).includes('Private room content'),false);assert.equal(JSON.stringify(storedJob).includes(invite.token),false)
 assert.equal(success(await invoke(owner,'getOperation',{operationId:admitted.operationId})).status,'complete')
 assert.equal(success(await invoke(owner,'getOperation',{operationId:`${owner.localId}_deleteRoom_${requestId}`})).status,'complete')
 assert.equal(success(await invoke(owner,'deleteRoom',{roomId},requestId)).status,'complete')
 assert.equal(success(await invoke(owner,'resumeMaintenance',{operationId:admitted.operationId})).status,'complete')
 assert.equal(success(await invoke(owner,'listPendingOperations',{cursor:null})).operations.some(x=>x.operationId===admitted.operationId),false)
})

test('real fence failure remains discoverable and resumable, and caller-only discovery is bounded',async()=>{
 const owner=await account(),other=await account();const roomId=await create(owner);const admitted=success(await invoke(owner,'deleteRoom',{roomId}));await patch(`rooms/${roomId}`,{maintenanceId:{stringValue:'fixture-failed-fence'}})
 const failed=await invoke(owner,'resumeMaintenance',{operationId:admitted.operationId});assert.notEqual(failed.body.result?.status,'complete')
 assert.equal(success(await invoke(owner,'getOperation',{operationId:admitted.operationId})).status,'failed');assert.equal((await adminRead(`rooms/${roomId}`)).status,200)
 await patch(`rooms/${roomId}`,{maintenanceId:{stringValue:admitted.operationId}});assert.equal(success(await invoke(owner,'resumeMaintenance',{operationId:admitted.operationId})).status,'complete')
 const ids=[];for(let i=0;i<22;i++){const id=await create(owner);ids.push(success(await invoke(owner,'deleteRoom',{roomId:id})).operationId)}
 const first=success(await invoke(owner,'listPendingOperations',{cursor:null}));assert.equal(first.operations.length,20);assert.ok(first.nextCursor);const second=success(await invoke(owner,'listPendingOperations',{cursor:first.nextCursor}));const discovered=[...first.operations,...second.operations].map(x=>x.operationId);assert.equal(new Set(discovered).size,22);assert.ok(ids.every(id=>discovered.includes(id)))
 assert.equal(success(await invoke(other,'listPendingOperations',{cursor:null})).operations.length,0)
 for(const id of ids)success(await invoke(owner,'resumeMaintenance',{operationId:id}))
})
