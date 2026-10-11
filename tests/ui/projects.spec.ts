import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from '../../server/api';
import { paymentDependencies } from '../fixtures';

const visible=(page:Page)=>page.locator('.project-container:not([hidden])');
async function fixture(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-ui-'));
  const roots=['service-a','service-b'].map(name=>path.join(temp,name));
  await Promise.all(roots.map(root=>fs.cp('examples/payment-service',root,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')})));
  for(const [i,root] of roots.entries())await fs.appendFile(path.join(root,'src/main/java/dev/mockingbird/payment/PaymentController.java'),`\n// SOURCE-${i===0?'A':'B'}\n`);
  return{temp,roots,dataDir:path.join(temp,'data'),remove:()=>fs.rm(temp,{recursive:true,force:true})};
}
async function openProject(page:Page,root:string,newWindow=false){
  await page.getByRole('button',{name:'打开新项目',exact:true}).click();
  await visible(page).getByPlaceholder('/path/to/your/java-project').fill(root);
  if(newWindow)await visible(page).getByLabel('在新窗口打开',{exact:true}).check();
  await visible(page).getByRole('button',{name:'打开并索引',exact:true}).click();
}
async function switchProject(page:Page,name:string){
  await page.getByRole('tab',{name,exact:true}).click();
  await expect(page.getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true');
  await expect(visible(page).getByRole('button',{name:'切换项目',exact:true})).toContainText(name);
}
async function source(page:Page){
  await visible(page).getByPlaceholder('Search files, APIs…').fill('PaymentController.java');
  await visible(page).locator('.project-tree button[title="src/main/java/dev/mockingbird/payment/PaymentController.java"]').click();
}
async function editMonaco(page:Page,selector:string,text:string){
  const input=visible(page).locator(selector+' .monaco-editor textarea');await input.waitFor();await input.focus();
  await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText(text);
}

test('Switching and reopening restore project tabs, raw JSON, request drafts and source caches without publishing',async({page},info)=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0),errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);await openProject(page,f.roots[0]);
    await expect(visible(page).locator('.project-root')).toContainText('service-a');
    const a=[...service.projects.workbenches.values()][0],idA=a.workspace.project!.id,wf=await a.analyzeEntry(a.workspace.project!.entries.find(e=>e.path.endsWith('/create'))!.id);
    await a.saveDependency(wf.id,paymentDependencies(a.index!)[0]);await a.setRules(a.generate());
    await visible(page).getByRole('button',{name:'Mock 规则',exact:true}).click();
    await visible(page).getByLabel('Status code',{exact:true}).fill('201');
    await visible(page).getByLabel('AI prompt',{exact:true}).fill('unsent prompt A');
    await visible(page).getByRole('button',{name:'HTTP 客户端',exact:true}).click();
    await visible(page).getByLabel('请求路径',{exact:true}).fill('/project-a');
    await editMonaco(page,'.request-body','{"broken":');
    await expect.poll(()=>service.projects.readView(idA).then(view=>view.values.testBody)).toContain('broken');
    const rawRequest=(await service.projects.readView(idA)).values.testBody;
    await source(page);await expect(visible(page).locator('.source-view .view-lines')).toContainText('SOURCE-A');
    const javaFile='src/main/java/dev/mockingbird/payment/PaymentController.java';
    const cursorLine=async(file:string)=>((await service.projects.readView(idA)).values.tabs as {file?:string;line?:number}[]).find(tab=>tab.file===file)?.line;
    await visible(page).locator('.source-view .monaco-editor textarea').focus();await page.keyboard.press('ControlOrMeta+Home');
    for(let i=0;i<7;i++)await page.keyboard.press('ArrowDown');await expect.poll(()=>cursorLine(javaFile)).toBe(8);
    const cursorTop=await visible(page).locator('.source-view .cursors-layer .cursor').evaluate(element=>(element as HTMLElement).style.top);
    await visible(page).getByPlaceholder('Search files, APIs…').fill('pom.xml');await visible(page).locator('.project-tree button[title="pom.xml"]').click();
    await expect(visible(page).locator('.source-path')).toContainText('pom.xml');
    await visible(page).locator('.source-view .monaco-editor textarea').focus();await page.keyboard.press('ControlOrMeta+Home');
    for(let i=0;i<3;i++)await page.keyboard.press('ArrowDown');await expect.poll(()=>cursorLine('pom.xml')).toBe(4);
    await visible(page).locator('.workspace-tab>button:first-child').filter({hasText:'PaymentController.java'}).click();
    await expect(visible(page).locator('.source-path')).toContainText('PaymentController.java');
    await expect(visible(page).locator('.source-view .cursors-layer .cursor')).toHaveCSS('top',cursorTop);
    await visible(page).locator('.source-view .monaco-editor textarea').focus();await page.keyboard.press('ArrowDown');
    await expect.poll(()=>cursorLine(javaFile)).toBe(9);await expect.poll(()=>cursorLine('pom.xml')).toBe(4);
    await openProject(page,f.roots[1]);await expect(visible(page).locator('.project-root')).toContainText('service-b');
    await expect(visible(page).getByLabel('AI prompt',{exact:true})).toHaveValue('');
    await visible(page).getByLabel('AI prompt',{exact:true}).fill('unsent prompt B');
    await source(page);await expect(visible(page).locator('.source-view .view-lines')).toContainText('SOURCE-B');
    await switchProject(page,'service-a');await expect(visible(page).locator('.source-view .view-lines')).toContainText('SOURCE-A');
    await expect(visible(page).getByLabel('AI prompt',{exact:true})).toHaveValue('unsent prompt A');
    await visible(page).getByRole('button',{name:'HTTP 客户端',exact:true}).click();await expect(visible(page).getByLabel('请求路径',{exact:true})).toHaveValue('/project-a');
    await expect(visible(page).locator('.request-body .view-lines')).toContainText('"broken":');
    await visible(page).getByRole('button',{name:'Mock 规则',exact:true}).click();await expect(visible(page).getByLabel('Status code',{exact:true})).toHaveValue('201');
    await visible(page).getByRole('button',{name:'Rule JSON',exact:true}).click();await editMonaco(page,'.json-area','{"incomplete":');
    await expect(visible(page).locator('.editor-error')).toBeVisible();
    await switchProject(page,'service-b');await switchProject(page,'service-a');
    await expect(visible(page).locator('.json-area .view-lines')).toContainText('"incomplete":');await expect(visible(page).getByRole('button',{name:'保存并应用',exact:true})).toBeDisabled();
    await page.locator('.project-tab-bar').getByRole('button',{name:'关闭项目 service-a',exact:true}).click();
    await expect(visible(page).locator('.project-root')).toContainText('service-b');
    await visible(page).getByRole('button',{name:'切换项目',exact:true}).click();await visible(page).locator('.project-menu-row>button:first-child').filter({has:page.getByText('service-a',{exact:true})}).click();
    await expect(visible(page).locator('.json-area .view-lines')).toContainText('"incomplete":');await expect(visible(page).getByRole('button',{name:'保存并应用',exact:true})).toBeDisabled();
    await page.reload();await expect(visible(page).locator('.json-area .view-lines')).toContainText('"incomplete":');
    await expect(visible(page).getByLabel('AI prompt',{exact:true})).toHaveValue('unsent prompt A');
    await expect.poll(()=>service.projects.readView(idA).then(view=>view.values.testBody)).toBe(rawRequest);
    assertSaved();function assertSaved(){expect(service.projects.get(idA).workspace.rules[0].status).toBe(200);expect(service.projects.workbenches.size).toBe(2);}
    await visible(page).getByRole('button',{name:'切换项目',exact:true}).click();await page.screenshot({path:info.outputPath('multi-project.png')});
    expect(errors).toEqual([]);
  }finally{await service.close();await f.remove();}
});

