import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { testApp, photo, cutout, until } from './helpers.mjs';

const imageForm = async (bytes) => { const form = new FormData(); form.append('image', new Blob([bytes || await photo()], {type:'image/png'}), 'photo.png'); return form; };
async function seed(app) {
  await app.store.lock(async () => {
    await app.store.asset('imported/top.png', await cutout());
    await app.store.asset('imported/bottom.png', await cutout());
    await app.store.write('library.json', [
      {id:'top',name:'Top',part:'upperbody',color:'#b72b30',tags:[],image:'/api/import/library/top.png'},
      {id:'bottom',name:'Bottom',part:'lowerbody',color:'#222222',tags:[],image:'/api/import/library/bottom.png'},
    ]);
  });
}

test('review: modeled approval preserves a subsequently replaced garment', async (t) => {
  const app = await testApp(t); await seed(app);
  await app.api('/api/reference','POST',await imageForm());
  const queued = await app.api('/api/import/wardrobe/top/generate-modeled','POST');
  await until(async () => (await app.store.job(queued.value.id)).stages.modeled.status === 'review');
  const replacement = await sharp({create:{width:64,height:64,channels:3,background:'#0000ff'}}).png().toBuffer();
  const changed = await app.api('/api/import/wardrobe/top/garment','POST',await imageForm(replacement));
  assert.equal(changed.status,200);
  const approved = await app.approveImport(queued.value.id, "modeled");
  assert.equal(approved.status,200);
  const digest=(bytes)=>createHash('sha256').update(bytes).digest('hex');
  const expected=digest(await readFile(await app.jobs.assetPath(changed.value.image)));
  const actual=digest(await readFile(await app.jobs.assetPath(approved.value.record.image)));
  assert.equal(actual,expected,'Modeled approval replaced the newer blue garment with the older red cutout');
});

test('review: curation receipt recovery preserves an approved outfit photo', async (t) => {
  const app = await testApp(t); await seed(app);
  app.codex.result={outfits:[{name:'Look',garmentIds:['top','bottom'],reason:'Balanced',setting:'Courtyard',occasion:['casual']}]};
  const save = app.store.saveJob.bind(app.store); let failOnce=true;
  app.store.saveJob=async (job) => {
    if(failOnce && job.kind==='curation' && job.status==='complete') { failOnce=false; throw new Error('Simulated disk failure during final job commit'); }
    return save(job);
  };
  const queued=await app.api('/api/outfits','POST',{count:1});
  await until(async () => (await app.store.job(queued.value.id)).stages.analysis.status==='failed');
  const outfit=(await app.api('/api/outfits')).value[0];
  const approved=await app.api(`/api/outfits/${outfit.id}/replacement`,'POST',await imageForm());
  assert.equal(approved.status,200); assert.equal(approved.value.status,'accepted');
  await app.api(`/api/import/jobs/${queued.value.id}/stages/analysis/retry`,'POST');
  await until(async () => (await app.store.job(queued.value.id)).status==='complete');
  assert.equal(app.codex.calls.length,1);
  const after=(await app.api('/api/outfits')).value[0];
  assert.equal(after.image,approved.value.image,'Receipt replay erased the approved outfit photo');
});

test('review: completed image checkpoint is reused when receipt metadata persistence fails', async (t) => {
  const app=await testApp(t); const uploaded=await app.upload(true); const id=uploaded.value.jobs[0].id;
  const rename=fs.promises.rename; let injected=false;
  fs.promises.rename=async (source,target) => {
    if(!injected && target===path.join(app.jobs.receipts,`${id}-garment-1.json`)) {
      injected=true; const error=new Error('Simulated receipt metadata persistence failure'); error.code='ENOSPC'; throw error;
    }
    return rename(source,target);
  };
  syncBuiltinESMExports();
  try {
    await app.approveImport(id, "crop");
    await until(async () => (await app.store.job(id)).stages.garment.status==='failed');
  } finally { fs.promises.rename=rename; syncBuiltinESMExports(); }
  assert.equal(injected,true);
  assert.ok((await readFile(path.join(app.jobs.receipts,`${id}-garment-1.png`))).length);
  assert.equal(app.codex.calls.length,1);
  await app.api(`/api/import/jobs/${id}/stages/garment/retry`,'POST');
  await until(async () => (await app.store.job(id)).stages.garment.status==='review');
  assert.equal(app.codex.calls.length,1,'Retry issued another AI request despite a complete image checkpoint');
});



test('curation recovery respects a deleted suggestion', async (t) => {
  const app = await testApp(t); await seed(app);
  app.codex.result = {outfits:[{name:'Look',garmentIds:['top','bottom'],reason:'Balanced',setting:'Courtyard',occasion:['casual']}]};
  const save = app.store.saveJob.bind(app.store); let failOnce = true;
  app.store.saveJob = async (job) => {
    if (failOnce && job.kind === 'curation' && job.status === 'complete') { failOnce = false; throw new Error('Simulated final commit failure'); }
    return save(job);
  };
  const queued = await app.api('/api/outfits', 'POST', {count:1});
  await until(async () => (await app.store.job(queued.value.id)).stages.analysis.status === 'failed');
  const outfit = (await app.api('/api/outfits')).value[0];
  assert.equal((await app.api(`/api/outfits/${outfit.id}`, 'DELETE')).status, 200);
  await app.api(`/api/import/jobs/${queued.value.id}/stages/analysis/retry`, 'POST');
  await until(async () => (await app.store.job(queued.value.id)).status === 'complete');
  assert.equal(app.codex.calls.length, 1);
  assert.deepEqual((await app.api('/api/outfits')).value, []);
});

