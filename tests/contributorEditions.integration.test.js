const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const AlbumCatalog = require('../models/AlbumCatalog');
const AlbumSubmission = require('../models/AlbumSubmission');
const Preview = require('../models/ContributorEditionPreview');
const Models = require('../models/AlbumBaseline');
const Listening = require('../models/Listening');
const editions = require('../lib/contributorEditions/service');
const discovery = require('../lib/baselines/discovery');
const baselines = require('../lib/baselines/service');
const { hashCandidateTracklist } = require('../lib/baselines/musicBrainz');
const { snapshotForSubmission, findDuplicateSignals } = require('../routes/utils/submissions');
const { approveAlbumSubmission } = require('../routes/utils/approval');
const enabled = process.env.RUN_MONGO_INTEGRATION === 'true';
const envNames = ['CONTRIBUTOR_EDITIONS_ENABLED','COMMUNITY_SUBMISSIONS_ENABLED','TRACKLIST_BASELINE_MODERATION_ENABLED','COMMUNITY_MODERATION_ENABLED'];
const env = Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
const originalPreview = discovery.preview;
let replSet;
function candidate(group = crypto.randomUUID()) {
 const releaseMbid = crypto.randomUUID();
 const value = { releaseMbid, releaseGroupMbid: group, title: `Fixture ${crypto.randomUUID()}`, artistDisplayName: 'Artist', date: '2026', country: 'US', formats: ['CD'], disambiguation: '', status: 'Official', retrievedAt: new Date(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: 'CC0', tracks: [{ discNumber:1, trackNumber:1, title:'One', durationMs:1000, artistDisplayName:'Artist', releaseTrackMbid:crypto.randomUUID(), recordingMbid:crypto.randomUUID() }] };
 return {...value,tracklistHash:hashCandidateTracklist(value)};
}
function input(value,previewId) { return {editionPreviewId:previewId,proposedMetadata:{title:value.title,artistCredits:[{name:'Artist'}],releaseType:'album',releaseDate:'2026'}, supportingSources:[{type:'musicbrainz',url:value.sourceUrl}],externalReferences:[]}; }
async function submit(value = candidate()) {
 discovery.preview=async()=>value;
 const preview=await editions.preview({releaseGroupMbid:value.releaseGroupMbid,releaseMbid:value.releaseMbid},'contributor');
 const payload=await editions.normalize(input(value,preview.previewId),'contributor');
 const duplicate=await findDuplicateSignals(payload); const now=new Date();
 const submission=await AlbumSubmission.create({...payload,submissionId:crypto.randomUUID(),submittedByUserId:'contributor',status:'pending',currentRevision:1,normalizedFingerprint:duplicate.fingerprint,revisions:[snapshotForSubmission(payload,duplicate,now,1)],moderationHistory:[{actorUserId:'contributor',action:'submitted',reason:'',createdAt:now}]});
 return {submission,preview,payload,value};
}
async function command(submission, action, candidateValue, revision=0, targetRevision=1, requestId=crypto.randomUUID()) {
 return baselines.performCommand({kind:'submissions',id:submission.submissionId,action,actorUserId:'moderator',body:{expectedRevision:revision,expectedTargetRevision:targetRevision,requestId,...(candidateValue?{releaseMbid:candidateValue.releaseMbid,releaseGroupMbid:candidateValue.releaseGroupMbid,candidateHash:candidateValue.tracklistHash}:{})}});
}
test.before(async()=>{
 if(!enabled) return;
 replSet=await MongoMemoryReplSet.create({replSet:{count:1}});
 await mongoose.connect(replSet.getUri(),{dbName:'rescened_contributor_editions_test'});
 await Promise.all([Preview,AlbumSubmission,AlbumCatalog,...Object.values(Models),Listening.AlbumMapping,Listening.Job].map(model=>model.syncIndexes()));
 for(const name of envNames) process.env[name]='true';
});
test.beforeEach(async()=>{if(enabled) await Promise.all([Preview,AlbumSubmission,AlbumCatalog,...Object.values(Models),Listening.AlbumMapping,Listening.Job].map(model=>model.deleteMany({})));});
test.after(async()=>{
 discovery.preview=originalPreview;
 if(enabled && mongoose.connection.readyState) {await mongoose.connection.dropDatabase();await mongoose.disconnect();}
 if(replSet) await replSet.stop();
 for(const name of envNames) {if(env[name]===undefined) delete process.env[name];else process.env[name]=env[name];}
});
test('provider proposal is durable revision evidence but neither preview nor submission establishes baseline readiness', {skip:!enabled},async()=>{
 const {submission,value}=await submit();
 const persisted=await AlbumSubmission.findOne({submissionId:submission.submissionId});
 assert.equal(persisted.editionProposal.candidate.tracklistHash,value.tracklistHash);
 assert.equal(persisted.revisions[0].editionProposal.candidate.sourceUrl,value.sourceUrl);
 assert.equal(persisted.editionProposal.candidate.license,'CC0');
 assert.equal(await Models.Head.countDocuments({}),0); assert.equal(await Models.Candidate.countDocuments({}),0);assert.equal(await Models.Baseline.countDocuments({}),0);
 await baselines.previewProposal('submissions',submission.submissionId,{expectedTargetRevision:1});
 assert.equal(await Models.Candidate.countDocuments({targetId:submission.submissionId}),1);assert.equal(await Models.Head.countDocuments({}),0);
 const approved=await approveAlbumSubmission({submissionId:submission.submissionId,actorUserId:'moderator',confirmPossibleDuplicate:true,reason:'Metadata reviewed; baseline deferred',coverResolver:null});
 const album=await AlbumCatalog.findOne({albumId:approved.album.albumId});
 assert.equal(album.tracks.length,1);assert.equal(await baselines.baselineForAlbum(album),null);
});
test('explicit moderator confirmation publishes the preserved candidate atomically and idempotently', {skip:!enabled},async()=>{
 const {submission,value}=await submit();
 await baselines.previewProposal('submissions',submission.submissionId,{expectedTargetRevision:1});
 const requestId=crypto.randomUUID();
 const result=await command(submission,'confirm',value,0,1,requestId);
 assert.equal(result.status,'reviewed');
 assert.equal((await command(submission,'confirm',value,0,1,requestId)).revision,1);
 const approved=await approveAlbumSubmission({submissionId:submission.submissionId,actorUserId:'moderator',confirmPossibleDuplicate:true,reason:'Metadata and edition reviewed',coverResolver:null});
 const album=await AlbumCatalog.findOne({albumId:approved.album.albumId});
 const baseline=await baselines.baselineForAlbum(album);
 assert.equal(baseline.tracklistHash,value.tracklistHash);assert.equal(await Models.Baseline.countDocuments({albumId:album.albumId}),1);
});
test('moderators can defer a proposal or explicitly choose a different provider edition', {skip:!enabled},async()=>{
 const first=await submit();
 assert.equal((await command(first.submission,'defer',null)).status,'deferred');
 assert.equal(await Models.Baseline.countDocuments({}),0);
 const second=await submit(); const changed=candidate(second.value.releaseGroupMbid);
 await baselines.storeCandidate('submissions',second.submission,changed);
 await command(second.submission,'confirm',changed);
 assert.equal((await baselines.detail('submissions',second.submission.submissionId)).selection.releaseMbid,changed.releaseMbid);
 const retained=await AlbumSubmission.findOne({submissionId:second.submission.submissionId});
 assert.equal(retained.editionProposal.candidate.releaseMbid,second.value.releaseMbid);
});
test('expired and other-owner previews are unavailable; current owner revision retains immutable proposal after preview deletion', {skip:!enabled},async()=>{
 const {submission,preview,value}=await submit();
 await assert.rejects(editions.normalize(input(value,preview.previewId),'intruder'),e=>e.code==='EDITION_PREVIEW_UNAVAILABLE');
 await Preview.updateOne({previewId:preview.previewId},{$set:{expiresAt:new Date(Date.now()-1000)}});
 await assert.rejects(editions.normalize(input(value,preview.previewId),'contributor'),e=>e.code==='EDITION_PREVIEW_UNAVAILABLE');
 await Preview.deleteMany({});
 const payload=await editions.normalize(input(value,preview.previewId),'contributor',submission);
 assert.equal(payload.editionProposal.candidate.tracklistHash,value.tracklistHash);
 const duplicate=await findDuplicateSignals(payload);
 await AlbumSubmission.updateOne({_id:submission._id},{$set:{status:'needs_changes'}});
 const query={_id:submission._id,status:'needs_changes',currentRevision:1};
 const update={$set:{status:'pending',currentRevision:2,...payload},$push:{revisions:snapshotForSubmission(payload,duplicate,new Date(),2)}};
 const results=await Promise.all([AlbumSubmission.findOneAndUpdate(query,update,{returnDocument:'after'}),AlbumSubmission.findOneAndUpdate(query,update,{returnDocument:'after'})]);
 assert.equal(results.filter(Boolean).length,1);
 const revised=await AlbumSubmission.findById(submission._id);assert.equal(revised.revisions.length,2);assert.equal(revised.revisions[0].editionProposal.candidate.tracklistHash,value.tracklistHash);
 await assert.rejects(baselines.previewProposal('submissions',submission.submissionId,{expectedTargetRevision:1}),e=>e.code==='TARGET_REVISION_CONFLICT');
});
test('stale and concurrent moderator commands cannot overwrite a reviewed proposal', {skip:!enabled},async()=>{
 const {submission,value}=await submit();
 await baselines.previewProposal('submissions',submission.submissionId,{expectedTargetRevision:1});
 await assert.rejects(command(submission,'confirm',value,0,2),e=>e.code==='TARGET_REVISION_CONFLICT');
 const results=await Promise.allSettled([command(submission,'confirm',value),command(submission,'confirm',value)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(await Models.Head.countDocuments({targetId:submission.submissionId}),1);assert.equal(await Models.Audit.countDocuments({targetId:submission.submissionId}),1);
});