test('Project tabs restore on reload, navigate by keyboard and select a neighbor when closed',async({page},info)=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0);
  try{
    const third=path.join(f.temp,'service-c');
    await fs.cp(f.roots[0],third,{recursive:true});
    await page.goto(`http://127.0.0.1:${service.port}`);
    for(const root of [...f.roots,third]){
      await openProject(page,root);
      await expect(page.getByRole('tab',{name:path.basename(root),exact:true})).toHaveAttribute('aria-selected','true');
    }
    const tabs=page.getByRole('tablist',{name:'已打开项目'}),bar=page.locator('.project-tab-bar');
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('tab',{name:'service-a',exact:true})).toHaveAttribute('title',await fs.realpath(f.roots[0]));
    await openProject(page,f.roots[0]);await expect(tabs.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('tab',{name:'service-a',exact:true})).toHaveAttribute('aria-selected','true');
    await visible(page).getByLabel('AI prompt',{exact:true}).fill('tab A draft');
    await switchProject(page,'service-b');
    await visible(page).getByLabel('AI prompt',{exact:true}).fill('tab B draft');
    await page.reload();
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('tab',{name:'service-b',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(visible(page).getByLabel('AI prompt',{exact:true})).toHaveValue('tab B draft');
    await page.getByRole('tab',{name:'service-b',exact:true}).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab',{name:'service-a',exact:true})).toBeFocused();
    await expect(visible(page).getByLabel('AI prompt',{exact:true})).toHaveValue('tab A draft');
    await page.keyboard.press('End');await expect(page.getByRole('tab',{name:'service-c',exact:true})).toBeFocused();
    await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'service-a',exact:true})).toBeFocused();
    await page.keyboard.press('ArrowLeft');await expect(page.getByRole('tab',{name:'service-c',exact:true})).toBeFocused();
    await page.keyboard.press('Home');await expect(page.getByRole('tab',{name:'service-a',exact:true})).toBeFocused();
    await page.setViewportSize({width:1060,height:720});
    await page.screenshot({path:info.outputPath('project-tabs.png')});
    await switchProject(page,'service-b');
    await bar.getByRole('button',{name:'关闭项目 service-b',exact:true}).click();
    await expect(page.getByRole('tab',{name:'service-c',exact:true})).toHaveAttribute('aria-selected','true');
    await bar.getByRole('button',{name:'关闭项目 service-c',exact:true}).click();
    await expect(page.getByRole('tab',{name:'service-a',exact:true})).toHaveAttribute('aria-selected','true');
    await openProject(page,third);
    await expect(page.getByRole('tab',{name:'service-c',exact:true})).toHaveAttribute('aria-selected','true');
    await bar.getByRole('button',{name:'关闭项目 service-a',exact:true}).click();
    await expect(page.getByRole('tab',{name:'service-c',exact:true})).toHaveAttribute('aria-selected','true');
    await bar.getByRole('button',{name:'关闭项目 service-c',exact:true}).click();
    await expect(tabs.getByRole('tab')).toHaveCount(0);
    await expect(visible(page).locator('.welcome')).toBeVisible();
    expect(new URL(page.url()).searchParams.has('project')).toBe(false);
    expect(service.projects.workbenches.size).toBe(0);
  }finally{await service.close();await f.remove();}
});