test('cleanup from an older review cannot overwrite a new generation or cancellation', async (t) => {
  const app = await testApp(t); app.jobs.stopped = true;
  const id = (await app.upload()).value.jobs[0].id;
  await app.store.lock(async () => {
    const job = await app.store.job(id); await app.store.asset(`jobs/${id}/garment-1-source.png`, await photo());
    Object.assign(job.stages.garment, {status:'queued', attempts:1, rawAsset:'garment-1-source.png', chromaKey:'#00ff00'});
    await app.store.saveJob(job);
  });
  const response = await app.api(`/api/import/jobs/${id}/stages/garment/cleanup-accept`, 'POST', {tolerance:46});
  assert.equal(response.status, 409);
  assert.equal((await app.store.job(id)).stages.garment.status, 'queued');
  await app.api(`/api/import/jobs/${id}/cancel`, 'POST');
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/cleanup-accept`, 'POST', {tolerance:46})).status, 409);
});

test('cleanup rejects a garment that advances while image processing is in flight', async (t) => {
  const app = await testApp(t); app.jobs.stopped = true;
  const id = (await app.upload()).value.jobs[0].id;
  await app.store.lock(async () => {
    const job = await app.store.job(id); await app.store.asset(`jobs/${id}/garment-1-source.png`, await photo());
    Object.assign(job.stages.garment, {status:'failed', attempts:1, rawAsset:'garment-1-source.png', chromaKey:'#00ff00'});
    await app.store.saveJob(job);
  });
  let entered, release;
  const reading = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const safe = app.store.safe.bind(app.store); let held = false;
  app.store.safe = async (relative) => {
    const result = await safe(relative);
    if (!held && relative === `jobs/${id}/garment-1-source.png`) { held = true; entered(); await gate; }
    return result;
  };
  const pending = app.api(`/api/import/jobs/${id}/stages/garment/cleanup-accept`, 'POST', {tolerance:46, reviewedRawAsset:'garment-1-source.png'});
  await reading;
  await app.store.lock(async () => { const job = await app.store.job(id); job.stages.garment.status = 'processing'; job.stages.garment.attempts = 2; await app.store.saveJob(job); });
  release();
  assert.equal((await pending).status, 409);
  assert.equal((await app.store.job(id)).stages.garment.status, 'processing');
});

async function holdCropRead(app, id) {
  let entered, release;
  const reading = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const safe = app.store.safe.bind(app.store); let held = false;
  app.store.safe = async (relative) => {
    const result = await safe(relative);
    if (!held && relative === `jobs/${id}/original.png`) { held = true; entered(); await gate; }
    return result;
  };
  return { reading, release };
}

test('concurrent import edits reject stale crop commits and preserve newer fields', async (t) => {
  const app = await testApp(t); const id = (await app.upload()).value.jobs[0].id;
  const held = await holdCropRead(app, id);
  const first = app.api(`/api/import/jobs/${id}/metadata`, 'PATCH', { metadata: { name: 'Device A name' } });
  await held.reading;
  const bounds = { x: 100, y: 200, width: 500, height: 600 };
  let second;
  try { second = await app.api(`/api/import/jobs/${id}/metadata`, 'PATCH', { metadata: { tags: ['linen'], boundingBox: bounds } }); }
  finally { held.release(); }
  assert.equal(second.status, 200);
  const rejected = await first;
  assert.equal(rejected.status, 409); assert.match(rejected.value.error, /changed while you edited/);
  const current = await app.store.job(id);
  assert.deepEqual(current.metadata.tags, ['linen']); assert.deepEqual(current.metadata.boundingBox, bounds);
  assert.equal(current.stages.crop.assetUrl, second.value.stages.crop.assetUrl);
  const savedCrop = await readFile(await app.jobs.assetPath(current.stages.crop.assetUrl));
  const retried = await app.api(`/api/import/jobs/${id}/metadata`, 'PATCH', { metadata: { name: 'Device A name' } });
  assert.equal(retried.status, 200); assert.equal(retried.value.metadata.name, 'Device A name');
  assert.deepEqual(retried.value.metadata.tags, ['linen']); assert.deepEqual(retried.value.metadata.boundingBox, bounds);
  const retriedCrop = await readFile(await app.jobs.assetPath(retried.value.stages.crop.assetUrl));
  assert.deepEqual(retriedCrop, savedCrop, 'Metadata retry must use the current crop bounds');
});

test('cancellation during crop processing prevents the pending metadata save', async (t) => {
  const app = await testApp(t); const id = (await app.upload()).value.jobs[0].id;
  const original = await app.store.job(id); const held = await holdCropRead(app, id);
  const pending = app.api(`/api/import/jobs/${id}/metadata`, 'PATCH', { metadata: { name: 'Delayed edit' } });
  await held.reading;
  let cancelled;
  try { cancelled = await app.api(`/api/import/jobs/${id}/cancel`, 'POST'); }
  finally { held.release(); }
  assert.equal(cancelled.status, 200); assert.equal((await pending).status, 409);
  const current = await app.store.job(id);
  assert.equal(current.status, 'cancelled'); assert.deepEqual(current.metadata, original.metadata);
  assert.equal(current.stages.crop.assetUrl, original.stages.crop.assetUrl);
});
