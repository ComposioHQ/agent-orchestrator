import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ChatUIRegressionHarness } from '../support/test';

const fixed = process.env.AO_REVIEW_FIXED === '1';
const png = readFileSync(process.env.AO_SPLIT_CHECKOUT + '/frontend/assets/icon.png').toString('base64');
const refusal = {error: 'conflict', code: 'CHAT_CONTROLLER_NOT_READY', message: 'Chat controller is not ready (injected pre-acceptance refusal).'};

test('a rejected first send remains an editable draft', async ({page}, info) => {
  const harness = await ChatUIRegressionHarness.create(page, {sessionId:'review-first-send'});
  const requests: Record<string, unknown>[] = [];
  await page.route('**/conversation/messages', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill(requests.length === 1
      ? {status:409, json:refusal}
      : {status:202, json:{status:'accepted', turnId:'accepted'}});
  });
  await harness.open();
  const composer=page.getByRole('combobox', {name:'Message the agent'});
  await composer.fill('Investigate the failing build');
  await page.getByRole('button', {name:'Send message', exact:true}).click();
  await expect.poll(()=>requests.length).toBe(1);
  await expect(composer).toHaveAttribute('contenteditable', fixed ? 'true' : 'false');
  await expect(composer).toHaveText('Investigate the failing build');
  await page.screenshot({path:info.outputPath('first-send-rejected.png')});
  await page.reload();
  await expect(composer).toHaveText('Investigate the failing build');
  await expect(composer).toHaveAttribute('contenteditable', fixed ? 'true' : 'false');
  if (fixed) {
    await composer.fill('Investigate the failing build and summarize the cause');
    await page.getByRole('button', {name:'Send message', exact:true}).click();
    await expect(composer).toHaveText('');
    expect(requests[1].clientMessageId).not.toBe(requests[0].clientMessageId);
    await page.screenshot({path:info.outputPath('edited-send-accepted.png')});
  }
  expect(harness.pageErrors).toEqual([]);
  await info.attach('requests.json', {body:JSON.stringify(requests,null,2), contentType:'application/json'});
});

test('uncertain sends keep their original identity after a retry refusal', async ({page}, info) => {
  const harness=await ChatUIRegressionHarness.create(page, {sessionId:'review-uncertain-send'});
  const requests: Record<string,unknown>[]=[];
  await page.route('**/conversation/messages', async route=>{
    requests.push(route.request().postDataJSON());
    await route.fulfill(requests.length===1
      ? {status:503,json:{error:'service_unavailable',code:'CHAT_DELIVERY_UNCERTAIN',message:'Response lost after acceptance (injected uncertainty).'}}
      : {status:409,json:refusal});
  });
  await harness.open();
  const composer=page.getByRole('combobox',{name:'Message the agent'});
  await composer.fill('A message whose acceptance is unknown');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry message safely'})).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'Retry message safely'}).click();
  await expect.poll(()=>requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(composer).toHaveAttribute('contenteditable','false');
  await expect(composer).toHaveText('A message whose acceptance is unknown');
  await page.screenshot({path:info.outputPath('uncertain-retry-protected.png')});
  expect(harness.pageErrors).toEqual([]);
});

test('a reloaded attachment keeps its image thumbnail', async ({page},info)=>{
  const harness=await ChatUIRegressionHarness.create(page, {sessionId:'review-thumbnail'});
  harness.stagePaths=['.ao/attachments/investigation.png'];
  await page.route('**/preview/files/.ao/attachments/investigation.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')}));
  await harness.open();
  const composer=page.getByRole('combobox',{name:'Message the agent'});
  await composer.fill('Keep this image with my draft');
  await page.locator('input[type="file"]').setInputFiles({name:'investigation.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  const image=page.getByRole('list',{name:'Attached files'}).locator('img');
  await expect(image).toHaveAttribute('src',/^data:image\/png/);
  await page.reload();
  await expect(page.getByLabel('Remove investigation.png')).toBeVisible();
  await expect(image).toHaveCount(fixed ? 1 : 0);
  if (fixed) {
    await expect(image).toHaveAttribute('src',/preview\/files\/\.ao\/attachments\/investigation.png/);
    await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.complete && img.naturalWidth>0)).toBe(true);
  }
  await page.screenshot({path:info.outputPath('restored-thumbnail.png')});
  expect(harness.pageErrors).toEqual([]);
});