test('Same-name project tabs show their paths and scroll the active tab into view',async({page},info)=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0);
  try{
    const name='payment-service-with-a-long-project-name',roots=Array.from({length:5},(_,i)=>path.join(f.temp,'group-'+i,name));
    for(const root of roots)await fs.cp(f.roots[0],root,{recursive:true});
    await page.setViewportSize({width:1060,height:720});
    await page.goto(`http://127.0.0.1:${service.port}`);
    const list=page.getByRole('tablist',{name:'已打开项目'});
    for(const [index,root] of roots.entries()){
      await openProject(page,root);
      await expect(list.getByRole('tab')).toHaveCount(index+1);
      await expect(list.getByRole('tab').nth(index)).toHaveAttribute('aria-selected','true');
      await expect(list.getByRole('tab').nth(index)).toHaveAttribute('title',await fs.realpath(root));
    }
    await expect.poll(()=>list.evaluate(node=>node.scrollWidth>node.clientWidth&&node.scrollLeft>0)).toBe(true);
    await expect(page.getByRole('button',{name:'打开新项目',exact:true})).toBeInViewport();
    await expect(list.getByRole('tab').last()).toBeInViewport();
    await expect(list.getByRole('button',{name:'关闭项目 '+name,exact:true}).last()).toBeInViewport({ratio:1});
    await list.getByRole('tab').last().focus();await page.keyboard.press('Home');
    await expect(list.getByRole('tab').first()).toBeFocused();
    await expect.poll(()=>list.evaluate(node=>node.scrollLeft)).toBe(0);
    await page.keyboard.press('End');await expect(list.getByRole('tab').last()).toBeFocused();
    await expect(list.getByRole('tab').last()).toBeInViewport();
    await expect(list.getByRole('button',{name:'关闭项目 '+name,exact:true}).last()).toBeInViewport({ratio:1});
    await page.screenshot({path:info.outputPath('project-tabs-overflow.png')});
  }finally{await service.close();await f.remove();}
});

test('An old project source response cannot overwrite the newly active project',async({page})=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0);
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>release=resolve);let started=false;
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);await openProject(page,f.roots[0]);await expect(visible(page).locator('.project-root')).toContainText('service-a');
    const idA=[...service.projects.workbenches.keys()][0];
    await page.route('**/api/projects/'+idA+'/source?*',async route=>{started=true;await held;await route.continue();});
    await source(page);await expect.poll(()=>started).toBe(true);
    await openProject(page,f.roots[1]);await expect(visible(page).locator('.project-root')).toContainText('service-b');
    await source(page);await expect(visible(page).locator('.source-view .view-lines')).toContainText('SOURCE-B');
    const response=page.waitForResponse(res=>res.url().includes('/projects/'+idA+'/source?'));release();await response;
    await expect(visible(page).locator('.source-view .view-lines')).toContainText('SOURCE-B');
    await expect(visible(page).locator('.source-view .view-lines')).not.toContainText('SOURCE-A');
    await switchProject(page,'service-a');await expect(visible(page).locator('.source-view .view-lines')).toContainText('SOURCE-A');
    await switchProject(page,'service-b');await expect(visible(page).locator('.source-view .view-lines')).toContainText('SOURCE-B');
  }finally{release();await service.close();await f.remove();}
});

test('Copying a browser project URL cannot create a second editor for the same project',async({page,context})=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0);
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);await openProject(page,f.roots[0]);await expect(visible(page).locator('.project-root')).toContainText('service-a');
    await visible(page).getByLabel('AI prompt',{exact:true}).fill('owned by first tab');
    const copy=await context.newPage();await copy.goto(page.url());
    await expect(copy.getByRole('alert')).toContainText('项目已在另一个窗口打开');
    await expect(visible(copy).locator('.welcome')).toBeVisible();
    expect(new URL(copy.url()).searchParams.get('client')).not.toBe(new URL(page.url()).searchParams.get('client'));
    await page.reload();await expect(visible(page).getByLabel('AI prompt',{exact:true})).toHaveValue('owned by first tab');
    expect(service.projects.workbenches.size).toBe(1);
  }finally{await service.close();await f.remove();}
});

test('Electron focuses existing projects, transfers drafts, and closing a window stops only its own running service',async({},info)=>{
  const f=await fixture(),app=await electron.launch({executablePath:process.env.MOCKINGBIRD_ELECTRON_EXECUTABLE||createRequire(import.meta.url)('electron') as string,args:process.env.MOCKINGBIRD_ELECTRON_EXECUTABLE?[]:[process.cwd()],env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),MOCKINGBIRD_DATA_DIR:f.dataDir}});
  const errors:string[]=[];
  try{
    const a=await app.firstWindow();a.on('pageerror',e=>errors.push(e.message));await openProject(a,f.roots[0]);await expect(visible(a).locator('.project-root')).toContainText('service-a');
    await visible(a).getByLabel('AI prompt',{exact:true}).fill('native unsent A');
    await visible(a).locator('.runtime-status').click();await visible(a).getByRole('button',{name:'启动 Server',exact:true}).click();await expect(visible(a).locator('.runtime-status')).toContainText('running');
    const opened=app.waitForEvent('window');await openProject(a,f.roots[1],true);const b=await opened;b.on('pageerror',e=>errors.push(e.message));
    await expect(visible(b).locator('.project-root')).toContainText('service-b');await expect(visible(a).locator('.project-root')).toContainText('service-a');
    await visible(b).getByLabel('AI prompt',{exact:true}).fill('native unsent B');
    await visible(b).locator('.runtime-status').click();await visible(b).getByRole('button',{name:'启动 Server',exact:true}).click();await expect(visible(b).locator('.runtime-status')).toContainText('running');
    await openProject(b,f.roots[0]);await expect(visible(b).locator('.project-root')).toContainText('service-b');expect(app.windows()).toHaveLength(2);
    const idB=new URL(b.url()).searchParams.get('project')!,bWindow=await app.browserWindow(b);
    const closing=b.waitForEvent('close');await bWindow.evaluate(window=>window.close());await closing;
    await expect(visible(a).locator('.runtime-status')).toContainText('running');
    await expect.poll(()=>a.evaluate(async()=>{const state=await(await fetch('/api/state')).json();return state.projects.map((p:{name:string})=>p.name);})).toEqual(['service-a']);
    const saved=JSON.parse(await fs.readFile(path.join(f.dataDir,'projects',idB,'view.json'),'utf8'));expect(saved.values.prompt).toBe('native unsent B');
    await visible(a).getByRole('button',{name:'切换项目',exact:true}).click();
    const moved=app.waitForEvent('window');await visible(a).getByRole('button',{name:'在新窗口打开 service-a',exact:true}).click();const transferred=await moved;
    await expect(visible(transferred).getByLabel('AI prompt',{exact:true})).toHaveValue('native unsent A');await expect(visible(transferred).locator('.runtime-status')).toContainText('running');
    await expect(visible(a).locator('.welcome')).toBeVisible();expect(app.windows()).toHaveLength(2);
    await transferred.screenshot({path:info.outputPath('desktop-project.png')});expect(errors).toEqual([]);
  }finally{await app.close();await f.remove();}
});


test('Batch export selects multiple mocks into one Collection and scopes disabled scenarios',async({page},info)=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0);
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);await openProject(page,f.roots[0]);
    await expect(visible(page).locator('.project-root')).toContainText('service-a');
    const bench=[...service.projects.workbenches.values()][0],wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(e=>e.path.endsWith('/create'))!.id);
    for(const dependency of paymentDependencies(bench.index!).slice(0,2))await bench.saveDependency(wf.id,dependency);
    const rules=bench.generate();
    await bench.setRules([...rules,{...rules[0],id:crypto.randomUUID(),name:'Disabled sample',scenario:'Disabled',enabled:false}]);
    await visible(page).getByRole('button',{name:'Mock 规则',exact:true}).click();
    await expect(visible(page).locator('.mock-main').getByRole('button',{name:'导出',exact:true})).toHaveCount(0);
    await page.setViewportSize({width:1200,height:900});
    await visible(page).getByRole('button',{name:'批量导出',exact:true}).click();
    const dialog=visible(page).getByRole('dialog',{name:'批量导出 Mock',exact:true});
    await expect(dialog.getByLabel('导出格式',{exact:true})).toHaveValue('postman');
    await expect(dialog.locator('.export-rule-row')).toHaveCount(2);
    await dialog.getByRole('button',{name:'清空',exact:true}).click();
    await expect(dialog.getByRole('button',{name:'导出 0 个 Mock 到一个 Collection',exact:true})).toBeDisabled();
    await dialog.getByLabel('包含未启用的场景',{exact:true}).check();
    await expect(dialog.locator('.export-rule-row')).toHaveCount(3);
    await dialog.getByRole('button',{name:'全选',exact:true}).click();
    await dialog.locator('.export-rule-row input').nth(1).uncheck();
    await page.screenshot({path:info.outputPath('batch-export.png')});
    const downloading=page.waitForEvent('download');
    await dialog.getByRole('button',{name:'导出 2 个 Mock 到一个 Collection',exact:true}).click();
    const download=await downloading,collection=JSON.parse(await fs.readFile((await download.path())!,'utf8'));
    expect(download.suggestedFilename()).toMatch(/\.postman_collection\.json$/);
    expect(collection.item.map((item:{name:string})=>item.name)).toEqual([rules[0].name+' · '+rules[0].scenario,'Disabled sample · Disabled']);
    expect(collection.item.every((item:{response:unknown[]})=>item.response.length===1)).toBe(true);
    expect(bench.workspace.rules).toHaveLength(3);
    await expect(dialog).toHaveCount(0);
  }finally{await service.close();await f.remove();}
});


test('Scrolling upward over the payload returns to the mock form instead of trapping the wheel',async({page})=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0);
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);await openProject(page,f.roots[0]);
    await expect(visible(page).locator('.project-root')).toContainText('service-a');
    const bench=[...service.projects.workbenches.values()][0],wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(e=>e.path.endsWith('/create'))!.id);
    await bench.saveDependency(wf.id,paymentDependencies(bench.index!)[0]);await bench.setRules(bench.generate());
    await visible(page).getByRole('button',{name:'Mock 规则',exact:true}).click();
    const form=visible(page).locator('.form-scroll'),payload=visible(page).locator('.body-editor .monaco-editor');
    await page.setViewportSize({width:1200,height:700});
    await visible(page).locator('.matchers summary').click();
    await payload.waitFor();await payload.scrollIntoViewIfNeeded();
    const start=await form.evaluate(node=>node.scrollTop);expect(start).toBeGreaterThan(0);
    await payload.hover();await page.mouse.wheel(0,-350);
    await expect.poll(()=>form.evaluate(node=>node.scrollTop)).toBeLessThan(start);
    // Moving down over a short payload must also scroll the surrounding form.
    await payload.scrollIntoViewIfNeeded();await payload.hover();
    const beforeDown=await form.evaluate(node=>node.scrollTop);
    await page.mouse.wheel(0,150);
    await expect.poll(()=>form.evaluate(node=>node.scrollTop)).toBeGreaterThan(beforeDown);
    // A long payload still scrolls internally, then hands upward scrolling back at its top.
    await editMonaco(page,'.body-editor',JSON.stringify({data:Array.from({length:80},(_,i)=>'line '+i)},null,2));
    await page.keyboard.press('ControlOrMeta+Home');
    await payload.scrollIntoViewIfNeeded();await payload.hover();
    const lines=payload.locator('.view-lines'),lineTop=await lines.evaluate(node=>node.getBoundingClientRect().top),outerTop=await form.evaluate(node=>node.scrollTop);
    await page.mouse.wheel(0,150);
    await expect.poll(()=>lines.evaluate(node=>node.getBoundingClientRect().top)).toBeLessThan(lineTop);
    expect(await form.evaluate(node=>node.scrollTop)).toBe(outerTop);
    await expect.poll(async()=>{await page.mouse.wheel(0,-600);return form.evaluate(node=>node.scrollTop);},{intervals:[100,200,300]}).toBeLessThan(outerTop);
  }finally{await service.close();await f.remove();}
});


test('AI rule configuration sends the draft, opens a diff, and applies only after explicit approval',async({page},info)=>{
  const f=await fixture(),service=await createServer({root:process.cwd(),dataDir:f.dataDir},0),errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  try{
    const executable=path.join(f.temp,'fake-grok.cjs');
    await fs.writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='models'){console.log('- grok-4.7 (default)');process.exit(0);}
const prompt=fs.readFileSync(process.argv[process.argv.indexOf('--prompt-file')+1],'utf8');
fs.writeFileSync(process.argv[1]+'.prompt',prompt);
const rule=JSON.parse(prompt.split('当前规则（包含未保存草稿）：')[1].split('\\n')[0]);
const behavior={schemaVersion:1,sample:{path:rule.path,headers:{},body:{amount:88}},cases:[{id:'large',name:'大额拒绝',patch:{body:{amount:1001}},expected:{matched:true,status:200,fields:{'/approved':false}},calls:1}],matchers:[],exceptions:[],bindings:[{target:'/approved',value:{kind:'condition',condition:{source:'body',field:'/amount',operator:'lte',value:1000},then:true,otherwise:false}}]};
const result={summary:'金额超过 1000 时拒绝，保留当前草稿的延迟',ruleId:rule.id,status:rule.status,body:JSON.stringify(rule.body),headers:JSON.stringify(rule.headers),delay:rule.delay,behavior:JSON.stringify(behavior)};
process.stdout.write(JSON.stringify({text:JSON.stringify(result),stopReason:'end_turn'}));
`,{mode:0o755});
    service.projects.agents=[{id:'grok',installed:true,path:executable,version:'fake'}];
    await page.goto(`http://127.0.0.1:${service.port}`);await openProject(page,f.roots[0]);
    await expect(visible(page).locator('.project-root')).toContainText('service-a');
    const bench=[...service.projects.workbenches.values()][0],wf=await bench.analyzeEntry(bench.workspace.project!.entries.find(e=>e.path.endsWith('/create'))!.id);
    await bench.saveDependency(wf.id,paymentDependencies(bench.index!).find(d=>d.name.includes('Bank'))!);await bench.setRules(bench.generate());
    const saved=structuredClone(bench.workspace.rules);
    await visible(page).getByRole('button',{name:'Mock 规则',exact:true}).click();
    await visible(page).locator('input[type="number"]').nth(1).fill('123');
    await visible(page).getByRole('button',{name:'AI 修改',exact:true}).click();
    await expect(visible(page).locator('.rule-edit-context')).toContainText('Bank');
    await visible(page).getByLabel('AI prompt',{exact:true}).fill('金额超过 1000 时拒绝');
    await expect(visible(page).getByRole('button',{name:'发送 AI 请求',exact:true})).toBeEnabled();
    await visible(page).getByRole('button',{name:'发送 AI 请求',exact:true}).click();
    await expect(visible(page).getByRole('button',{name:'Review 行为修改',exact:true})).toBeVisible();
    expect(bench.workspace.rules).toEqual(saved);
    expect(await fs.readFile(executable+'.prompt','utf8')).toContain('"delay":123');
    await visible(page).getByRole('button',{name:'Review 行为修改',exact:true}).click();
    await expect(visible(page).locator('.diff-area')).toBeVisible();
    await expect(visible(page).getByRole('button',{name:'批准并应用',exact:true})).toBeEnabled();
    expect(bench.workspace.rules).toEqual(saved);
    await page.screenshot({path:info.outputPath('rule-behavior-review.png')});
    await visible(page).getByRole('button',{name:'批准并应用',exact:true}).click();
    await expect.poll(()=>bench.agentManager.tasks[0]?.approved).toBe(true);
    expect(bench.workspace.rules[0].delay).toBe(123);expect(bench.workspace.rules[0].behavior?.bindings[0].target).toBe('/approved');
    await expect(visible(page).getByRole('button',{name:'Review 行为修改',exact:true})).toHaveCount(0);
    await expect(visible(page).getByRole('button',{name:'保存并应用',exact:true})).toBeDisabled();
    expect(errors).toEqual([]);
  }finally{await service.close();await f.remove();}
});
